import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  CommitGitChangesRequest,
  CommitGitChangesResponse,
  GenerateGitCommitMessageRequest,
  GenerateGitCommitMessageResponse,
  GitComparisonResponse,
  GitComparisonStreamEvent,
  MergeGitBranchRequest,
  ResolveGitMergeConflictsRequest,
} from "../../shared/types.js";
import { resolveAiCommandTemplate } from "../../shared/ai-command-utils.js";
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
} from "../../shared/constants.js";
import { quoteShellArg } from "../../shared/shell-utils.js";
import {
  commitGitChanges,
  formatMergeConflictResolutionPrompt,
  generateGitCommitMessage,
  getGitComparison,
  listWorktrees,
  mergeGitBranch,
} from "../services/git-service.js";
import { buildWorktreeMergeComment } from "../services/project-management-comment-formatters.js";
import { buildRuntimeProcessEnv } from "../services/runtime-service.js";
import { addProjectManagementComment } from "../services/project-management-service.js";
import { getWorktreeDocumentLink } from "../services/worktree-link-service.js";
import { runCommand } from "../utils/process.js";
import { logServerEvent } from "../utils/server-logger.js";
import {
  createAiLogIdentifiers,
  createGitConflictResolutionOrigin,
  parseAiCommandId,
  safeWriteAiRequestLog,
} from "./api-helpers.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiGitRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/git/compare/stream", async (req, res, next) => {
    try {
      const compareBranch = String(req.query.compareBranch ?? "").trim();
      const baseBranch = typeof req.query.baseBranch === "string" ? req.query.baseBranch : undefined;

      if (!compareBranch) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      let currentComparison = await getGitComparison(context.repoRoot, compareBranch, baseBranch);
      let lastPayload = JSON.stringify(currentComparison);
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

      const writeEvent = (type: GitComparisonStreamEvent["type"], comparison: GitComparisonResponse) => {
        if (isStreamClosed()) {
          return;
        }

        const event: GitComparisonStreamEvent = { type, comparison };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentComparison);

      const rebuildAndEmit = () => {
        if (rebuilding || isStreamClosed()) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          const nextComparison = await getGitComparison(context.repoRoot, compareBranch, baseBranch);
          if (isStreamClosed()) {
            return;
          }

          currentComparison = nextComparison;
          const nextPayload = JSON.stringify(nextComparison);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeEvent("update", nextComparison);
          }
        }).catch((error) => {
          logServerEvent("git-comparison-stream", "rebuild-failed", {
            compareBranch,
            baseBranch: baseBranch ?? null,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToGitComparisonRefresh(rebuildAndEmit);
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

  router.get("/git/compare", async (req, res, next) => {
    try {
      const compareBranch = String(req.query.compareBranch ?? "").trim();
      const baseBranch = typeof req.query.baseBranch === "string" ? req.query.baseBranch : undefined;

      if (!compareBranch) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      const comparison: GitComparisonResponse = await getGitComparison(context.repoRoot, compareBranch, baseBranch);
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/merge", async (req, res, next) => {
    try {
      const compareBranch = decodeURIComponent(req.params.branch);
      const body = req.body as MergeGitBranchRequest | undefined;
      const baseBranch = typeof body?.baseBranch === "string" ? body.baseBranch : undefined;
      const preserveConflicts = body?.preserveConflicts === true;

      if (!compareBranch.trim()) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      const mergeBlockedByAiReason = await context.getMergeBlockedByAiReason([compareBranch, baseBranch]);
      if (mergeBlockedByAiReason) {
        res.status(409).json({ message: mergeBlockedByAiReason });
        return;
      }

      const comparisonBeforeMerge: GitComparisonResponse = await getGitComparison(context.repoRoot, compareBranch, baseBranch);
      const comparison: GitComparisonResponse = await mergeGitBranch(context.repoRoot, compareBranch, baseBranch, {
        preserveConflicts,
      });

      const compareWorktree = await context.findWorktree(compareBranch);
      const linkedDocument = compareWorktree
        ? await getWorktreeDocumentLink(context.repoRoot, compareWorktree.id)
        : null;
      if (linkedDocument?.documentId) {
        try {
          await addProjectManagementComment(context.repoRoot, linkedDocument.documentId, {
            body: buildWorktreeMergeComment({
              branch: comparison.compareBranch,
              baseBranch: comparison.baseBranch,
              commits: comparisonBeforeMerge.compareCommits,
            }),
          });
        } catch (error) {
          logServerEvent("project-management-comment", "failed", {
            branch: compareBranch,
            documentId: linkedDocument.documentId,
            stage: "merge",
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }
      }

      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/resolve-conflicts", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as ResolveGitMergeConflictsRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await context.loadCurrentConfig();
      const worktrees = await listWorktrees(context.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const comparisonBeforeResolution = await getGitComparison(
        context.repoRoot,
        branch,
        typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
      );
      const baseBranch = comparisonBeforeResolution.baseBranch;
      const conflictsToResolve = comparisonBeforeResolution.workingTreeConflicts.length > 0
        ? comparisonBeforeResolution.workingTreeConflicts
        : comparisonBeforeResolution.mergeIntoCompareStatus.conflicts;

      if (conflictsToResolve.length === 0) {
        throw new Error(`Branch ${branch} does not currently expose merge conflicts against ${baseBranch}.`);
      }

      const runtime = await context.operationalState.getRuntimeById(worktree.id);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
            ...process.env,
            ...config.env,
            WORKTREE_ID: worktree.id,
            WORKTREE_BRANCH: worktree.branch,
            WORKTREE_PATH: worktree.worktreePath,
          };

      const commandId = parseAiCommandId(body?.commandId ?? "smart");
      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      const origin = createGitConflictResolutionOrigin({
        branch: worktree.branch,
        worktreeId: worktree.id,
        baseBranch,
      });

      if (!template) {
        const error = new Error(`${commandId === "simple" ? "Simple AI" : "Smart AI"} is not configured.`);
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree.id,
          branch: worktree.branch,
          commandId,
          origin,
          worktreePath: worktree.worktreePath,
          renderedCommand: template,
          input: "",
          error,
        });
        throw error;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        const error = new Error(`${commandId === "simple" ? "Simple AI" : "Smart AI"} must include $WTM_AI_INPUT.`);
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree.id,
          branch: worktree.branch,
          commandId,
          origin,
          worktreePath: worktree.worktreePath,
          renderedCommand: template,
          input: "",
          error,
        });
        throw error;
      }

      for (const conflict of conflictsToResolve) {
        const input = formatMergeConflictResolutionPrompt({
          branch: worktree.branch,
          baseBranch,
          conflicts: [conflict],
        });
        const renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));
        const completedAt = new Date().toISOString();
        try {
          const { stdout, stderr } = await runCommand(process.env.SHELL || "/usr/bin/bash", ["-lc", template], {
            cwd: worktree.worktreePath,
            env: { ...env, WTM_AI_INPUT: input },
          });
          const normalized = stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
          if (!normalized.trim()) {
            throw new Error(`AI did not return resolved contents for ${conflict.path}.`);
          }

          await fs.writeFile(path.join(worktree.worktreePath, conflict.path), `${normalized}\n`, "utf8");

          const { jobId, fileName, startedAt } = createAiLogIdentifiers(worktree.id);
          await safeWriteAiRequestLog({
            fileName,
            jobId,
            repoRoot: context.repoRoot,
            worktreeId: worktree.id,
            branch: worktree.branch,
            commandId,
            origin,
            worktreePath: worktree.worktreePath,
            renderedCommand,
            input,
            stdout,
            stderr,
            startedAt,
            completedAt,
            pid: null,
            exitCode: 0,
            processName: null,
          });
        } catch (error) {
          const { jobId, fileName, startedAt } = createAiLogIdentifiers(worktree.id);
          await safeWriteAiRequestLog({
            fileName,
            jobId,
            repoRoot: context.repoRoot,
            worktreeId: worktree.id,
            branch: worktree.branch,
            commandId,
            origin,
            worktreePath: worktree.worktreePath,
            renderedCommand,
            input,
            startedAt,
            completedAt,
            pid: null,
            exitCode: null,
            processName: null,
            error,
          });
          throw error;
        }
      }

      await runCommand("git", ["add", "--", ...conflictsToResolve.map((conflict) => conflict.path)], {
        cwd: worktree.worktreePath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_AUTHOR_NAME,
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || DEFAULT_GIT_AUTHOR_NAME,
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
        },
      });

      const comparison: GitComparisonResponse = await getGitComparison(context.repoRoot, branch, baseBranch);
      context.emitGitComparisonRefresh();
      context.emitStateRefresh();
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/commit", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as CommitGitChangesRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await context.loadCurrentConfig();
      const worktrees = await listWorktrees(context.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const runtime = await context.operationalState.getRuntimeById(worktree.id);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
            ...process.env,
            ...config.env,
            WORKTREE_ID: worktree.id,
            WORKTREE_BRANCH: worktree.branch,
            WORKTREE_PATH: worktree.worktreePath,
          };

      const payload: CommitGitChangesResponse = await commitGitChanges({
        repoRoot: context.repoRoot,
        branch,
        baseBranch: typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
        aiCommands: config.aiCommands,
        commandId: parseAiCommandId(body?.commandId ?? "simple"),
        env,
        message: typeof body?.message === "string" ? body.message : undefined,
      });
      context.emitGitComparisonRefresh();
      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/commit-message", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as GenerateGitCommitMessageRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await context.loadCurrentConfig();
      const worktrees = await listWorktrees(context.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const runtime = await context.operationalState.getRuntimeById(worktree.id);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
            ...process.env,
            ...config.env,
            WORKTREE_ID: worktree.id,
            WORKTREE_BRANCH: worktree.branch,
            WORKTREE_PATH: worktree.worktreePath,
          };

      const payload: GenerateGitCommitMessageResponse = await generateGitCommitMessage({
        repoRoot: context.repoRoot,
        branch,
        baseBranch: typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
        aiCommands: config.aiCommands,
        commandId: parseAiCommandId(body?.commandId ?? "simple"),
        env,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });
}
