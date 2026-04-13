import express from "express";
import type {
  AiCommandLogEntry,
  AiCommandLogResponse,
  AiCommandLogStreamEvent,
} from "../../shared/types.js";
import { logServerEvent } from "../utils/server-logger.js";
import {
  buildAiCommandLogsResponse,
  readAiCommandLogEntryByIdentifier,
} from "./api-helpers.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiAiLogRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/ai/logs", async (_req, res, next) => {
    try {
      res.json(await buildAiCommandLogsResponse({
        repoRoot: context.repoRoot,
        aiProcesses: context.passiveAiProcesses,
        reconcileJobs: context.shouldReconcileAiJobs,
      }));
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

      let currentLog: AiCommandLogEntry | null = null;
      let lastPayload = "null";

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      let closed = false;

      const isStreamClosed = () => closed || req.destroyed || res.destroyed || res.writableEnded;

      let unsubscribe: () => Promise<void> = async () => {};
      let interval: NodeJS.Timeout | null = null;

      const closeStream = () => {
        if (closed) {
          return;
        }

        closed = true;
        if (interval) {
          clearInterval(interval);
        }
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

      const refreshLog = async () => {
        try {
          const nextLog = await readAiCommandLogEntryByIdentifier(context.repoRoot, jobId);
          if (isStreamClosed()) {
            return;
          }

          currentLog = nextLog;
          const nextPayload = JSON.stringify(nextLog);
          if (nextPayload !== lastPayload) {
            const eventType = lastPayload === "null" ? "snapshot" : "update";
            lastPayload = nextPayload;
            writeEvent(eventType, nextLog);
          }
        } catch (error) {
          const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
          if (code === "ENOENT") {
            currentLog = null;
            if (lastPayload !== "null") {
              lastPayload = "null";
              writeEvent("update", null);
            }
            return;
          }

          throw error;
        }
      };

      unsubscribe = await context.operationalState.subscribeToAiCommandLogNotifications((notification) => {
        if (!currentLog) {
          return;
        }
        if (notification.jobId !== currentLog.jobId && notification.fileName !== currentLog.fileName) {
          return;
        }

        void Promise.resolve().then(async () => {
          await refreshLog();
        }).catch((error) => {
          logServerEvent("ai-log-stream", "listen-failed", {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        });
      });

      await refreshLog();

      let polling = false;
      interval = setInterval(() => {
        if (polling || isStreamClosed()) {
          return;
        }

        polling = true;
        void Promise.resolve().then(async () => {
          await refreshLog();
        }).catch((error) => {
          logServerEvent("ai-log-stream", "poll-failed", {
            jobId,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          polling = false;
        });
      }, context.aiLogStreamPollIntervalMs);

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
