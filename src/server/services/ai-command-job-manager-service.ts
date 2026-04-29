import { PgBoss, type JobWithMetadata } from "pg-boss";
import type { AiCommandConfig, AiCommandId, AiCommandJob, AiCommandOrigin } from "../../shared/types.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import { readAiSessionIdFromEnv } from "../routes/api-helpers.js";
import { AI_COMMAND_STARTUP_RECONCILE_FAILURE_REASON } from "../../shared/ai-command-utils.js";
import { beginAiCommandJob, continueAiCommandJob, getAiCommandJob, listAiCommandJobs, type StartedAiCommandJob } from "./ai-command-service.js";
import { closeManagedDatabaseClient, getManagedDatabaseClient } from "./database-client-service.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";
import { getAiCommandProcessName, startAiCommandProcess, waitForAiCommandProcess } from "./ai-command-process-service.js";
import { completeAiCommandRun } from "./ai-command-completion-service.js";

const PROJECT_MANAGEMENT_AI_QUEUE = "project-management-ai-update";
const DEFAULT_JOB_POLL_INTERVAL_SECONDS = 0.5;

function resolveJobPollIntervalSeconds(): number {
  const raw = process.env.WTM_AI_JOB_POLL_INTERVAL_SECONDS;
  if (!raw) {
    return DEFAULT_JOB_POLL_INTERVAL_SECONDS;
  }
  const parsed = Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JOB_POLL_INTERVAL_SECONDS;
  }
  return parsed;
}

function isInlineJobMode(): boolean {
  return process.env.WTM_AI_JOB_INLINE === "1";
}
export interface ProjectManagementAiQueuePayload {
  jobId?: string;
  worktreeId: WorktreeId;
  branch: string;
  commandId: AiCommandId;
  worktreePath: string;
  input: string;
  renderedCommand: string;
  executionCommand?: string;
  env: Record<string, string>;
  aiCommands: AiCommandConfig;
  documentId: string;
  origin?: AiCommandOrigin | null;
  applyDocumentUpdateToDocumentId?: string | null;
  reviewDocumentId?: string | null;
  reviewRequestSummary?: string | null;
  reviewAction?: "implement" | "review" | null;
  autoCommitDirtyWorktree?: boolean;
}

interface ManagedAiCommandJobQueue {
  boss: PgBoss | null;
  workerId: string | null;
  readyPromise: Promise<void>;
  activeJobs: Set<Promise<void>>;
  inline: boolean;
  inlineHandler: ((payload: ProjectManagementAiQueuePayload) => Promise<void>) | null;
}

const managedQueues = new Map<string, ManagedAiCommandJobQueue>();

async function shutdownManager(repoRoot: string, manager: ManagedAiCommandJobQueue, removeFromMap = true) {
  if (removeFromMap) {
    managedQueues.delete(repoRoot);
  }

  if (manager.workerId && manager.boss) {
    await manager.boss.offWork(PROJECT_MANAGEMENT_AI_QUEUE, { id: manager.workerId, wait: true }).catch(() => undefined);
    manager.workerId = null;
  }
  manager.inlineHandler = null;

  if (manager.activeJobs.size > 0) {
    await Promise.allSettled(Array.from(manager.activeJobs));
  }

  const shutdownTasks: Promise<unknown>[] = [
    closeManagedDatabaseClient(repoRoot, "jobs"),
  ];
  if (manager.boss) {
    shutdownTasks.unshift(manager.boss.stop());
  }
  await Promise.allSettled(shutdownTasks);
}

function summarizeQueuePayload(payload: ProjectManagementAiQueuePayload) {
  return {
    worktreeId: payload.worktreeId,
    branch: payload.branch,
    documentId: payload.documentId,
    commandId: payload.commandId,
    origin: payload.origin?.kind ?? null,
    worktreePath: payload.worktreePath,
  };
}

function describeError(error: unknown) {
  if (error instanceof Error) {
    const errorWithCause = error as Error & { cause?: unknown };
    return {
      error: error.message,
      errorName: error.name,
      stack: error.stack,
      cause: errorWithCause.cause instanceof Error ? errorWithCause.cause.message : errorWithCause.cause,
    };
  }

  return {
    error: String(error),
  };
}

function isQueuedProjectManagementJob(queueJob: JobWithMetadata<ProjectManagementAiQueuePayload>): boolean {
  return queueJob.state === "created" || queueJob.state === "retry";
}

async function hasQueuedProjectManagementJob(manager: ManagedAiCommandJobQueue, jobId: string): Promise<boolean> {
  if (manager.inline || !manager.boss) {
    return false;
  }

  const queueJobs = await manager.boss.findJobs<ProjectManagementAiQueuePayload>(PROJECT_MANAGEMENT_AI_QUEUE, {
    data: { jobId },
  });

  return queueJobs.some((queueJob) => queueJob.data?.jobId === jobId && isQueuedProjectManagementJob(queueJob));
}

async function reconcileRunningAiJobsOnStartup(repoRoot: string, manager: ManagedAiCommandJobQueue): Promise<void> {
  const persistedJobs = await listAiCommandJobs(repoRoot, { reconcile: false });
  const runningJobs = persistedJobs.filter((job) => job.status === "running");

  if (runningJobs.length === 0) {
    return;
  }

  let keptQueued = 0;
  let reconciled = 0;
  let failed = 0;

  for (const job of runningJobs) {
    try {
      if (await hasQueuedProjectManagementJob(manager, job.jobId)) {
        keptQueued += 1;
        continue;
      }

      const nextJob = await getAiCommandJob(repoRoot, job.worktreeId, {
        treatProcessNameAsObserved: true,
        missingProcessFailureReason: AI_COMMAND_STARTUP_RECONCILE_FAILURE_REASON,
      });
      if (nextJob?.status !== job.status || nextJob?.exitCode !== job.exitCode || nextJob?.pid !== job.pid) {
        reconciled += 1;
      }
    } catch (error) {
      failed += 1;
      logServerEvent("ai-job-queue", "startup-reconcile-job-failed", {
        repoRoot,
        jobId: job.jobId,
        worktreeId: job.worktreeId,
        branch: job.branch,
        ...describeError(error),
      }, "error");
    }
  }

  logServerEvent("ai-job-queue", "startup-reconcile-complete", {
    repoRoot,
    runningJobs: runningJobs.length,
    keptQueued,
    reconciled,
    failed,
  }, failed > 0 ? "warn" : "info");
}

async function runManagedAiProcess(options: {
  repoRoot: string;
  jobId: string;
  payload: ProjectManagementAiQueuePayload;
}): Promise<StartedAiCommandJob> {
  return await continueAiCommandJob({
    repoRoot: options.repoRoot,
    worktreeId: options.payload.worktreeId,
    jobId: options.jobId,
    execute: async (payload) => {
      const processName = getAiCommandProcessName(payload.jobId);
      const processInfo = await startAiCommandProcess({
        processName,
        command: options.payload.executionCommand ?? options.payload.renderedCommand,
        input: options.payload.input,
        worktreePath: options.payload.worktreePath,
        env: options.payload.env,
        hooks: payload.hooks,
      });

      await payload.hooks.onSpawn?.({
        pid: processInfo.pid ?? null,
        processName,
      });

      const completedProcess = await waitForAiCommandProcess(processName);
      if (!completedProcess) {
        await payload.hooks.onExit?.({ exitCode: null });
        throw new Error("AI process no longer available.");
      }

      await payload.hooks.onExit?.({ exitCode: completedProcess.exitCode ?? null });
      if ((completedProcess.exitCode ?? 0) !== 0) {
        throw new Error(`AI process exited with code ${completedProcess.exitCode ?? "unknown"}.`);
      }
    },
    onComplete: async ({ stdout, stderr }) => {
      await completeAiCommandRun({
        repoRoot: options.repoRoot,
        branch: options.payload.branch,
        commandId: options.payload.commandId,
        aiCommands: options.payload.aiCommands,
        env: options.payload.env,
        stdout,
        stderr,
        applyDocumentUpdateToDocumentId: options.payload.applyDocumentUpdateToDocumentId,
        reviewDocumentId: options.payload.reviewDocumentId,
        reviewRequestSummary: options.payload.reviewRequestSummary,
        reviewAction: options.payload.reviewAction,
        autoCommitDirtyWorktree: options.payload.autoCommitDirtyWorktree,
      });
    },
  });
}

async function processProjectManagementJob(repoRoot: string, payload: ProjectManagementAiQueuePayload): Promise<void> {
  if (!payload.jobId) {
    throw new Error("Queued project-management AI job is missing jobId.");
  }

  const started = await runManagedAiProcess({
    repoRoot,
    jobId: payload.jobId,
    payload,
  });
  await started.completed;
}

async function ensureJobManager(repoRoot: string): Promise<ManagedAiCommandJobQueue> {
  const existing = managedQueues.get(repoRoot);
  if (existing) {
    await existing.readyPromise;
    return existing;
  }

  const inline = isInlineJobMode();

  if (inline) {
    const managed: ManagedAiCommandJobQueue = {
      boss: null,
      workerId: null,
      activeJobs: new Set(),
      inline: true,
      inlineHandler: null,
      readyPromise: (async () => {
        logServerEvent("ai-job-queue", "manager-ready", {
          repoRoot,
          queue: PROJECT_MANAGEMENT_AI_QUEUE,
          inline: true,
        });
      })(),
    };
    managedQueues.set(repoRoot, managed);
    await managed.readyPromise;
    return managed;
  }

  const db = await getManagedDatabaseClient(repoRoot, "jobs");
  const boss = new PgBoss({
    db: {
      executeSql: (text, values) => db.executeSql(text, values),
    },
    schema: "pgboss",
    // This worker instance only needs enqueue/dequeue semantics. Disable pg-boss
    // supervision here to avoid its monitor loop crashing the worker process.
    supervise: false,
    schedule: false,
    createSchema: true,
    migrate: true,
  });

  const managed: ManagedAiCommandJobQueue = {
    boss,
    workerId: null,
    activeJobs: new Set(),
    inline: false,
    inlineHandler: null,
    readyPromise: (async () => {
      boss.on("error", (error) => {
        logServerEvent("ai-job-queue", "pg-boss-error", {
          repoRoot,
          ...describeError(error),
        }, "error");
      });
      await boss.start();
      await boss.createQueue(PROJECT_MANAGEMENT_AI_QUEUE);
      logServerEvent("ai-job-queue", "manager-ready", {
        repoRoot,
        queue: PROJECT_MANAGEMENT_AI_QUEUE,
        supervise: false,
        schedule: false,
      });
    })(),
  };

  managedQueues.set(repoRoot, managed);

  try {
    await managed.readyPromise;
    return managed;
  } catch (error) {
    managedQueues.delete(repoRoot);
    await Promise.allSettled([boss.stop(), closeManagedDatabaseClient(repoRoot, "jobs")]);
    throw error;
  }
}

export async function enqueueProjectManagementAiJob(options: {
  repoRoot: string;
  payload: ProjectManagementAiQueuePayload;
}): Promise<AiCommandJob> {
  const enqueueStartedAt = Date.now();
  const manager = await ensureJobManager(options.repoRoot);
  const job = await beginAiCommandJob({
    repoRoot: options.repoRoot,
    worktreeId: options.payload.worktreeId,
    branch: options.payload.branch,
    sessionId: readAiSessionIdFromEnv(options.payload.env),
    documentId: options.payload.documentId,
    commandId: options.payload.commandId,
    origin: options.payload.origin ?? null,
    input: options.payload.input,
    command: options.payload.renderedCommand,
    worktreePath: options.payload.worktreePath,
  });

  const fullPayload = { ...options.payload, jobId: job.jobId };

  if (manager.inline) {
    const handler = manager.inlineHandler;
    if (!handler) {
      throw new Error("Inline AI job mode requires a worker to be registered before enqueueing.");
    }

    const inlineJobId = `inline-${job.jobId}`;
    logServerEvent("ai-job-queue", "enqueued", {
      repoRoot: options.repoRoot,
      queueJobId: inlineJobId,
      inline: true,
      ...summarizeQueuePayload(fullPayload),
      duration: formatDurationMs(Date.now() - enqueueStartedAt),
    });

    // Dispatch asynchronously so the HTTP request returns before the handler runs.
    const activeJob = (async () => {
      // Yield once so the caller's Promise resolves first; preserves the
      // real queue's semantics where the worker runs after enqueue returns.
      await Promise.resolve();
      await handler(fullPayload);
    })();
    manager.activeJobs.add(activeJob);
    activeJob.finally(() => {
      manager.activeJobs.delete(activeJob);
    }).catch(() => undefined);

    return job;
  }

  if (!manager.boss) {
    throw new Error("AI job manager is missing a queue instance.");
  }

  const queueJobId = await manager.boss.send(PROJECT_MANAGEMENT_AI_QUEUE, fullPayload, { retryLimit: 0 });

  if (!queueJobId) {
    throw new Error("Failed to enqueue the project management AI job.");
  }

  logServerEvent("ai-job-queue", "enqueued", {
    repoRoot: options.repoRoot,
    queueJobId,
    ...summarizeQueuePayload(options.payload),
    duration: formatDurationMs(Date.now() - enqueueStartedAt),
  });

  return job;
}

export async function startProjectManagementAiWorker(options: { repoRoot: string }): Promise<{ close: () => Promise<void> }> {
  const manager = await ensureJobManager(options.repoRoot);
  const pollingIntervalSeconds = resolveJobPollIntervalSeconds();

  if (!manager.inline) {
    await reconcileRunningAiJobsOnStartup(options.repoRoot, manager);
  }

  const runHandler = async (queueJobId: string, payload: ProjectManagementAiQueuePayload) => {
    const startedAt = Date.now();
    logServerEvent("ai-job-queue", "dequeued", {
      repoRoot: options.repoRoot,
      queueJobId,
      ...summarizeQueuePayload(payload),
    });
    try {
      await processProjectManagementJob(options.repoRoot, payload);
      logServerEvent("ai-job-queue", "completed", {
        repoRoot: options.repoRoot,
        queueJobId,
        ...summarizeQueuePayload(payload),
        duration: formatDurationMs(Date.now() - startedAt),
      });
    } catch (error) {
      logServerEvent("ai-job-queue", "failed", {
        repoRoot: options.repoRoot,
        queueJobId,
        ...summarizeQueuePayload(payload),
        duration: formatDurationMs(Date.now() - startedAt),
        ...describeError(error),
      }, "error");
      throw error;
    }
  };

  if (manager.inline) {
    manager.inlineHandler = async (payload) => {
      const queueJobId = `inline-${payload.jobId ?? "unknown"}`;
      await runHandler(queueJobId, payload);
    };
    logServerEvent("ai-job-queue", "worker-ready", {
      repoRoot: options.repoRoot,
      queue: PROJECT_MANAGEMENT_AI_QUEUE,
      inline: true,
    });
    return {
      close: async () => {
        await shutdownManager(options.repoRoot, manager);
      },
    };
  }

  if (!manager.boss) {
    throw new Error("AI job manager is missing a queue instance.");
  }

  let workerId: string;

  try {
    workerId = await manager.boss.work<ProjectManagementAiQueuePayload>(
      PROJECT_MANAGEMENT_AI_QUEUE,
      { pollingIntervalSeconds },
      async (jobs) => {
        for (const job of jobs) {
          const activeJob = runHandler(job.id, job.data);
          manager.activeJobs.add(activeJob);
          try {
            await activeJob;
          } finally {
            manager.activeJobs.delete(activeJob);
          }
        }
      },
    );
  } catch (error) {
    logServerEvent("ai-job-queue", "worker-start-failed", {
      repoRoot: options.repoRoot,
      queue: PROJECT_MANAGEMENT_AI_QUEUE,
      pollingIntervalSeconds,
      ...describeError(error),
    }, "error");
    throw error;
  }

  manager.workerId = workerId;
  logServerEvent("ai-job-queue", "worker-ready", {
    repoRoot: options.repoRoot,
    queue: PROJECT_MANAGEMENT_AI_QUEUE,
    workerId,
    pollingIntervalSeconds,
  });

  return {
    close: async () => {
      await shutdownManager(options.repoRoot, manager);
    },
  };
}

export async function stopAllAiCommandJobManagers() {
  const entries = Array.from(managedQueues.entries());
  managedQueues.clear();

  await Promise.all(entries.map(async ([repoRoot, manager]) => {
    await shutdownManager(repoRoot, manager, false);
  }));
}

export async function stopAiCommandJobManager(repoRoot: string) {
  const manager = managedQueues.get(repoRoot);
  if (!manager) {
    return;
  }

  await shutdownManager(repoRoot, manager);
}
