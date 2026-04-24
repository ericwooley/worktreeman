import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AiCommandId, AiCommandJob, AiCommandLogEntry, AiCommandOrigin, AiCommandOutputEvent } from "../../shared/types.js";
import { cloneAiCommandJob } from "../../shared/ai-command-utils.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import { createOperationalStateStore } from "./operational-state-service.js";
import {
  getAiCommandProcessName,
  getAiCommandProcess,
  isAiCommandProcessActive,
  waitForAiCommandProcess,
  type AiCommandProcessDescription,
} from "./ai-command-process-service.js";
import { noteAiJobSnapshotGrowth } from "./ai-command-diagnostics-service.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";

const aiCommandJobEmitter = new EventEmitter();
const AI_COMMAND_PROCESS_METADATA_GRACE_MS = 5_000;
const activeAiCommandJobsByRepo = new Map<string, Map<string, Promise<AiCommandJob>>>();
const completingAiCommandJobsByRepo = new Map<string, Set<string>>();
const postExecuteAiCommandJobsByRepo = new Map<string, Set<string>>();

interface AiCommandProcessAdapter {
  getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  waitForProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  isProcessActive: (status: string | undefined) => boolean;
}

const defaultAiCommandProcessAdapter: AiCommandProcessAdapter = {
  getProcess: getAiCommandProcess,
  waitForProcess: waitForAiCommandProcess,
  isProcessActive: isAiCommandProcessActive,
};

function getAiCommandEventKey(repoRoot: string, worktreeId: WorktreeId) {
  return `${repoRoot}:${worktreeId}`;
}

function describeAiCommandError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function buildAiCommandLogFileName(worktreeId: WorktreeId, date = new Date()): string {
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${worktreeId}-ai-request.json`;
}

function trackActiveAiCommandJob(repoRoot: string, jobId: string, completed: Promise<AiCommandJob>): Promise<AiCommandJob> {
  let activeJobs = activeAiCommandJobsByRepo.get(repoRoot);
  if (!activeJobs) {
    activeJobs = new Map();
    activeAiCommandJobsByRepo.set(repoRoot, activeJobs);
  }

  activeJobs.set(jobId, completed);
  void completed
    .catch(() => undefined)
    .finally(() => {
      activeJobs?.delete(jobId);
      if (activeJobs && activeJobs.size === 0) {
        activeAiCommandJobsByRepo.delete(repoRoot);
      }
    });

  return completed;
}

function isActiveAiCommandJob(repoRoot: string, jobId: string): boolean {
  return activeAiCommandJobsByRepo.get(repoRoot)?.has(jobId) ?? false;
}

function markAiCommandJobCompleting(repoRoot: string, jobId: string): () => void {
  let completingJobs = completingAiCommandJobsByRepo.get(repoRoot);
  if (!completingJobs) {
    completingJobs = new Set();
    completingAiCommandJobsByRepo.set(repoRoot, completingJobs);
  }

  completingJobs.add(jobId);
  return () => {
    completingJobs?.delete(jobId);
    if (completingJobs && completingJobs.size === 0) {
      completingAiCommandJobsByRepo.delete(repoRoot);
    }
  };
}

function isCompletingAiCommandJob(repoRoot: string, jobId: string): boolean {
  return completingAiCommandJobsByRepo.get(repoRoot)?.has(jobId) ?? false;
}

function markAiCommandJobPostExecute(repoRoot: string, jobId: string): () => void {
  let repoJobs = postExecuteAiCommandJobsByRepo.get(repoRoot);
  if (!repoJobs) {
    repoJobs = new Set<string>();
    postExecuteAiCommandJobsByRepo.set(repoRoot, repoJobs);
  }
  repoJobs.add(jobId);

  return () => {
    const currentRepoJobs = postExecuteAiCommandJobsByRepo.get(repoRoot);
    if (!currentRepoJobs) {
      return;
    }

    currentRepoJobs.delete(jobId);
    if (currentRepoJobs.size === 0) {
      postExecuteAiCommandJobsByRepo.delete(repoRoot);
    }
  };
}

function isPostExecuteAiCommandJob(repoRoot: string, jobId: string): boolean {
  return postExecuteAiCommandJobsByRepo.get(repoRoot)?.has(jobId) ?? false;
}

export async function waitForActiveAiCommandJobs(repoRoot: string, options?: { timeoutMs?: number }): Promise<void> {
  const activeJobs = Array.from(activeAiCommandJobsByRepo.get(repoRoot)?.values() ?? []);
  if (activeJobs.length === 0) {
    return;
  }

  const waitForJobs = Promise.allSettled(activeJobs).then(() => undefined);
  const timeoutMs = options?.timeoutMs ?? 0;
  if (timeoutMs <= 0) {
    await waitForJobs;
    return;
  }

  await Promise.race([
    waitForJobs,
    new Promise<void>((resolve) => {
      setTimeout(resolve, timeoutMs);
    }),
  ]);
}

function cloneOutputEvent(event: AiCommandOutputEvent): AiCommandOutputEvent {
  return { ...event };
}

function toAiCommandLogEntry(job: AiCommandJob): AiCommandLogEntry {
  return {
    jobId: job.jobId,
    fileName: job.fileName,
    timestamp: job.startedAt,
    worktreeId: job.worktreeId,
    branch: job.branch,
    sessionId: job.sessionId ?? null,
    documentId: job.documentId ?? null,
    commandId: job.commandId,
    origin: job.origin ?? null,
    worktreePath: job.worktreePath ?? job.branch,
    command: job.command,
    request: job.input,
    response: {
      stdout: job.stdout,
      stderr: job.stderr,
      events: job.outputEvents?.map(cloneOutputEvent) ?? [],
    },
    status: job.status,
    pid: job.pid ?? null,
    exitCode: job.exitCode ?? null,
    processName: job.processName ?? null,
    completedAt: job.completedAt,
    error: job.error ? { message: job.error } : null,
  };
}

function createAiCommandJobRecord(options: {
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  input: string;
  command: string;
  worktreePath: string;
}): AiCommandJob {
  const startedAt = new Date().toISOString();
  const jobId = randomUUID();
  return {
    jobId,
    fileName: buildAiCommandLogFileName(options.worktreeId, new Date(startedAt)),
    worktreeId: options.worktreeId,
    branch: options.branch,
    sessionId: options.sessionId ?? null,
    documentId: options.documentId ?? null,
    commandId: options.commandId,
    origin: options.origin ?? null,
    command: options.command,
    input: options.input,
    status: "running",
    startedAt,
    stdout: "",
    stderr: "",
    outputEvents: [],
    pid: null,
    exitCode: null,
    processName: getAiCommandProcessName(jobId),
    worktreePath: options.worktreePath,
  };
}

function hasObservedAiCommandProcess(
  job: AiCommandJob,
  options?: { treatProcessNameAsObserved?: boolean },
): boolean {
  return job.pid != null
    || job.exitCode != null
    || typeof job.completedAt === "string"
    || (options?.treatProcessNameAsObserved === true && Boolean(job.processName));
}

function createOutputEvent(
  runId: string,
  entry: number,
  source: AiCommandOutputEvent["source"],
  text: string,
): AiCommandOutputEvent {
  return {
    id: randomUUID(),
    runId,
    entry,
    source,
    text,
    timestamp: new Date().toISOString(),
  };
}

async function appendAiCommandOutputChunk(options: {
  repoRoot: string;
  job: AiCommandJob;
  source: AiCommandOutputEvent["source"];
  chunk: string;
}) {
  if (!options.chunk) {
    return null;
  }

  const store = await createOperationalStateStore(options.repoRoot);
  return await store.appendAiCommandOutputChunk({
    jobId: options.job.jobId,
    fileName: options.job.fileName,
    worktreeId: options.job.worktreeId,
    branch: options.job.branch,
    source: options.source,
    text: options.chunk,
  });
}

async function ensureAiCommandLogEntry(repoRoot: string, job: AiCommandJob): Promise<void> {
  const store = await createOperationalStateStore(repoRoot);
  await store.upsertAiCommandLogEntry(toAiCommandLogEntry(job), { preserveOutputText: true });
}

async function reconcileAiCommandJob(
  repoRoot: string,
  job: AiCommandJob | null,
  aiProcesses: AiCommandProcessAdapter = defaultAiCommandProcessAdapter,
  options?: { treatProcessNameAsObserved?: boolean },
): Promise<AiCommandJob | null> {
  if (!job || job.status !== "running") {
    return cloneAiCommandJob(job);
  }

  let currentJob = cloneAiCommandJob(job)!;

  const store = await createOperationalStateStore(repoRoot);
  const persistJob = async (nextJob: AiCommandJob) => {
    await store.setAiCommandJob(nextJob);
    await store.upsertAiCommandLogEntry(toAiCommandLogEntry(nextJob), { preserveOutputText: true });
  };

  if (!currentJob.processName) {
    const nextJob: AiCommandJob = {
      ...currentJob,
      processName: getAiCommandProcessName(currentJob.jobId),
    };
    currentJob = nextJob;
    await persistJob(nextJob);
  }

  const processName = currentJob.processName;
  if (!processName) {
    return cloneAiCommandJob(currentJob);
  }

  const processInfo = await aiProcesses.getProcess(processName);
  if (!processInfo && !hasObservedAiCommandProcess(currentJob, options)) {
    return cloneAiCommandJob(currentJob);
  }

  if (processInfo && aiProcesses.isProcessActive(processInfo.status)) {
    const nextPid = processInfo.pid ?? currentJob.pid ?? null;
    const nextJob: AiCommandJob = {
      ...currentJob,
      pid: nextPid,
    };

    const hasChanged = nextJob.stdout !== currentJob.stdout
      || nextJob.stderr !== currentJob.stderr
      || nextJob.pid !== (currentJob.pid ?? null)
      || (nextJob.outputEvents?.length ?? 0) !== (currentJob.outputEvents?.length ?? 0);

    if (!hasChanged) {
      return cloneAiCommandJob(currentJob);
    }

    await persistJob(nextJob);
    return cloneAiCommandJob(nextJob);
  }

  const resolvedExitCode = processInfo?.exitCode ?? currentJob.exitCode ?? null;
  const completedAt = currentJob.completedAt ?? new Date().toISOString();
  const baseJob: AiCommandJob = {
    ...currentJob,
    completedAt,
    pid: processInfo?.pid ?? currentJob.pid ?? null,
    exitCode: resolvedExitCode,
  };

  if (isPostExecuteAiCommandJob(repoRoot, currentJob.jobId) || isCompletingAiCommandJob(repoRoot, currentJob.jobId)) {
    const settlingJob: AiCommandJob = {
      ...baseJob,
      status: "running",
      completedAt,
      error: currentJob.error,
    };
    await persistJob(settlingJob);
    return cloneAiCommandJob(settlingJob);
  }

  if (resolvedExitCode === 0) {
    const nextJob: AiCommandJob = {
      ...baseJob,
      status: "completed",
      error: null,
    };
    await persistJob(nextJob);
    return cloneAiCommandJob(nextJob);
  }

  const failureMessage = currentJob.error ?? (processInfo
    ? `AI process exited with code ${resolvedExitCode ?? "unknown"}.`
    : "AI process was no longer available. The server may have restarted or the process may have crashed.");

  await ensureAiCommandLogEntry(repoRoot, currentJob);
  await appendAiCommandOutputChunk({
    repoRoot,
    job: currentJob,
    source: "stderr",
    chunk: failureMessage,
  });

  const settledJob: AiCommandJob = {
    ...baseJob,
    status: "failed",
    stderr: failureMessage,
    outputEvents: [],
    error: failureMessage,
  };

  await persistJob(settledJob);
  return cloneAiCommandJob(settledJob);
}

async function emitAiCommandJobUpdate(repoRoot: string, worktreeId: WorktreeId) {
  const store = await createOperationalStateStore(repoRoot);
  const job = await store.getAiCommandJobById(worktreeId);
  aiCommandJobEmitter.emit(getAiCommandEventKey(repoRoot, worktreeId), cloneAiCommandJob(job));
}

function instrumentAiJobSnapshot(job: AiCommandJob) {
  noteAiJobSnapshotGrowth({
    jobId: job.jobId,
    branch: job.branch,
    processName: job.processName ?? null,
    stdout: job.stdout,
    stderr: job.stderr,
    outputEvents: job.outputEvents,
  });
}

export async function persistAiCommandJobSnapshot(repoRoot: string, job: AiCommandJob): Promise<void> {
  instrumentAiJobSnapshot(job);
  const store = await createOperationalStateStore(repoRoot);
  await store.setAiCommandJob(job);
  await store.upsertAiCommandLogEntry(toAiCommandLogEntry(job), { preserveOutputText: true });
  await emitAiCommandJobUpdate(repoRoot, job.worktreeId);
}

export async function beginAiCommandJob(options: {
  repoRoot: string;
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  input: string;
  command: string;
  worktreePath: string;
}): Promise<AiCommandJob> {
  const store = await createOperationalStateStore(options.repoRoot);
  const job = createAiCommandJobRecord(options);
  const claimed = await store.claimRunningAiCommandJob(job);
  if (!claimed) {
    throw new Error(`AI command already running for ${options.branch}.`);
  }

  await store.upsertAiCommandLogEntry(toAiCommandLogEntry(job));
  await emitAiCommandJobUpdate(options.repoRoot, options.worktreeId);
  return cloneAiCommandJob(job)!;
}

export async function getAiCommandJob(
  repoRoot: string,
  worktreeId: WorktreeId,
  options?: { aiProcesses?: AiCommandProcessAdapter; reconcile?: boolean; treatProcessNameAsObserved?: boolean },
): Promise<AiCommandJob | null> {
  const store = await createOperationalStateStore(repoRoot);
  const job = await store.getAiCommandJobById(worktreeId);
  if (options?.reconcile === false) {
    return cloneAiCommandJob(job);
  }

  return await reconcileAiCommandJob(repoRoot, job, options?.aiProcesses, {
    treatProcessNameAsObserved: options?.treatProcessNameAsObserved,
  });
}

export async function listAiCommandJobs(
  repoRoot: string,
  options?: { aiProcesses?: AiCommandProcessAdapter; reconcile?: boolean; treatProcessNameAsObserved?: boolean },
): Promise<AiCommandJob[]> {
  const store = await createOperationalStateStore(repoRoot);
  const persistedJobs = await store.listAiCommandJobs();
  if (options?.reconcile === false) {
    return persistedJobs
      .map((job) => cloneAiCommandJob(job))
      .filter((job): job is AiCommandJob => job !== null);
  }

  const jobs = await Promise.all(
    persistedJobs.map((job) => reconcileAiCommandJob(repoRoot, job, options?.aiProcesses, {
      treatProcessNameAsObserved: options?.treatProcessNameAsObserved,
    })),
  );
  return jobs
    .map((job) => cloneAiCommandJob(job))
    .filter((job): job is AiCommandJob => job !== null)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export async function reconcileInterruptedAiCommandJobs(
  repoRoot: string,
  options?: { aiProcesses?: AiCommandProcessAdapter },
): Promise<AiCommandJob[]> {
  return await listAiCommandJobs(repoRoot, options);
}

export async function clearAiCommandJobs(repoRoot: string, worktreeId?: WorktreeId) {
  const store = await createOperationalStateStore(repoRoot);
  if (worktreeId) {
    await store.clearAiCommandJobsById(worktreeId);
    await emitAiCommandJobUpdate(repoRoot, worktreeId);
    return;
  }

  const worktreeIds = (await store.listAiCommandJobs()).map((job) => job.worktreeId);
  await store.clearAiCommandJobsById();
  for (const currentWorktreeId of worktreeIds) {
    await emitAiCommandJobUpdate(repoRoot, currentWorktreeId);
  }
}

export function subscribeToAiCommandJob(repoRoot: string, worktreeId: WorktreeId, listener: (job: AiCommandJob | null) => void): () => void {
  const wrappedListener = (job: AiCommandJob | null) => listener(cloneAiCommandJob(job));
  aiCommandJobEmitter.on(getAiCommandEventKey(repoRoot, worktreeId), wrappedListener);
  return () => {
    aiCommandJobEmitter.off(getAiCommandEventKey(repoRoot, worktreeId), wrappedListener);
  };
}

export async function waitForAiCommandJob(repoRoot: string, worktreeId: WorktreeId, jobId: string): Promise<AiCommandJob> {
  const store = await createOperationalStateStore(repoRoot);
  const currentJob = cloneAiCommandJob(await store.getAiCommandJobById(worktreeId));
  if (currentJob?.jobId === jobId && currentJob.status !== "running") {
    return currentJob;
  }

  return await new Promise<AiCommandJob>((resolve, reject) => {
    let settled = false;
    const finish = (job: AiCommandJob) => {
      if (settled) {
        return;
      }

      settled = true;
      clearInterval(interval);
      unsubscribe();
      resolve(job);
    };
    const fail = (error: unknown) => {
      if (settled) {
        return;
      }

      settled = true;
      clearInterval(interval);
      unsubscribe();
      reject(error);
    };

    const unsubscribe = subscribeToAiCommandJob(repoRoot, worktreeId, (job) => {
      if (!job || job.jobId !== jobId || job.status === "running") {
        return;
      }

      finish(job);
    });

    const interval = setInterval(() => {
      store.getAiCommandJobById(worktreeId)
        .then((job) => {
          const snapshot = cloneAiCommandJob(job);
          if (!snapshot || snapshot.jobId !== jobId || snapshot.status === "running") {
            return;
          }

          finish(snapshot);
        })
        .catch((error) => {
          fail(error);
        });
    }, 250);
  });
}

export async function failAiCommandJob(options: {
  repoRoot: string;
  worktreeId: WorktreeId;
  jobId: string;
  error: string;
  exitCode?: number | null;
  outputEvents?: AiCommandOutputEvent[];
}) {
  const store = await createOperationalStateStore(options.repoRoot);
  const currentJob = await store.getAiCommandJobById(options.worktreeId);
  if (!currentJob || currentJob.jobId !== options.jobId) {
    return null;
  }

  const nextJob: AiCommandJob = {
    ...currentJob,
    status: "failed",
    completedAt: currentJob.completedAt ?? new Date().toISOString(),
    exitCode: options.exitCode ?? currentJob.exitCode ?? null,
    stderr: options.error,
    outputEvents: options.outputEvents?.map(cloneOutputEvent) ?? [],
    error: options.error,
  };
  await ensureAiCommandLogEntry(options.repoRoot, currentJob);
  await appendAiCommandOutputChunk({
    repoRoot: options.repoRoot,
    job: currentJob,
    source: "stderr",
    chunk: options.error,
  });
  await persistAiCommandJobSnapshot(options.repoRoot, nextJob);
  return cloneAiCommandJob(nextJob);
}

export interface StartedAiCommandJob {
  started: Promise<AiCommandJob>;
  completed: Promise<AiCommandJob>;
}

interface RunAiCommandJobOptions {
  repoRoot: string;
  worktreeId: WorktreeId;
  branch: string;
  currentJob: AiCommandJob;
  execute: (payload: {
    jobId: string;
    fileName: string;
    worktreeId: WorktreeId;
    branch: string;
    input: string;
    command: string;
    worktreePath: string;
    hooks: {
      onSpawn?: (details: { pid?: number | null; processName?: string | null }) => void | Promise<void>;
      onStdout?: (chunk: string) => void | Promise<void>;
      onStderr?: (chunk: string) => void | Promise<void>;
      onExit?: (details: { exitCode?: number | null }) => void | Promise<void>;
    };
  }) => Promise<void>;
  onComplete?: (payload: {
    job: AiCommandJob;
    stdout: string;
    stderr: string;
  }) => Promise<void>;
}

async function runAiCommandJob(options: RunAiCommandJobOptions): Promise<StartedAiCommandJob> {
  const store = await createOperationalStateStore(options.repoRoot);
  let currentJob = cloneAiCommandJob(options.currentJob)!;
  const { jobId, fileName } = currentJob;
  let settleStartup: (() => void) | null = null;
  const startupObserved = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const resolveStartup = () => {
    const pending = settleStartup;
    settleStartup = null;
    pending?.();
  };
  const runJob = async () => {
    const executionStartedAt = Date.now();
    const finishPostExecute = markAiCommandJobPostExecute(options.repoRoot, jobId);
      logServerEvent("ai-command", "job-started", {
        repoRoot: options.repoRoot,
        worktreeId: options.worktreeId,
        branch: options.branch,
        jobId,
        commandId: currentJob.commandId,
        origin: currentJob.origin?.kind ?? null,
        worktreePath: currentJob.worktreePath ?? null,
      });
    try {
      const hooks = {
        onSpawn: async ({ pid, processName }: { pid?: number | null; processName?: string | null }) => {
          const nextJob: AiCommandJob = {
            ...currentJob,
            pid: pid ?? null,
            processName: processName ?? null,
          };
          await persistSnapshot(nextJob);
          logServerEvent("ai-command", "job-process-spawned", {
            repoRoot: options.repoRoot,
            worktreeId: options.worktreeId,
            branch: options.branch,
            jobId,
            pid: pid ?? null,
            processName: processName ?? null,
          });
          resolveStartup();
        },
        onStdout: async (chunk: string) => {
          await appendAiCommandOutputChunk({ repoRoot: options.repoRoot, job: currentJob, source: "stdout", chunk });
        },
        onStderr: async (chunk: string) => {
          await appendAiCommandOutputChunk({ repoRoot: options.repoRoot, job: currentJob, source: "stderr", chunk });
        },
        onExit: async ({ exitCode }: { exitCode?: number | null }) => {
          const nextJob: AiCommandJob = {
            ...currentJob,
            exitCode: exitCode ?? null,
          };
          await persistSnapshot(nextJob);
          logServerEvent("ai-command", "job-process-exited", {
            repoRoot: options.repoRoot,
            worktreeId: options.worktreeId,
            branch: options.branch,
            jobId,
            exitCode: exitCode ?? null,
          });
        },
      };
      await options.execute({
        jobId,
        fileName,
        worktreeId: options.worktreeId,
        branch: options.branch,
        input: currentJob.input,
        command: currentJob.command,
        worktreePath: currentJob.worktreePath ?? options.currentJob.worktreePath ?? options.branch,
        hooks,
      });
      const storedJob = await store.getAiCommandJobById(options.worktreeId);
      if (storedJob && storedJob.jobId === jobId && storedJob.status !== "running") {
        currentJob = cloneAiCommandJob(storedJob) ?? currentJob;
        resolveStartup();
        return cloneAiCommandJob(currentJob)!;
      }

      try {
        const completedLog = await store.getAiCommandLogEntryByJobId(jobId);
        const stdout = completedLog?.response.stdout ?? "";
        const stderr = completedLog?.response.stderr ?? "";
        if (options.onComplete) {
          const finishCompleting = markAiCommandJobCompleting(options.repoRoot, jobId);
          try {
            await options.onComplete({
              job: {
                ...currentJob,
                stdout,
                stderr,
                outputEvents: completedLog?.response.events?.map((event) => ({ ...event })) ?? [],
              },
              stdout,
              stderr,
            });
          } finally {
            finishCompleting();
          }
        }

        const completedAt = new Date().toISOString();
        currentJob = {
          ...currentJob,
          status: "completed",
          completedAt,
          stdout: "",
          stderr: "",
          outputEvents: [],
        };
        await persistJobSafely(currentJob);
      } finally {
        finishPostExecute();
      }
      logServerEvent("ai-command", "job-completed", {
        repoRoot: options.repoRoot,
        worktreeId: options.worktreeId,
        branch: options.branch,
        jobId,
        commandId: currentJob.commandId,
        duration: formatDurationMs(Date.now() - executionStartedAt),
        exitCode: currentJob.exitCode ?? null,
      });
      resolveStartup();
      return cloneAiCommandJob(currentJob)!;
    } catch (error) {
      const storedJob = await store.getAiCommandJobById(options.worktreeId);
      const latestJob = storedJob && storedJob.jobId === jobId ? storedJob : null;
      const errorMessage = latestJob?.status === "failed" && latestJob.error
        ? latestJob.error
        : describeAiCommandError(error);
      if (latestJob?.status !== "failed") {
        await appendAiCommandOutputChunk({
          repoRoot: options.repoRoot,
          job: currentJob,
          source: "stderr",
          chunk: errorMessage,
        });
      }
      const completedAt = new Date().toISOString();
      currentJob = {
        ...(latestJob ?? currentJob),
        status: "failed",
        completedAt,
        stderr: errorMessage,
        outputEvents: [],
        error: errorMessage,
      };
      await persistJobSafely(currentJob);
      logServerEvent("ai-command", "job-failed", {
        repoRoot: options.repoRoot,
        worktreeId: options.worktreeId,
        branch: options.branch,
        jobId,
        commandId: currentJob.commandId,
        duration: formatDurationMs(Date.now() - executionStartedAt),
        exitCode: currentJob.exitCode ?? null,
        error: errorMessage,
      }, "error");
      resolveStartup();
      return cloneAiCommandJob(currentJob)!;
    } finally {
      finishPostExecute();
    }
  };
  const persistJobSafely = async (nextJob: AiCommandJob) => {
    try {
      await persistAiCommandJobSnapshot(options.repoRoot, nextJob);
    } catch {
      // Ignore persistence failures after startup so background cleanup does not crash the process.
    }
  };

  const persistSnapshot = async (overrides?: Partial<AiCommandJob>, error?: unknown) => {
    const nextJob = {
      ...currentJob,
      ...(overrides ?? {}),
    };

    const storedJob = await store.getAiCommandJobById(options.worktreeId);
    if (storedJob && storedJob.jobId === jobId && storedJob.status !== "running" && nextJob.status === "running") {
      currentJob = cloneAiCommandJob(storedJob) ?? nextJob;
      return;
    }

    if (error) {
      nextJob.error = describeAiCommandError(error);
    }

    currentJob = nextJob;
    await persistJobSafely(nextJob);
  };

  const completed = trackActiveAiCommandJob(options.repoRoot, jobId, runJob());

  await Promise.race([
    startupObserved,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    }),
  ]);

  return {
    started: Promise.resolve(cloneAiCommandJob(currentJob)!),
    completed,
  };
}

export async function continueAiCommandJob(options: {
  repoRoot: string;
  worktreeId: WorktreeId;
  jobId: string;
  execute: RunAiCommandJobOptions["execute"];
  onComplete?: RunAiCommandJobOptions["onComplete"];
}): Promise<StartedAiCommandJob> {
  const store = await createOperationalStateStore(options.repoRoot);
  const currentJob = await store.getAiCommandJobById(options.worktreeId);
  if (!currentJob || currentJob.jobId !== options.jobId) {
    throw new Error(`AI command job ${options.jobId} was not found for worktree ${options.worktreeId}.`);
  }

  return await runAiCommandJob({
    repoRoot: options.repoRoot,
    worktreeId: options.worktreeId,
    branch: currentJob.branch,
    currentJob,
    execute: options.execute,
    onComplete: options.onComplete,
  });
}

export async function startAiCommandJob(options: {
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  input: string;
  command: string;
  repoRoot: string;
  worktreePath: string;
  execute: RunAiCommandJobOptions["execute"];
  onComplete?: RunAiCommandJobOptions["onComplete"];
}): Promise<StartedAiCommandJob> {
  const currentJob = await beginAiCommandJob({
    repoRoot: options.repoRoot,
    worktreeId: options.worktreeId,
    branch: options.branch,
    sessionId: options.sessionId ?? null,
    documentId: options.documentId ?? null,
    commandId: options.commandId,
    origin: options.origin ?? null,
    input: options.input,
    command: options.command,
    worktreePath: options.worktreePath,
  });

  return await runAiCommandJob({
    repoRoot: options.repoRoot,
    worktreeId: options.worktreeId,
    branch: options.branch,
    currentJob,
    execute: options.execute,
    onComplete: options.onComplete,
  });
}
