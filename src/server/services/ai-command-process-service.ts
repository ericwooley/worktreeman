import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";
import pm2 from "pm2";
import type { ProcessDescription, StartOptions } from "pm2";

const PM2_NAMESPACE = "worktreeman-ai";

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
  return status === "online" || status === "launching" || status === "waiting restart";
}

async function withPm2<T>(operation: () => Promise<T>): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    pm2.connect((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  try {
    return await operation();
  } finally {
    pm2.disconnect();
  }
}

function toAiCommandProcessDescription(entry: ProcessDescription): [string, AiCommandProcessDescription] | null {
  const name = typeof entry.name === "string" ? entry.name : null;
  if (!name) {
    return null;
  }

  const pid = typeof entry.pid === "number" ? entry.pid : undefined;
  const pm2Env = entry.pm2_env ?? {};
  const createdAt = typeof pm2Env.pm_uptime === "number"
    ? new Date(pm2Env.pm_uptime).toISOString()
    : undefined;
  const status = typeof pm2Env.status === "string" ? pm2Env.status : "unknown";
  const outLogPath = typeof pm2Env.pm_out_log_path === "string" ? pm2Env.pm_out_log_path : undefined;
  const errLogPath = typeof pm2Env.pm_err_log_path === "string" ? pm2Env.pm_err_log_path : undefined;
  const candidateExitCode = (pm2Env as Record<string, unknown>).exit_code;
  const exitCode = typeof candidateExitCode === "number" ? candidateExitCode : null;

  return [name, { name, pid, status, createdAt, outLogPath, errLogPath, exitCode }];
}

export async function listAiCommandProcesses(): Promise<Map<string, AiCommandProcessDescription>> {
  const parsed = await withPm2(() => new Promise<ProcessDescription[]>((resolve, reject) => {
    pm2.list((error, processList) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(processList);
    });
  }));

  const entries: Array<[string, AiCommandProcessDescription]> = [];
  for (const entry of parsed) {
    const description = toAiCommandProcessDescription(entry);
    if (description && description[0].startsWith("wtm:ai:")) {
      entries.push(description);
    }
  }

  return new Map(entries);
}

export async function getAiCommandProcess(processName: string): Promise<AiCommandProcessDescription | null> {
  const processes = await listAiCommandProcesses();
  return processes.get(processName) ?? null;
}

export async function deleteAiCommandProcess(processName: string): Promise<void> {
  await withPm2(() => new Promise<void>((resolve, reject) => {
    pm2.delete(processName, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));
}

export async function startAiCommandProcess(options: {
  processName: string;
  command: string;
  worktreePath: string;
  env: NodeJS.ProcessEnv;
  outFile: string;
  errFile: string;
}): Promise<AiCommandProcessDescription> {
  await fs.mkdir(path.dirname(options.outFile), { recursive: true });
  await fs.mkdir(path.dirname(options.errFile), { recursive: true });
  await fs.writeFile(options.outFile, "", { flag: "a" });
  await fs.writeFile(options.errFile, "", { flag: "a" });
  await deleteAiCommandProcess(options.processName).catch(() => undefined);

  const normalizedEnv = Object.fromEntries(
    Object.entries(options.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const startOptions: StartOptions & { out_file: string; error_file: string } = {
    script: process.env.SHELL || "/usr/bin/bash",
    args: ["-lc", options.command],
    interpreter: "none",
    namespace: PM2_NAMESPACE,
    name: options.processName,
    cwd: options.worktreePath,
    env: normalizedEnv,
    time: true,
    autorestart: false,
    out_file: options.outFile,
    error_file: options.errFile,
  };

  await withPm2(() => new Promise<void>((resolve, reject) => {
    pm2.start(startOptions, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));

  return await getAiCommandProcess(options.processName) ?? {
    name: options.processName,
    status: "launching",
    outLogPath: options.outFile,
    errLogPath: options.errFile,
  };
}

async function readProcessLog(filePath: string | undefined): Promise<string> {
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
  return {
    stdout: await readProcessLog(processInfo?.outLogPath),
    stderr: await readProcessLog(processInfo?.errLogPath),
  };
}

function bindLineStream(
  stream: NodeJS.ReadableStream,
  onChunk: (chunk: string) => void,
): () => void {
  const lineReader = readline.createInterface({ input: stream });

  lineReader.on("line", (line) => {
    onChunk(`${line}\n`);
  });

  return () => {
    lineReader.removeAllListeners();
    lineReader.close();
  };
}

function followFile(filePath: string, onChunk: (chunk: string) => void) {
  const child = spawn("tail", ["-n", "0", "-F", filePath], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const disposeReader = bindLineStream(child.stdout, onChunk);
  return {
    child,
    dispose: () => {
      disposeReader();
      child.kill();
    },
  };
}

export async function streamAiCommandProcessLogs(options: {
  processInfo: AiCommandProcessDescription | null;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  onError?: (message: string) => void;
}): Promise<() => void> {
  const followers: Array<{ child: ReturnType<typeof spawn>; dispose: () => void }> = [];

  if (options.processInfo?.outLogPath && options.onStdout) {
    followers.push(followFile(options.processInfo.outLogPath, options.onStdout));
  }

  if (options.processInfo?.errLogPath && options.onStderr) {
    followers.push(followFile(options.processInfo.errLogPath, options.onStderr));
  }

  for (const follower of followers) {
    follower.child.on("error", (error) => {
      options.onError?.(`AI log stream failed: ${error.message}`);
    });
  }

  return () => {
    for (const follower of followers) {
      follower.dispose();
    }
  };
}
