#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { confirm, input } from "@inquirer/prompts";
import {
  boolean,
  command,
  flag,
  number,
  option,
  optional,
  positional,
  run,
  string,
  subcommands,
} from "cmd-ts";
import {
  DEFAULT_WORKTREE_BASE_DIR,
  DEFAULT_WORKTREEMAN_MAIN_BRANCH,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
} from "./shared/constants.js";
import { findRepoContext } from "./server/utils/paths.js";
import { initRepository } from "./server/services/init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees, resolveCloneRootDir } from "./server/services/repository-layout-service.js";
import { configureDatabaseConnection } from "./server/services/database-connection-service.js";
import { startDatabaseSocketServer, stopDatabaseSocketServer } from "./server/services/database-socket-service.js";
import { startManagedRuntimeProcess, type ManagedRuntimeProcess } from "./server/services/process-supervisor-service.js";

const normalizedArgv = normalizeArgv(process.argv.slice(2));

const startCommand = command({
  name: "start",
  description:
    "Start the local worktreeman server for the current git repository and open the browser UI.",
  version: "0.1.0",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description:
        "Directory to start searching from when locating the repository root. If no project exists there, init creates one in that directory.",
    }),
    port: option({
      type: optional(number),
      long: "port",
      short: "p",
      description: "Port for the local web server. Defaults to PORT or 4312, then falls back to another open port.",
    }),
    host: option({
      type: optional(string),
      long: "host",
      description:
        "Host interface for the local web server. Defaults to localhost. Use auto to prefer Tailscale, then WireGuard, then LAN, then localhost.",
    }),
    dangerouslyExposeToNetwork: flag({
      type: boolean,
      long: "dangerously-expose-to-network",
      description:
        "Required when binding to wildcard hosts like 0.0.0.0 or :: because that exposes the terminal UI to the network.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
    open: flag({
      type: boolean,
      long: "open",
      short: "o",
      description: "Open the browser after starting the server.",
      defaultValue: () => true,
      defaultValueIsSerializable: true,
    }),
    noOpen: flag({
      type: boolean,
      long: "no-open",
      description: "Do not open the browser after starting the server.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
  },
  handler: async ({ cwd, port, host, dangerouslyExposeToNetwork, open, noOpen }) => {
    const repo = await findRepoContext(cwd);
    let serverProcess: ManagedRuntimeProcess | null = null;
    let workerProcess: ManagedRuntimeProcess | null = null;
    let databaseConnectionString: string | null = null;

    try {
      const database = await startDatabaseSocketServer(repo.repoRoot);
      databaseConnectionString = database.connectionString;
      configureDatabaseConnection(databaseConnectionString);

      workerProcess = startManagedRuntimeProcess({
        role: "worker",
        cwd: repo.repoRoot,
        databaseUrl: databaseConnectionString,
      });
      await workerProcess.ready;

      serverProcess = startManagedRuntimeProcess({
        role: "server",
        cwd: repo.repoRoot,
        databaseUrl: databaseConnectionString,
        port,
        host,
        dangerouslyExposeToNetwork,
        openBrowser: noOpen ? false : open,
      });
      const serverReady = await serverProcess.ready;
      process.stdout.write(`worktreeman running at ${serverReady.url}\n`);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      await Promise.allSettled([
        serverProcess?.stop() ?? Promise.resolve(),
        workerProcess?.stop() ?? Promise.resolve(),
        stopDatabaseSocketServer(repo.repoRoot),
      ]);
      process.exit(1);
      return;
    }

    let shuttingDown = false;
    const cleanupListeners = () => {
      process.off("SIGINT", handleSigint);
      process.off("SIGTERM", handleSigterm);
      process.off("SIGHUP", handleSighup);
      process.off("uncaughtException", handleUncaughtException);
      process.off("unhandledRejection", handleUnhandledRejection);
    };

    const shutdown = async (reason: string, exitCode: number) => {
      if (shuttingDown) {
        process.stdout.write("[shutdown] Shutdown already in progress...\n");
        return;
      }

      shuttingDown = true;
      process.stdout.write(`${reason}\n`);

      try {
        await Promise.allSettled([
          serverProcess?.stop() ?? Promise.resolve(),
          workerProcess?.stop() ?? Promise.resolve(),
        ]);
        configureDatabaseConnection(null);
        await stopDatabaseSocketServer(repo.repoRoot);
        cleanupListeners();
        process.exit(exitCode);
      } catch (error) {
        process.stderr.write(
          `[shutdown] Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        cleanupListeners();
        process.exit(1);
      }
    };

    const handleSigint = () => {
      void shutdown("[shutdown] Received SIGINT.", 0);
    };
    const handleSigterm = () => {
      void shutdown("[shutdown] Received SIGTERM.", 0);
    };
    const handleSighup = () => {
      void shutdown("[shutdown] Received SIGHUP.", 0);
    };
    const handleUncaughtException = (error: Error) => {
      process.stderr.write(`[shutdown] Uncaught exception: ${error.message}\n`);
      void shutdown("[shutdown] Closing server after uncaught exception.", 1);
    };
    const handleUnhandledRejection = (reason: unknown) => {
      process.stderr.write(
        `[shutdown] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
      );
      void shutdown("[shutdown] Closing server after unhandled rejection.", 1);
    };

    process.on("SIGINT", handleSigint);
    process.on("SIGTERM", handleSigterm);
    process.on("SIGHUP", handleSighup);
    process.on("uncaughtException", handleUncaughtException);
    process.on("unhandledRejection", handleUnhandledRejection);
  },
});

const initCommand = command({
  name: "init",
  description:
    "Create or update the starter worktree.yml in the required wtm-settings worktree.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description:
        "Directory to start searching from when locating the repository root.",
    }),
    force: flag({
      type: boolean,
      long: "force",
      short: "f",
      description:
        "Overwrite worktree.yml in the target branch worktree if an existing worktree config is already present.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
  },
  handler: async ({ cwd, force }) => {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;
    const createLayoutIfMissing = cliArgvIncludesOption(normalizedArgv, "cwd", "c");

    if (interactive) {
      process.stdout.write("\nworktreeman init\n");
      process.stdout.write(`Create or reuse the ${DEFAULT_WORKTREEMAN_SETTINGS_BRANCH} settings worktree, then generate a shared worktree.yml.\n\n`);
    }

    const resolvedRuntimePorts = interactive ? await promptForRuntimePorts() : [];

    let result = await initRepository(cwd, {
      baseDir: DEFAULT_WORKTREE_BASE_DIR,
      runtimePorts: resolvedRuntimePorts,
      force,
      createLayoutIfMissing,
    });

    if (!result.created && !force && interactive) {
      const overwrite = await confirm({
        message: `Config already exists at ${result.configPath} for branch ${result.branch}. Overwrite it?`,
        default: false,
      });

      if (!overwrite) {
        process.stdout.write(
          `Keeping existing config at ${result.configPath} for branch ${result.branch}.\n`,
        );
        return;
      }

      result = await initRepository(cwd, {
        baseDir: DEFAULT_WORKTREE_BASE_DIR,
        runtimePorts: resolvedRuntimePorts,
        force: true,
        createLayoutIfMissing,
      });
    }

    if (!result.created) {
      process.stdout.write(
        `Existing config found at ${result.configPath} for branch ${result.branch}. Use --force to overwrite it.\n`,
      );
      return;
    }

    if (result.createdWorktree) {
      process.stdout.write(`Created worktree for branch ${result.branch} at ${result.worktreePath}\n`);
    } else {
      process.stdout.write(`Using existing worktree for branch ${result.branch} at ${result.worktreePath}\n`);
    }

    process.stdout.write(`Created ${result.configPath}\n`);
    process.stdout.write("Wrote a starter config with runtime ports, startup commands, and background commands ready to customize.\n");
  },
});

const createCommand = command({
  name: "create",
  description:
    "Create a new bare-repo worktreeman layout with .bare, a linked .git file, main, and wtm-settings.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory where the managed repository layout should be created.",
    }),
  },
  handler: async ({ cwd }) => {
    const runtimePorts = process.stdin.isTTY && process.stdout.isTTY ? await promptForRuntimePorts() : [];

    await createBareRepoLayout({ rootDir: cwd });
    await ensurePrimaryWorktrees({ rootDir: cwd, createMissingBranches: true });

    const result = await initRepository(cwd, {
      baseDir: DEFAULT_WORKTREE_BASE_DIR,
      runtimePorts,
      force: false,
    });

    process.stdout.write(`Created bare repository layout at ${result.repoRoot}\n`);
    process.stdout.write(`Created primary worktrees at ${result.repoRoot}/${DEFAULT_WORKTREEMAN_MAIN_BRANCH} and ${result.worktreePath}\n`);
    process.stdout.write(`Created ${result.configPath}\n`);
  },
});

const cloneCommand = command({
  name: "clone",
  description:
    "Clone a remote into the required bare-repo worktreeman layout and check out main plus wtm-settings.",
  args: {
    remote: positional({
      type: string,
      displayName: "remote",
      description: "Remote repository URL to clone.",
    }),
    directory: positional({
      type: optional(string),
      displayName: "directory",
      description: "Optional target directory. Defaults to the remote repository name.",
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Base directory used to resolve the clone target directory.",
    }),
  },
  handler: async ({ remote, directory, cwd }) => {
    const rootDir = resolveCloneRootDir(cwd, remote, directory);
    await createBareRepoLayout({ rootDir, remoteUrl: remote });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
    await initRepository(rootDir, {
      baseDir: DEFAULT_WORKTREE_BASE_DIR,
      runtimePorts: [],
      force: false,
    });
    const repo = await findRepoContext(rootDir);

    process.stdout.write(`Cloned ${remote} into bare repository layout at ${repo.repoRoot}\n`);
    process.stdout.write(`Checked out ${path.join(repo.repoRoot, DEFAULT_WORKTREEMAN_MAIN_BRANCH)} and ${repo.configWorktreePath}\n`);
  },
});

const cli = subcommands({
  name: "worktreeman",
  version: "0.1.0",
  description:
    "Manage git worktrees, runtime env setup, background commands, and tmux-backed terminals from one local UI.",
  cmds: {
    create: createCommand,
    clone: cloneCommand,
    start: startCommand,
    init: initCommand,
  },
});

run(cli, normalizedArgv).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

function normalizeArgv(argv: string[]): string[] {
  return argv
    .filter((value) => value !== "--")
    .map((value) => value === "--danagerously-expose-to-network" ? "--dangerously-expose-to-network" : value);
}

function cliArgvIncludesOption(argv: string[], longName: string, shortName?: string): boolean {
  return argv.some((value) => {
    if (value === `--${longName}` || value.startsWith(`--${longName}=`)) {
      return true;
    }

    if (!shortName) {
      return false;
    }

    return value === `-${shortName}` || value.startsWith(`-${shortName}`);
  });
}

async function promptForRuntimePorts(): Promise<string[]> {
  const ports: string[] = [];

  process.stdout.write("\nAdd environment variables that should get a free local port at runtime.\n");
  process.stdout.write("Examples: PORT, VITE_PORT, WEBHOOK_PORT. Leave blank when you're done.\n\n");

  while (true) {
    if (ports.length > 0) {
      process.stdout.write(`Current dynamic port env vars: ${ports.join(", ")}\n`);
    }

    const envName = (await input({
      message: ports.length === 0 ? "Dynamic port env var (optional)" : "Another dynamic port env var (optional)",
      validate: (value) => {
        const trimmed = value.trim();
        if (!trimmed) {
          return true;
        }

        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
          return "Use a valid environment variable name like PORT or WEBHOOK_PORT.";
        }

        if (ports.includes(trimmed)) {
          return `${trimmed} is already in the list.`;
        }

        return true;
      },
    })).trim();

    if (!envName) {
      return ports;
    }

    ports.push(envName);
  }
}
