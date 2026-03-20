#!/usr/bin/env node

import path from "node:path";
import process from "node:process";
import { confirm, input, select } from "@inquirer/prompts";
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
import { findRepoContext } from "./server/utils/paths.js";
import { startServer } from "./server/app.js";
import { listWorktrees } from "./server/services/git-service.js";
import { initRepository } from "./server/services/init-service.js";
import { findGitRoot } from "./server/utils/paths.js";

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
    configRef: option({
      type: optional(string),
      long: "config-ref",
      description:
        "Git ref to load worktree config from. Overrides WORKTREEMAN_CONFIG_REF and git config worktreeman.configRef.",
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
  handler: async ({ cwd, port, configRef, open, noOpen }) => {
    const repo = await findRepoContext(cwd, {
      configRef: configRef ?? process.env.WORKTREEMAN_CONFIG_REF,
    });
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
    "Create a starter worktree.yml, prompting for branch, layout, and dynamic runtime port env vars when they are not provided.",
  args: {
    branch: positional({
      type: optional(string),
      displayName: "branch",
      description: "Branch whose worktree should hold the shared worktree.yml config. If omitted, init will ask.",
    }),
    cwd: option({
      type: string,
      long: "cwd",
      short: "c",
      defaultValue: () => process.cwd(),
      defaultValueIsSerializable: true,
      description:
        "Directory to start searching from when locating the repository root.",
    }),
    baseDir: option({
      type: optional(string),
      long: "base-dir",
      description:
        "Value to write to worktrees.baseDir in worktree.yml. If omitted in a TTY session, init will ask.",
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
  handler: async ({ branch, cwd, baseDir, force }) => {
    const interactive = process.stdin.isTTY && process.stdout.isTTY;

    if (interactive) {
      process.stdout.write("\nworktreeman init\n");
      process.stdout.write("Create or reuse a branch worktree, then generate a shared worktree.yml.\n\n");
    }

    const resolvedBranch =
      branch ??
      (interactive
        ? await promptForBranch()
        : undefined);

    if (!resolvedBranch?.trim()) {
      throw new Error(
        "Branch is required. Pass `worktreeman init <branch>` or run `worktreeman init` in an interactive terminal.",
      );
    }

    const suggestedBaseDir = baseDir ?? (interactive ? await detectSuggestedBaseDir(cwd) : ".worktrees");
    const resolvedBaseDir =
      baseDir ??
      (interactive ? await promptForBaseDir(suggestedBaseDir) : suggestedBaseDir);

    const resolvedRuntimePorts = interactive ? await promptForRuntimePorts() : [];

    let result = await initRepository(cwd, {
      branch: resolvedBranch,
      baseDir: resolvedBaseDir,
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
        branch: resolvedBranch,
        baseDir: resolvedBaseDir,
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

const cli = subcommands({
  name: "worktreeman",
  version: "0.1.0",
  description:
    "Manage git worktrees, runtime env setup, background commands, and tmux-backed terminals from one local UI.",
  cmds: {
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

async function detectSuggestedBaseDir(startDir: string): Promise<string> {
  try {
    const repoRoot = await findGitRoot(startDir);
    const worktrees = await listWorktrees(repoRoot);
    const repoRootWithSeparator = `${repoRoot}${path.sep}`;
    const siblingLayout = worktrees.some(
      (worktree) =>
        path.dirname(worktree.worktreePath) === path.dirname(repoRoot) &&
        worktree.worktreePath !== repoRoot &&
        !worktree.worktreePath.startsWith(repoRootWithSeparator),
    );

    return siblingLayout ? ".." : ".worktrees";
  } catch {
    return ".worktrees";
  }
}

async function promptForBranch(): Promise<string> {
  return input({
    message: "Which branch should hold the shared worktree.yml config?",
    default: "main",
    validate: (value) => (value.trim() ? true : "Branch is required."),
  });
}

async function promptForBaseDir(suggestedBaseDir: string): Promise<string> {
  const defaultChoice = suggestedBaseDir === ".." ? "siblings" : suggestedBaseDir === ".worktrees" ? "nested" : "custom";

  const layout = await select<string>({
    message: "Where should new branch worktrees be created relative to the config worktree?",
    default: defaultChoice,
    choices: [
      {
        name: ".worktrees",
        value: "nested",
        description: "Nested layout, for example main/.worktrees/feature-x",
      },
      {
        name: "..",
        value: "siblings",
        description: "Sibling layout, for example main/, feature-x/, bugfix-y/ under one parent",
      },
      {
        name: "Custom path",
        value: "custom",
        description: "Write your own relative or absolute worktrees.baseDir value",
      },
    ],
  });

  if (layout === "nested") {
    return ".worktrees";
  }

  if (layout === "siblings") {
    return "..";
  }

  return input({
    message: "Custom value for worktrees.baseDir",
    default: suggestedBaseDir,
    validate: (value) => (value.trim() ? true : "baseDir is required."),
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
