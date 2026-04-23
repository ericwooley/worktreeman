#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
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
import type {
  BackgroundCommandLogLine,
  WorktreeManagerConfig,
  WorktreeRecord,
  WorktreeRuntime,
} from "./shared/types.js";
import {
  DEFAULT_WORKTREE_BASE_DIR,
  DEFAULT_WORKTREEMAN_MAIN_BRANCH,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
} from "./shared/constants.js";
import { findRepoContext } from "./server/utils/paths.js";
import { listWorktrees } from "./server/services/git-service.js";
import { loadConfig } from "./server/services/config-service.js";
import { createOperationalStateStore } from "./server/services/operational-state-service.js";
import { ensureRuntimeTerminalSession, getTmuxSessionName, killTmuxSession, killTmuxSessionByName } from "./server/services/terminal-service.js";
import { buildRuntimeProcessEnv, createRuntime, runStartupCommands } from "./server/services/runtime-service.js";
import {
  getBackgroundCommandLogs,
  listBackgroundCommands,
  startConfiguredBackgroundCommands,
  stopAllBackgroundCommands,
} from "./server/services/background-command-service.js";
import {
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
} from "./server/services/project-management-service.js";
import { initRepository } from "./server/services/init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees, resolveCloneRootDir } from "./server/services/repository-layout-service.js";
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
    let databaseProcess: ManagedRuntimeProcess | null = null;
    let serverProcess: ManagedRuntimeProcess | null = null;
    let workerProcess: ManagedRuntimeProcess | null = null;
    let databaseConnectionString: string | null = null;
    let shuttingDown = false;
    const restartTimers = new Map<"database" | "server" | "worker", NodeJS.Timeout>();

    const clearRestartTimers = () => {
      for (const timer of restartTimers.values()) {
        clearTimeout(timer);
      }
      restartTimers.clear();
    };

    const launchDatabase = async () => {
      databaseProcess = startManagedRuntimeProcess({
        role: "database",
        cwd: repo.repoRoot,
        onExit: () => {
          if (shuttingDown) {
            return;
          }
          databaseProcess = null;
          databaseConnectionString = null;
          if (serverProcess || workerProcess) {
            void Promise.allSettled([
              serverProcess?.stop() ?? Promise.resolve(),
              workerProcess?.stop() ?? Promise.resolve(),
            ]).finally(() => {
              serverProcess = null;
              workerProcess = null;
            });
          }
          scheduleRestart("database");
        },
      });
      const ready = await databaseProcess.ready;
      databaseConnectionString = ready.connectionString ?? null;
      if (!databaseConnectionString) {
        throw new Error("Database process did not provide a connection string.");
      }
    };

    const launchWorker = async () => {
      if (!databaseConnectionString) {
        throw new Error("Cannot start worker without database connection string.");
      }
      workerProcess = startManagedRuntimeProcess({
        role: "worker",
        cwd: repo.repoRoot,
        databaseUrl: databaseConnectionString,
        onExit: () => {
          if (shuttingDown) {
            return;
          }
          workerProcess = null;
          scheduleRestart("worker");
        },
      });
      await workerProcess.ready;
    };

    const launchServer = async (openBrowser: boolean) => {
      if (!databaseConnectionString) {
        throw new Error("Cannot start server without database connection string.");
      }
      serverProcess = startManagedRuntimeProcess({
        role: "server",
        cwd: repo.repoRoot,
        databaseUrl: databaseConnectionString,
        port,
        host,
        dangerouslyExposeToNetwork,
        openBrowser,
        onExit: () => {
          if (shuttingDown) {
            return;
          }
          serverProcess = null;
          scheduleRestart("server");
        },
      });
      const serverReady = await serverProcess.ready;
      process.stdout.write(`worktreeman running at ${serverReady.url}\n`);
    };

    const restartRole = (role: "database" | "server" | "worker") => {
      if (shuttingDown || restartTimers.has(role)) {
        return;
      }
      const timer = setTimeout(() => {
        restartTimers.delete(role);
        void (async () => {
          try {
            if (role === "database") {
              await launchDatabase();
              if (!workerProcess) {
                await launchWorker();
              }
              if (!serverProcess) {
                await launchServer(false);
              }
              return;
            }

            if (role === "worker" && !workerProcess) {
              await launchWorker();
            }

            if (role === "server" && !serverProcess) {
              await launchServer(false);
            }
          } catch (error) {
            process.stderr.write(`[supervisor] Failed to restart ${role}: ${error instanceof Error ? error.message : String(error)}\n`);
            restartRole(role);
          }
        })();
      }, 1000);
      restartTimers.set(role, timer);
    };

    const scheduleRestart = (role: "database" | "server" | "worker") => {
      restartRole(role);
    };

    const stopManagedProcess = (child: ManagedRuntimeProcess | null): Promise<void> | null => {
      if (!child) {
        return null;
      }

      return child.stop();
    };

    try {
      await launchDatabase();
      await launchWorker();
      await launchServer(noOpen ? false : open);
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      const stopPromises = [
        stopManagedProcess(databaseProcess),
        stopManagedProcess(serverProcess),
        stopManagedProcess(workerProcess),
      ].filter((promise): promise is Promise<void> => promise !== null);
      await Promise.allSettled(stopPromises);
      process.exit(1);
      return;
    }

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
      clearRestartTimers();
      process.stdout.write(`${reason}\n`);

      try {
        await Promise.allSettled([
          databaseProcess?.stop() ?? Promise.resolve(),
          serverProcess?.stop() ?? Promise.resolve(),
          workerProcess?.stop() ?? Promise.resolve(),
        ]);
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

const apiDevStartCommand = command({
  name: "start",
  description: "Start the dev environment for a worktree.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository and target worktree.",
    }),
    branch: option({
      type: optional(string),
      long: "branch",
      short: "b",
      description: "Optional branch name when the cwd is not already inside the target worktree.",
    }),
  },
  handler: async ({ cwd, branch }) => {
    const target = await resolveApiWorktreeTarget(cwd, branch);
    const runtime = await ensureCliWorktreeRuntime(target);
    writeJson({
      branch: target.worktree.branch,
      worktreePath: target.worktree.worktreePath,
      runtime,
      backgroundCommands: await listBackgroundCommands(target.config, target.repo.repoRoot, target.worktree, runtime),
    });
  },
});

const apiDevStopCommand = command({
  name: "stop",
  description: "Stop the dev environment for a worktree.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository and target worktree.",
    }),
    branch: option({
      type: optional(string),
      long: "branch",
      short: "b",
      description: "Optional branch name when the cwd is not already inside the target worktree.",
    }),
  },
  handler: async ({ cwd, branch }) => {
    const target = await resolveApiWorktreeTarget(cwd, branch);
    await stopCliWorktreeRuntime(target);
    writeJson({
      ok: true,
      branch: target.worktree.branch,
      worktreePath: target.worktree.worktreePath,
      runtime: null,
      backgroundCommands: await listBackgroundCommands(target.config, target.repo.repoRoot, target.worktree, undefined),
    });
  },
});

const apiDevStatusCommand = command({
  name: "status",
  description: "Show dev runtime and service status.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository and target worktree.",
    }),
    branch: option({
      type: optional(string),
      long: "branch",
      short: "b",
      description: "Optional branch name when the cwd is not already inside the target worktree.",
    }),
  },
  handler: async ({ cwd, branch }) => {
    const target = await resolveApiWorktreeTarget(cwd, branch);
    const runtime = await target.operationalState.getRuntimeById(target.worktree.id);
    writeJson({
      branch: target.worktree.branch,
      worktreePath: target.worktree.worktreePath,
      runtime,
      backgroundCommands: await listBackgroundCommands(target.config, target.repo.repoRoot, target.worktree, runtime ?? undefined),
    });
  },
});

const apiDevLogsReadCommand = command({
  name: "read",
  description: "Read recent stdout/stderr service logs.",
  args: {
    commandName: option({
      type: string,
      long: "command",
      short: "n",
      description: "Background command name to inspect.",
    }),
    source: option({
      type: optional(string),
      long: "source",
      short: "s",
      description: "Log source to include: stdout, stderr, or all. Defaults to all.",
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository and target worktree.",
    }),
    branch: option({
      type: optional(string),
      long: "branch",
      short: "b",
      description: "Optional branch name when the cwd is not already inside the target worktree.",
    }),
  },
  handler: async ({ commandName, source, cwd, branch }) => {
    const target = await resolveApiWorktreeTarget(cwd, branch);
    const normalizedSource = normalizeLogSource(source);
    const logs = await getBackgroundCommandLogs(target.config, target.worktree, commandName);
    writeJson({
      ...logs,
      source: normalizedSource,
      lines: filterLogLines(logs.lines, normalizedSource),
    });
  },
});

const apiDevLogsGrepCommand = command({
  name: "grep",
  description: "Search recent stdout/stderr service logs.",
  args: {
    pattern: positional({
      type: string,
      displayName: "pattern",
      description: "Text or regex pattern to search for.",
    }),
    commandName: option({
      type: string,
      long: "command",
      short: "n",
      description: "Background command name to inspect.",
    }),
    source: option({
      type: optional(string),
      long: "source",
      short: "s",
      description: "Log source to include: stdout, stderr, or all. Defaults to all.",
    }),
    regex: flag({
      type: boolean,
      long: "regex",
      description: "Interpret the pattern as a regular expression.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
    ignoreCase: flag({
      type: boolean,
      long: "ignore-case",
      short: "i",
      description: "Match without case sensitivity.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository and target worktree.",
    }),
    branch: option({
      type: optional(string),
      long: "branch",
      short: "b",
      description: "Optional branch name when the cwd is not already inside the target worktree.",
    }),
  },
  handler: async ({ pattern, commandName, source, regex, ignoreCase, cwd, branch }) => {
    const target = await resolveApiWorktreeTarget(cwd, branch);
    const normalizedSource = normalizeLogSource(source);
    const logs = await getBackgroundCommandLogs(target.config, target.worktree, commandName);
    const filteredLines = filterLogLines(logs.lines, normalizedSource);
    const matcher = createLogMatcher(pattern, { regex, ignoreCase });
    writeJson({
      commandName: logs.commandName,
      source: normalizedSource,
      pattern,
      regex,
      ignoreCase,
      lines: filteredLines.filter((line) => matcher(line.text)),
    });
  },
});

const apiDevLogsCommand = subcommands({
  name: "logs",
  description: "Read or search background command logs.",
  cmds: {
    read: apiDevLogsReadCommand,
    grep: apiDevLogsGrepCommand,
  },
});

const apiDevCommand = subcommands({
  name: "dev",
  description: "Inspect or control worktree dev environments.",
  cmds: {
    start: apiDevStartCommand,
    stop: apiDevStopCommand,
    status: apiDevStatusCommand,
    logs: apiDevLogsCommand,
  },
});

const apiDocumentsListCommand = command({
  name: "list",
  description: "List project-management documents.",
  args: {
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository.",
    }),
  },
  handler: async ({ cwd }) => {
    const repo = await findRepoContext(cwd);
    writeJson(await listProjectManagementDocuments(repo.repoRoot));
  },
});

const apiDocumentsReadCommand = command({
  name: "read",
  description: "Read a project-management document.",
  args: {
    documentId: positional({
      type: string,
      displayName: "document-id",
      description: "Project-management document id.",
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository.",
    }),
  },
  handler: async ({ documentId, cwd }) => {
    const repo = await findRepoContext(cwd);
    writeJson(await getProjectManagementDocument(repo.repoRoot, documentId));
  },
});

const apiDocumentsHistoryCommand = command({
  name: "history",
  description: "Read project-management document history.",
  args: {
    documentId: positional({
      type: string,
      displayName: "document-id",
      description: "Project-management document id.",
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description: "Directory used to resolve the managed repository.",
    }),
  },
  handler: async ({ documentId, cwd }) => {
    const repo = await findRepoContext(cwd);
    writeJson(await getProjectManagementDocumentHistory(repo.repoRoot, documentId));
  },
});

const apiDocumentsCommand = subcommands({
  name: "documents",
  description: "Read project-management documents and history.",
  cmds: {
    list: apiDocumentsListCommand,
    read: apiDocumentsReadCommand,
    history: apiDocumentsHistoryCommand,
  },
});

const apiCommand = subcommands({
  name: "api",
  description: "Repo-local runtime, log, and project-management document helpers.",
  cmds: {
    dev: apiDevCommand,
    documents: apiDocumentsCommand,
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
    api: apiCommand,
  },
});

export { cli };

export function runCli(argv: string[]) {
  return run(cli, normalizeArgv(argv));
}

if (isDirectCliEntryPoint()) {
  runCli(normalizedArgv).catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  });
}

export function normalizeArgv(argv: string[]): string[] {
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

function isDirectCliEntryPoint(): boolean {
  const entryPoint = process.argv[1];
  return typeof entryPoint === "string" && entryPoint.length > 0 && import.meta.url === pathToFileURL(entryPoint).href;
}

interface CliApiTarget {
  cwd: string;
  repo: Awaited<ReturnType<typeof findRepoContext>>;
  config: WorktreeManagerConfig;
  worktree: WorktreeRecord;
  operationalState: Awaited<ReturnType<typeof createOperationalStateStore>>;
}

async function resolveApiWorktreeTarget(cwd: string, branch?: string): Promise<CliApiTarget> {
  const resolvedCwd = path.resolve(cwd);
  const repo = await findRepoContext(resolvedCwd);
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const worktrees = await listWorktrees(repo.repoRoot);
  const worktree = resolveTargetWorktree(worktrees, resolvedCwd, branch);
  if (!worktree) {
    throw new Error(
      branch
        ? `Unknown worktree branch ${branch}.`
        : `Unable to determine a worktree from ${resolvedCwd}. Re-run from inside a worktree or pass --branch.`,
    );
  }

  return {
    cwd: resolvedCwd,
    repo,
    config,
    worktree,
    operationalState: await createOperationalStateStore(repo.repoRoot),
  };
}

function resolveTargetWorktree(worktrees: WorktreeRecord[], cwd: string, branch?: string): WorktreeRecord | undefined {
  if (branch) {
    return worktrees.find((entry) => entry.branch === branch);
  }

  const exact = worktrees.find((entry) => path.resolve(entry.worktreePath) === cwd);
  if (exact) {
    return exact;
  }

  const containing = worktrees.filter((entry) => isPathWithin(entry.worktreePath, cwd));
  return containing.sort((left, right) => right.worktreePath.length - left.worktreePath.length)[0];
}

function isPathWithin(parentPath: string, childPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function ensureCliWorktreeRuntime(target: CliApiTarget): Promise<WorktreeRuntime> {
  const existingRuntime = await target.operationalState.getRuntimeById(target.worktree.id);
  if (existingRuntime) {
    return existingRuntime;
  }

  const { runtime } = await createRuntime(target.config, target.repo.repoRoot, target.worktree);
  await target.operationalState.setRuntime(runtime);
  await ensureRuntimeTerminalSession(runtime, target.repo.repoRoot);
  await runStartupCommands(target.config.startupCommands, target.worktree.worktreePath, buildRuntimeProcessEnv(runtime));
  await startConfiguredBackgroundCommands({
    config: target.config,
    repoRoot: target.repo.repoRoot,
    worktree: target.worktree,
    runtime,
  });
  return runtime;
}

async function stopCliWorktreeRuntime(target: CliApiTarget): Promise<void> {
  const runtime = await target.operationalState.getRuntimeById(target.worktree.id);
  if (!runtime) {
    await killTmuxSessionByName(getTmuxSessionName(target.repo.repoRoot, target.worktree.id), target.worktree.worktreePath);
    return;
  }

  let stopError: unknown = null;

  try {
    await stopAllBackgroundCommands(target.repo.repoRoot, runtime);
  } catch (error) {
    stopError = error;
  }

  try {
    await killTmuxSession(runtime);
  } catch (error) {
    stopError ??= error;
  }

  await target.operationalState.deleteRuntimeById(runtime.id);

  if (stopError) {
    throw stopError;
  }
}

function normalizeLogSource(source: string | undefined): "stdout" | "stderr" | "all" {
  if (!source || source === "all") {
    return "all";
  }

  if (source === "stdout" || source === "stderr") {
    return source;
  }

  throw new Error(`Unknown log source ${source}. Use stdout, stderr, or all.`);
}

function filterLogLines(lines: BackgroundCommandLogLine[], source: "stdout" | "stderr" | "all"): BackgroundCommandLogLine[] {
  return source === "all" ? lines : lines.filter((line) => line.source === source);
}

function createLogMatcher(pattern: string, options: { regex: boolean; ignoreCase: boolean }): (value: string) => boolean {
  if (options.regex) {
    const flags = options.ignoreCase ? "i" : "";
    const expression = new RegExp(pattern, flags);
    return (value) => expression.test(value);
  }

  const expected = options.ignoreCase ? pattern.toLocaleLowerCase() : pattern;
  return (value) => (options.ignoreCase ? value.toLocaleLowerCase() : value).includes(expected);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
