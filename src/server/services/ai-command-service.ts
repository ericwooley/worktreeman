import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AiCommandJob } from "../../shared/types.js";

const aiCommandJobEmitter = new EventEmitter();
const aiCommandJobsByBranch = new Map<string, AiCommandJob>();

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
  };
}

function emitAiCommandJobUpdate(branch: string) {
  aiCommandJobEmitter.emit(branch, cloneAiCommandJob(aiCommandJobsByBranch.get(branch) ?? null));
}

export function getAiCommandJob(branch: string): AiCommandJob | null {
  return cloneAiCommandJob(aiCommandJobsByBranch.get(branch) ?? null);
}

export function listAiCommandJobs(): AiCommandJob[] {
  return Array.from(aiCommandJobsByBranch.values())
    .map((job) => cloneAiCommandJob(job))
    .filter((job): job is AiCommandJob => job !== null)
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
}

export function clearAiCommandJobs(branch?: string) {
  if (branch) {
    aiCommandJobsByBranch.delete(branch);
    emitAiCommandJobUpdate(branch);
    return;
  }

  const branches = Array.from(aiCommandJobsByBranch.keys());
  aiCommandJobsByBranch.clear();
  for (const currentBranch of branches) {
    emitAiCommandJobUpdate(currentBranch);
  }
}

export function subscribeToAiCommandJob(branch: string, listener: (job: AiCommandJob | null) => void): () => void {
  const wrappedListener = (job: AiCommandJob | null) => listener(cloneAiCommandJob(job));
  aiCommandJobEmitter.on(branch, wrappedListener);
  return () => {
    aiCommandJobEmitter.off(branch, wrappedListener);
  };
}

export function waitForAiCommandJob(branch: string, jobId: string): Promise<AiCommandJob> {
  const currentJob = getAiCommandJob(branch);
  if (currentJob?.jobId === jobId && currentJob.status !== "running") {
    return Promise.resolve(currentJob);
  }

  return new Promise<AiCommandJob>((resolve) => {
    const unsubscribe = subscribeToAiCommandJob(branch, (job) => {
      if (!job || job.jobId !== jobId || job.status === "running") {
        return;
      }

      unsubscribe();
      resolve(job);
    });
  });
}

export function failAiCommandJob(options: {
  branch: string;
  jobId: string;
  error: string;
  exitCode?: number | null;
}) {
  const currentJob = aiCommandJobsByBranch.get(options.branch);
  if (!currentJob || currentJob.jobId !== options.jobId) {
    return null;
  }

  const nextJob: AiCommandJob = {
    ...currentJob,
    status: "failed",
    completedAt: currentJob.completedAt ?? new Date().toISOString(),
    exitCode: options.exitCode ?? currentJob.exitCode ?? null,
    stderr: `${currentJob.stderr}${options.error}`,
    error: options.error,
  };
  aiCommandJobsByBranch.set(options.branch, nextJob);
  emitAiCommandJobUpdate(options.branch);
  return cloneAiCommandJob(nextJob);
}

export async function startAiCommandJob(options: {
  branch: string;
  documentId?: string | null;
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
      onSpawn?: (details: { pid?: number | null; processName?: string | null }) => void;
      onStdout?: (chunk: string) => void;
      onStderr?: (chunk: string) => void;
      onExit?: (details: { exitCode?: number | null }) => void;
    };
  }) => Promise<{ stdout: string; stderr: string }>;
  writeLog: (payload: {
    fileName: string;
    jobId: string;
    repoRoot: string;
    branch: string;
    documentId?: string | null;
    worktreePath: string;
    renderedCommand: string;
    input: string;
    stdout?: string;
    stderr?: string;
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
  const existingJob = aiCommandJobsByBranch.get(options.branch);
  if (existingJob?.status === "running") {
    throw new Error(`AI command already running for ${options.branch}.`);
  }

  const jobId = randomUUID();
  const startedAt = new Date().toISOString();
  const fileName = buildAiCommandLogFileName(options.branch, new Date(startedAt));
  const job: AiCommandJob = {
    jobId,
    fileName,
    branch: options.branch,
    documentId: options.documentId ?? null,
    command: options.command,
    input: options.input,
    status: "running",
    startedAt,
    stdout: "",
    stderr: "",
    pid: null,
    exitCode: null,
    processName: null,
  };

  aiCommandJobsByBranch.set(options.branch, job);
  const initialLogPath = await options.writeLog({
    fileName,
    jobId,
    repoRoot: options.repoRoot,
    branch: options.branch,
    documentId: options.documentId ?? null,
    worktreePath: options.worktreePath,
    renderedCommand: options.command,
    input: options.input,
    stdout: job.stdout,
    stderr: job.stderr,
    startedAt,
    completedAt: undefined,
    pid: job.pid,
    exitCode: job.exitCode,
    processName: job.processName,
  });
  if (initialLogPath) {
    aiCommandJobsByBranch.set(options.branch, {
      ...job,
      logPath: initialLogPath,
    });
  }
  emitAiCommandJobUpdate(options.branch);

  const persistSnapshot = async (overrides?: Partial<AiCommandJob>, error?: unknown) => {
    const currentJob = {
      ...(aiCommandJobsByBranch.get(options.branch) ?? job),
      ...(overrides ?? {}),
    };

    const logPath = await options.writeLog({
      fileName,
      jobId,
      repoRoot: options.repoRoot,
      branch: options.branch,
      documentId: options.documentId ?? null,
      worktreePath: options.worktreePath,
      renderedCommand: options.command,
      input: options.input,
      stdout: currentJob.stdout,
      stderr: currentJob.stderr,
      startedAt,
      completedAt: currentJob.completedAt,
      pid: currentJob.pid,
      exitCode: currentJob.exitCode,
      processName: currentJob.processName,
      error,
    });

    if (logPath) {
      aiCommandJobsByBranch.set(options.branch, {
        ...currentJob,
        logPath,
      });
    }
  };

  void (async () => {
    try {
      const hooks = {
        onSpawn: ({ pid, processName }: { pid?: number | null; processName?: string | null }) => {
          const nextJob = {
            ...(aiCommandJobsByBranch.get(options.branch) ?? job),
            pid: pid ?? null,
            processName: processName ?? null,
          };
          aiCommandJobsByBranch.set(options.branch, nextJob);
          emitAiCommandJobUpdate(options.branch);
          void persistSnapshot(nextJob);
        },
        onStdout: (chunk: string) => {
          const nextJob = {
            ...(aiCommandJobsByBranch.get(options.branch) ?? job),
            stdout: `${(aiCommandJobsByBranch.get(options.branch) ?? job).stdout}${chunk}`,
          };
          aiCommandJobsByBranch.set(options.branch, nextJob);
          emitAiCommandJobUpdate(options.branch);
          void persistSnapshot(nextJob);
        },
        onStderr: (chunk: string) => {
          const nextJob = {
            ...(aiCommandJobsByBranch.get(options.branch) ?? job),
            stderr: `${(aiCommandJobsByBranch.get(options.branch) ?? job).stderr}${chunk}`,
          };
          aiCommandJobsByBranch.set(options.branch, nextJob);
          emitAiCommandJobUpdate(options.branch);
          void persistSnapshot(nextJob);
        },
        onExit: ({ exitCode }: { exitCode?: number | null }) => {
          const nextJob = {
            ...(aiCommandJobsByBranch.get(options.branch) ?? job),
            exitCode: exitCode ?? null,
          };
          aiCommandJobsByBranch.set(options.branch, nextJob);
          emitAiCommandJobUpdate(options.branch);
          void persistSnapshot(nextJob);
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
          ...(aiCommandJobsByBranch.get(options.branch) ?? job),
          stdout: result.stdout,
          stderr: result.stderr,
        },
        stdout: result.stdout,
        stderr: result.stderr,
      });
      const completedAt = new Date().toISOString();
      const logPath = await options.writeLog({
        fileName,
        jobId,
        repoRoot: options.repoRoot,
        branch: options.branch,
        documentId: options.documentId ?? null,
        worktreePath: options.worktreePath,
        renderedCommand: options.command,
        input: options.input,
        stdout: result.stdout,
        stderr: result.stderr,
        startedAt,
        completedAt,
        pid: (aiCommandJobsByBranch.get(options.branch) ?? job).pid,
        exitCode: (aiCommandJobsByBranch.get(options.branch) ?? job).exitCode,
        processName: (aiCommandJobsByBranch.get(options.branch) ?? job).processName,
      });

      aiCommandJobsByBranch.set(options.branch, {
        ...(aiCommandJobsByBranch.get(options.branch) ?? job),
        status: "completed",
        completedAt,
        stdout: result.stdout,
        stderr: result.stderr,
        logPath: logPath ?? undefined,
      });
      emitAiCommandJobUpdate(options.branch);
    } catch (error) {
      const completedAt = new Date().toISOString();
      const logPath = await options.writeLog({
        fileName,
        jobId,
        repoRoot: options.repoRoot,
        branch: options.branch,
        documentId: options.documentId ?? null,
        worktreePath: options.worktreePath,
        renderedCommand: options.command,
        input: options.input,
        stdout: (aiCommandJobsByBranch.get(options.branch) ?? job).stdout,
        stderr: (aiCommandJobsByBranch.get(options.branch) ?? job).stderr,
        startedAt,
        completedAt,
        pid: (aiCommandJobsByBranch.get(options.branch) ?? job).pid,
        exitCode: (aiCommandJobsByBranch.get(options.branch) ?? job).exitCode,
        processName: (aiCommandJobsByBranch.get(options.branch) ?? job).processName,
        error,
      });

      aiCommandJobsByBranch.set(options.branch, {
        ...(aiCommandJobsByBranch.get(options.branch) ?? job),
        status: "failed",
        completedAt,
        stderr: `${(aiCommandJobsByBranch.get(options.branch) ?? job).stderr}${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        logPath: logPath ?? undefined,
      });
      emitAiCommandJobUpdate(options.branch);
    }
  })();

  return cloneAiCommandJob(job)!;
}
