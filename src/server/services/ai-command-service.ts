import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AiCommandId, AiCommandJob, AiCommandOrigin, AiCommandOutputEvent } from "../../shared/types.js";
import { createOperationalStateStore } from "./operational-state-service.js";

const aiCommandJobEmitter = new EventEmitter();

function getAiCommandEventKey(repoRoot: string, branch: string) {
  return `${repoRoot}:${branch}`;
}

function buildAiCommandLogFileName(branch: string, date = new Date()): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
  const timestamp = date.toISOString().replace(/[:.]/g, "-");
  return `${timestamp}-${safeBranch}-ai-request.json`;
}

function cloneAiCommandJob(job: AiCommandJob | null): AiCommandJob | null {
  if (!job) {
    return null;
  }

  return {
    ...job,
    completedAt: job.completedAt,
    logPath: job.logPath,
    error: job.error,
    outputEvents: job.outputEvents?.map((event) => ({ ...event })) ?? [],
  };
}

function createOutputEvent(source: AiCommandOutputEvent["source"], text: string): AiCommandOutputEvent {
  return {
    id: randomUUID(),
    source,
    text,
    timestamp: new Date().toISOString(),
  };
}

function appendOutputEvent(events: AiCommandOutputEvent[] | undefined, source: AiCommandOutputEvent["source"], chunk: string) {
  if (!chunk) {
    return events?.map((event) => ({ ...event })) ?? [];
  }

  return [...(events?.map((event) => ({ ...event })) ?? []), createOutputEvent(source, chunk)];
}

async function emitAiCommandJobUpdate(repoRoot: string, branch: string) {
  const store = await createOperationalStateStore(repoRoot);
  const job = await store.getAiCommandJob(branch);
  aiCommandJobEmitter.emit(getAiCommandEventKey(repoRoot, branch), cloneAiCommandJob(job));
}

export async function getAiCommandJob(repoRoot: string, branch: string): Promise<AiCommandJob | null> {
  const store = await createOperationalStateStore(repoRoot);
  return cloneAiCommandJob(await store.getAiCommandJob(branch));
}

export async function listAiCommandJobs(repoRoot: string): Promise<AiCommandJob[]> {
  const store = await createOperationalStateStore(repoRoot);
  return (await store.listAiCommandJobs())
    .map((job) => cloneAiCommandJob(job))
    .filter((job): job is AiCommandJob => job !== null)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export async function clearAiCommandJobs(repoRoot: string, branch?: string) {
  const store = await createOperationalStateStore(repoRoot);
  if (branch) {
    await store.clearAiCommandJobs(branch);
    await emitAiCommandJobUpdate(repoRoot, branch);
    return;
  }

  const branches = (await store.listAiCommandJobs()).map((job) => job.branch);
  await store.clearAiCommandJobs();
  for (const currentBranch of branches) {
    await emitAiCommandJobUpdate(repoRoot, currentBranch);
  }
}

export function subscribeToAiCommandJob(repoRoot: string, branch: string, listener: (job: AiCommandJob | null) => void): () => void {
  const wrappedListener = (job: AiCommandJob | null) => listener(cloneAiCommandJob(job));
  aiCommandJobEmitter.on(getAiCommandEventKey(repoRoot, branch), wrappedListener);
  return () => {
    aiCommandJobEmitter.off(getAiCommandEventKey(repoRoot, branch), wrappedListener);
  };
}

export async function waitForAiCommandJob(repoRoot: string, branch: string, jobId: string): Promise<AiCommandJob> {
  const currentJob = await getAiCommandJob(repoRoot, branch);
  if (currentJob?.jobId === jobId && currentJob.status !== "running") {
    return currentJob;
  }

  return await new Promise<AiCommandJob>((resolve) => {
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

    const unsubscribe = subscribeToAiCommandJob(repoRoot, branch, (job) => {
      if (!job || job.jobId !== jobId || job.status === "running") {
        return;
      }

      finish(job);
    });

    const interval = setInterval(() => {
      void getAiCommandJob(repoRoot, branch).then((job) => {
        if (!job || job.jobId !== jobId || job.status === "running") {
          return;
        }

        finish(job);
      });
    }, 250);
  });
}

export async function failAiCommandJob(options: {
  repoRoot: string;
  branch: string;
  jobId: string;
  error: string;
  exitCode?: number | null;
  outputEvents?: AiCommandOutputEvent[];
}) {
  const store = await createOperationalStateStore(options.repoRoot);
  const currentJob = await store.getAiCommandJob(options.branch);
  if (!currentJob || currentJob.jobId !== options.jobId) {
    return null;
  }

  const nextJob: AiCommandJob = {
    ...currentJob,
    status: "failed",
    completedAt: currentJob.completedAt ?? new Date().toISOString(),
    exitCode: options.exitCode ?? currentJob.exitCode ?? null,
    stderr: `${currentJob.stderr}${options.error}`,
    outputEvents: options.outputEvents?.map((event) => ({ ...event })) ?? appendOutputEvent(currentJob.outputEvents, "stderr", options.error),
    error: options.error,
  };
  await store.setAiCommandJob(nextJob);
  await emitAiCommandJobUpdate(options.repoRoot, options.branch);
  return cloneAiCommandJob(nextJob);
}

export async function startAiCommandJob(options: {
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  input: string;
  command: string;
  repoRoot: string;
  worktreePath: string;
  execute: (payload: {
    jobId: string;
    fileName: string;
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
  writeLog: (payload: {
    fileName: string;
    jobId: string;
    repoRoot: string;
    branch: string;
    documentId?: string | null;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    worktreePath: string;
    renderedCommand: string;
    input: string;
    stdout?: string;
    stderr?: string;
    events?: AiCommandOutputEvent[];
    startedAt?: string;
    completedAt?: string;
    pid?: number | null;
    exitCode?: number | null;
    processName?: string | null;
    error?: unknown;
  }) => Promise<string | null>;
  onComplete?: (payload: {
    job: AiCommandJob;
    stdout: string;
    stderr: string;
  }) => Promise<void>;
}): Promise<AiCommandJob> {
  const store = await createOperationalStateStore(options.repoRoot);

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const fileName = buildAiCommandLogFileName(options.branch, new Date(startedAt));
  const job: AiCommandJob = {
    jobId,
    fileName,
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
    processName: null,
  };

  const claimed = await store.claimRunningAiCommandJob(job);
  if (!claimed) {
    throw new Error(`AI command already running for ${options.branch}.`);
  }

  let currentJob = job;
  let settleStartup: (() => void) | null = null;
  const startupObserved = new Promise<void>((resolve) => {
    settleStartup = resolve;
  });
  const resolveStartup = () => {
    const pending = settleStartup;
    settleStartup = null;
    pending?.();
  };
  const writeLogSafely = async (payload: Parameters<typeof options.writeLog>[0]) => {
    try {
      return await options.writeLog(payload);
    } catch {
      return null;
    }
  };
  const persistJobSafely = async (nextJob: AiCommandJob) => {
    try {
      await store.setAiCommandJob(nextJob);
      await emitAiCommandJobUpdate(options.repoRoot, options.branch);
    } catch {
      // Ignore persistence failures after startup so background cleanup does not crash the process.
    }
  };
  const initialLogPath = await options.writeLog({
    fileName,
    jobId,
    repoRoot: options.repoRoot,
    branch: options.branch,
    documentId: options.documentId ?? null,
    commandId: options.commandId,
    origin: options.origin ?? null,
    worktreePath: options.worktreePath,
    renderedCommand: options.command,
    input: options.input,
    stdout: job.stdout,
    stderr: job.stderr,
    events: job.outputEvents,
    startedAt,
    completedAt: undefined,
    pid: job.pid,
    exitCode: job.exitCode,
    processName: job.processName,
  });
  if (initialLogPath) {
    currentJob = {
      ...currentJob,
      logPath: initialLogPath,
    };
    await store.setAiCommandJob(currentJob);
  }
  await emitAiCommandJobUpdate(options.repoRoot, options.branch);

  const persistSnapshot = async (overrides?: Partial<AiCommandJob>, error?: unknown) => {
    const nextJob = {
      ...currentJob,
      ...(overrides ?? {}),
    };

    const storedJob = await store.getAiCommandJob(options.branch);
    if (storedJob && storedJob.jobId === jobId && storedJob.status !== "running" && nextJob.status === "running") {
      currentJob = cloneAiCommandJob(storedJob) ?? nextJob;
      return;
    }

    const logPath = await writeLogSafely({
      fileName,
      jobId,
      repoRoot: options.repoRoot,
      branch: options.branch,
      documentId: options.documentId ?? null,
      commandId: options.commandId,
      origin: options.origin ?? null,
      worktreePath: options.worktreePath,
      renderedCommand: options.command,
      input: options.input,
      stdout: nextJob.stdout,
      stderr: nextJob.stderr,
      events: nextJob.outputEvents,
      startedAt,
      completedAt: nextJob.completedAt,
      pid: nextJob.pid,
      exitCode: nextJob.exitCode,
      processName: nextJob.processName,
      error,
    });

    if (logPath) {
      nextJob.logPath = logPath;
    }

    currentJob = nextJob;
    await persistJobSafely(nextJob);
  };

  void (async () => {
    try {
      const hooks = {
        onSpawn: async ({ pid, processName }: { pid?: number | null; processName?: string | null }) => {
          const nextJob: AiCommandJob = {
            ...(currentJob ?? job),
            pid: pid ?? null,
            processName: processName ?? null,
          };
          await persistSnapshot(nextJob);
          resolveStartup();
        },
        onStdout: async (chunk: string) => {
          const nextJob: AiCommandJob = {
            ...(currentJob ?? job),
            stdout: `${(currentJob ?? job).stdout}${chunk}`,
            outputEvents: appendOutputEvent((currentJob ?? job).outputEvents, "stdout", chunk),
          };
          await persistSnapshot(nextJob);
        },
        onStderr: async (chunk: string) => {
          const nextJob: AiCommandJob = {
            ...(currentJob ?? job),
            stderr: `${(currentJob ?? job).stderr}${chunk}`,
            outputEvents: appendOutputEvent((currentJob ?? job).outputEvents, "stderr", chunk),
          };
          await persistSnapshot(nextJob);
        },
        onExit: async ({ exitCode }: { exitCode?: number | null }) => {
          const nextJob: AiCommandJob = {
            ...(currentJob ?? job),
            exitCode: exitCode ?? null,
          };
          await persistSnapshot(nextJob);
        },
      };
      const result = await options.execute({
        jobId,
        fileName,
        branch: options.branch,
        input: options.input,
        command: options.command,
        worktreePath: options.worktreePath,
        hooks,
      });
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
      const logPath = await writeLogSafely({
        fileName,
        jobId,
        repoRoot: options.repoRoot,
        branch: options.branch,
        documentId: options.documentId ?? null,
        commandId: options.commandId,
        origin: options.origin ?? null,
        worktreePath: options.worktreePath,
        renderedCommand: options.command,
        input: options.input,
        stdout: result.stdout,
        stderr: result.stderr,
        events: currentJob.outputEvents,
        startedAt,
        completedAt,
        pid: currentJob.pid,
        exitCode: currentJob.exitCode,
        processName: currentJob.processName,
      });

      currentJob = {
        ...currentJob,
        status: "completed",
        completedAt,
        stdout: result.stdout,
        stderr: result.stderr,
        outputEvents: currentJob.outputEvents?.map((event) => ({ ...event })) ?? [],
        logPath: logPath ?? undefined,
      };
      await persistJobSafely(currentJob);
      resolveStartup();
    } catch (error) {
      const storedJob = await store.getAiCommandJob(options.branch);
      const latestJob = storedJob && storedJob.jobId === jobId ? storedJob : null;
      const errorMessage = latestJob?.status === "failed" && latestJob.error
        ? latestJob.error
        : error instanceof Error
          ? error.message
          : String(error);
      const nextOutputEvents = latestJob?.status === "failed"
        ? latestJob.outputEvents?.map((event) => ({ ...event })) ?? []
        : appendOutputEvent(currentJob.outputEvents, "stderr", errorMessage);
      const nextStderr = latestJob?.status === "failed"
        ? latestJob.stderr
        : `${currentJob.stderr}${errorMessage}`;
      const completedAt = new Date().toISOString();
      const logPath = await writeLogSafely({
        fileName,
        jobId,
        repoRoot: options.repoRoot,
        branch: options.branch,
        documentId: options.documentId ?? null,
        commandId: options.commandId,
        origin: options.origin ?? null,
        worktreePath: options.worktreePath,
        renderedCommand: options.command,
        input: options.input,
        stdout: latestJob?.stdout ?? currentJob.stdout,
        stderr: nextStderr,
        events: nextOutputEvents,
        startedAt,
        completedAt,
        pid: latestJob?.pid ?? currentJob.pid,
        exitCode: latestJob?.exitCode ?? currentJob.exitCode,
        processName: latestJob?.processName ?? currentJob.processName,
        error: latestJob?.status === "failed" ? new Error(errorMessage) : error,
      });

      currentJob = {
        ...(latestJob ?? currentJob),
        status: "failed",
        completedAt,
        stderr: nextStderr,
        outputEvents: nextOutputEvents,
        error: errorMessage,
        logPath: logPath ?? undefined,
      };
      await persistJobSafely(currentJob);
      resolveStartup();
    }
  })();

  await Promise.race([
    startupObserved,
    new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    }),
  ]);

  return cloneAiCommandJob(currentJob)!;
}
