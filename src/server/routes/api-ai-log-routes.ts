import express from "express";
import type {
  AiCommandLogEntry,
  AiCommandLogResponse,
  AiCommandLogsResponse,
  AiCommandLogStreamEvent,
} from "../../shared/types.js";
import { logServerEvent } from "../utils/server-logger.js";
import {
  isAiCommandLogActivelyRunning,
  listAiCommandLogEntries,
  readAiCommandLogEntryByIdentifier,
  resolveHistoricalAiCommandLogEntry,
  toHistoricalAiCommandLogSummaries,
  toRunningAiCommandJob,
} from "./api-helpers.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiAiLogRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/ai/logs", async (_req, res, next) => {
    try {
      const rawEntries = await listAiCommandLogEntries(context.repoRoot);
      const reconciledEntries = await Promise.all(
        rawEntries.map((entry) => resolveHistoricalAiCommandLogEntry({
          entry,
          repoRoot: context.repoRoot,
          aiProcesses: context.passiveAiProcesses,
          reconcileJobs: context.shouldReconcileAiJobs,
        })),
      );

      const payload: AiCommandLogsResponse = {
        logs: toHistoricalAiCommandLogSummaries(reconciledEntries),
        runningJobs: rawEntries.filter(isAiCommandLogActivelyRunning).map(toRunningAiCommandJob),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai/logs/:jobId", async (req, res, next) => {
    try {
      const jobId = decodeURIComponent(req.params.jobId || "").trim();
      if (!jobId) {
        res.status(400).json({ message: "AI log job id is required." });
        return;
      }

      const log = await context.loadResolvedAiLog(jobId);
      const response: AiCommandLogResponse = { log };
      res.json(response);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        res.status(404).json({ message: `Unknown AI log ${req.params.jobId}` });
        return;
      }
      next(error);
    }
  });

  router.get("/ai/logs/:jobId/stream", async (req, res, next) => {
    try {
      const jobId = decodeURIComponent(req.params.jobId || "").trim();
      if (!jobId) {
        res.status(400).json({ message: "AI log job id is required." });
        return;
      }

      let currentLog = await readAiCommandLogEntryByIdentifier(context.repoRoot, jobId);
      let lastPayload = JSON.stringify(currentLog);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      let closed = false;

      const isStreamClosed = () => closed || req.destroyed || res.destroyed || res.writableEnded;

      const closeStream = () => {
        if (closed) {
          return;
        }

        closed = true;
        clearInterval(keepAlive);
        void unsubscribe().catch(() => undefined);
        if (res.destroyed || res.writableEnded) {
          return;
        }

        try {
          res.end();
        } catch {
          // Ignore connection teardown races during SSE cleanup.
        }
      };

      const writeEvent = (type: AiCommandLogStreamEvent["type"], log: AiCommandLogEntry | null) => {
        if (isStreamClosed()) {
          return;
        }
        const event: AiCommandLogStreamEvent = { type, log };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentLog);
      const unsubscribe = await context.operationalState.subscribeToAiCommandLogNotifications((notification) => {
        if (notification.jobId !== currentLog.jobId && notification.fileName !== currentLog.fileName) {
          return;
        }

        void Promise.resolve().then(async () => {
          try {
            currentLog = await readAiCommandLogEntryByIdentifier(context.repoRoot, jobId);
            if (isStreamClosed()) {
              return;
            }
            const nextPayload = JSON.stringify(currentLog);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", currentLog);
            }
          } catch (error) {
            const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
            if (code === "ENOENT") {
              if (lastPayload !== "null") {
                lastPayload = "null";
                writeEvent("update", null);
              }
              return;
            }

            throw error;
          }
        }).catch((error) => {
          logServerEvent("ai-log-stream", "listen-failed", {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        });
      });

      const keepAlive = setInterval(() => {
        if (isStreamClosed()) {
          return;
        }
        try {
          res.write(": keep-alive\n\n");
        } catch {
          closeStream();
        }
      }, 15000);

      req.on("close", closeStream);
      res.on("close", closeStream);
      res.on("error", closeStream);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        res.status(404).json({ message: `Unknown AI log ${req.params.jobId}` });
        return;
      }
      next(error);
    }
  });
}
