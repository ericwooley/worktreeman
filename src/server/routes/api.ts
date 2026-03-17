import express from "express";
import path from "node:path";
import type { ApiStateResponse, CreateWorktreeRequest, TmuxClientInfo, WorktreeManagerConfig } from "../../shared/types.js";
import { createWorktree, listWorktrees, removeWorktree } from "../services/git-service.js";
import { ensureDockerRuntime, stopDockerRuntime } from "../services/docker-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import { loadConfig } from "../services/config-service.js";
import { releaseReservedPorts } from "../services/runtime-port-service.js";
import { disconnectTmuxClient, getTmuxSessionName, killTmuxSessionByName, listTmuxClients } from "../services/terminal-service.js";
import type { RuntimeStore } from "../state/runtime-store.js";

interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  configRef: string;
  configSourceRef: string;
  configFile: string;
  configWorktreePath?: string;
  runtimes: RuntimeStore;
}

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();

  const loadCurrentConfig = () => loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitRef: options.configRef === "WORKTREE" ? undefined : options.configRef,
    gitFile: options.configFile,
  });

  const resolveEnvSyncSourceRoot = async (worktrees: Awaited<ReturnType<typeof listWorktrees>>) => {
    if (options.configWorktreePath) {
      return options.configWorktreePath;
    }

    if (path.isAbsolute(options.configPath)) {
      return path.dirname(options.configPath);
    }

    return (worktrees.find((entry) => entry.branch === options.configSourceRef)
      ?? worktrees.find((entry) => entry.branch === "main"))?.worktreePath;
  };

  router.get("/state", async (_req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const payload: ApiStateResponse = {
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        config,
        worktrees: options.runtimes.mergeInto(worktrees),
      };
      res.json(payload);
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

      const { runtime, reservedPorts } = await ensureDockerRuntime(config, worktree.branch, worktree.worktreePath);
      options.runtimes.set(runtime, reservedPorts);
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
      const config = await loadCurrentConfig();
      const runtime = options.runtimes.get(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await stopDockerRuntime(runtime, config);
      const deletedRuntime = options.runtimes.delete(req.params.branch);
      await releaseReservedPorts(deletedRuntime?.reservedPorts ?? []);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      const clients: TmuxClientInfo[] = await listTmuxClients(runtime);
      res.json(clients);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/tmux-clients/:clientId/disconnect", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await disconnectTmuxClient(runtime, decodeURIComponent(req.params.clientId));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/worktrees/:branch", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = options.runtimes.get(worktree.branch);
      if (runtime) {
        await stopDockerRuntime(runtime, config);
        const deletedRuntime = options.runtimes.delete(worktree.branch);
        await releaseReservedPorts(deletedRuntime?.reservedPorts ?? []);
      }

      await killTmuxSessionByName(getTmuxSessionName(worktree.branch), worktree.worktreePath);

      await removeWorktree(options.repoRoot, worktree.worktreePath);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
