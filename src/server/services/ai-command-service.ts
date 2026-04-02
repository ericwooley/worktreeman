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
  readAiCommandProcessLogs,
  type AiCommandProcessDescription,
} from "./ai-command-process-service.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";

const aiCommandJobEmitter = new EventEmitter();
const AI_COMMAND_PROCESS_METADATA_GRACE_MS = 5_000;

interface AiCommandProcessAdapter {
  getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
  readProcessLogs: (processInfo: AiCommandProcessDescription | null) => Promise<{ stdout: string; stderr: string }>;
  isProcessActive: (status: string | undefined) => boolean;
}

const defaultAiCommandProcessAdapter: AiCommandProcessAdapter = {
  getProcess: getAiCommandProcess,
  readProcessLogs: readAiCommandProcessLogs,
  isProcessActive: isAiCommandProcessActive,
};

function getAiCommandEventKey(repoRoot: string, worktreeId: WorktreeId) {
  return `${repoRoot}:${worktreeId}`;
}

function buildAiCommandLogFileName(worktreeId: WorktreeId, date = new Date()): string {
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${worktreeId}-ai-request.json`;
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

function hasObservedAiCommandProcess(job: AiCommandJob): boolean {
  return job.pid != null
    || job.exitCode != null
    || typeof job.completedAt === "string"
    || Boolean(job.stdout)
    || Boolean(job.stderr)
    || (job.outputEvents?.length ?? 0) > 0;
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

function appendOutputEvent(
  runId: string,
  events: AiCommandOutputEvent[] | undefined,
  source: AiCommandOutputEvent["source"],
  chunk: string,
) {
  if (!chunk) {
    return events?.map(cloneOutputEvent) ?? [];
  }

  const nextEvents = events?.map(cloneOutputEvent) ?? [];
  return [...nextEvents, createOutputEvent(runId, nextEvents.length + 1, source, chunk)];
}

function resolveAppendedChunk(previous: string, next: string): string {
  if (!next || next === previous) {
    return "";
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length);
  }

  return next.slice(Math.min(previous.length, next.length));
}

async function reconcileAiCommandJob(
  repoRoot: string,
  job: AiCommandJob | null,
  aiProcesses: AiCommandProcessAdapter = defaultAiCommandProcessAdapter,
): Promise<AiCommandJob | null> {
  if (!job || job.status !== "running") {
    return cloneAiCommandJob(job);
  }

  let currentJob = cloneAiCommandJob(job)!;

  const store = await createOperationalStateStore(repoRoot);
  const persistJob = async (nextJob: AiCommandJob) => {
    await store.setAiCommandJob(nextJob);
    await store.upsertAiCommandLogEntry(toAiCommandLogEntry(nextJob));
    await store.syncAiCommandOutputEvents(nextJob.jobId, nextJob.fileName, nextJob.worktreeId, nextJob.branch, nextJob.outputEvents);
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
  if (!processInfo && !hasObservedAiCommandProcess(currentJob)) {
    return cloneAiCommandJob(currentJob);
  }

  if (processInfo && aiProcesses.isProcessActive(processInfo.status)) {
    const logs = await aiProcesses.readProcessLogs(processInfo);
    const stdoutDelta = resolveAppendedChunk(currentJob.stdout, logs.stdout);
    const stderrDelta = resolveAppendedChunk(currentJob.stderr, logs.stderr);
    const nextPid = processInfo.pid ?? currentJob.pid ?? null;
    const nextJob: AiCommandJob = {
      ...currentJob,
      stdout: logs.stdout,
      stderr: logs.stderr,
      pid: nextPid,
      outputEvents: appendOutputEvent(
        currentJob.jobId,
        appendOutputEvent(currentJob.jobId, currentJob.outputEvents, "stdout", stdoutDelta),
        "stderr",
        stderrDelta,
      ),
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

  const logs = await aiProcesses.readProcessLogs(processInfo);
  const resolvedExitCode = processInfo?.exitCode ?? currentJob.exitCode ?? null;
  const completedAt = currentJob.completedAt ?? new Date().toISOString();
  const baseJob: AiCommandJob = {
    ...currentJob,
    completedAt,
    stdout: logs.stdout || currentJob.stdout,
    stderr: logs.stderr || currentJob.stderr,
    pid: processInfo?.pid ?? currentJob.pid ?? null,
    exitCode: resolvedExitCode,
    outputEvents: appendOutputEvent(
      currentJob.jobId,
      appendOutputEvent(
        currentJob.jobId,
        currentJob.outputEvents,
        "stdout",
        resolveAppendedChunk(currentJob.stdout, logs.stdout || currentJob.stdout),
      ),
      "stderr",
      resolveAppendedChunk(currentJob.stderr, logs.stderr || currentJob.stderr),
    ),
  };

  if (resolvedExitCode === 0) {
    const nextJob: AiCommandJob = {
      ...baseJob,
      status: "completed",
      error: null,
    };
    await persistJob(nextJob);
    return cloneAiCommandJob(nextJob);
  }

  const settledJob: AiCommandJob = {
        ...baseJob,
        status: "failed",
        stderr: `${baseJob.stderr}${currentJob.error ?? (processInfo
          ? `AI process exited with code ${resolvedExitCode ?? "unknown"}.`
          : "AI process was no longer available. The server may have restarted or the process may have crashed.")}`,
        outputEvents: appendOutputEvent(
          currentJob.jobId,
          baseJob.outputEvents,
          "stderr",
          currentJob.error ?? (processInfo
            ? `AI process exited with code ${resolvedExitCode ?? "unknown"}.`
            : "AI process was no longer available. The server may have restarted or the process may have crashed."),
        ),
        error: currentJob.error ?? (processInfo
          ? `AI process exited with code ${resolvedExitCode ?? "unknown"}.`
          : "AI process was no longer available. The server may have restarted or the process may have crashed."),
      };

  await persistJob(settledJob);
  return cloneAiCommandJob(settledJob);
}

async function emitAiCommandJobUpdate(repoRoot: string, worktreeId: WorktreeId) {
  const store = await createOperationalStateStore(repoRoot);
  const job = await store.getAiCommandJobById(worktreeId);
  aiCommandJobEmitter.emit(getAiCommandEventKey(repoRoot, worktreeId), cloneAiCommandJob(job));
}

export async function persistAiCommandJobSnapshot(repoRoot: string, job: AiCommandJob): Promise<void> {
  const store = await createOperationalStateStore(repoRoot);
  await store.setAiCommandJob(job);
  await store.upsertAiCommandLogEntry(toAiCommandLogEntry(job));
  await store.syncAiCommandOutputEvents(job.jobId, job.fileName, job.worktreeId, job.branch, job.outputEvents);
  await emitAiCommandJobUpdate(repoRoot, job.worktreeId);
}

export async function beginAiCommandJob(options: {
  repoRoot: string;
  worktreeId: WorktreeId;
  branch: string;
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
  options?: { aiProcesses?: AiCommandProcessAdapter; reconcile?: boolean },
): Promise<AiCommandJob | null> {
  const store = await createOperationalStateStore(repoRoot);
  const job = await store.getAiCommandJobById(worktreeId);
  if (options?.reconcile === false) {
    return cloneAiCommandJob(job);
  }

  return await reconcileAiCommandJob(repoRoot, job, options?.aiProcesses);
}

export async function listAiCommandJobs(
  repoRoot: string,
  options?: { aiProcesses?: AiCommandProcessAdapter; reconcile?: boolean },
): Promise<AiCommandJob[]> {
  const store = await createOperationalStateStore(repoRoot);
  const persistedJobs = await store.listAiCommandJobs();
  if (options?.reconcile === false) {
    return persistedJobs
      .map((job) => cloneAiCommandJob(job))
      .filter((job): job is AiCommandJob => job !== null);
  }

  const jobs = await Promise.all(
    persistedJobs.map((job) => reconcileAiCommandJob(repoRoot, job, options?.aiProcesses)),
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
    stderr: `${currentJob.stderr}${options.error}`,
    outputEvents: options.outputEvents?.map(cloneOutputEvent)
      ?? appendOutputEvent(currentJob.jobId, currentJob.outputEvents, "stderr", options.error),
    error: options.error,
  };
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
  }) => Promise<{ stdout: string; stderr: string }>;
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
          const nextJob: AiCommandJob = {
            ...currentJob,
            stdout: `${currentJob.stdout}${chunk}`,
            outputEvents: appendOutputEvent(jobId, currentJob.outputEvents, "stdout", chunk),
          };
          await persistSnapshot(nextJob);
        },
        onStderr: async (chunk: string) => {
          const nextJob: AiCommandJob = {
            ...currentJob,
            stderr: `${currentJob.stderr}${chunk}`,
            outputEvents: appendOutputEvent(jobId, currentJob.outputEvents, "stderr", chunk),
          };
          await persistSnapshot(nextJob);
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
      const result = await options.execute({
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

      await options.onComplete?.({
        job: {
          ...currentJob,
          stdout: result.stdout,
          stderr: result.stderr,
          outputEvents: currentJob.outputEvents?.map((event) => ({ ...event })) ?? [],
        },
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const completedAt = new Date().toISOString();
      currentJob = {
        ...currentJob,
        status: "completed",
        completedAt,
        stdout: result.stdout,
        stderr: result.stderr,
        outputEvents: currentJob.outputEvents?.map(cloneOutputEvent) ?? [],
      };
      await persistJobSafely(currentJob);
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
        : error instanceof Error
          ? error.message
          : String(error);
      const nextOutputEvents = latestJob?.status === "failed"
        ? latestJob.outputEvents?.map(cloneOutputEvent) ?? []
        : appendOutputEvent(jobId, currentJob.outputEvents, "stderr", errorMessage);
      const nextStderr = latestJob?.status === "failed"
        ? latestJob.stderr
        : `${currentJob.stderr}${errorMessage}`;
      const completedAt = new Date().toISOString();
      currentJob = {
        ...(latestJob ?? currentJob),
        status: "failed",
        completedAt,
        stderr: nextStderr,
        outputEvents: nextOutputEvents,
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
      nextJob.error = error instanceof Error ? error.message : String(error);
    }

    currentJob = nextJob;
    await persistJobSafely(nextJob);
  };

  const completed = runJob();

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
