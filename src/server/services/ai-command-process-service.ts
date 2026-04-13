import process from "node:process";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

export interface AiCommandProcessHooks {
  onStdout?: (chunk: string) => void | Promise<void>;
  onStderr?: (chunk: string) => void | Promise<void>;
}

interface ManagedAiCommandProcess {
  description: AiCommandProcessDescription;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
  callbackQueue: Promise<void>;
  completion: Promise<AiCommandProcessDescription>;
  settleCompletion: {
    resolve: (processInfo: AiCommandProcessDescription) => void;
    reject: (error: unknown) => void;
  };
  hookError: unknown;
}

const aiCommandProcesses = new Map<string, ManagedAiCommandProcess>();

export interface AiCommandProcessDescription {
  name: string;
  pid?: number;
  status: string;
  createdAt?: string;
  exitCode?: number | null;
}

export function getAiCommandProcessName(jobId: string): string {
  return `wtm:ai:${jobId}`;
}

export function isAiCommandProcessActive(status: string | undefined): boolean {
  return status === "online" || status === "launching";
}

async function terminateManagedProcess(processName: string, managed: ManagedAiCommandProcess): Promise<void> {
  const child = managed.child;
  if (child && !child.killed) {
    await new Promise<void>((resolve) => {
      const finish = () => {
        child.off("close", finish);
        child.off("error", finish);
        resolve();
      };

      child.on("close", finish);
      child.on("error", finish);
      child.kill("SIGTERM");
    });
  }

  aiCommandProcesses.delete(processName);
}

function cloneProcessDescription(processInfo: AiCommandProcessDescription): AiCommandProcessDescription {
  return { ...processInfo };
}

function sanitizeAiCommandOutput(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "")
    .replace(ANSI_ESCAPE_PATTERN, "");
}

function enqueueManagedCallback(processName: string, callback: () => void | Promise<void>) {
  const managed = aiCommandProcesses.get(processName);
  if (!managed) {
    return;
  }

  managed.callbackQueue = managed.callbackQueue
    .then(async () => {
      await callback();
    })
    .catch((error) => {
      managed.hookError ??= error;
      const child = managed.child;
      if (child && !child.killed) {
        child.kill("SIGTERM");
      }
    });
}

export async function listAiCommandProcesses(): Promise<Map<string, AiCommandProcessDescription>> {
  return new Map(
    Array.from(aiCommandProcesses.entries()).map(([name, managed]) => [name, cloneProcessDescription(managed.description)]),
  );
}

export async function getAiCommandProcess(processName: string): Promise<AiCommandProcessDescription | null> {
  const managed = aiCommandProcesses.get(processName);
  return managed ? cloneProcessDescription(managed.description) : null;
}

export async function deleteAiCommandProcess(processName: string): Promise<void> {
  const managed = aiCommandProcesses.get(processName);
  if (!managed) {
    return;
  }

  await terminateManagedProcess(processName, managed);
}

export async function stopAllAiCommandProcesses(): Promise<void> {
  const entries = Array.from(aiCommandProcesses.entries());
  await Promise.all(entries.map(async ([processName, managed]) => {
    await terminateManagedProcess(processName, managed);
  }));
}

export async function startAiCommandProcess(options: {
  processName: string;
  command: string;
  input: string;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  hooks?: AiCommandProcessHooks;
}): Promise<AiCommandProcessDescription> {
  await deleteAiCommandProcess(options.processName).catch(() => undefined);

  const shellPath = process.env.SHELL || "/usr/bin/bash";
  const child = spawn(shellPath, ["-lc", options.command], {
    cwd: options.worktreePath,
    env: Object.fromEntries(
      Object.entries({ ...options.env, WTM_AI_INPUT: options.input }).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    stdio: ["ignore", "pipe", "pipe"],
  });

  const description: AiCommandProcessDescription = {
    name: options.processName,
    pid: child.pid,
    status: "launching",
    createdAt: new Date().toISOString(),
    exitCode: null,
  };
  let resolveCompletion!: (processInfo: AiCommandProcessDescription) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<AiCommandProcessDescription>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  aiCommandProcesses.set(options.processName, {
    description,
    child,
    callbackQueue: Promise.resolve(),
    completion,
    settleCompletion: {
      resolve: resolveCompletion,
      reject: rejectCompletion,
    },
    hookError: null,
  });

  let settled = false;

  const finalize = async (status: string, exitCode: number | null) => {
    const managed = aiCommandProcesses.get(options.processName);
    if (!managed) {
      return;
    }

    managed.description.status = status;
    managed.description.exitCode = exitCode;
    managed.child = null;
    await managed.callbackQueue.catch(() => undefined);

    const snapshot = cloneProcessDescription(managed.description);
    if (managed.hookError) {
      managed.settleCompletion.reject(managed.hookError);
      return;
    }

    managed.settleCompletion.resolve(snapshot);
  };

  child.stdout.on("data", (chunk) => {
    const sanitized = sanitizeAiCommandOutput(chunk.toString());
    if (!sanitized) {
      return;
    }

    if (options.hooks?.onStdout) {
      enqueueManagedCallback(options.processName, () => options.hooks?.onStdout?.(sanitized));
    }
  });

  child.stderr.on("data", (chunk) => {
    const sanitized = sanitizeAiCommandOutput(chunk.toString());
    if (!sanitized) {
      return;
    }

    if (options.hooks?.onStderr) {
      enqueueManagedCallback(options.processName, () => options.hooks?.onStderr?.(sanitized));
    }
  });

  child.on("spawn", () => {
    const managed = aiCommandProcesses.get(options.processName);
    if (managed) {
      managed.description.status = "online";
      managed.description.pid = child.pid;
    }
  });

  child.on("error", (error) => {
    if (settled) {
      return;
    }

    settled = true;
    const sanitized = sanitizeAiCommandOutput(error.message);
    if (sanitized && options.hooks?.onStderr) {
      enqueueManagedCallback(options.processName, () => options.hooks?.onStderr?.(`${sanitized}\n`));
    }
    void finalize("errored", null);
  });

  child.on("close", (code, signal) => {
    if (settled) {
      return;
    }

    settled = true;
    const exitCode = typeof code === "number" ? code : null;
    const status = signal ? "stopped" : exitCode === 0 ? "stopped" : "errored";
    void finalize(status, exitCode);
  });

  return cloneProcessDescription(description);
}

export async function waitForAiCommandProcess(processName: string): Promise<AiCommandProcessDescription | null> {
  const managed = aiCommandProcesses.get(processName);
  if (!managed) {
    return null;
  }

  return await managed.completion;
}
