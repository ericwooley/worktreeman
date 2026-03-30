import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";

const ANSI_ESCAPE_PATTERN = /\u001B\[[0-?]*[ -/]*[@-~]/g;

interface ManagedAiCommandProcess {
  description: AiCommandProcessDescription;
  child: ChildProcessByStdio<null, Readable, Readable> | null;
  stdout: string;
  stderr: string;
}

const aiCommandProcesses = new Map<string, ManagedAiCommandProcess>();

export interface AiCommandProcessDescription {
  name: string;
  pid?: number;
  status: string;
  createdAt?: string;
  outLogPath?: string;
  errLogPath?: string;
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

function appendManagedOutput(processName: string, source: "stdout" | "stderr", chunk: string) {
  const managed = aiCommandProcesses.get(processName);
  if (!managed) {
    return;
  }

  if (source === "stdout") {
    managed.stdout += chunk;
    return;
  }

  managed.stderr += chunk;
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
  outFile: string;
  errFile: string;
}): Promise<AiCommandProcessDescription> {
  await fs.mkdir(path.dirname(options.outFile), { recursive: true });
  await fs.mkdir(path.dirname(options.errFile), { recursive: true });
  await fs.writeFile(options.outFile, "");
  await fs.writeFile(options.errFile, "");
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
    outLogPath: options.outFile,
    errLogPath: options.errFile,
    exitCode: null,
  };
  aiCommandProcesses.set(options.processName, {
    description,
    child,
    stdout: "",
    stderr: "",
  });

  const stdoutStream = createWriteStream(options.outFile, { flags: "a" });
  const stderrStream = createWriteStream(options.errFile, { flags: "a" });
  let settled = false;

  const finalize = async (status: string, exitCode: number | null) => {
    const managed = aiCommandProcesses.get(options.processName);
    if (managed) {
      managed.description.status = status;
      managed.description.exitCode = exitCode;
      managed.child = null;
    }

    await Promise.all([
      new Promise<void>((resolve) => stdoutStream.end(resolve)),
      new Promise<void>((resolve) => stderrStream.end(resolve)),
    ]);
  };

  child.stdout.on("data", (chunk) => {
    const sanitized = sanitizeAiCommandOutput(chunk.toString());
    if (!sanitized) {
      return;
    }

    appendManagedOutput(options.processName, "stdout", sanitized);
    stdoutStream.write(sanitized);
  });

  child.stderr.on("data", (chunk) => {
    const sanitized = sanitizeAiCommandOutput(chunk.toString());
    if (!sanitized) {
      return;
    }

    appendManagedOutput(options.processName, "stderr", sanitized);
    stderrStream.write(sanitized);
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
    appendManagedOutput(options.processName, "stderr", `${sanitized}\n`);
    stderrStream.write(`${sanitized}\n`);
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

async function readPersistedProcessLog(filePath: string | undefined): Promise<string> {
  if (!filePath) {
    return "";
  }

  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function readAiCommandProcessLogs(processInfo: AiCommandProcessDescription | null): Promise<{ stdout: string; stderr: string }> {
  if (!processInfo) {
    return { stdout: "", stderr: "" };
  }

  const managed = aiCommandProcesses.get(processInfo.name);
  if (managed) {
    return {
      stdout: managed.stdout,
      stderr: managed.stderr,
    };
  }

  return {
    stdout: await readPersistedProcessLog(processInfo.outLogPath),
    stderr: await readPersistedProcessLog(processInfo.errLogPath),
  };
}
