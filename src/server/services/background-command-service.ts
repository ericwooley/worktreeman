import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import readline from "node:readline";
import type {
  BackgroundCommandConfigEntry,
  BackgroundCommandLogLine,
  BackgroundCommandLogsResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandState,
  WorktreeManagerConfig,
  WorktreeRuntime,
} from "../../shared/types.js";
import { runCommand } from "../utils/process.js";
import { sanitizeBranchName } from "../utils/paths.js";
import { renderDerivedEnv } from "./config-service.js";
const PM2_BIN = path.resolve(import.meta.dirname, "../../../node_modules/.bin/pm2");
const DOCKER_COMPOSE_PATTERN = /^docker\s+compose\s+up(?:\s|$)/i;
const PM2_NAMESPACE = "worktreemanager";
const LOG_LINES_LIMIT = 400;
export const INTEGRAL_ENVIRONMENT_COMMAND_NAME = "docker compose";
export const LEGACY_INTEGRAL_ENVIRONMENT_COMMAND_NAME = "Environment";
let streamedLogSequence = 0;

interface Pm2ProcessDescription {
  name: string;
  pid?: number;
  status: string;
  createdAt?: string;
  outLogPath?: string;
  errLogPath?: string;
}

interface BackgroundCommandMetadata {
  branch: string;
  commandName: string;
  command: string;
  worktreePath: string;
  composeProject: string;
  runtimeEnv: Record<string, string>;
}

function getPm2CommandName(branch: string, commandName: string): string {
  return `wtm:${branch}:${commandName}`;
}

export function normalizeBackgroundCommandName(commandName: string): string {
  return commandName === LEGACY_INTEGRAL_ENVIRONMENT_COMMAND_NAME
    ? INTEGRAL_ENVIRONMENT_COMMAND_NAME
    : commandName;
}

export function getBackgroundCommandEntries(config: WorktreeManagerConfig): Record<string, BackgroundCommandConfigEntry> {
  const entries: Record<string, BackgroundCommandConfigEntry> = {
    ...(config.backgroundCommands ?? {}),
  };

  const hasRuntimeManagedEntry = Object.values(entries).some((entry) => isRuntimeManagedBackgroundCommand(entry.command));
  if (!hasRuntimeManagedEntry) {
    entries[INTEGRAL_ENVIRONMENT_COMMAND_NAME] = { command: "docker compose up -d" };
  }

  return entries;
}

export function isRuntimeManagedBackgroundCommand(command: string): boolean {
  return DOCKER_COMPOSE_PATTERN.test(command);
}

function getPm2MetadataPath(processName: string): string {
  return path.join(os.tmpdir(), `${processName.replace(/[^a-zA-Z0-9_.-]+/g, "_")}.json`);
}

function buildBackgroundEnv(config: WorktreeManagerConfig, runtime: WorktreeRuntime): NodeJS.ProcessEnv {
  const baseEnv = {
    ...config.env,
    ...Object.fromEntries(Object.entries(runtime.allocatedPorts).map(([key, value]) => [key, String(value)])),
    ...Object.fromEntries(runtime.ports.map((binding) => [binding.envName, String(binding.hostPort)])),
  };

  const env = {
    ...baseEnv,
    ...renderDerivedEnv(config.derivedEnv ?? {}, baseEnv),
    ...runtime.env,
    WORKTREE_BRANCH: runtime.branch,
    WORKTREE_PATH: runtime.worktreePath,
    TMUX_SESSION_NAME: runtime.tmuxSession,
  };

  return {
    ...process.env,
    ...env,
  };
}

async function runPm2(args: string[], cwd: string, env?: NodeJS.ProcessEnv) {
  return runCommand(PM2_BIN, args, { cwd, env });
}

async function listPm2Processes(cwd: string): Promise<Map<string, Pm2ProcessDescription>> {
  const { stdout } = await runPm2(["jlist"], cwd);
  const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
  const entries: Array<[string, Pm2ProcessDescription]> = [];

  for (const entry of parsed) {
    const name = typeof entry.name === "string" ? entry.name : null;
    if (!name) {
      continue;
    }

    const pid = typeof entry.pid === "number" ? entry.pid : undefined;
    const pm2Env = (entry.pm2_env as Record<string, unknown> | undefined) ?? {};
    const createdAt = typeof pm2Env.pm_uptime === "number"
      ? new Date(pm2Env.pm_uptime).toISOString()
      : undefined;
    const status = typeof pm2Env.status === "string" ? pm2Env.status : "unknown";
    const outLogPath = typeof pm2Env.pm_out_log_path === "string" ? pm2Env.pm_out_log_path : undefined;
    const errLogPath = typeof pm2Env.pm_err_log_path === "string" ? pm2Env.pm_err_log_path : undefined;

    entries.push([name, { name, pid, status, createdAt, outLogPath, errLogPath }]);
  }

  return new Map(entries);
}

async function writeMetadata(processName: string, metadata: BackgroundCommandMetadata): Promise<void> {
  await fs.writeFile(getPm2MetadataPath(processName), JSON.stringify(metadata), "utf8");
}

async function readMetadata(processName: string): Promise<BackgroundCommandMetadata | null> {
  try {
    const raw = await fs.readFile(getPm2MetadataPath(processName), "utf8");
    return JSON.parse(raw) as BackgroundCommandMetadata;
  } catch {
    return null;
  }
}

async function deleteMetadata(processName: string): Promise<void> {
  await fs.rm(getPm2MetadataPath(processName), { force: true });
}

export async function listBackgroundCommands(
  config: WorktreeManagerConfig,
  branch: string,
  worktreePath: string,
  runtime: WorktreeRuntime | undefined,
): Promise<BackgroundCommandState[]> {
  const processes = await listPm2Processes(worktreePath);
  const commandEntries = getBackgroundCommandEntries(config);

  return Object.entries(commandEntries).map(([name, entry]) => {
    const processName = getPm2CommandName(branch, name);
    const processInfo = processes.get(processName);
    const isDockerComposeUp = DOCKER_COMPOSE_PATTERN.test(entry.command);
    const requiresRuntime = !isDockerComposeUp;
    const hasRuntime = Boolean(runtime);

    return {
      name,
      command: entry.command,
      processName,
      manager: isDockerComposeUp ? "runtime" : "pm2",
      running: isDockerComposeUp ? hasRuntime : processInfo?.status === "online",
      status: isDockerComposeUp ? (hasRuntime ? "online" : "stopped") : processInfo?.status ?? "stopped",
      requiresRuntime,
      canStart: isDockerComposeUp || hasRuntime,
      note: !isDockerComposeUp && !hasRuntime ? "Start environment first" : undefined,
      pid: isDockerComposeUp ? undefined : processInfo?.pid,
      startedAt: isDockerComposeUp ? runtime?.dockerStartedAt : processInfo?.createdAt,
    };
  });
}

export async function startBackgroundCommand(options: {
  config: WorktreeManagerConfig;
  branch: string;
  worktreePath: string;
  runtime: WorktreeRuntime | undefined;
  commandName: string;
}): Promise<void> {
  const normalizedCommandName = normalizeBackgroundCommandName(options.commandName);
  const entry = getBackgroundCommandEntries(options.config)[normalizedCommandName];
  if (!entry) {
    throw new Error(`Unknown background command ${options.commandName}.`);
  }

  if (isRuntimeManagedBackgroundCommand(entry.command)) {
    return;
  }

  const processName = getPm2CommandName(options.branch, normalizedCommandName);
  await runPm2(["delete", processName], options.worktreePath).catch(() => undefined);

  const runtime = options.runtime;

  if (!runtime) {
    throw new Error(`Background command ${options.commandName} requires the environment to be started first.`);
  }

  const env = buildBackgroundEnv(options.config, runtime);
  const metadata: BackgroundCommandMetadata = {
    branch: options.branch,
    commandName: normalizedCommandName,
    command: entry.command,
    worktreePath: options.worktreePath,
    composeProject: runtime.composeProject,
    runtimeEnv: runtime.env,
  };

  await writeMetadata(processName, metadata);

  try {
    await runPm2(
      [
        "start",
        process.env.SHELL || "/usr/bin/bash",
        "--interpreter",
        "none",
        "--namespace",
        PM2_NAMESPACE,
        "--name",
        processName,
        "--cwd",
        options.worktreePath,
        "--time",
        "--",
        "-lc",
        entry.command,
      ],
      options.worktreePath,
      env,
    );
  } catch (error) {
    await deleteMetadata(processName);
    throw error;
  }
}

export async function stopBackgroundCommand(branch: string, worktreePath: string, commandName: string): Promise<void> {
  const processName = getPm2CommandName(branch, normalizeBackgroundCommandName(commandName));
  await runPm2(["delete", processName], worktreePath);
  await deleteMetadata(processName);
}

function parseLogTimestamp(line: string): { timestamp?: string; text: string } {
  const match = line.match(/^\d+\|[^|]*\|\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}):\s?(.*)$/);
  if (!match) {
    return { text: line };
  }

  return {
    timestamp: new Date(match[1]).toISOString(),
    text: match[2] ?? "",
  };
}

function parsePm2LogOutput(raw: string): BackgroundCommandLogLine[] {
  const sections = raw.split(/\n\n+/);
  const lines: BackgroundCommandLogLine[] = [];

  for (const section of sections) {
    const header = section.split(/\r?\n/)[0] ?? "";
    const source = header.includes("error.log") ? "stderr" : "stdout";
    const bodyLines = section
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.trimEnd())
      .filter(Boolean);

    for (const line of bodyLines) {
      const parsed = parseLogTimestamp(line);
      lines.push({
        id: `${source}:${lines.length}:${parsed.timestamp ?? ""}:${parsed.text}`,
        source,
        text: parsed.text,
        timestamp: parsed.timestamp,
      });
    }
  }

  return lines.slice(-LOG_LINES_LIMIT);
}

function buildRawLogLines(source: "stdout" | "stderr", raw: string): BackgroundCommandLogLine[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((text, index) => ({
      id: `${source}:${index}:${text}`,
      source,
      text,
    }));
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

function buildComposeProjectName(config: WorktreeManagerConfig, branch: string): string {
  return `${config.docker.projectPrefix ?? "wt"}-${sanitizeBranchName(branch)}`;
}

function buildComposeLogsArgs(config: WorktreeManagerConfig, branch: string): string[] {
  const args = ["compose", "-p", buildComposeProjectName(config, branch)];

  if (config.docker.composeFile) {
    args.push("-f", config.docker.composeFile);
  }

  args.push("logs", "--tail", String(LOG_LINES_LIMIT));
  return args;
}

function buildComposeFollowLogsArgs(config: WorktreeManagerConfig, branch: string): string[] {
  const args = ["compose", "-p", buildComposeProjectName(config, branch)];

  if (config.docker.composeFile) {
    args.push("-f", config.docker.composeFile);
  }

  args.push("logs", "--follow", "--tail", "0");
  return args;
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
  branch: string,
  worktreePath: string,
  commandName: string,
): Promise<BackgroundCommandLogsResponse> {
  const normalizedCommandName = normalizeBackgroundCommandName(commandName);
  const entry = getBackgroundCommandEntries(config)[normalizedCommandName];
  if (!entry) {
    throw new Error(`Unknown background command ${commandName}.`);
  }

  if (isRuntimeManagedBackgroundCommand(entry.command)) {
    const { stdout, stderr } = await runCommand("docker", buildComposeLogsArgs(config, branch), { cwd: worktreePath }).catch(() => ({ stdout: "", stderr: "" }));

    return {
      commandName: normalizedCommandName,
      lines: [...buildRawLogLines("stdout", stdout), ...buildRawLogLines("stderr", stderr)].slice(-LOG_LINES_LIMIT),
    };
  }

  const processName = getPm2CommandName(branch, normalizedCommandName);
  const { stdout, stderr } = await runPm2(["logs", processName, "--nostream", "--lines", String(LOG_LINES_LIMIT)], worktreePath).catch(() => ({ stdout: "", stderr: "" }));
  const pm2Output = [stdout, stderr].filter(Boolean).join("\n").trim();

  return {
    commandName: normalizedCommandName,
    lines: parsePm2LogOutput(pm2Output),
  };
}

export async function streamBackgroundCommandLogs(options: {
  config: WorktreeManagerConfig;
  branch: string;
  worktreePath: string;
  commandName: string;
  onEvent: (event: BackgroundCommandLogStreamEvent) => void;
  onError?: (message: string) => void;
}): Promise<() => void> {
  const normalizedCommandName = normalizeBackgroundCommandName(options.commandName);
  const entry = getBackgroundCommandEntries(options.config)[normalizedCommandName];
  if (!entry) {
    throw new Error(`Unknown background command ${options.commandName}.`);
  }

  if (isRuntimeManagedBackgroundCommand(entry.command)) {
    const child = spawn("docker", buildComposeFollowLogsArgs(options.config, options.branch), {
      cwd: options.worktreePath,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const disposeStdout = bindLineStream(child.stdout, "stdout", (lines) => {
      options.onEvent({ type: "append", commandName: normalizedCommandName, lines });
    });
    const disposeStderr = bindLineStream(child.stderr, "stderr", (lines) => {
      options.onEvent({ type: "append", commandName: normalizedCommandName, lines });
    });

    child.on("error", (error) => {
      options.onError?.(`Background log stream failed for ${normalizedCommandName}: ${error.message}`);
    });

    return () => {
      disposeStdout();
      disposeStderr();
      child.kill();
    };
  }

  const processName = getPm2CommandName(options.branch, normalizedCommandName);
  const processInfo = (await listPm2Processes(options.worktreePath)).get(processName);

  if (!processInfo) {
    return () => undefined;
  }

  const followers = [
    processInfo.outLogPath ? spawnTailFollower(processInfo.outLogPath, "stdout", (lines) => {
      options.onEvent({ type: "append", commandName: normalizedCommandName, lines });
    }) : null,
    processInfo.errLogPath ? spawnTailFollower(processInfo.errLogPath, "stderr", (lines) => {
      options.onEvent({ type: "append", commandName: normalizedCommandName, lines });
    }) : null,
  ].filter((entry): entry is { child: ReturnType<typeof spawn>; dispose: () => void } => entry !== null);

  for (const follower of followers) {
    follower.child.on("error", (error) => {
      options.onError?.(`Background log stream failed for ${normalizedCommandName}: ${error.message}`);
    });
  }

  return () => {
    for (const follower of followers) {
      follower.dispose();
    }
  };
}

export async function stopAllBackgroundCommands(branch: string, worktreePath: string): Promise<void> {
  const processes = await listPm2Processes(worktreePath);
  const branchPrefix = `wtm:${branch}:`;

  await Promise.all(
    [...processes.keys()]
      .filter((name) => name.startsWith(branchPrefix))
      .map(async (name) => {
        await runPm2(["delete", name], worktreePath).catch(() => undefined);
        await deleteMetadata(name);
      }),
  );
}

export async function stopAllBackgroundCommandsForShutdown(worktreePath: string): Promise<void> {
  const processes = await listPm2Processes(worktreePath).catch(() => new Map<string, Pm2ProcessDescription>());

  await Promise.all(
    [...processes.keys()]
      .filter((name) => name.startsWith("wtm:"))
      .map(async (name) => {
        const metadata = await readMetadata(name);
        if (metadata?.worktreePath !== worktreePath) {
          return;
        }

        await runPm2(["delete", name], worktreePath).catch(() => undefined);
        await deleteMetadata(name);
      }),
  );
}
