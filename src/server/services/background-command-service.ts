import fs from "node:fs/promises";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import pm2 from "pm2";
import type { ProcessDescription, StartOptions } from "pm2";
import { PM2_PROCESS_PREFIX, Pm2ProcessStatus, WORKTREEMAN_NAMESPACE } from "../../shared/constants.js";
import type {
  BackgroundCommandConfigEntry,
  BackgroundCommandLogLine,
  BackgroundCommandLogsResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandState,
  WorktreeManagerConfig,
  WorktreeRecord,
  WorktreeRuntime,
} from "../../shared/types.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import { createOperationalStateStore } from "./operational-state-service.js";
import { buildRuntimeProcessEnv } from "./runtime-service.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";

const LOG_LINES_LIMIT = 400;
let streamedLogSequence = 0;

interface Pm2ProcessDescription {
  name: string;
  pid?: number;
  status: string;
  createdAt?: string;
  outLogPath?: string;
  errLogPath?: string;
  namespace?: string;
}

interface BackgroundCommandTarget {
  id: WorktreeId;
  branch: string;
  worktreePath: string;
}

function getPm2CommandName(worktreeId: WorktreeId, commandName: string): string {
  return `${PM2_PROCESS_PREFIX}${worktreeId}:${commandName}`;
}

function getPm2Namespace(worktreeId: WorktreeId): string {
  return `${WORKTREEMAN_NAMESPACE}:${worktreeId}`;
}

export function getBackgroundCommandEntries(config: WorktreeManagerConfig): Record<string, BackgroundCommandConfigEntry> {
  return {
    ...(config.backgroundCommands ?? {}),
  };
}

function buildBackgroundEnv(config: WorktreeManagerConfig, runtime: WorktreeRuntime): Record<string, string> {
  void config;
  return Object.fromEntries(
    Object.entries(buildRuntimeProcessEnv(runtime)).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
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
    const disconnectPm2 = pm2.disconnect.bind(pm2) as unknown as (callback?: () => void) => void;
    await new Promise<void>((resolve) => {
      disconnectPm2(() => resolve());
    });
  }
}

function toPm2ProcessDescription(entry: ProcessDescription): [string, Pm2ProcessDescription] | null {
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
  const namespace = typeof (pm2Env as { namespace?: unknown }).namespace === "string"
    ? (pm2Env as { namespace: string }).namespace
    : undefined;

  return [name, { name, pid, status, createdAt, outLogPath, errLogPath, namespace }];
}

async function listPm2Processes(): Promise<Map<string, Pm2ProcessDescription>> {
  const parsed = await withPm2(() => new Promise<ProcessDescription[]>((resolve, reject) => {
    pm2.list((error, processList) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(processList);
    });
  }));

  const entries: Array<[string, Pm2ProcessDescription]> = [];

  for (const entry of parsed) {
    const description = toPm2ProcessDescription(entry);
    if (description) {
      entries.push(description);
    }
  }

  return new Map(entries);
}

async function deletePm2Process(processName: string): Promise<void> {
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

async function startPm2Process(options: StartOptions): Promise<void> {
  await withPm2(() => new Promise<void>((resolve, reject) => {
    pm2.start(options, (error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  }));
}

function isRunningPm2Status(status: string | undefined): boolean {
  return status === Pm2ProcessStatus.Online || status === Pm2ProcessStatus.Launching;
}

function normalizePm2Status(status: string | undefined): string {
  if (status === Pm2ProcessStatus.Launching) {
    return Pm2ProcessStatus.Online;
  }

  return status ?? Pm2ProcessStatus.Stopped;
}

async function readLogLines(filePath: string | undefined, source: "stdout" | "stderr"): Promise<BackgroundCommandLogLine[]> {
  if (!filePath) {
    return [];
  }

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(-LOG_LINES_LIMIT);

    return lines.map((text, index) => ({
      id: `${source}:history:${index}:${text}`,
      source,
      text,
    }));
  } catch {
    return [];
  }
}

export async function listBackgroundCommands(
  config: WorktreeManagerConfig,
  repoRoot: string,
  worktree: BackgroundCommandTarget,
  runtime: WorktreeRuntime | undefined,
): Promise<BackgroundCommandState[]> {
  const processes = await listPm2Processes();
  const commandEntries = getBackgroundCommandEntries(config);
  const operationalState = await createOperationalStateStore(repoRoot);
  const metadataByProcessName = new Map(
    (await operationalState.listBackgroundCommandMetadataByWorktreeId(worktree.id)).map((entry) => [entry.processName, entry]),
  );

  return await Promise.all(Object.entries(commandEntries).map(async ([name, entry]) => {
    const processName = getPm2CommandName(worktree.id, name);
    const processInfo = processes.get(processName);
    const metadata = metadataByProcessName.get(processName);
    const hasRuntime = Boolean(runtime);
    const inferredRunning = processInfo
      ? isRunningPm2Status(processInfo.status)
      : Boolean(metadata && metadata.worktreePath === worktree.worktreePath);

    return {
      name,
      command: entry.command,
      processName,
      manager: "pm2",
      running: inferredRunning,
      status: processInfo ? normalizePm2Status(processInfo.status) : inferredRunning ? Pm2ProcessStatus.Online : Pm2ProcessStatus.Stopped,
      requiresRuntime: true,
      canStart: hasRuntime,
      note: !hasRuntime ? "Start the environment first so this command gets the configured runtime ports and env." : undefined,
      pid: processInfo?.pid,
      startedAt: processInfo?.createdAt,
    };
  }));
}

export async function startBackgroundCommand(options: {
  config: WorktreeManagerConfig;
  repoRoot: string;
  worktree: BackgroundCommandTarget;
  runtime: WorktreeRuntime | undefined;
  commandName: string;
}): Promise<void> {
  const startedAt = Date.now();
  const entry = getBackgroundCommandEntries(options.config)[options.commandName];
  if (!entry) {
    throw new Error(`Unknown background command ${options.commandName}.`);
  }

  const processName = getPm2CommandName(options.worktree.id, options.commandName);
  const operationalState = await createOperationalStateStore(options.repoRoot);
  await deletePm2Process(processName).catch(() => undefined);
  await operationalState.deleteBackgroundCommandMetadata(processName);

  const runtime = options.runtime;

  if (!runtime) {
    throw new Error(`Background command ${options.commandName} requires the environment to be started first.`);
  }

  const env = buildBackgroundEnv(options.config, runtime);
  await operationalState.setBackgroundCommandMetadata({
    processName,
    worktreeId: options.worktree.id,
    branch: options.worktree.branch,
    commandName: options.commandName,
    command: entry.command,
    worktreePath: options.worktree.worktreePath,
    runtimeEnv: runtime.env,
  });

  try {
    await startPm2Process({
      script: process.env.SHELL || "/usr/bin/bash",
      args: ["-lc", entry.command],
      interpreter: "none",
      namespace: getPm2Namespace(options.worktree.id),
      name: processName,
      cwd: options.worktree.worktreePath,
      time: true,
      env,
    });
    logServerEvent("background-command", "started", {
      worktreeId: options.worktree.id,
      branch: options.worktree.branch,
      commandName: options.commandName,
      processName,
      worktreePath: options.worktree.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
    });
  } catch (error) {
    await operationalState.deleteBackgroundCommandMetadata(processName);
    logServerEvent("background-command", "failed-to-start", {
      worktreeId: options.worktree.id,
      branch: options.worktree.branch,
      commandName: options.commandName,
      processName,
      worktreePath: options.worktree.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    }, "error");
    throw error;
  }
}

export async function startConfiguredBackgroundCommands(options: {
  config: WorktreeManagerConfig;
  repoRoot: string;
  worktree: BackgroundCommandTarget;
  runtime: WorktreeRuntime;
}): Promise<void> {
  const entries = getBackgroundCommandEntries(options.config);

  for (const [commandName] of Object.entries(entries)) {
    await startBackgroundCommand({
      config: options.config,
      repoRoot: options.repoRoot,
      worktree: options.worktree,
      runtime: options.runtime,
      commandName,
    });
  }
}

export async function stopBackgroundCommand(repoRoot: string, worktree: BackgroundCommandTarget, commandName: string): Promise<void> {
  const startedAt = Date.now();
  const processName = getPm2CommandName(worktree.id, commandName);
  const operationalState = await createOperationalStateStore(repoRoot);
  const metadata = await operationalState.getBackgroundCommandMetadata(processName);
  if (metadata && metadata.worktreePath !== worktree.worktreePath) {
    return;
  }

  await deletePm2Process(processName).catch(() => undefined);
  await operationalState.deleteBackgroundCommandMetadata(processName);
  logServerEvent("background-command", "stopped", {
    worktreeId: worktree.id,
    branch: worktree.branch,
    commandName,
    processName,
    worktreePath: worktree.worktreePath,
    duration: formatDurationMs(Date.now() - startedAt),
  });
}

export async function restartBackgroundCommand(options: {
  config: WorktreeManagerConfig;
  repoRoot: string;
  worktree: BackgroundCommandTarget;
  runtime: WorktreeRuntime | undefined;
  commandName: string;
}): Promise<void> {
  await startBackgroundCommand(options);
}

function createStreamLogLine(source: "stdout" | "stderr", text: string): BackgroundCommandLogLine {
  streamedLogSequence += 1;

  return {
    id: `${source}:stream:${streamedLogSequence}`,
    source,
    text,
    timestamp: new Date().toISOString(),
  };
}

function bindLineStream(
  stream: NodeJS.ReadableStream,
  source: "stdout" | "stderr",
  onLines: (lines: BackgroundCommandLogLine[]) => void,
): () => void {
  const lineReader = readline.createInterface({ input: stream });

  lineReader.on("line", (line) => {
    const text = line.trimEnd();
    if (!text) {
      return;
    }

    onLines([createStreamLogLine(source, text)]);
  });

  return () => {
    lineReader.removeAllListeners();
    lineReader.close();
  };
}

function spawnTailFollower(
  filePath: string,
  source: "stdout" | "stderr",
  onLines: (lines: BackgroundCommandLogLine[]) => void,
): { child: ReturnType<typeof spawn>; dispose: () => void } {
  const child = spawn("tail", ["-n", "0", "-F", filePath], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const disposeReader = bindLineStream(child.stdout, source, onLines);

  return {
    child,
    dispose: () => {
      disposeReader();
      child.kill();
    },
  };
}

export async function getBackgroundCommandLogs(
  config: WorktreeManagerConfig,
  worktree: BackgroundCommandTarget,
  commandName: string,
): Promise<BackgroundCommandLogsResponse> {
  const entry = getBackgroundCommandEntries(config)[commandName];
  if (!entry) {
    throw new Error(`Unknown background command ${commandName}.`);
  }

  void entry;
  const processName = getPm2CommandName(worktree.id, commandName);
  const processInfo = (await listPm2Processes().catch(() => new Map<string, Pm2ProcessDescription>())).get(processName);

  return {
    commandName,
    lines: processInfo
      ? [
          ...(await readLogLines(processInfo.outLogPath, "stdout")),
          ...(await readLogLines(processInfo.errLogPath, "stderr")),
        ].slice(-LOG_LINES_LIMIT)
      : [],
  };
}

export async function streamBackgroundCommandLogs(options: {
  config: WorktreeManagerConfig;
  worktree: BackgroundCommandTarget;
  commandName: string;
  onEvent: (event: BackgroundCommandLogStreamEvent) => void;
  onError?: (message: string) => void;
}): Promise<() => void> {
  const entry = getBackgroundCommandEntries(options.config)[options.commandName];
  if (!entry) {
    throw new Error(`Unknown background command ${options.commandName}.`);
  }

  void entry;
  const processName = getPm2CommandName(options.worktree.id, options.commandName);
  const processInfo = (await listPm2Processes()).get(processName);

  if (!processInfo) {
    return () => undefined;
  }

  const followers = [
    processInfo.outLogPath ? spawnTailFollower(processInfo.outLogPath, "stdout", (lines) => {
      options.onEvent({ type: "append", commandName: options.commandName, lines });
    }) : null,
    processInfo.errLogPath ? spawnTailFollower(processInfo.errLogPath, "stderr", (lines) => {
      options.onEvent({ type: "append", commandName: options.commandName, lines });
    }) : null,
  ].filter((entry): entry is { child: ReturnType<typeof spawn>; dispose: () => void } => entry !== null);

  for (const follower of followers) {
    follower.child.on("error", (error) => {
      options.onError?.(`Background log stream failed for ${options.commandName}: ${error.message}`);
    });
  }

  return () => {
    for (const follower of followers) {
      follower.dispose();
    }
  };
}

export async function stopAllBackgroundCommands(repoRoot: string, worktree: BackgroundCommandTarget): Promise<void> {
  const operationalState = await createOperationalStateStore(repoRoot);
  const processes = await listPm2Processes().catch(() => new Map<string, Pm2ProcessDescription>());
  const namespace = getPm2Namespace(worktree.id);
  const processNames = new Set([
    ...[...processes.entries()]
      .filter(([name, process]) => name.startsWith(`${PM2_PROCESS_PREFIX}${worktree.id}:`) && process.namespace === namespace)
      .map(([name]) => name),
    ...(await operationalState.listBackgroundCommandMetadataByWorktreeId(worktree.id)).map((entry) => entry.processName),
  ]);

  await Promise.all(
    [...processNames]
      .map(async (name) => {
        const metadata = await operationalState.getBackgroundCommandMetadata(name);
        if (metadata && metadata.worktreePath !== worktree.worktreePath) {
          return;
        }

        await deletePm2Process(name).catch(() => undefined);
        await operationalState.deleteBackgroundCommandMetadata(name);
      }),
  );
}

export async function stopAllBackgroundCommandsForShutdown(
  repoRoot: string,
  worktree: Pick<WorktreeRecord, "id" | "worktreePath">,
): Promise<void> {
  const operationalState = await createOperationalStateStore(repoRoot);
  const processes = await listPm2Processes().catch(() => new Map<string, Pm2ProcessDescription>());
  const namespace = getPm2Namespace(worktree.id);
  const processNames = new Set([
    ...[...processes.entries()]
      .filter(([name, process]) => name.startsWith(`${PM2_PROCESS_PREFIX}${worktree.id}:`) && process.namespace === namespace)
      .map(([name]) => name),
    ...(await operationalState.listBackgroundCommandMetadataByWorktreeId(worktree.id)).map((entry) => entry.processName),
  ]);

  await Promise.all(
    [...processNames]
      .map(async (name) => {
        const metadata = await operationalState.getBackgroundCommandMetadata(name);
        if (metadata?.worktreePath !== worktree.worktreePath) {
          return;
        }

        await deletePm2Process(name).catch(() => undefined);
        await operationalState.deleteBackgroundCommandMetadata(name);
      }),
  );
}
