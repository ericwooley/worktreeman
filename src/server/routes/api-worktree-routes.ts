import express from "express";
import process from "node:process";
import type {
  AiCommandId,
  AiCommandOrigin,
  ProjectManagementDocumentResponse,
  ProjectManagementListResponse,
  CreateWorktreeRequest,
  DeleteWorktreeRequest,
  ReconnectTerminalResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  TmuxClientInfo,
  TmuxClientsStreamEvent,
  WorktreeRecord,
} from "../../shared/types.js";
import {
  parseAiCommandOrigin,
  resolveAiCommandTemplate,
} from "../../shared/ai-command-utils.js";
import { listBackgroundCommands } from "../services/background-command-service.js";
import {
  createWorktree,
  deleteBranch,
  listWorktrees,
  removeWorktree,
  validateDeleteWorktreeRequest,
} from "../services/git-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import {
  failAiCommandJob,
  getAiCommandJob,
  waitForAiCommandJob,
} from "../services/ai-command-service.js";
import {
  getProjectManagementDocument,
  listProjectManagementDocuments,
} from "../services/project-management-service.js";
import { buildRuntimeProcessEnv } from "../services/runtime-service.js";
import {
  disconnectTmuxClient,
  ensureTerminalSession,
  listTmuxClients,
} from "../services/terminal-service.js";
import {
  clearWorktreeDocumentLink,
  getWorktreeDocumentLink,
  setWorktreeDocumentLink,
} from "../services/worktree-link-service.js";
import { logServerEvent } from "../utils/server-logger.js";
import {
  appendAiCommandOutputEvents,
  buildAiEnvironmentContext,
  buildProjectManagementAiPrompt,
  buildWorktreeAiPrompt,
  createProjectManagementDocumentOrigin,
  createWorktreeEnvironmentOrigin,
  formatLogSnippet,
  isAiCommandLogActivelyRunning,
  listAiCommandLogEntries,
  readAiCommandLogEntryByJobId,
  reconcileAiCommandLogEntry,
  renderAiCommand,
  resolveRequestedAiCommandId,
  runBackgroundTask,
  safeWriteAiRequestLog,
  toRunningAiCommandJob,
} from "./api-helpers.js";
import type { ApiRouterContext } from "./api-router-context.js";

export function registerApiWorktreeRoutes(router: express.Router, context: ApiRouterContext) {
  const loadTmuxClients = async (branch: string) => {
    const worktree = await context.findWorktree(branch);
    if (!worktree) {
      return null;
    }

    const runtime = await context.operationalState.getRuntimeById(worktree.id);
    const tmuxSession = await ensureTerminalSession({
      repoRoot: context.repoRoot,
      id: worktree.id,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      runtime: runtime ?? undefined,
    });

    const clients = await listTmuxClients({
      tmuxSession,
      worktreePath: worktree.worktreePath,
    });

    return {
      worktree,
      runtime: runtime ?? undefined,
      tmuxSession,
      clients,
    };
  };

  router.get("/worktrees/:branch/ai-command/stream", async (req, res, next) => {
    try {
      const branch = req.params.branch;
      const worktree = await context.findWorktree(branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      let currentJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
      let lastPayload = JSON.stringify(currentJob);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();
      let closed = false;
      let interval: ReturnType<typeof setInterval>;
      let keepAlive: ReturnType<typeof setInterval>;

      const isStreamClosed = () => closed || req.destroyed || res.destroyed || res.writableEnded;

      const closeStream = () => {
        if (closed) {
          return;
        }

        closed = true;
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

      const writeEvent = (type: "snapshot" | "update", job: typeof currentJob) => {
        if (isStreamClosed()) {
          return;
        }
        const event = {
          type,
          job,
        };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentJob);

      let polling = false;
      interval = setInterval(() => {
        if (polling || isStreamClosed()) {
          return;
        }

        polling = true;
        runBackgroundTask(async () => {
          const nextJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
          if (isStreamClosed()) {
            return;
          }
          currentJob = nextJob;
          const nextPayload = JSON.stringify(nextJob);
          if (nextPayload !== lastPayload) {
            lastPayload = nextPayload;
            writeEvent("update", nextJob);
          }
        }, (error) => {
          logServerEvent("ai-command-stream", "poll-failed", {
            branch,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          polling = false;
        });
      }, context.aiLogStreamPollIntervalMs);
      keepAlive = setInterval(() => {
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

  router.post("/worktrees", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const body = req.body as CreateWorktreeRequest;
      if (!body?.branch?.trim()) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const documentId = typeof body.documentId === "string" && body.documentId.trim()
        ? body.documentId.trim()
        : null;
      if (documentId) {
        try {
          await getProjectManagementDocument(context.repoRoot, documentId);
        } catch {
          res.status(404).json({ message: `Unknown project management document ${documentId}.` });
          return;
        }
      }

      const worktree = await createWorktree(context.repoRoot, config, body);
      if (documentId) {
        await setWorktreeDocumentLink(context.repoRoot, {
          worktreeId: worktree.id,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          documentId,
        });
      }
      const worktrees = await listWorktrees(context.repoRoot);
      const sourceRoot = await context.resolveEnvSyncSourceRoot(worktrees);

      if (sourceRoot) {
        const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
        context.emitStateRefresh();
        res.status(201).json(result);
        return;
      }

      context.emitStateRefresh();
      res.status(201).json({ copiedFiles: [] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/start", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await context.ensureWorktreeRuntime(config, worktree);
      res.json(runtime);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/env/sync", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(context.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const sourceRoot = await context.resolveEnvSyncSourceRoot(worktrees);

      if (!sourceRoot) {
        res.status(404).json({ message: `Unable to locate the source config worktree for ${context.configSourceRef}.` });
        return;
      }

      const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
      context.emitStateRefresh();
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/ai-command/run", async (req, res, next) => {
    let worktree: WorktreeRecord | null = null;
    let input = "";
    let renderedCommand = "";
    let worktreePath = "";
    let commandId: AiCommandId = "smart";
    let origin: AiCommandOrigin | null = null;
    let branch = req.params.branch;
    let stopAutoStartedRuntimeOnError = false;
    let explicitDocumentPayload: ProjectManagementDocumentResponse | null = null;
    let documentsPayload: ProjectManagementListResponse | null = null;

    try {
      const config = await context.loadCurrentConfig();
      const worktrees = await listWorktrees(context.repoRoot);
      worktree = worktrees.find((entry) => entry.branch === req.params.branch) ?? null;
      const body = req.body as RunAiCommandRequest;
      input = typeof body?.input === "string" ? body.input : "";
      const explicitDocumentId = typeof body?.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : null;
      const requestedCommentDocumentId = typeof body?.commentDocumentId === "string" && body.commentDocumentId.trim()
        ? body.commentDocumentId.trim()
        : null;
      const requestedOrigin = parseAiCommandOrigin(body?.origin);

      if (!worktree) {
        await context.writeImmediateAiFailureLog({
          branch: req.params.branch,
          documentId: explicitDocumentId,
          commandId,
          origin: requestedOrigin,
          worktreePath: "",
          renderedCommand: "",
          input,
          error: new Error(`Unknown worktree ${req.params.branch}`),
        });
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const linkedDocumentId = explicitDocumentId
        ? null
        : (await getWorktreeDocumentLink(context.repoRoot, worktree.id))?.documentId ?? null;
      const documentId = explicitDocumentId ?? linkedDocumentId;
      const commentDocumentId = explicitDocumentId ? null : requestedCommentDocumentId ?? linkedDocumentId;
      commandId = resolveRequestedAiCommandId(body?.commandId, { documentId: explicitDocumentId });
      worktreePath = worktree.worktreePath;
      branch = worktree.branch;
      origin = requestedOrigin ?? createWorktreeEnvironmentOrigin(worktree.branch, worktree.id);

      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      if (!template) {
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree.id,
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI Command is not configured."),
        });
        res.status(400).json({ message: "AI Command is not configured." });
        return;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree.id,
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI Command must include $WTM_AI_INPUT."),
        });
        res.status(400).json({ message: "AI Command must include $WTM_AI_INPUT." });
        return;
      }

      if (!input.trim()) {
        await context.writeImmediateAiFailureLog({
          worktreeId: worktree.id,
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI command input is required."),
        });
        res.status(400).json({ message: "AI command input is required." });
        return;
      }

      if (explicitDocumentId) {
        try {
          explicitDocumentPayload = await getProjectManagementDocument(context.repoRoot, explicitDocumentId);
          documentsPayload = await listProjectManagementDocuments(context.repoRoot);
          origin = requestedOrigin ?? createProjectManagementDocumentOrigin({
            branch: worktree.branch,
            worktreeId: worktree.id,
            document: explicitDocumentPayload.document,
            kind: "project-management-document",
            label: "Project management document",
            viewMode: "edit",
          });
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          origin = {
            kind: "project-management-document",
            label: "Project management document",
            description: explicitDocumentId,
            location: {
              tab: "project-management",
              branch: worktree.branch,
              worktreeId: worktree.id,
              projectManagementSubTab: "document",
              documentId: explicitDocumentId,
              projectManagementDocumentViewMode: "edit",
            },
          };
          await context.writeImmediateAiFailureLog({
            worktreeId: worktree.id,
            branch: worktree.branch,
            documentId: explicitDocumentId,
            commandId,
            origin,
            worktreePath,
            renderedCommand: template,
            input,
            error: reason,
          });
          res.status(404).json({ message: `Unknown project management document ${explicitDocumentId}.` });
          return;
        }
      }

      if ((await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions))?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${worktree.branch}.` });
        return;
      }

      const existingRuntime = await context.operationalState.getRuntimeById(worktree.id);
      const runtime = existingRuntime ?? (config.aiCommands.autoStartRuntime ? await context.ensureWorktreeRuntime(config, worktree) : undefined);
      stopAutoStartedRuntimeOnError = !existingRuntime && runtime != null;
      const backgroundCommands = await listBackgroundCommands(config, context.repoRoot, worktree, runtime);
      const environmentContext = buildAiEnvironmentContext({
        repoRoot: context.repoRoot,
        config,
        branch: worktree.branch,
        worktreePath,
        runtime,
        backgroundCommands,
      });

      if (explicitDocumentId && explicitDocumentPayload && documentsPayload) {
        input = buildProjectManagementAiPrompt({
          branch: worktree.branch,
          worktreePath,
          requestedChange: input.trim(),
          environmentContext,
          document: explicitDocumentPayload.document,
          relatedDocuments: documentsPayload.documents,
        });
      }

      logServerEvent("ai-command", "request-started", {
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        documentId,
        commandId,
        origin: origin?.kind ?? null,
        input: formatLogSnippet(input),
      });

      if (!explicitDocumentId) {
        input = buildWorktreeAiPrompt({
          request: input,
          environmentContext,
        });
      }

      const env = runtime ? buildRuntimeProcessEnv(runtime) : { ...process.env };

      renderedCommand = renderAiCommand(template, input);
      const runDetails = {
        worktreeId: worktree.id,
        branch: worktree.branch,
        documentId,
        commandId,
        aiCommands: config.aiCommands,
        origin,
        input,
        renderedCommand,
        worktreePath,
        env,
        applyDocumentUpdateToDocumentId: explicitDocumentId,
        commentDocumentId,
        commentRequestSummary: explicitDocumentId ? null : body.input,
        autoCommitDirtyWorktree: true,
      };
      const job = explicitDocumentId
        ? context.hasInjectedAiProcesses
          ? await (await context.startAiProcessJob(runDetails)).started
          : await context.enqueueProjectManagementDocumentAiJob({
              worktreeId: runDetails.worktreeId,
              branch: runDetails.branch,
              documentId: explicitDocumentId,
              commandId: runDetails.commandId,
              aiCommands: runDetails.aiCommands,
              origin: runDetails.origin,
              input: runDetails.input,
              renderedCommand: runDetails.renderedCommand,
              worktreePath: runDetails.worktreePath,
              env: runDetails.env,
              applyDocumentUpdateToDocumentId: runDetails.applyDocumentUpdateToDocumentId,
              commentDocumentId: runDetails.commentDocumentId,
              commentRequestSummary: runDetails.commentRequestSummary,
              autoCommitDirtyWorktree: runDetails.autoCommitDirtyWorktree,
            })
        : await (await context.startAiProcessJob(runDetails)).started;
      await context.addWorktreeAiStartedComment({
        branch: runDetails.branch,
        commandId: runDetails.commandId,
        commentDocumentId: runDetails.commentDocumentId,
        requestSummary: runDetails.commentRequestSummary,
      });
      context.scheduleRuntimeStopAfterAiJob({
        worktree,
        jobId: job.jobId,
        shouldStopRuntime: stopAutoStartedRuntimeOnError,
      });
      stopAutoStartedRuntimeOnError = false;

      const payload: RunAiCommandResponse = { job, runtime };
      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      const cleanupWorktree = worktree;
      if (stopAutoStartedRuntimeOnError && cleanupWorktree) {
        await context.stopWorktreeRuntime(cleanupWorktree).catch((cleanupError) => {
          logServerEvent("ai-command", "runtime-stop-after-request-error-failed", {
            worktreeId: cleanupWorktree.id,
            branch,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }, "error");
        });
      }

      logServerEvent("ai-command", "request-failed", {
        branch: req.params.branch,
        commandId,
        origin: origin?.kind ?? null,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      next(error);
    }
  });

  router.post("/worktrees/:branch/ai-command/cancel", async (req, res, next) => {
    try {
      const worktree = await context.findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}.` });
        return;
      }

      const inMemoryJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
      const persistedLog = (await Promise.all(
        (await listAiCommandLogEntries(context.repoRoot)).map((entry) => reconcileAiCommandLogEntry({
          entry,
          repoRoot: context.repoRoot,
          aiProcesses: context.passiveAiProcesses,
          reconcileJobs: context.shouldReconcileAiJobs,
        })),
      )).find((entry) => entry.worktreeId === worktree.id && isAiCommandLogActivelyRunning(entry)) ?? null;

      const job = inMemoryJob?.status === "running"
        ? inMemoryJob
        : persistedLog
          ? toRunningAiCommandJob(persistedLog)
          : null;

      if (!job || job.status !== "running") {
        res.status(404).json({ message: `No running AI command for ${req.params.branch}.` });
        return;
      }

      if (!job.processName) {
        res.status(409).json({ message: `Running AI command for ${req.params.branch} cannot be cancelled yet.` });
        return;
      }

      await context.executionAiProcesses.deleteProcess(job.processName);

      const cancellationMessage = "AI process exited with code unknown. Cancellation requested by the user.";
      const failedJob = inMemoryJob?.status === "running"
        ? await failAiCommandJob({
            repoRoot: context.repoRoot,
            worktreeId: worktree.id,
            jobId: job.jobId,
            error: cancellationMessage,
            outputEvents: appendAiCommandOutputEvents(job.jobId, job.outputEvents, "stderr", cancellationMessage),
          })
        : null;

      if (failedJob) {
        await safeWriteAiRequestLog({
          fileName: failedJob.fileName,
          jobId: failedJob.jobId,
          repoRoot: context.repoRoot,
          worktreeId: failedJob.worktreeId,
          branch: failedJob.branch,
          documentId: failedJob.documentId ?? null,
          commandId: failedJob.commandId,
          origin: failedJob.origin ?? null,
          worktreePath: persistedLog?.worktreePath ?? worktree.worktreePath,
          renderedCommand: failedJob.command,
          input: failedJob.input,
          stdout: failedJob.stdout,
          stderr: failedJob.stderr,
          events: failedJob.outputEvents,
          startedAt: failedJob.startedAt,
          completedAt: failedJob.completedAt,
          pid: failedJob.pid ?? null,
          exitCode: failedJob.exitCode ?? null,
          processName: failedJob.processName,
          error: failedJob.error ? new Error(failedJob.error) : null,
        });
      } else if (persistedLog) {
        await safeWriteAiRequestLog({
          fileName: persistedLog.fileName,
          jobId: persistedLog.jobId,
          repoRoot: context.repoRoot,
          worktreeId: persistedLog.worktreeId,
          branch: persistedLog.branch,
          documentId: persistedLog.documentId ?? null,
          commandId: persistedLog.commandId,
          origin: persistedLog.origin ?? null,
          worktreePath: persistedLog.worktreePath,
          renderedCommand: persistedLog.command,
          input: persistedLog.request,
          stdout: persistedLog.response.stdout,
          stderr: `${persistedLog.response.stderr}${cancellationMessage}`,
          events: appendAiCommandOutputEvents(persistedLog.jobId, persistedLog.response.events, "stderr", cancellationMessage),
          startedAt: persistedLog.timestamp,
          completedAt: new Date().toISOString(),
          pid: persistedLog.pid ?? null,
          exitCode: persistedLog.exitCode ?? null,
          processName: persistedLog.processName,
          error: new Error(cancellationMessage),
        });
      }

      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const settledJob = await Promise.race([
        waitForAiCommandJob(context.repoRoot, worktree.id, job.jobId),
        new Promise<typeof job>((resolve) => {
          fallbackTimer = setTimeout(() => {
            runBackgroundTask(async () => {
              try {
                const nextInMemoryJob = await getAiCommandJob(context.repoRoot, worktree.id, context.aiJobReadOptions);
                if (nextInMemoryJob) {
                  resolve(nextInMemoryJob);
                  return;
                }

                if (persistedLog) {
                  const nextLog = await context.loadResolvedAiLog(persistedLog.jobId);
                  resolve(toRunningAiCommandJob(nextLog));
                  return;
                }

                resolve(job);
              } catch {
                resolve(job);
              }
            }, () => {
              resolve(job);
            });
          }, Math.max(context.aiProcessPollIntervalMs * 4, 500));
        }),
      ]);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }

      const finalJob = failedJob ?? settledJob;
      try {
        const resolvedLog = await readAiCommandLogEntryByJobId(context.repoRoot, finalJob.jobId);
        const hasCancellationEvent = resolvedLog.response.events?.some(
          (event) => event.source === "stderr" && /Cancellation requested by the user/.test(event.text),
        ) ?? false;
        const nextStderr = /Cancellation requested by the user/.test(resolvedLog.response.stderr)
          ? resolvedLog.response.stderr
          : `${resolvedLog.response.stderr}${cancellationMessage}`;
        await safeWriteAiRequestLog({
          fileName: resolvedLog.fileName,
          jobId: resolvedLog.jobId,
          repoRoot: context.repoRoot,
          worktreeId: resolvedLog.worktreeId,
          branch: resolvedLog.branch,
          documentId: resolvedLog.documentId ?? null,
          commandId: resolvedLog.commandId,
          origin: resolvedLog.origin ?? null,
          worktreePath: resolvedLog.worktreePath,
          renderedCommand: resolvedLog.command,
          input: resolvedLog.request,
          stdout: resolvedLog.response.stdout,
          stderr: nextStderr,
          events: hasCancellationEvent
            ? resolvedLog.response.events
            : appendAiCommandOutputEvents(resolvedLog.jobId, resolvedLog.response.events, "stderr", cancellationMessage),
          startedAt: resolvedLog.timestamp,
          completedAt: resolvedLog.completedAt ?? finalJob.completedAt ?? new Date().toISOString(),
          pid: finalJob.pid ?? resolvedLog.pid ?? null,
          exitCode: finalJob.exitCode ?? resolvedLog.exitCode ?? null,
          processName: finalJob.processName ?? resolvedLog.processName ?? null,
          error: new Error(cancellationMessage),
        });
      } catch {
        // Best-effort persistence only; the cancellation response should still succeed.
      }

      const payload: RunAiCommandResponse = { job: finalJob };
      context.emitStateRefresh();
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/stop", async (req, res, next) => {
    try {
      const worktree = await context.findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await context.operationalState.getRuntimeById(worktree.id);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await context.stopWorktreeRuntime(worktree);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/restart", async (req, res, next) => {
    try {
      const config = await context.loadCurrentConfig();
      const worktree = await context.findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await context.restartWorktreeRuntime(config, worktree);
      context.emitSystemStatusRefresh();
      res.json(runtime);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/reconnect", async (req, res, next) => {
    try {
      const payloadSource = await loadTmuxClients(req.params.branch);
      if (!payloadSource) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const payload: ReconnectTerminalResponse = {
        tmuxSession: payloadSource.tmuxSession,
        clients: payloadSource.clients,
        runtime: payloadSource.runtime,
      };
      context.emitTmuxClientsRefresh(payloadSource.worktree.branch);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients/stream", async (req, res, next) => {
    try {
      const branch = req.params.branch;
      const initialPayload = await loadTmuxClients(branch);
      if (!initialPayload) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      let currentClients = initialPayload.clients;
      let lastPayload = JSON.stringify(currentClients);
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

      const writeEvent = (type: TmuxClientsStreamEvent["type"], clients: TmuxClientInfo[]) => {
        if (isStreamClosed()) {
          return;
        }

        const event: TmuxClientsStreamEvent = { type, branch, clients };
        try {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        } catch {
          closeStream();
        }
      };

      writeEvent("snapshot", currentClients);

      const rebuildAndEmit = () => {
        if (rebuilding || isStreamClosed()) {
          return;
        }

        rebuilding = true;
        void Promise.resolve().then(async () => {
          const nextPayload = await loadTmuxClients(branch);
          if (!nextPayload || isStreamClosed()) {
            return;
          }

          currentClients = nextPayload.clients;
          const nextSerialized = JSON.stringify(nextPayload.clients);
          if (nextSerialized !== lastPayload) {
            lastPayload = nextSerialized;
            writeEvent("update", nextPayload.clients);
          }
        }).catch((error) => {
          logServerEvent("tmux-clients-stream", "rebuild-failed", {
            branch,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        }).finally(() => {
          rebuilding = false;
        });
      };

      const unsubscribe = context.subscribeToTmuxClientsRefresh(branch, rebuildAndEmit);
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

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const payload = await loadTmuxClients(req.params.branch);
      if (!payload) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      res.json(payload.clients);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/tmux-clients/:clientId/disconnect", async (req, res, next) => {
    try {
      const worktree = await context.findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      await disconnectTmuxClient({ worktreePath: worktree.worktreePath }, decodeURIComponent(req.params.clientId));
      context.emitTmuxClientsRefresh(worktree.branch);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/worktrees/:branch", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(context.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const request: DeleteWorktreeRequest = {
        confirmWorktreeName: typeof req.body?.confirmWorktreeName === "string" ? req.body.confirmWorktreeName : undefined,
        deleteBranch: typeof req.body?.deleteBranch === "boolean" ? req.body.deleteBranch : true,
      };
      const deletion = await context.buildDeletionState(worktree);
      try {
        validateDeleteWorktreeRequest(worktree, deletion, request);
      } catch (error) {
        res.status(await context.getRunningAiJobForBranch(worktree) ? 409 : 400).json({
          message: error instanceof Error ? error.message : "Invalid delete request.",
        });
        return;
      }

      await context.stopWorktreeRuntime(worktree);

      await removeWorktree(context.repoRoot, worktree.worktreePath);
      await clearWorktreeDocumentLink(context.repoRoot, worktree.id);
      if (request.deleteBranch) {
        await deleteBranch(context.repoRoot, worktree.branch);
      }
      context.emitStateRefresh();
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });
}
