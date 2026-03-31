import process from "node:process";
import { configureDatabaseConnection } from "../services/database-connection-service.js";
import { startServer } from "../app.js";
import { findRepoContext } from "../utils/paths.js";

interface ServerEntrypointArgs {
  cwd: string;
  port?: number;
  host?: string;
  dangerouslyExposeToNetwork: boolean;
  openBrowser: boolean;
  databaseUrl?: string;
}

function parseArgs(argv: string[]): ServerEntrypointArgs {
  const args: ServerEntrypointArgs = {
    cwd: process.cwd(),
    dangerouslyExposeToNetwork: false,
    openBrowser: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    switch (value) {
      case "--cwd":
        args.cwd = argv[index + 1] ?? args.cwd;
        index += 1;
        break;
      case "--port": {
        const next = argv[index + 1];
        if (next) {
          args.port = Number(next);
          index += 1;
        }
        break;
      }
      case "--host":
        args.host = argv[index + 1] ?? args.host;
        index += 1;
        break;
      case "--dangerously-expose-to-network":
        args.dangerouslyExposeToNetwork = true;
        break;
      case "--open":
        args.openBrowser = true;
        break;
      case "--no-open":
        args.openBrowser = false;
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
  const server = await startServer({
    repo,
    port: args.port,
    host: args.host,
    dangerouslyExposeToNetwork: args.dangerouslyExposeToNetwork,
    openBrowser: args.openBrowser,
  });

  process.stdout.write(`${JSON.stringify({ type: "server-ready", url: server.url, port: server.port, host: server.host })}\n`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await server.close();
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
