import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import open from "open";
import { createApiRouter } from "./routes/api.js";
import { loadConfig } from "./services/config-service.js";
import { stopDockerRuntime } from "./services/docker-service.js";
import { createTerminalService } from "./services/terminal-service.js";
import { releaseReservedPorts } from "./services/runtime-port-service.js";
import { RuntimeStore } from "./state/runtime-store.js";
import type { RepoContext } from "./utils/paths.js";
import type { WebSocketServer } from "ws";

export interface StartServerOptions {
  repo: RepoContext;
  port?: number;
  openBrowser?: boolean;
}

export async function startServer(options: StartServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const appRoot = fileURLToPath(new URL("../../", import.meta.url));
  const config = await loadConfig({
    path: options.repo.configPath,
    repoRoot: options.repo.repoRoot,
    gitRef: options.repo.configRef === "WORKTREE" ? undefined : options.repo.configRef,
    gitFile: options.repo.configFile,
  });
  const runtimes = new RuntimeStore();
  const app = express();
  const server = http.createServer(app);
  let terminalService: WebSocketServer | undefined;
  let vite: Awaited<ReturnType<typeof import("vite")["createServer"]>> | undefined;
  let closed = false;

  app.use(express.json());
  app.use("/api", createApiRouter({
    repoRoot: options.repo.repoRoot,
    configPath: options.repo.configPath,
    configRef: options.repo.configRef,
    configSourceRef: options.repo.configSourceRef,
    configFile: options.repo.configFile,
    configWorktreePath: options.repo.configWorktreePath,
    runtimes,
  }));

  const isDevelopment = process.env.NODE_ENV === "development";
  if (isDevelopment) {
    const { createServer } = await import("vite");
    vite = await createServer({
      root: appRoot,
      server: {
        middlewareMode: true,
        hmr: { server },
      },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const webDistPath = path.resolve(appRoot, "dist/web");
    app.use(express.static(webDistPath));
    app.get("*", async (_req, res, next) => {
      try {
        const indexPath = path.join(webDistPath, "index.html");
        await fs.access(indexPath);
        res.sendFile(indexPath);
      } catch (error) {
        next(error);
      }
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    res.status(500).json({ message });
  });

  const port = options.port ?? Number(process.env.PORT || 4312);

  const loadShutdownConfig = () => loadConfig({
    path: options.repo.configPath,
    repoRoot: options.repo.repoRoot,
    gitRef: options.repo.configRef === "WORKTREE" ? undefined : options.repo.configRef,
    gitFile: options.repo.configFile,
  });

  const close = async () => {
    if (closed) {
      return;
    }

    closed = true;
    process.stdout.write("[shutdown] Closing Worktree Manager server...\n");

    const shutdownConfig = await loadShutdownConfig().catch((error) => {
      process.stderr.write(
        `[shutdown] Failed to reload config for shutdown, using startup config: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      return config;
    });

    const activeRuntimes = runtimes.entries();
    if (activeRuntimes.length > 0) {
      process.stdout.write(`[shutdown] Stopping ${activeRuntimes.length} active runtime${activeRuntimes.length === 1 ? "" : "s"}...\n`);
    }

    for (const { runtime, reservedPorts } of activeRuntimes) {
      process.stdout.write(`[shutdown] Stopping runtime ${runtime.branch} (${runtime.composeProject})...\n`);

      try {
        process.stdout.write(`[shutdown] docker compose down for ${runtime.branch}...\n`);
        await stopDockerRuntime(runtime, shutdownConfig);
      } catch (error) {
        process.stderr.write(
          `[shutdown] Failed to stop docker runtime ${runtime.branch}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      try {
        if (reservedPorts.length > 0) {
          process.stdout.write(`[shutdown] releasing ${reservedPorts.length} reserved port${reservedPorts.length === 1 ? "" : "s"} for ${runtime.branch}...\n`);
        }
        await releaseReservedPorts(reservedPorts);
      } catch (error) {
        process.stderr.write(
          `[shutdown] Failed to release reserved ports for ${runtime.branch}: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }

      runtimes.delete(runtime.branch);
    }

    if (terminalService) {
      process.stdout.write(`[shutdown] Closing terminal websocket service (${terminalService.clients.size} client${terminalService.clients.size === 1 ? "" : "s"})...\n`);
      for (const client of terminalService.clients) {
        client.close();
      }

      await new Promise<void>((resolve) => {
        const forceTerminateTimer = setTimeout(() => {
          process.stdout.write("[shutdown] Forcing terminal client disconnects...\n");
          for (const client of terminalService?.clients ?? []) {
            client.terminate();
          }
        }, 250);

        terminalService?.close(() => {
          clearTimeout(forceTerminateTimer);
          resolve();
        });
      });
    }

    if (server.listening) {
      process.stdout.write("[shutdown] Closing HTTP server...\n");
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }

    if (vite) {
      process.stdout.write("[shutdown] Closing Vite dev server...\n");
      await vite.close();
    }

    process.stdout.write("[shutdown] Shutdown complete.\n");
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };

      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });

    terminalService = createTerminalService({
      server,
      getRuntime: (branch) => runtimes.get(branch),
    });

    const url = `http://127.0.0.1:${port}`;
    if (options.openBrowser ?? true) {
      await open(url);
    }
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }

  return {
    port,
    close,
  };
}
