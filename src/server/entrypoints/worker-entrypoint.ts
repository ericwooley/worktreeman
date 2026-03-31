import process from "node:process";
import { configureDatabaseConnection } from "../services/database-connection-service.js";
import { startProjectManagementAiWorker } from "../services/ai-command-job-manager-service.js";
import { stopAllAiCommandProcesses } from "../services/ai-command-process-service.js";
import { stopAllOperationalStateStores } from "../services/operational-state-service.js";
import { findRepoContext } from "../utils/paths.js";

interface WorkerEntrypointArgs {
  cwd: string;
  databaseUrl?: string;
}

function parseArgs(argv: string[]): WorkerEntrypointArgs {
  const args: WorkerEntrypointArgs = {
    cwd: process.cwd(),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--cwd":
        args.cwd = argv[index + 1] ?? args.cwd;
        index += 1;
        break;
      case "--database-url":
        args.databaseUrl = argv[index + 1] ?? args.databaseUrl;
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
  configureDatabaseConnection(args.databaseUrl ?? process.env.WTM_DATABASE_URL ?? null);
  const repo = await findRepoContext(args.cwd);
  const worker = await startProjectManagementAiWorker({ repoRoot: repo.repoRoot });
  process.stdout.write(`${JSON.stringify({ type: "worker-ready", repoRoot: repo.repoRoot })}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await worker.close();
    await stopAllAiCommandProcesses().catch(() => undefined);
    await stopAllOperationalStateStores().catch(() => undefined);
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
