import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiCommandConfig,
  AiCommandLogsResponse,
  AiCommandLogsStreamEvent,
  AiCommandSettingsResponse,
  ApiStateStreamEvent,
  ConfigDocumentResponse,
  DashboardEventsStreamEvent,
  ProjectManagementUsersResponse,
  ProjectManagementUsersStreamEvent,
  ShutdownStatus,
  ShutdownStatusStreamEvent,
  SystemStatusResponse,
  SystemStatusStreamEvent,
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
import { buildAiCommandLogsResponse } from "./api-helpers.js";
import { getSystemStatus } from "../services/system-status-service.js";
import {
  formatBytes,
  logServerEvent,
  snapshotProcessMemoryUsage,
} from "../utils/server-logger.js";
import type { ApiRouterContext } from "./api-router-context.js";

function buildStateChangeKey(state: Awaited<ReturnType<ApiRouterContext["loadState"]>>): string {
  const worktrees = state.worktrees;
  return [
    state.config.favicon,
    state.config.preferredPort ?? "",
    worktrees.length,
    ...worktrees.map((worktree) => [
      worktree.id,
      worktree.branch,
      worktree.worktreePath,
      worktree.headSha ?? "",
      worktree.runtime?.tmuxSession ?? "",
      worktree.runtime?.runtimeStartedAt ?? "",
      worktree.runtime ? "1" : "0",
      worktree.deletion?.canDelete ? "1" : "0",
      worktree.deletion?.reason ?? "",
    ].join(":")),
  ].join("|");
}

function buildShutdownChangeKey(status: ShutdownStatus): string {
  const lastLog = status.logs.at(-1);
  return [
    status.active ? "1" : "0",
    status.completed ? "1" : "0",
    status.failed ? "1" : "0",
    status.logs.length,
    lastLog?.id ?? "",
    lastLog?.timestamp ?? "",
    lastLog?.level ?? "",
  ].join(":");
}

function buildSystemChangeKey(status: SystemStatusResponse): string {
  const firstJob = status.jobs.items[0];
  return [
    status.capturedAt,
    status.performance.memory.usedBytes,
    status.performance.memory.freeBytes,
    status.performance.worktrees.total,
    status.performance.worktrees.runtimeCount,
    status.jobs.available ? "1" : "0",
    status.jobs.total,
    firstJob?.id ?? "",
    firstJob?.state ?? "",
    firstJob?.heartbeatAt ?? "",
  ].join(":");
}

function buildAiCommandLogsChangeKey(logs: AiCommandLogsResponse): string {
  const historicalTail = logs.logs.slice(0, 10);
  const runningTail = logs.runningJobs.slice(0, 10);
  return [
    logs.logs.length,
    logs.runningJobs.length,
    ...historicalTail.map((entry) => [entry.jobId, entry.status, entry.timestamp, entry.pid ?? "", entry.origin?.kind ?? ""].join(":")),
    ...runningTail.map((entry) => [
      entry.jobId,
      entry.status,
      entry.completedAt ?? "",
      entry.pid ?? "",
      entry.exitCode ?? "",
      entry.processName ?? "",
      entry.error ?? "",
    ].join(":")),
  ].join("|");
}

function buildProjectManagementUsersChangeKey(users: ProjectManagementUsersResponse): string {
  const lastUser = users.users.at(-1);
  return [
    users.users.length,
    users.config.customUsers.length,
    users.config.archivedUserIds.length,
    lastUser?.id ?? "",
    lastUser?.archived ? "1" : "0",
    lastUser?.lastCommitAt ?? "",
  ].join(":");
}

function buildProjectManagementDocumentsChangeKey(
  documents: Awaited<ReturnType<ApiRouterContext["listProjectManagementDocuments"]>>,
): string {
  const lastDocument = documents.documents.at(-1);
  return [
    documents.documents.length,
    documents.availableTags.length,
    documents.availableStatuses.length,
    lastDocument?.id ?? "",
    lastDocument?.updatedAt ?? "",
    lastDocument?.historyCount ?? "",
  ].join(":");
}

function noteDashboardRebuild(scope: string, details: Record<string, unknown>) {
  const memory = snapshotProcessMemoryUsage();
  logServerEvent(scope, "rebuild", {
    ...details,
    rss: formatBytes(memory.rssBytes),
    heapUsed: formatBytes(memory.heapUsedBytes),
    heapTotal: formatBytes(memory.heapTotalBytes),
    heapRatio: memory.heapUsedRatio ?? "n/a",
  });
}

function noteDashboardPayload(scope: string, eventType: DashboardEventsStreamEvent["type"], payload: string) {
  const payloadBytes = Buffer.byteLength(payload, "utf8");
  if (payloadBytes < 512 * 1024) {
    return;
  }

  const memory = snapshotProcessMemoryUsage();
  logServerEvent(scope, "large-payload", {
    eventType,
    payloadBytes,
    payload: formatBytes(payloadBytes),
    heapUsed: formatBytes(memory.heapUsedBytes),
    heapTotal: formatBytes(memory.heapTotalBytes),
    heapRatio: memory.heapUsedRatio ?? "n/a",
  }, payloadBytes >= 2 * 1024 * 1024 ? "warn" : "info");
}

export function registerApiStateRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/state", async (_req, res, next) => {
    try {
      const payload = await context.loadState();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/events/stream", async (req, res, next) => {
    try {
      let currentState = await context.loadState();
      let currentShutdownStatus = await context.operationalState.getShutdownStatus();
      let currentSystemStatus = await getSystemStatus(context.repoRoot);
      const initialConfig = await context.loadCurrentConfig();
      let currentAiCommandLogs = await buildAiCommandLogsResponse({
        repoRoot: context.repoRoot,
        aiProcesses: context.passiveAiProcesses,
        reconcileJobs: context.shouldReconcileAiJobs,
      });
      let currentProjectManagementUsers = await listProjectManagementUsers(context.repoRoot, initialConfig.projectManagement.users);
      let currentProjectManagementDocuments = await context.listProjectManagementDocuments();
      let lastStateChangeKey = buildStateChangeKey(currentState);
      let lastShutdownChangeKey = buildShutdownChangeKey(currentShutdownStatus);
      let lastSystemChangeKey = buildSystemChangeKey(currentSystemStatus);
      let lastAiCommandLogsChangeKey = buildAiCommandLogsChangeKey(currentAiCommandLogs);
      let lastUsersChangeKey = buildProjectManagementUsersChangeKey(currentProjectManagementUsers);
      let lastDocumentsChangeKey = buildProjectManagementDocumentsChangeKey(currentProjectManagementDocuments);
      let rebuildingState = false;
      let rebuildingShutdown = false;
      let rebuildingSystem = false;
      let rebuildingAiCommandLogs = false;
      let rebuildingUsers = false;
      let rebuildingDocuments = false;

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
        unsubscribeState();
        void unsubscribeAiCommandLogs().catch(() => undefined);
        unsubscribeProjectManagementDocuments();
        unsubscribeProjectManagementUsers();
        unsubscribeSystemStatus();
        clearInterval(stateInterval);
        clearInterval(shutdownInterval);
        clearInterval(systemInterval);
        clearInterval(aiCommandLogsInterval);
        clearInterval(projectManagementUsersInterval);
        clearInterval(projectManagementDocumentsInterval);
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

      const writeEvent = (event: DashboardEventsStreamEvent) => {
        if (isStreamClosed()) {
          return;
        }

        try {
          const payload = JSON.stringify(event);
          noteDashboardPayload("events-stream", event.type, payload);
          res.write(`data: ${payload}\n\n`);
        } catch {
          closeStream();
        }
      };

      const writeStateEvent = (type: ApiStateStreamEvent["type"], state: Awaited<ReturnType<typeof context.loadState>>) => {
        writeEvent({ type: "state", event: { type, state } });
      };

      const writeShutdownEvent = (type: ShutdownStatusStreamEvent["type"], status: ShutdownStatus) => {
        writeEvent({ type: "shutdown-status", event: { type, status } });
      };

      const writeSystemEvent = (type: SystemStatusStreamEvent["type"], status: SystemStatusResponse) => {
        writeEvent({ type: "system-status", event: { type, status } });
      };

      const writeAiCommandLogsEvent = (type: AiCommandLogsStreamEvent["type"], logs: AiCommandLogsResponse) => {
        writeEvent({ type: "ai-logs", event: { type, logs } });
      };

      const writeProjectManagementUsersEvent = (
        type: ProjectManagementUsersStreamEvent["type"],
        users: ProjectManagementUsersResponse,
      ) => {
        writeEvent({ type: "project-management-users", event: { type, users } });
      };

      const writeProjectManagementDocumentsEvent = (
        type: "snapshot" | "update",
        documents: Awaited<ReturnType<typeof context.listProjectManagementDocuments>>,
      ) => {
        writeEvent({ type: "project-management-documents", event: { type, documents } });
      };

      writeStateEvent("snapshot", currentState);
      writeShutdownEvent("snapshot", currentShutdownStatus);
      writeSystemEvent("snapshot", currentSystemStatus);
      writeAiCommandLogsEvent("snapshot", currentAiCommandLogs);
      writeProjectManagementUsersEvent("snapshot", currentProjectManagementUsers);
      writeProjectManagementDocumentsEvent("snapshot", currentProjectManagementDocuments);

      const rebuildAndEmitState = () => {
        if (rebuildingState || isStreamClosed()) {
          return;
        }

        rebuildingState = true;
        void Promise.resolve().then(async () => {
          noteDashboardRebuild("events-stream", { section: "state", stage: "start" });
          const nextState = await context.loadState();
          if (isStreamClosed()) {
            return;
          }

          currentState = nextState;
          const nextChangeKey = buildStateChangeKey(nextState);
          noteDashboardRebuild("events-stream", {
            section: "state",
            stage: "done",
            worktrees: nextState.worktrees.length,
          });
          if (nextChangeKey !== lastStateChangeKey) {
            lastStateChangeKey = nextChangeKey;
            writeStateEvent("update", nextState);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "state-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingState = false;
        });
      };

      const rebuildAndEmitShutdown = () => {
        if (rebuildingShutdown || isStreamClosed()) {
          return;
        }

        rebuildingShutdown = true;
        void Promise.resolve().then(async () => {
          const nextStatus = await context.operationalState.getShutdownStatus();
          if (isStreamClosed()) {
            return;
          }

          currentShutdownStatus = nextStatus;
          const nextChangeKey = buildShutdownChangeKey(nextStatus);
          if (nextChangeKey !== lastShutdownChangeKey) {
            lastShutdownChangeKey = nextChangeKey;
            writeShutdownEvent("update", nextStatus);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "shutdown-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingShutdown = false;
        });
      };

      const rebuildAndEmitSystem = () => {
        if (rebuildingSystem || isStreamClosed()) {
          return;
        }

        rebuildingSystem = true;
        void Promise.resolve().then(async () => {
          noteDashboardRebuild("events-stream", { section: "system", stage: "start" });
          const nextStatus = await getSystemStatus(context.repoRoot);
          if (isStreamClosed()) {
            return;
          }

          currentSystemStatus = nextStatus;
          const nextChangeKey = buildSystemChangeKey(nextStatus);
          noteDashboardRebuild("events-stream", {
            section: "system",
            stage: "done",
            jobs: nextStatus.jobs.total,
          });
          if (nextChangeKey !== lastSystemChangeKey) {
            lastSystemChangeKey = nextChangeKey;
            writeSystemEvent("update", nextStatus);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "system-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingSystem = false;
        });
      };

      const rebuildAndEmitAiCommandLogs = () => {
        if (rebuildingAiCommandLogs || isStreamClosed()) {
          return;
        }

        rebuildingAiCommandLogs = true;
        void Promise.resolve().then(async () => {
          noteDashboardRebuild("events-stream", { section: "ai-logs", stage: "start" });
          const nextLogs = await buildAiCommandLogsResponse({
            repoRoot: context.repoRoot,
            aiProcesses: context.passiveAiProcesses,
            reconcileJobs: context.shouldReconcileAiJobs,
          });
          if (isStreamClosed()) {
            return;
          }

          currentAiCommandLogs = nextLogs;
          const nextChangeKey = buildAiCommandLogsChangeKey(nextLogs);
          noteDashboardRebuild("events-stream", {
            section: "ai-logs",
            stage: "done",
            logs: nextLogs.logs.length,
            runningJobs: nextLogs.runningJobs.length,
          });
          if (nextChangeKey !== lastAiCommandLogsChangeKey) {
            lastAiCommandLogsChangeKey = nextChangeKey;
            writeAiCommandLogsEvent("update", nextLogs);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "ai-logs-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingAiCommandLogs = false;
        });
      };

      const rebuildAndEmitProjectManagementUsers = () => {
        if (rebuildingUsers || isStreamClosed()) {
          return;
        }

        rebuildingUsers = true;
        void Promise.resolve().then(async () => {
          const nextConfig = await context.loadCurrentConfig();
          const nextUsers = await listProjectManagementUsers(context.repoRoot, nextConfig.projectManagement.users);
          if (isStreamClosed()) {
            return;
          }

          currentProjectManagementUsers = nextUsers;
          const nextChangeKey = buildProjectManagementUsersChangeKey(nextUsers);
          if (nextChangeKey !== lastUsersChangeKey) {
            lastUsersChangeKey = nextChangeKey;
            writeProjectManagementUsersEvent("update", nextUsers);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "project-management-users-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingUsers = false;
        });
      };

      const rebuildAndEmitProjectManagementDocuments = () => {
        if (rebuildingDocuments || isStreamClosed()) {
          return;
        }

        rebuildingDocuments = true;
        void Promise.resolve().then(async () => {
          const nextDocuments = await context.listProjectManagementDocuments();
          if (isStreamClosed()) {
            return;
          }

          currentProjectManagementDocuments = nextDocuments;
          const nextChangeKey = buildProjectManagementDocumentsChangeKey(nextDocuments);
          if (nextChangeKey !== lastDocumentsChangeKey) {
            lastDocumentsChangeKey = nextChangeKey;
            writeProjectManagementDocumentsEvent("update", nextDocuments);
          }
        }).catch((error) => {
          logServerEvent("events-stream", "project-management-documents-rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuildingDocuments = false;
        });
      };

      const unsubscribeState = context.subscribeToStateRefresh(rebuildAndEmitState);
      const unsubscribeAiCommandLogs = await context.operationalState.subscribeToAiCommandLogNotifications(() => {
        rebuildAndEmitAiCommandLogs();
      });
      const unsubscribeProjectManagementDocuments = context.subscribeToProjectManagementDocumentsRefresh(rebuildAndEmitProjectManagementDocuments);
      const unsubscribeProjectManagementUsers = context.subscribeToProjectManagementUsersRefresh(rebuildAndEmitProjectManagementUsers);
      const unsubscribeSystemStatus = context.subscribeToSystemStatusRefresh(rebuildAndEmitSystem);
      const stateInterval = setInterval(rebuildAndEmitState, context.stateStreamFullRefreshIntervalMs);
      const shutdownInterval = setInterval(rebuildAndEmitShutdown, context.aiLogStreamPollIntervalMs);
      const systemInterval = setInterval(rebuildAndEmitSystem, context.stateStreamFullRefreshIntervalMs);
      const aiCommandLogsInterval = setInterval(rebuildAndEmitAiCommandLogs, Math.max(context.aiLogStreamPollIntervalMs * 6, 30000));
      const projectManagementUsersInterval = setInterval(rebuildAndEmitProjectManagementUsers, context.stateStreamFullRefreshIntervalMs);
      const projectManagementDocumentsInterval = setInterval(rebuildAndEmitProjectManagementDocuments, context.stateStreamFullRefreshIntervalMs);
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

  router.get("/state/stream", async (req, res, next) => {
    try {
      let currentState = await context.loadState();
      let lastChangeKey = buildStateChangeKey(currentState);
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
          const payload = JSON.stringify(event);
          noteDashboardPayload("state-stream", "state", payload);
          res.write(`data: ${payload}\n\n`);
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
          noteDashboardRebuild("state-stream", { section: "state", stage: "start" });
          const nextState = await context.loadState();
          if (isStreamClosed()) {
            return;
          }
          currentState = nextState;
          const nextChangeKey = buildStateChangeKey(nextState);
          noteDashboardRebuild("state-stream", {
            section: "state",
            stage: "done",
            worktrees: nextState.worktrees.length,
          });
          if (nextChangeKey !== lastChangeKey) {
            lastChangeKey = nextChangeKey;
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

  router.get("/system/stream", async (_req, res, next) => {
    try {
      let currentStatus = await getSystemStatus(context.repoRoot);
      let lastPayload = JSON.stringify(currentStatus);
      let rebuilding = false;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      let closed = false;

      const isStreamClosed = () => closed || res.destroyed || res.writableEnded;

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

      const writeEvent = (type: SystemStatusStreamEvent["type"], status: SystemStatusResponse) => {
        if (isStreamClosed()) {
          return;
        }

        const event: SystemStatusStreamEvent = { type, status };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentStatus);

      const rebuildAndEmit = () => {
        if (rebuilding || isStreamClosed()) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          const nextStatus = await getSystemStatus(context.repoRoot);
          if (isStreamClosed()) {
            return;
          }

          currentStatus = nextStatus;
          const nextPayload = JSON.stringify(nextStatus);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeEvent("update", nextStatus);
          }
        }).catch((error) => {
          logServerEvent("system-status-stream", "rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToSystemStatusRefresh(rebuildAndEmit);
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

      res.on("close", closeStream);
      res.on("error", closeStream);
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
      context.emitProjectManagementUsersRefresh();
      context.emitSystemStatusRefresh();
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
      context.emitSystemStatusRefresh();
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

  router.get("/project-management/users/stream", async (_req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      let currentUsers = await listProjectManagementUsers(context.repoRoot, config.projectManagement.users);
      let lastPayload = JSON.stringify(currentUsers);
      let rebuilding = false;

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      let closed = false;

      const isStreamClosed = () => closed || res.destroyed || res.writableEnded;

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

      const writeEvent = (type: ProjectManagementUsersStreamEvent["type"], users: ProjectManagementUsersResponse) => {
        if (isStreamClosed()) {
          return;
        }

        const event: ProjectManagementUsersStreamEvent = { type, users };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentUsers);

      const rebuildAndEmit = () => {
        if (rebuilding || isStreamClosed()) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          const nextConfig = await context.loadCurrentConfig();
          const nextUsers = await listProjectManagementUsers(context.repoRoot, nextConfig.projectManagement.users);
          if (isStreamClosed()) {
            return;
          }

          currentUsers = nextUsers;
          const nextPayload = JSON.stringify(nextUsers);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeEvent("update", nextUsers);
          }
        }).catch((error) => {
          logServerEvent("project-management-users-stream", "rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToProjectManagementUsersRefresh(rebuildAndEmit);
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

      res.on("close", closeStream);
      res.on("error", closeStream);
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
      context.emitProjectManagementUsersRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}
