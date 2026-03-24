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
import { startServer } from "./server/app.js";
import { initRepository } from "./server/services/init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees, resolveCloneRootDir } from "./server/services/repository-layout-service.js";

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
        "Directory to start searching from when locating the repository root.",
    }),
    port: option({
      type: optional(number),
      long: "port",
      short: "p",
      description: "Port for the local web server. Defaults to PORT or 4312.",
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
  handler: async ({ cwd, port, open, noOpen }) => {
    const repo = await findRepoContext(cwd);
    let server: Awaited<ReturnType<typeof startServer>>;

    try {
      server = await startServer({
        repo,
        port,
        openBrowser: noOpen ? false : open,
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
      return;
    }

    process.stdout.write(
      `worktreeman running at http://127.0.0.1:${server.port}\n`,
    );

    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) {
        process.stdout.write("[shutdown] Shutdown already in progress...\n");
        return;
      }

      shuttingDown = true;
      process.stdout.write("[shutdown] Received shutdown signal.\n");

      try {
        await server.close();
        process.exit(0);
      } catch (error) {
        process.stderr.write(
          `[shutdown] Shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        process.exit(1);
      }
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
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

    if (interactive) {
      process.stdout.write("\nworktreeman init\n");
      process.stdout.write(`Create or reuse the ${DEFAULT_WORKTREEMAN_SETTINGS_BRANCH} settings worktree, then generate a shared worktree.yml.\n\n`);
    }

    const resolvedRuntimePorts = interactive ? await promptForRuntimePorts() : [];

    let result = await initRepository(cwd, {
      baseDir: DEFAULT_WORKTREE_BASE_DIR,
      runtimePorts: resolvedRuntimePorts,
      force,
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

run(cli, normalizeArgv(process.argv.slice(2))).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});

function normalizeArgv(argv: string[]): string[] {
  return argv.filter((value) => value !== "--");
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
