import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { configureDatabaseConnection } from "../services/database-connection-service.js";
import { startDatabaseSocketServer, stopDatabaseSocketServer } from "../services/database-socket-service.js";
import { restartManagedRuntimeProcess, startManagedRuntimeProcess, type ManagedRuntimeProcess, type ManagedRuntimeRole } from "../services/process-supervisor-service.js";
import { findRepoContext } from "../utils/paths.js";

interface DevEntrypointArgs {
  cwd: string;
  port?: number;
  host?: string;
  dangerouslyExposeToNetwork: boolean;
  openBrowser: boolean;
}

function parseArgs(argv: string[]): DevEntrypointArgs {
  const args: DevEntrypointArgs = {
    cwd: process.cwd(),
    dangerouslyExposeToNetwork: false,
    openBrowser: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--cwd":
        args.cwd = argv[index + 1] ?? args.cwd;
        index += 1;
        break;
      case "--port": {
        const next = argv[index + 1];
        if (next) {
          args.port = Number(next);
          index += 1;
        }
        break;
      }
      case "--host":
        args.host = argv[index + 1] ?? args.host;
        index += 1;
        break;
      case "--dangerously-expose-to-network":
        args.dangerouslyExposeToNetwork = true;
        break;
      case "--open":
        args.openBrowser = true;
        break;
      case "--no-open":
        args.openBrowser = false;
        break;
      default:
        break;
    }
  }

  return args;
}

export function classifyChangedPath(repoRoot: string, filePath: string): ManagedRuntimeRole | "both" | null {
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join("/");
  if (!relativePath || relativePath.startsWith("..")) {
    return null;
  }

  if (
    relativePath === "package.json"
    || relativePath === "tsconfig.node.json"
    || relativePath.startsWith("src/shared/")
    || relativePath === "src/cli.ts"
    || relativePath === "src/server/services/process-supervisor-service.ts"
    || relativePath === "src/server/entrypoints/dev-entrypoint.ts"
  ) {
    return "both";
  }

  if (
    relativePath === "src/server/app.ts"
    || relativePath.startsWith("src/server/routes/")
    || relativePath === "src/server/entrypoints/server-entrypoint.ts"
  ) {
    return "server";
  }

  if (
    relativePath.startsWith("src/server/services/ai-command")
    || relativePath.startsWith("src/server/services/database-")
    || relativePath === "src/server/entrypoints/worker-entrypoint.ts"
  ) {
    return "worker";
  }

  if (relativePath.startsWith("src/server/")) {
    return "both";
  }

  return null;
}

async function collectWatchDirectories(rootPath: string): Promise<string[]> {
  const directories = new Set<string>([rootPath]);
  const pending = [rootPath];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }

    const entries = await fsp.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const nextPath = path.join(current, entry.name);
      directories.add(nextPath);
      pending.push(nextPath);
    }
  }

  return Array.from(directories);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = await findRepoContext(args.cwd);
  const database = await startDatabaseSocketServer(repo.repoRoot);
  configureDatabaseConnection(database.connectionString);

  let openBrowserOnNextServerStart = args.openBrowser;
  let serverProcess: ManagedRuntimeProcess | null = null;
  let workerProcess: ManagedRuntimeProcess | null = null;
  let shuttingDown = false;
  let restartTimer: NodeJS.Timeout | null = null;
  let pendingRestart: ManagedRuntimeRole | "both" | null = null;
  let restartInFlight = false;
  const watchers = new Map<string, fs.FSWatcher>();

  const isCurrentProcess = (role: ManagedRuntimeRole, child: ManagedRuntimeProcess) => {
    return role === "server" ? serverProcess === child : workerProcess === child;
  };

  const handleRoleReady = (role: ManagedRuntimeRole, child: ManagedRuntimeProcess, ready: Awaited<ManagedRuntimeProcess["ready"]>) => {
    if (role === "server") {
      serverProcess = child;
      openBrowserOnNextServerStart = false;
      if (ready.url) {
        process.stdout.write(`worktreeman running at ${ready.url}\n`);
      }
      return;
    }

    workerProcess = child;
  };

  const launchRole = async (role: ManagedRuntimeRole) => {
    let child!: ManagedRuntimeProcess;
    child = startManagedRuntimeProcess({
      role,
      cwd: repo.repoRoot,
      databaseUrl: database.connectionString,
      port: args.port,
      host: args.host,
      dangerouslyExposeToNetwork: args.dangerouslyExposeToNetwork,
      openBrowser: role === "server" ? openBrowserOnNextServerStart : false,
      onExit: ({ role: exitedRole, code, signal }) => {
        if (shuttingDown || !isCurrentProcess(exitedRole, child)) {
          return;
        }

        process.stderr.write(`[dev] ${exitedRole} exited with ${code ?? signal ?? "unknown"}. Waiting for file changes to restart.\n`);
        if (exitedRole === "server") {
          serverProcess = null;
        } else {
          workerProcess = null;
        }
      },
    });
    const ready = await child.ready;
    return { child, ready };
  };

  const startRole = async (role: ManagedRuntimeRole) => {
    const { child, ready } = await launchRole(role);
    handleRoleReady(role, child, ready);
    return child;
  };

  const restartRole = async (role: ManagedRuntimeRole) => {
    const current = role === "server" ? serverProcess : workerProcess;
    const mode = role === "worker" ? "overlap" : "serial" as const;
    process.stdout.write(
      role === "worker"
        ? "[dev] Starting replacement worker and draining the previous worker...\n"
        : `[dev] Restarting ${role}...\n`,
    );
    await restartManagedRuntimeProcess({
      mode,
      current,
      start: async () => {
        const { child, ready } = await launchRole(role);
        handleRoleReady(role, child, ready);
        return child;
      },
      onReplaced: async () => {
        if (role !== "worker") {
          return;
        }

        process.stdout.write("[dev] Replacement worker ready. Waiting for the previous worker to finish active jobs...\n");
      },
    });
  };

  const runPendingRestarts = async () => {
    if (restartInFlight) {
      return;
    }

    restartInFlight = true;
    try {
      while (pendingRestart && !shuttingDown) {
        const restartTarget = pendingRestart;
        pendingRestart = null;

        if (restartTarget === "both") {
          await restartRole("worker");
          await restartRole("server");
          continue;
        }

        await restartRole(restartTarget);
      }
    } finally {
      restartInFlight = false;
    }
  };

  const scheduleRestart = (target: ManagedRuntimeRole | "both") => {
    pendingRestart = pendingRestart === "both" || target === "both"
      ? "both"
      : pendingRestart ?? target;

    if (restartTimer) {
      clearTimeout(restartTimer);
    }

    restartTimer = setTimeout(() => {
      restartTimer = null;
      void runPendingRestarts().catch((error) => {
        process.stderr.write(`[dev] Restart failed: ${error instanceof Error ? error.message : String(error)}\n`);
      });
    }, 150);
  };

  const refreshWatchers = async () => {
    const rootsToWatch = [path.join(repo.repoRoot, "src"), repo.repoRoot];
    const directories = new Set<string>();
    for (const rootPath of rootsToWatch) {
      for (const directory of await collectWatchDirectories(rootPath)) {
        directories.add(directory);
      }
    }

    for (const [directory, watcher] of watchers.entries()) {
      if (!directories.has(directory)) {
        watcher.close();
        watchers.delete(directory);
      }
    }

    for (const directory of directories) {
      if (watchers.has(directory)) {
        continue;
      }

      const watcher = fs.watch(directory, (_eventType, fileName) => {
        if (!fileName || shuttingDown) {
          return;
        }

        const changedPath = path.join(directory, fileName.toString());
        const target = classifyChangedPath(repo.repoRoot, changedPath);
        if (!target) {
          return;
        }

        process.stdout.write(`[dev] Change detected in ${path.relative(repo.repoRoot, changedPath)} -> restart ${target}.\n`);
        scheduleRestart(target);
        void refreshWatchers().catch(() => undefined);
      });
      watchers.set(directory, watcher);
    }
  };

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }

    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();

    await Promise.allSettled([
      serverProcess?.stop() ?? Promise.resolve(),
      workerProcess?.stop() ?? Promise.resolve(),
    ]);
    configureDatabaseConnection(null);
    await stopDatabaseSocketServer(repo.repoRoot);
  };

  try {
    await startRole("worker");
    await startRole("server");
    await refreshWatchers();
  } catch (error) {
    await shutdown().catch(() => undefined);
    throw error;
  }

  process.on("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on("SIGHUP", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

const invokedAsScript = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
  : false;

if (invokedAsScript) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
