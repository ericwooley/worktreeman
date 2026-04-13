import process from "node:process";
import { startDatabaseSocketServer, stopDatabaseSocketServer } from "../services/database-socket-service.js";
import { findRepoContext } from "../utils/paths.js";

interface DatabaseEntrypointArgs {
  cwd: string;
}

function parseArgs(argv: string[]): DatabaseEntrypointArgs {
  const args: DatabaseEntrypointArgs = {
    cwd: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--cwd":
        args.cwd = argv[index + 1] ?? args.cwd;
        index += 1;
        break;
      default:
        break;
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const repo = await findRepoContext(args.cwd);
  const database = await startDatabaseSocketServer(repo.repoRoot);

  process.stdout.write(`${JSON.stringify({
    type: "database-ready",
    repoRoot: repo.repoRoot,
    connectionString: database.connectionString,
  })}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await stopDatabaseSocketServer(repo.repoRoot);
  };

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

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
