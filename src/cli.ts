#!/usr/bin/env node

import process from "node:process";
import { boolean, command, flag, number, option, optional, run, string } from "cmd-ts";
import { findRepoContext } from "./server/utils/paths.js";
import { startServer } from "./server/app.js";

const cli = command({
  name: "worktreemanager",
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
      description: "Directory to start searching from when locating the repository root.",
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
    const server = await startServer({ repo, port, openBrowser: noOpen ? false : open });

    process.stdout.write(`worktreemanager running at http://127.0.0.1:${server.port}\n`);

    const shutdown = async () => {
      await server.close();
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  },
});

run(cli, process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
