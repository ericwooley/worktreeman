#!/usr/bin/env node

import process from "node:process";
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
import type { InitEnvNameStyle } from "./shared/types.js";
import { findRepoContext } from "./server/utils/paths.js";
import { startServer } from "./server/app.js";
import { initRepository } from "./server/services/init-service.js";

const initEnvNameStyle = {
  async from(value: string): Promise<InitEnvNameStyle> {
    if (
      value === "service-port-number" ||
      value === "service-port-suffix" ||
      value === "service-port"
    ) {
      return value;
    }

    throw new Error(
      "env-name-style must be one of: service-port-number, service-port-suffix, service-port",
    );
  },
};

const startCommand = command({
  name: "start",
  description:
    "Start the local Worktree Manager server for the current git repository and open the browser UI.",
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
        "Git ref to load worktree config from. Overrides WORKTREEMANAGER_CONFIG_REF and git config worktreemanager.configRef.",
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
      configRef: configRef ?? process.env.WORKTREEMANAGER_CONFIG_REF,
    });
    const server = await startServer({
      repo,
      port,
      openBrowser: noOpen ? false : open,
    });

    process.stdout.write(
      `worktreemanager running at http://127.0.0.1:${server.port}\n`,
    );

    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

const initCommand = command({
  name: "init",
  description:
    "Create a starter worktree.yml in the specified branch worktree, creating that worktree first if needed.",
  args: {
    branch: positional({
      type: string,
      displayName: "branch",
      description: "Branch whose worktree should hold the shared worktree.yml config.",
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
    force: flag({
      type: boolean,
      long: "force",
      short: "f",
      description:
        "Overwrite worktree.yml in the target branch worktree if an existing worktree config is already present.",
      defaultValue: () => false,
      defaultValueIsSerializable: true,
    }),
    envNameStyle: option({
      type: optional(initEnvNameStyle),
      long: "env-name-style",
      description:
        "Generated env var format: service-port-number, service-port-suffix, or service-port.",
    }),
  },
  handler: async ({ branch, cwd, force, envNameStyle }) => {
    const result = await initRepository(cwd, { branch, force, envNameStyle });

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
    if (result.composeFile) {
      process.stdout.write(
        `Detected Docker Compose file: ${result.composeFile}\n`,
      );
    } else {
      process.stdout.write(
        "No Docker Compose file detected. Wrote a starter config with empty docker mappings.\n",
      );
    }
  },
});

const cli = subcommands({
  name: "worktreemanager",
  version: "0.1.0",
  description:
    "Manage git worktrees, Docker Compose runtimes, and tmux-backed terminals from one local UI.",
  cmds: {
    start: startCommand,
    init: initCommand,
  },
});

run(cli, process.argv.slice(2)).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
