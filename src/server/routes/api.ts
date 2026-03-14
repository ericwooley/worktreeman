import express from "express";
import type { ApiStateResponse, CreateWorktreeRequest, WorktreeManagerConfig } from "../../shared/types.js";
import { createWorktree, listWorktrees, removeWorktree } from "../services/git-service.js";
import { ensureDockerRuntime, stopDockerRuntime } from "../services/docker-service.js";
import { releaseReservedPorts } from "../services/runtime-port-service.js";
import type { RuntimeStore } from "../state/runtime-store.js";

interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  config: WorktreeManagerConfig;
  runtimes: RuntimeStore;
}

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();

  router.get("/state", async (_req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const payload: ApiStateResponse = {
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        config: options.config,
        worktrees: options.runtimes.mergeInto(worktrees),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees", async (req, res, next) => {
    try {
      const body = req.body as CreateWorktreeRequest;
      if (!body?.branch?.trim()) {
        res.status(400).json({ message: "branch is required" });
        return;
      }
      const worktree = await createWorktree(options.repoRoot, options.config, body);
      res.status(201).json(worktree);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/start", async (req, res, next) => {
    try {
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

      const { runtime, reservedPorts } = await ensureDockerRuntime(options.config, worktree.branch, worktree.worktreePath);
      options.runtimes.set(runtime, reservedPorts);
      res.json(runtime);
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

      await stopDockerRuntime(runtime, options.config);
      const deletedRuntime = options.runtimes.delete(req.params.branch);
      await releaseReservedPorts(deletedRuntime?.reservedPorts ?? []);
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
        await stopDockerRuntime(runtime, options.config);
        const deletedRuntime = options.runtimes.delete(worktree.branch);
        await releaseReservedPorts(deletedRuntime?.reservedPorts ?? []);
      }

      await removeWorktree(options.repoRoot, worktree.worktreePath);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  return router;
}
