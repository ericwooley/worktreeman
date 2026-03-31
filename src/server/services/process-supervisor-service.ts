import path from "node:path";
import process from "node:process";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type ManagedRuntimeRole = "server" | "worker";

export interface ManagedRuntimeProcessReadyEvent {
  role: ManagedRuntimeRole;
  url?: string;
  port?: number;
  host?: string;
  repoRoot?: string;
}

export interface StartManagedRuntimeProcessOptions {
  role: ManagedRuntimeRole;
  cwd: string;
  databaseUrl: string;
  port?: number;
  host?: string;
  dangerouslyExposeToNetwork?: boolean;
  openBrowser?: boolean;
  onExit?: (details: { role: ManagedRuntimeRole; code: number | null; signal: NodeJS.Signals | null }) => void;
}

export interface ManagedRuntimeProcess {
  role: ManagedRuntimeRole;
  process: ChildProcess;
  ready: Promise<ManagedRuntimeProcessReadyEvent>;
  stop: () => Promise<void>;
}

export type ManagedRuntimeRestartMode = "serial" | "overlap";

const CHILD_STOP_TIMEOUT_MS = 65_000;

function resolveEntrypointPath(role: ManagedRuntimeRole) {
  const currentFilePath = fileURLToPath(import.meta.url);
  const extension = path.extname(currentFilePath);
  const entrypointExtension = extension === ".ts" ? ".ts" : ".js";
  return path.resolve(path.dirname(currentFilePath), "..", "entrypoints", `${role}-entrypoint${entrypointExtension}`);
}

function buildChildCommand(role: ManagedRuntimeRole, options: StartManagedRuntimeProcessOptions) {
  const entrypointPath = resolveEntrypointPath(role);
  const isSourceEntrypoint = entrypointPath.endsWith(".ts");
  const args = isSourceEntrypoint ? ["--import", "tsx", entrypointPath] : [entrypointPath];

  args.push("--cwd", options.cwd, "--database-url", options.databaseUrl);

  if (role === "server") {
    if (typeof options.port === "number") {
      args.push("--port", String(options.port));
    }
    if (options.host) {
      args.push("--host", options.host);
    }
    if (options.dangerouslyExposeToNetwork) {
      args.push("--dangerously-expose-to-network");
    }
    args.push(options.openBrowser ? "--open" : "--no-open");
  }

  return {
    command: process.execPath,
    args,
  };
}

function prefixLine(role: ManagedRuntimeRole, line: string) {
  return `[${role}] ${line}`;
}

async function stopChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, CHILD_STOP_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill("SIGTERM");
  });
}

export async function restartManagedRuntimeProcess(options: {
  mode: ManagedRuntimeRestartMode;
  current: ManagedRuntimeProcess | null;
  start: () => Promise<ManagedRuntimeProcess>;
  onReplaced?: (next: ManagedRuntimeProcess) => void | Promise<void>;
}): Promise<ManagedRuntimeProcess> {
  if (options.mode === "overlap") {
    const next = await options.start();
    await options.onReplaced?.(next);
    await options.current?.stop();
    return next;
  }

  await options.current?.stop();
  const next = await options.start();
  await options.onReplaced?.(next);
  return next;
}

export function startManagedRuntimeProcess(options: StartManagedRuntimeProcessOptions): ManagedRuntimeProcess {
  const { command, args } = buildChildCommand(options.role, options);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      WTM_DATABASE_URL: options.databaseUrl,
      WTM_SERVER_ROLE: options.role,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let readyResolved = false;
  let resolveReady!: (event: ManagedRuntimeProcessReadyEvent) => void;
  let rejectReady!: (error: Error) => void;

  const ready = new Promise<ManagedRuntimeProcessReadyEvent>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const tryHandleReadyLine = (line: string) => {
    try {
      const parsed = JSON.parse(line) as { type?: string; url?: string; port?: number; host?: string; repoRoot?: string };
      if (options.role === "server" && parsed.type === "server-ready" && typeof parsed.url === "string") {
        readyResolved = true;
        resolveReady({
          role: "server",
          url: parsed.url,
          port: parsed.port,
          host: parsed.host,
        });
        return true;
      }

      if (options.role === "worker" && parsed.type === "worker-ready") {
        readyResolved = true;
        resolveReady({
          role: "worker",
          repoRoot: parsed.repoRoot,
        });
        return true;
      }
    } catch {
      // normal non-JSON child output
    }

    return false;
  };

  const flushStdout = () => {
    let newlineIndex = stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (!tryHandleReadyLine(line) && line) {
        process.stdout.write(`${prefixLine(options.role, line)}\n`);
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  };

  const flushStderr = () => {
    let newlineIndex = stderrBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = stderrBuffer.slice(0, newlineIndex).replace(/\r$/, "");
      stderrBuffer = stderrBuffer.slice(newlineIndex + 1);
      if (line) {
        process.stderr.write(`${prefixLine(options.role, line)}\n`);
      }
      newlineIndex = stderrBuffer.indexOf("\n");
    }
  };

  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += chunk.toString();
    flushStdout();
  });

  child.stderr?.on("data", (chunk) => {
    stderrBuffer += chunk.toString();
    flushStderr();
  });

  child.once("error", (error) => {
    if (!readyResolved) {
      rejectReady(error instanceof Error ? error : new Error(String(error)));
    }
  });

  child.once("exit", (code, signal) => {
    if (stdoutBuffer.trim()) {
      const remaining = stdoutBuffer.trim();
      if (!tryHandleReadyLine(remaining)) {
        process.stdout.write(`${prefixLine(options.role, remaining)}\n`);
      }
    }
    if (stderrBuffer.trim()) {
      process.stderr.write(`${prefixLine(options.role, stderrBuffer.trim())}\n`);
    }

    if (!readyResolved) {
      rejectReady(new Error(`${options.role} process exited before becoming ready.`));
    }

    options.onExit?.({ role: options.role, code, signal });
  });

  return {
    role: options.role,
    process: child,
    ready,
    stop: async () => {
      await stopChildProcess(child);
    },
  };
}
