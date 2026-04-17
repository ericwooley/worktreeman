import express from "express";
import path from "node:path";
import process from "node:process";
import type {
  AddProjectManagementCommentRequest,
  AppendProjectManagementBatchRequest,
  AiCommandId,
  AiCommandOrigin,
  CreateProjectManagementDocumentRequest,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementDocumentSummaryResponse,
  ProjectManagementDocumentsStreamEvent,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  RunAiCommandResponse,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementDocumentRequest,
  UpdateProjectManagementStatusRequest,
  WorktreeRecord,
} from "../../shared/types.js";
import {
  parseAiCommandOrigin,
  resolveAiCommandTemplate,
} from "../../shared/ai-command-utils.js";
import { createWorktree, listWorktrees } from "../services/git-service.js";
import { listBackgroundCommands } from "../services/background-command-service.js";
import {
  buildRuntimeProcessEnv,
  buildWorktreeProcessEnv,
  runStartupCommands,
} from "../services/runtime-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import {
  addProjectManagementComment,
  appendProjectManagementBatch,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
  moveProjectManagementDocumentTowardInProgress,
  updateProjectManagementDependencies,
  updateProjectManagementDocument,
  updateProjectManagementStatus,
} from "../services/project-management-service.js";
import {
  getAiCommandJob,
  waitForAiCommandJob,
} from "../services/ai-command-service.js";
import {
  getWorktreeDocumentLink,
  setWorktreeDocumentLink,
} from "../services/worktree-link-service.js";
import { sanitizeBranchName } from "../utils/paths.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";
import {
  buildAiCommandProcessEnv,
  buildAiEnvironmentContext,
  buildProjectManagementExecutionAiPrompt,
  createProjectManagementDocumentOrigin,
  generateProjectManagementDocumentSummary,
  renderAiCommand,
  resolveProjectManagementDocumentWorktreeBranch,
  resolveRequestedAiCommandId,
} from "./api-helpers.js";
import type { ApiRouterContext } from "./api-router-context.js";
import type { RunProjectManagementDocumentAiRequest } from "./api-types.js";

export function registerApiProjectManagementRoutes(router: express.Router, context: ApiRouterContext) {
  router.get("/project-management/documents/stream", async (_req, res, next) => {
    try {
      let currentDocuments = await listProjectManagementDocuments(context.repoRoot);
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

      const writeEvent = (type: ProjectManagementDocumentsStreamEvent["type"], documents: ProjectManagementListResponse) => {
        if (isStreamClosed()) {
          return;
        }

        const event: ProjectManagementDocumentsStreamEvent = { type, documents };
        try {
          const payload = JSON.stringify(event);
          res.write(`data: ${payload}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentDocuments);

      const rebuildAndEmit = () => {
        if (rebuilding || isStreamClosed()) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          const nextDocuments = await listProjectManagementDocuments(context.repoRoot);
          if (isStreamClosed()) {
            return;
          }

          currentDocuments = nextDocuments;
          writeEvent("update", nextDocuments);
        }).catch((error) => {
          logServerEvent("project-management-documents-stream", "rebuild-failed", {
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToProjectManagementDocumentsRefresh(rebuildAndEmit);
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

  router.get("/project-management/documents", async (_req, res, next) => {
    try {
      const payload: ProjectManagementListResponse = await listProjectManagementDocuments(context.repoRoot);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents/:id", async (req, res, next) => {
    try {
      const payload: ProjectManagementDocumentResponse = await getProjectManagementDocument(
        context.repoRoot,
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
        context.repoRoot,
        decodeURIComponent(req.params.id),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const body = req.body as CreateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      let payload: ProjectManagementDocumentResponse = await createProjectManagementDocument(context.repoRoot, {
        title: body.title,
        summary: typeof body.summary === "string" ? body.summary : undefined,
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
        dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((entry) => String(entry)) : [],
        status: typeof body.status === "string" ? body.status : undefined,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      });

      if (!payload.document.summary) {
        const relatedDocuments = (await listProjectManagementDocuments(context.repoRoot)).documents;
        const generatedSummary = await generateProjectManagementDocumentSummary({
          repoRoot: context.repoRoot,
          config,
          document: payload.document,
          relatedDocuments,
        });

        if (generatedSummary) {
          await updateProjectManagementDocument(context.repoRoot, payload.document.id, {
            title: payload.document.title,
            summary: generatedSummary,
            markdown: payload.document.markdown,
            tags: payload.document.tags,
            dependencies: payload.document.dependencies,
            status: payload.document.status,
            assignee: payload.document.assignee,
            archived: payload.document.archived,
          });
          payload = await getProjectManagementDocument(context.repoRoot, payload.document.id);
        }
      }

      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/updates", async (req, res, next) => {
    const startedAt = Date.now();
    const documentId = decodeURIComponent(req.params.id);
    try {
      const body = req.body as UpdateProjectManagementDocumentRequest;
      logServerEvent("project-management-update-route", "started", {
        documentId,
        hasTitle: typeof body?.title === "string",
        hasSummary: typeof body?.summary === "string",
        hasMarkdown: typeof body?.markdown === "string",
        hasTags: Array.isArray(body?.tags),
        hasDependencies: Array.isArray(body?.dependencies),
        status: typeof body?.status === "string" ? body.status : undefined,
      });
      const payload: ProjectManagementDocumentSummaryResponse = await updateProjectManagementDocument(
        context.repoRoot,
        documentId,
        {
          title: typeof body.title === "string" ? body.title : undefined,
          summary: typeof body.summary === "string" ? body.summary : undefined,
          markdown: typeof body.markdown === "string" ? body.markdown : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : undefined,
          dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((entry) => String(entry)) : undefined,
          status: typeof body.status === "string" ? body.status : undefined,
          assignee: typeof body.assignee === "string" ? body.assignee : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
        },
      );
      logServerEvent("project-management-update-route", "completed", {
        documentId,
        duration: formatDurationMs(Date.now() - startedAt),
        status: payload.document.status,
      });
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.json(payload);
    } catch (error) {
      logServerEvent("project-management-update-route", "failed", {
        documentId,
        duration: formatDurationMs(Date.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      }, "error");
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

        const payload: ProjectManagementBatchResponse = await appendProjectManagementBatch(context.repoRoot, {
          entries: body.entries.map((entry) => ({
            documentId: typeof entry.documentId === "string" ? entry.documentId : undefined,
            title: typeof entry.title === "string" ? entry.title : undefined,
            summary: typeof entry.summary === "string" ? entry.summary : undefined,
            markdown: typeof entry.markdown === "string" ? entry.markdown : undefined,
            tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag)) : undefined,
            dependencies: Array.isArray(entry.dependencies) ? entry.dependencies.map((dependencyId) => String(dependencyId)) : undefined,
            status: typeof entry.status === "string" ? entry.status : undefined,
            assignee: typeof entry.assignee === "string" ? entry.assignee : undefined,
            archived: typeof entry.archived === "boolean" ? entry.archived : undefined,
        })),
      });
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/dependencies", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementDependenciesRequest;
      const payload: ProjectManagementDocumentSummaryResponse = await updateProjectManagementDependencies(
        context.repoRoot,
        decodeURIComponent(req.params.id),
        Array.isArray(body?.dependencyIds) ? body.dependencyIds.map((entry) => String(entry)) : [],
      );
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/status", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementStatusRequest;
      if (!body?.status?.trim()) {
        res.status(400).json({ message: "Document status is required." });
        return;
      }

      const payload: ProjectManagementDocumentSummaryResponse = await updateProjectManagementStatus(
        context.repoRoot,
        decodeURIComponent(req.params.id),
        body.status,
      );
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/comments", async (req, res, next) => {
    try {
      const body = req.body as AddProjectManagementCommentRequest;
      if (!body?.body?.trim()) {
        res.status(400).json({ message: "Comment body is required." });
        return;
      }

      const payload: ProjectManagementDocumentSummaryResponse = await addProjectManagementComment(
        context.repoRoot,
        decodeURIComponent(req.params.id),
        { body: body.body },
      );
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/ai-command/run", async (req, res, next) => {
    let worktree: WorktreeRecord | null = null;
    let worktreePath = "";
    let branch = "";
    let input = "";
    let commandId: AiCommandId = "smart";
    let origin: AiCommandOrigin | null = null;
    let stopAutoStartedRuntimeOnError = false;

    try {
      const config = await context.loadCurrentConfig();
      const documentId = decodeURIComponent(req.params.id).trim();
      const body = req.body as RunProjectManagementDocumentAiRequest | undefined;
      const requestedChange = typeof body?.input === "string" ? body.input : null;
      const requestedOrigin = parseAiCommandOrigin(body?.origin);
      const requestedWorktreeStrategy = body?.worktreeStrategy === "continue-current"
        ? "continue-current"
        : "new";
      const requestedTargetBranch = typeof body?.targetBranch === "string" && body.targetBranch.trim()
        ? body.targetBranch.trim()
        : null;
      const requestedWorktreeName = typeof body?.worktreeName === "string" && body.worktreeName.trim()
        ? body.worktreeName.trim()
        : null;
      const documentPayload = await getProjectManagementDocument(context.repoRoot, documentId);
      const documentsPayload = await listProjectManagementDocuments(context.repoRoot);

      if (requestedWorktreeStrategy === "continue-current") {
        if (!requestedTargetBranch) {
          res.status(400).json({ message: "A linked worktree branch is required to continue current work." });
          return;
        }

        const existingWorktree = await context.findWorktree(requestedTargetBranch);
        if (!existingWorktree) {
          res.status(404).json({ message: `Unknown worktree ${requestedTargetBranch}` });
          return;
        }

        const requestedLink = await getWorktreeDocumentLink(context.repoRoot, existingWorktree.id);
        if (!requestedLink || requestedLink.documentId !== documentId) {
          res.status(404).json({ message: `No linked worktree ${requestedTargetBranch} exists for document ${documentId}.` });
          return;
        }

        worktree = existingWorktree;
        branch = existingWorktree.branch;
        worktreePath = existingWorktree.worktreePath;
      } else {
        branch = await resolveProjectManagementDocumentWorktreeBranch({
          repoRoot: context.repoRoot,
          baseDir: path.resolve(context.repoRoot, config.worktrees.baseDir),
          document: documentPayload.document,
          preferredName: requestedWorktreeName,
        });
      }

      commandId = resolveRequestedAiCommandId(body?.commandId, { documentId });
      const defaultOrigin = createProjectManagementDocumentOrigin({
        branch,
        worktreeId: worktree?.id,
        document: documentPayload.document,
        kind: "project-management-document-run",
        label: "Project management document run",
        viewMode: "document",
      });
      origin = requestedOrigin?.kind === "project-management-document-run"
        && requestedOrigin.location.tab === "project-management"
        ? {
            ...requestedOrigin,
            description: requestedOrigin.description?.trim() || defaultOrigin.description,
            location: {
              ...requestedOrigin.location,
              tab: "project-management",
              branch,
              worktreeId: worktree?.id,
              documentId: documentPayload.document.id,
              projectManagementSubTab: requestedOrigin.location.projectManagementSubTab ?? "document",
              projectManagementDocumentViewMode: requestedOrigin.location.projectManagementDocumentViewMode ?? "document",
            },
          }
        : defaultOrigin;

      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      if (!template) {
        await context.writeImmediateAiFailureLog({
          branch,
          documentId,
          commandId,
          origin,
          worktreePath: "",
          renderedCommand: template,
          input: documentId,
          error: new Error("AI Command is not configured."),
        });
        res.status(400).json({ message: "AI Command is not configured." });
        return;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        await context.writeImmediateAiFailureLog({
          branch,
          documentId,
          commandId,
          origin,
          worktreePath: "",
          renderedCommand: template,
          input: documentId,
          error: new Error("AI Command must include $WTM_AI_INPUT."),
        });
        res.status(400).json({ message: "AI Command must include $WTM_AI_INPUT." });
        return;
      }

      const worktreesBefore = await listWorktrees(context.repoRoot);
      worktree = worktreesBefore.find((entry) => entry.branch === branch) ?? null;
      let createdWorktreeForAiRun = false;
      if (!worktree) {
        worktree = await createWorktree(context.repoRoot, config, { branch });
        createdWorktreeForAiRun = true;
        const sourceRoot = await context.resolveEnvSyncSourceRoot(await listWorktrees(context.repoRoot));
        if (sourceRoot) {
          await syncEnvFiles(sourceRoot, worktree.worktreePath);
        }
      }

      await setWorktreeDocumentLink(context.repoRoot, {
        worktreeId: worktree.id,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        documentId,
      });

      worktreePath = worktree.worktreePath;
      branch = worktree.branch;
      origin = requestedOrigin?.kind === "project-management-document-run"
        && requestedOrigin.location.tab === "project-management"
        ? {
            ...requestedOrigin,
            description: requestedOrigin.description?.trim() || defaultOrigin.description,
            location: {
              ...requestedOrigin.location,
              tab: "project-management",
              branch,
              worktreeId: worktree.id,
              documentId: documentPayload.document.id,
              projectManagementSubTab: requestedOrigin.location.projectManagementSubTab ?? "document",
              projectManagementDocumentViewMode: requestedOrigin.location.projectManagementDocumentViewMode ?? "document",
            },
          }
        : createProjectManagementDocumentOrigin({
            branch,
            worktreeId: worktree.id,
            document: documentPayload.document,
            kind: "project-management-document-run",
            label: "Project management document run",
            viewMode: "document",
          });

      const existingAiJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
      if (
        requestedWorktreeStrategy === "continue-current"
        && existingAiJob?.status === "running"
        && existingAiJob.origin?.kind === "project-management-document-run"
        && existingAiJob.documentId === documentId
        && typeof existingAiJob.completedAt === "string"
      ) {
        await waitForAiCommandJob(context.repoRoot, worktree.id, existingAiJob.jobId).catch(() => null);
      }

      const latestAiJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
      const blocksProjectManagementContinuation = latestAiJob?.status === "running";

      if (blocksProjectManagementContinuation) {
        res.status(409).json({ message: `AI command already running for ${branch}.` });
        return;
      }

      const existingRuntime = await context.operationalState.getRuntimeById(worktree.id);
      if (!existingRuntime && createdWorktreeForAiRun) {
        await runStartupCommands(
          config.startupCommands,
          worktreePath,
          buildWorktreeProcessEnv(config, worktree),
        );
      }
      const runtime = existingRuntime ?? (config.aiCommands.autoStartRuntime ? await context.ensureWorktreeRuntime(config, worktree) : undefined);
      stopAutoStartedRuntimeOnError = !existingRuntime && runtime != null;
      const backgroundCommands = await listBackgroundCommands(config, context.repoRoot, worktree, runtime);
      const environmentContext = buildAiEnvironmentContext({
        repoRoot: context.repoRoot,
        config,
        branch,
        worktreePath,
        runtime,
        backgroundCommands,
      });
      input = buildProjectManagementExecutionAiPrompt({
        branch,
        worktreePath,
        environmentContext,
        document: documentPayload.document,
        relatedDocuments: documentsPayload.documents,
        requestedChange: requestedChange ?? undefined,
      });
      const env = buildAiCommandProcessEnv({
        repoRoot: context.repoRoot,
        worktreeId: worktree.id,
        documentId,
        worktreePath,
        env: runtime ? buildRuntimeProcessEnv(runtime) : { ...process.env },
      });

      const renderedCommand = renderAiCommand(template, input);
      const runDetails = {
        worktreeId: worktree.id,
        branch,
        documentId,
        sessionId: env.AI_SESSION_ID ?? null,
        commandId,
        aiCommands: config.aiCommands,
        origin,
        input,
        renderedCommand,
        worktreePath,
        env,
        commentDocumentId: documentId,
        commentRequestSummary: requestedChange,
        autoCommitDirtyWorktree: true,
      };
      const job = await (await context.startAiProcessJob(runDetails)).started;
      await context.addWorktreeAiStartedComment({
        branch,
        commandId,
        commentDocumentId: documentId,
        requestSummary: requestedChange,
      });
      await moveProjectManagementDocumentTowardInProgress(context.repoRoot, documentId);
      context.scheduleRuntimeStopAfterAiJob({
        worktree,
        jobId: job.jobId,
        shouldStopRuntime: stopAutoStartedRuntimeOnError,
      });
      stopAutoStartedRuntimeOnError = false;

      const payload: RunAiCommandResponse = { job, runtime };
      context.emitStateRefresh();
      context.emitProjectManagementDocumentsRefresh();
      context.emitSystemStatusRefresh();
      res.json(payload);
    } catch (error) {
      const cleanupWorktree = worktree;
      if (stopAutoStartedRuntimeOnError && cleanupWorktree) {
        await context.stopWorktreeRuntime(cleanupWorktree).catch((cleanupError) => {
          logServerEvent("ai-command", "runtime-stop-after-project-management-error-failed", {
            worktreeId: cleanupWorktree.id,
            branch,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }, "error");
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Unknown project management document ")) {
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree?.id,
          branch: branch || `pm-${sanitizeBranchName(decodeURIComponent(req.params.id)) || "document"}`,
          documentId: decodeURIComponent(req.params.id),
          commandId,
          origin,
          worktreePath,
          renderedCommand: "",
          input,
          error: new Error(message),
        });
        res.status(404).json({ message });
        return;
      }

      logServerEvent("project-management-ai", "request-failed", {
        documentId: req.params.id,
        branch,
        commandId,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      next(error);
    }
  });
}
