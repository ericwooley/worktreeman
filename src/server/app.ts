import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import open from "open";
import { createApiRouter } from "./routes/api.js";
import { loadConfig } from "./services/config-service.js";
import { stopAllBackgroundCommandsForShutdown } from "./services/background-command-service.js";
import { listWorktrees } from "./services/git-service.js";
import { ShutdownStatusService } from "./services/shutdown-status-service.js";
import { createTerminalService, killTmuxSession } from "./services/terminal-service.js";
import { RuntimeStore } from "./state/runtime-store.js";
import type { RepoContext } from "./utils/paths.js";
import type { WebSocketServer } from "ws";
import type { ViteDevServer } from "vite";

export interface StartServerOptions {
  repo: RepoContext;
  port?: number;
  openBrowser?: boolean;
}

export async function startServer(options: StartServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const config = await loadConfig({
    path: options.repo.configPath,
    repoRoot: options.repo.repoRoot,
    gitFile: options.repo.configFile,
  });
  const runtimes = new RuntimeStore();
  const shutdownStatus = new ShutdownStatusService();
  const app = express();
  const server = http.createServer(app);
  let terminalService: WebSocketServer | undefined;
  let vite: ViteDevServer | undefined;
  let closed = false;

  app.use(express.json());
  app.use("/api", createApiRouter({
    repoRoot: options.repo.repoRoot,
    configPath: options.repo.configPath,
    configSourceRef: options.repo.configSourceRef,
    configFile: options.repo.configFile,
    configWorktreePath: options.repo.configWorktreePath,
    runtimes,
    shutdownStatus,
  }));
  app.use("/api", (_req, res) => {
    res.status(404).json({
      message: "API route not found. Restart the server to pick up newly added endpoints.",
    });
  });

  const isDevelopment = process.env.NODE_ENV === "development";
  if (isDevelopment) {
    const appRoot = fileURLToPath(new URL("../../", import.meta.url));
    const viteModuleId = "vite";
    const { createServer } = await import(viteModuleId) as typeof import("vite");
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
    const appRoot = fileURLToPath(new URL("../../", import.meta.url));
    const webDistPath = path.resolve(appRoot, "dist/web");
    app.use(express.static(webDistPath));
    const indexPath = path.join(webDistPath, "index.html");
    app.get("*", (_req, res) => {
      res.sendFile(indexPath);
    });
  }

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    res.status(500).json({ message });
  });

  const port = options.port ?? Number(process.env.PORT || 4312);

  const formatStartupError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : null;

    if (code === "EADDRINUSE") {
      return `Port ${port} is already in use on 127.0.0.1. Stop the existing server or start worktreeman with --port <port>.`;
    }

    return message;
  };

  const loadShutdownConfig = () => loadConfig({
    path: options.repo.configPath,
    repoRoot: options.repo.repoRoot,
    gitFile: options.repo.configFile,
  });

  const close = async () => {
    if (closed) {
      return;
    }

    closed = true;
    const logInfo = (message: string) => {
      process.stdout.write(`${message}\n`);
      shutdownStatus.info(message);
    };
    const logError = (message: string) => {
      process.stderr.write(`${message}\n`);
      shutdownStatus.error(message);
    };

    shutdownStatus.begin("[shutdown] Closing worktreeman server...");
    process.stdout.write("[shutdown] Closing worktreeman server...\n");

    await loadShutdownConfig().catch((error) => {
      logError(
        `[shutdown] Failed to reload config for shutdown: ${error instanceof Error ? error.message : String(error)}`,
      );
    });

    const activeRuntimes = runtimes.entries();
    if (activeRuntimes.length > 0) {
      logInfo(`[shutdown] Stopping ${activeRuntimes.length} active runtime${activeRuntimes.length === 1 ? "" : "s"}...`);
    }

    for (const runtime of activeRuntimes) {
      logInfo(`[shutdown] Stopping runtime ${runtime.branch}...`);

      try {
        logInfo(`[shutdown] stopping background commands for ${runtime.branch}...`);
        await stopAllBackgroundCommandsForShutdown(runtime.worktreePath);
      } catch (error) {
        logError(
          `[shutdown] Failed to stop background commands for ${runtime.branch}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      try {
        logInfo(`[shutdown] killing tmux session for ${runtime.branch}...`);
        await killTmuxSession(runtime);
      } catch (error) {
        logError(
          `[shutdown] Failed to stop tmux session for ${runtime.branch}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      runtimes.delete(runtime.branch);
    }

    if (terminalService) {
      logInfo(`[shutdown] Closing terminal websocket service (${terminalService.clients.size} client${terminalService.clients.size === 1 ? "" : "s"})...`);
      for (const client of terminalService.clients) {
        client.close();
      }

      await new Promise<void>((resolve) => {
        const forceTerminateTimer = setTimeout(() => {
          logInfo("[shutdown] Forcing terminal client disconnects...");
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
      logInfo("[shutdown] Closing HTTP server...");
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
      logInfo("[shutdown] Closing Vite dev server...");
      await vite.close();
    }

    shutdownStatus.complete("[shutdown] Shutdown complete.");
    process.stdout.write("[shutdown] Shutdown complete.\n");
  };

  const cleanupFailedStart = async (error: unknown) => {
    process.stderr.write(`[startup] ${formatStartupError(error)}\n`);

    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((closeError) => {
          if (closeError) {
            reject(closeError);
            return;
          }

          resolve();
        });
      });
    }

    if (vite) {
      process.stdout.write("[startup] Closing Vite dev server after failed startup...\n");
      await vite.close();
    }
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
      getTerminalTarget: async (branch) => {
        const worktrees = await listWorktrees(options.repo.repoRoot);
        const worktree = worktrees.find((entry) => entry.branch === branch);
        if (!worktree) {
          return undefined;
        }

        return {
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          runtime: runtimes.get(branch),
        };
      },
    });

    const url = `http://127.0.0.1:${port}`;
    if (options.openBrowser ?? true) {
      await open(url);
    }
  } catch (error) {
    await cleanupFailedStart(error).catch(() => undefined);
    throw new Error(formatStartupError(error));
  }

  return {
    port,
    close,
  };
}
