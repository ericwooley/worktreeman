import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiCommandConfig,
  AiCommandSettingsResponse,
  ApiStateStreamEvent,
  ConfigDocumentResponse,
  ProjectManagementUsersResponse,
  ShutdownStatus,
  SystemStatusResponse,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementUsersRequest,
} from "../../shared/types.js";
import {
  listProjectManagementUsers,
} from "../services/project-management-service.js";
import {
  readConfigContents as readConfigDocumentContents,
  parseConfigContents,
  updateAiCommandInConfigContents,
  updateProjectManagementUsersInConfigContents,
} from "../services/config-service.js";
import { getSystemStatus } from "../services/system-status-service.js";
import { logServerEvent } from "../utils/server-logger.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiStateRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/state/stream", async (req, res, next) => {
    try {
      let currentState = await context.loadState();
      let lastPayload = JSON.stringify(currentState);
      let rebuilding = false;

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
        unsubscribe();
        clearInterval(interval);
        clearInterval(keepAlive);
        if (res.destroyed || res.writableEnded) {
          return;
        }

        try {
          res.end();
        } catch {
          // Ignore connection teardown races during SSE cleanup.
        }
      };

      const writeEvent = (type: ApiStateStreamEvent["type"], state: Awaited<ReturnType<typeof context.loadState>>) => {
        if (isStreamClosed()) {
          return;
        }
        const event: ApiStateStreamEvent = { type, state };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentState);

      const rebuildAndEmit = () => {
        if (rebuilding) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          if (isStreamClosed()) {
            return;
          }
          const nextState = await context.loadState();
          if (isStreamClosed()) {
            return;
          }
          currentState = nextState;
          const nextPayload = JSON.stringify(nextState);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeEvent("update", nextState);
          }
        }).catch((error) => {
          logServerEvent("state-stream", "rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToStateRefresh(rebuildAndEmit);
      const interval = setInterval(rebuildAndEmit, context.stateStreamFullRefreshIntervalMs);
      const keepAlive = setInterval(() => {
        if (isStreamClosed()) {
          return;
        }
        try {
          res.write(`: keep-alive\n\n`);
        } catch {
          closeStream();
        }
      }, 15000);

      req.on("close", closeStream);
      res.on("close", closeStream);
      res.on("error", closeStream);
    } catch (error) {
      next(error);
    }
  });

  router.get("/shutdown-status", async (req, res, next) => {
    try {
      let currentStatus = await context.operationalState.getShutdownStatus();
      let lastPayload = JSON.stringify(currentStatus);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeStatus = (status: ShutdownStatus) => {
        res.write(`data: ${JSON.stringify(status)}\n\n`);
      };

      writeStatus(currentStatus);

      let polling = false;
      const interval = setInterval(() => {
        if (polling) {
          return;
        }

        polling = true;
        void Promise.resolve().then(async () => {
          const nextStatus = await context.operationalState.getShutdownStatus();
          currentStatus = nextStatus;
          const nextPayload = JSON.stringify(nextStatus);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeStatus(nextStatus);
          }
        }).catch((error) => {
          logServerEvent("shutdown-status", "poll-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          polling = false;
        });
      }, context.aiLogStreamPollIntervalMs);
      const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/system", async (_req, res, next) => {
    try {
      const payload: SystemStatusResponse = await getSystemStatus(context.repoRoot);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/document", async (_req, res, next) => {
    try {
      const contents = await readConfigDocumentContents({
        path: context.configPath,
        repoRoot: context.repoRoot,
        gitFile: context.configFile,
      });

      const payload: ConfigDocumentResponse = {
        branch: context.configSourceRef,
        filePath: path.join(context.configWorktreePath, context.configFile),
        contents,
        editable: true,
      };

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/document", async (req, res, next) => {
    try {
      const contents = typeof req.body?.contents === "string" ? req.body.contents : "";
      if (!contents.trim()) {
        res.status(400).json({ message: "Config contents are required." });
        return;
      }

      parseConfigContents(contents);

      const absoluteConfigPath = path.join(context.configWorktreePath, context.configFile);
      await fs.writeFile(absoluteConfigPath, contents, "utf8");
      await context.commitConfigEdit("config: update worktree config");

      const payload: ConfigDocumentResponse = {
        branch: context.configSourceRef,
        filePath: absoluteConfigPath,
        contents,
        editable: true,
      };

      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings/ai-command", async (_req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const payload: AiCommandSettingsResponse = {
        branch: context.configSourceRef,
        filePath: path.join(context.configWorktreePath, context.configFile),
        aiCommands: config.aiCommands,
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings/ai-command", async (req, res, next) => {
    try {
      const body = req.body as UpdateAiCommandSettingsRequest;
      const aiCommands: AiCommandConfig = {
        smart: typeof body?.aiCommands?.smart === "string" ? body.aiCommands.smart : "",
        simple: typeof body?.aiCommands?.simple === "string" ? body.aiCommands.simple : "",
        autoStartRuntime: body?.aiCommands?.autoStartRuntime === true,
      };
      const currentContents = await readConfigDocumentContents({
        path: context.configPath,
        repoRoot: context.repoRoot,
        gitFile: context.configFile,
      });
      const nextContents = updateAiCommandInConfigContents(currentContents, aiCommands);

      const absoluteConfigPath = path.join(context.configWorktreePath, context.configFile);
      await fs.writeFile(absoluteConfigPath, nextContents, "utf8");
      await context.commitConfigEdit("config: update ai commands");

      const payload: AiCommandSettingsResponse = {
        branch: context.configSourceRef,
        filePath: absoluteConfigPath,
        aiCommands,
      };

      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/users", async (_req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const payload: ProjectManagementUsersResponse = await listProjectManagementUsers(context.repoRoot, config.projectManagement.users);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/project-management/users", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementUsersRequest | undefined;
      const config = body?.config;
      if (!config || typeof config !== "object") {
        res.status(400).json({ message: "Project management users config is required." });
        return;
      }

      const currentContents = await readConfigDocumentContents({
        path: context.configPath,
        repoRoot: context.repoRoot,
        gitFile: context.configFile,
      });

      const nextContents = updateProjectManagementUsersInConfigContents(currentContents, {
        customUsers: Array.isArray(config.customUsers)
          ? config.customUsers.map((entry) => ({
              name: typeof entry?.name === "string" ? entry.name : "",
              email: typeof entry?.email === "string" ? entry.email : "",
            }))
          : [],
        archivedUserIds: Array.isArray(config.archivedUserIds)
          ? config.archivedUserIds.map((entry) => String(entry))
          : [],
      });

      const absoluteConfigPath = path.join(context.configWorktreePath, context.configFile);
      await fs.writeFile(absoluteConfigPath, nextContents, "utf8");
      await context.commitConfigEdit("config: update project management users");

      const nextConfig = await context.loadCurrentConfig();
      const payload: ProjectManagementUsersResponse = await listProjectManagementUsers(context.repoRoot, nextConfig.projectManagement.users);
      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}
