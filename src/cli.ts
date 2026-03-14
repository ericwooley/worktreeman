#!/usr/bin/env node

import process from "node:process";
import {
  boolean,
  command,
  flag,
  number,
  option,
  optional,
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

const serveCommand = command({
  name: "serve",
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
    "Create a starter worktree.yml by inspecting the current repository and common Docker Compose files.",
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
        "Overwrite worktree.yml if an existing worktree config is already present.",
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
  handler: async ({ cwd, force, envNameStyle }) => {
    const result = await initRepository(cwd, { force, envNameStyle });

    if (!result.created) {
      process.stdout.write(
        `Existing config found at ${result.configPath}. Use --force to overwrite it.\n`,
      );
      return;
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
    serve: serveCommand,
    init: initCommand,
  },
});

function normalizeArgv(argv: string[]): string[] {
  if (argv.length === 0) {
    return ["serve"];
  }

  const [first] = argv;
  const topLevelFlags = new Set(["--help", "-h", "--version", "-v"]);
  const subcommands = new Set(["serve", "init"]);

  if (subcommands.has(first) || topLevelFlags.has(first)) {
    return argv;
  }

  if (first.startsWith("-")) {
    return ["serve", ...argv];
  }

  return argv;
}

run(cli, normalizeArgv(process.argv.slice(2))).catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
