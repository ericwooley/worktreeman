import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AppendProjectManagementBatchRequest,
  ApiStateResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  CreateWorktreeRequest,
  GitComparisonResponse,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  TmuxClientInfo,
  UpdateProjectManagementDocumentRequest,
  WorktreeManagerConfig,
} from "../../shared/types.js";
import {
  getBackgroundCommandLogs,
  getBackgroundCommandEntries,
  listBackgroundCommands,
  restartBackgroundCommand,
  startBackgroundCommand,
  startConfiguredBackgroundCommands,
  streamBackgroundCommandLogs,
  stopAllBackgroundCommands,
  stopBackgroundCommand,
} from "../services/background-command-service.js";
import { createWorktree, getGitComparison, listWorktrees, removeWorktree } from "../services/git-service.js";
import { buildRuntimeProcessEnv, createRuntime, runStartupCommands } from "../services/runtime-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import { loadConfig, parseConfigContents, readConfigContents } from "../services/config-service.js";
import type { ShutdownStatus } from "../../shared/types.js";
import { disconnectTmuxClient, ensureRuntimeTerminalSession, ensureTerminalSession, getTmuxSessionName, killTmuxSession, killTmuxSessionByName, listTmuxClients } from "../services/terminal-service.js";
import {
  appendProjectManagementBatch,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
  updateProjectManagementDocument,
} from "../services/project-management-service.js";
import type { ShutdownStatusService } from "../services/shutdown-status-service.js";
import type { RuntimeStore } from "../state/runtime-store.js";

interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  configSourceRef: string;
  configFile: string;
  configWorktreePath: string;
  runtimes: RuntimeStore;
  shutdownStatus: ShutdownStatusService;
}

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();

  const loadCurrentConfig = () => loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitFile: options.configFile,
  });

  const resolveEnvSyncSourceRoot = async (_worktrees: Awaited<ReturnType<typeof listWorktrees>>) => options.configWorktreePath;

  router.get("/state", async (_req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const payload: ApiStateResponse = {
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        configFile: options.configFile,
        configSourceRef: options.configSourceRef,
        configWorktreePath: options.configWorktreePath,
        config,
        worktrees: options.runtimes.mergeInto(worktrees),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/shutdown-status", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeStatus = (status: ShutdownStatus) => {
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    };

    const unsubscribe = options.shutdownStatus.subscribe(writeStatus);

    req.on("close", () => {
      unsubscribe();
      res.end();
    });
  });

  router.get("/config/document", async (_req, res, next) => {
    try {
      const contents = await readConfigContents({
        path: options.configPath,
        repoRoot: options.repoRoot,
        gitFile: options.configFile,
      });

      const payload: ConfigDocumentResponse = {
        branch: options.configSourceRef,
        filePath: path.join(options.configWorktreePath, options.configFile),
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

      const absoluteConfigPath = path.join(options.configWorktreePath, options.configFile);
      await fs.writeFile(absoluteConfigPath, contents, "utf8");

      const payload: ConfigDocumentResponse = {
        branch: options.configSourceRef,
        filePath: absoluteConfigPath,
        contents,
        editable: true,
      };

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/git/compare", async (req, res, next) => {
    try {
      const compareBranch = String(req.query.compareBranch ?? "").trim();
      const baseBranch = typeof req.query.baseBranch === "string" ? req.query.baseBranch : undefined;

      if (!compareBranch) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      const comparison: GitComparisonResponse = await getGitComparison(options.repoRoot, compareBranch, baseBranch);
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents", async (_req, res, next) => {
    try {
      const payload: ProjectManagementListResponse = await listProjectManagementDocuments(options.repoRoot);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents/:id", async (req, res, next) => {
    try {
      const payload: ProjectManagementDocumentResponse = await getProjectManagementDocument(
        options.repoRoot,
        decodeURIComponent(req.params.id),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents/:id/history", async (req, res, next) => {
    try {
      const payload: ProjectManagementHistoryResponse = await getProjectManagementDocumentHistory(
        options.repoRoot,
        decodeURIComponent(req.params.id),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents", async (req, res, next) => {
    try {
      const body = req.body as CreateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await createProjectManagementDocument(options.repoRoot, {
        title: body.title,
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
        status: typeof body.status === "string" ? body.status : undefined,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      });
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/updates", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await updateProjectManagementDocument(
        options.repoRoot,
        decodeURIComponent(req.params.id),
        {
          title: body.title,
          markdown: typeof body.markdown === "string" ? body.markdown : "",
          tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
          status: typeof body.status === "string" ? body.status : undefined,
          assignee: typeof body.assignee === "string" ? body.assignee : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
        },
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/batches", async (req, res, next) => {
    try {
      const body = req.body as AppendProjectManagementBatchRequest;
      if (!Array.isArray(body?.entries) || body.entries.length === 0) {
        res.status(400).json({ message: "At least one batch entry is required." });
        return;
      }

      const payload: ProjectManagementBatchResponse = await appendProjectManagementBatch(options.repoRoot, {
        entries: body.entries.map((entry) => ({
          documentId: typeof entry.documentId === "string" ? entry.documentId : undefined,
          title: String(entry.title ?? ""),
          markdown: typeof entry.markdown === "string" ? entry.markdown : "",
          tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag)) : [],
          status: typeof entry.status === "string" ? entry.status : undefined,
          assignee: typeof entry.assignee === "string" ? entry.assignee : undefined,
          archived: typeof entry.archived === "boolean" ? entry.archived : undefined,
        })),
      });
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const body = req.body as CreateWorktreeRequest;
      if (!body?.branch?.trim()) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const worktree = await createWorktree(options.repoRoot, config, body);
      const worktrees = await listWorktrees(options.repoRoot);
      const sourceRoot = await resolveEnvSyncSourceRoot(worktrees);

      if (sourceRoot) {
        const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
        res.status(201).json(result);
        return;
      }

      res.status(201).json({ copiedFiles: [] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/start", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const existingRuntime = options.runtimes.get(worktree.branch);
      if (existingRuntime) {
        res.json(existingRuntime);
        return;
      }

      const { runtime } = await createRuntime(config, worktree.branch, worktree.worktreePath);
      options.runtimes.set(runtime);
      await ensureRuntimeTerminalSession(runtime);
      await runStartupCommands(config.startupCommands, worktree.worktreePath, buildRuntimeProcessEnv(runtime));
      await startConfiguredBackgroundCommands({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime,
      });
      res.json(runtime);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/env/sync", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const sourceRoot = await resolveEnvSyncSourceRoot(worktrees);

      if (!sourceRoot) {
        res.status(404).json({ message: `Unable to locate the source config worktree for ${options.configSourceRef}.` });
        return;
      }

      const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/stop", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await stopAllBackgroundCommands(req.params.branch, runtime.worktreePath);
      await killTmuxSession(runtime);
      options.runtimes.delete(req.params.branch);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const tmuxSession = await ensureTerminalSession({
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime,
      });

      const clients: TmuxClientInfo[] = await listTmuxClients({
        tmuxSession,
        worktreePath: worktree.worktreePath,
      });
      res.json(clients);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/tmux-clients/:clientId/disconnect", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      await disconnectTmuxClient({ worktreePath: worktree.worktreePath }, decodeURIComponent(req.params.clientId));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/worktrees/:branch", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = options.runtimes.get(worktree.branch);
      if (runtime) {
        await stopAllBackgroundCommands(worktree.branch, runtime.worktreePath);
        await killTmuxSession(runtime);
        options.runtimes.delete(worktree.branch);
      } else {
        await killTmuxSessionByName(getTmuxSessionName(worktree.branch), worktree.worktreePath);
      }

      await removeWorktree(options.repoRoot, worktree.worktreePath);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/start", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await startBackgroundCommand({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime: options.runtimes.get(worktree.branch),
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/stop", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(await loadCurrentConfig())[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await stopBackgroundCommand(worktree.branch, worktree.worktreePath, decodedName);

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        await loadCurrentConfig(),
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/restart", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await restartBackgroundCommand({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime: options.runtimes.get(worktree.branch),
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const logs: BackgroundCommandLogsResponse = await getBackgroundCommandLogs(
        config,
        worktree.branch,
        worktree.worktreePath,
        decodeURIComponent(req.params.name),
      );
      res.json(logs);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs/stream", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commandName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[commandName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${commandName}` });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (payload: BackgroundCommandLogStreamEvent) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const history = await getBackgroundCommandLogs(config, worktree.branch, worktree.worktreePath, commandName);
      writeEvent({ type: "snapshot", commandName: history.commandName, lines: history.lines });

      const dispose = await streamBackgroundCommandLogs({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        commandName,
        onEvent: (event) => writeEvent(event),
        onError: (message) => writeEvent({
          type: "append",
          commandName,
          lines: [{
            id: `stream-error:${Date.now()}`,
            source: "stderr",
            text: message,
            timestamp: new Date().toISOString(),
          }],
        }),
      });

      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        dispose();
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
