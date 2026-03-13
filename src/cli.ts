#!/usr/bin/env node

import process from "node:process";
import { findRepoContext } from "./server/utils/paths.js";
import { startServer } from "./server/app.js";

async function main(): Promise<void> {
  const repo = await findRepoContext(process.cwd());
  const server = await startServer({ repo, openBrowser: true });

  process.stdout.write(`worktreemanager running at http://127.0.0.1:${server.port}\n`);

  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
