import http from "node:http";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import open from "open";
import { DEFAULT_WORKTREEMAN_MAIN_BRANCH } from "../shared/constants.js";
import type { WorktreeId } from "../shared/worktree-id.js";
import { createApiRouter } from "./routes/api.js";
import { loadConfig } from "./services/config-service.js";
import { stopAllBackgroundCommandsForShutdown } from "./services/background-command-service.js";
import { waitForActiveAiCommandJobs } from "./services/ai-command-service.js";
import { listWorktrees } from "./services/git-service.js";
import { createOperationalStateStore, stopOperationalStateStore } from "./services/operational-state-service.js";
import { createTerminalService, ensureTerminalSession, killTmuxSession } from "./services/terminal-service.js";
import { formatServerUrl, resolveServerHost } from "./utils/server-host.js";
import { formatDurationMs, logServerEvent } from "./utils/server-logger.js";
import type { RepoContext } from "./utils/paths.js";
import type { WebSocketServer } from "ws";
import type { ViteDevServer } from "vite";
import type os from "node:os";

export interface StartServerOptions {
  repo: RepoContext;
  port?: number;
  host?: string;
  dangerouslyExposeToNetwork?: boolean;
  openBrowser?: boolean;
  prepareInitialTerminalSession?: (target: { repoRoot: string; id: WorktreeId; branch: string; worktreePath: string }) => Promise<string | void>;
  networkInterfaces?: ReturnType<typeof os.networkInterfaces>;
}

export async function startServer(options: StartServerOptions): Promise<{ port: number; host: string; url: string; close: () => Promise<void> }> {
  const config = await loadConfig({
    path: options.repo.configPath,
    repoRoot: options.repo.repoRoot,
    gitFile: options.repo.configFile,
  });
  const operationalState = await createOperationalStateStore(options.repo.repoRoot);
  await operationalState.resetShutdownStatus();
  const app = express();
  const server = http.createServer(app);
  let terminalService: WebSocketServer | undefined;
  let vite: ViteDevServer | undefined;
  let closed = false;
  const appRoot = fileURLToPath(new URL("../../", import.meta.url));
  const isDevelopment = process.env.NODE_ENV === "development";

  app.use(express.json());
  app.use((req, res, next) => {
    const startedAt = Date.now();
    let settled = false;

    const logRequest = (event: "request-completed" | "request-aborted", level: "info" | "warn" = "info") => {
      if (settled) {
        return;
      }

      settled = true;
      logServerEvent("http", event, {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        duration: formatDurationMs(Date.now() - startedAt),
        sse: req.headers.accept?.includes("text/event-stream") ?? false,
        aborted: event === "request-aborted",
      }, level);
    };

    res.on("finish", () => {
      logRequest("request-completed");
    });
    res.on("close", () => {
      if (!res.writableEnded) {
        logRequest("request-aborted", "warn");
      }
    });

    next();
  });
  app.get("/favicon.ico", async (_req, res) => {
    const faviconPath = await resolveFaviconPath({
      appRoot,
      configPath: options.repo.configPath,
      configFile: options.repo.configFile,
      configWorktreePath: options.repo.configWorktreePath,
      isDevelopment,
      repoRoot: options.repo.repoRoot,
    });

    if (!faviconPath) {
      res.status(404).end();
      return;
    }

    res.sendFile(faviconPath);
  });
  app.use("/api", createApiRouter({
    repoRoot: options.repo.repoRoot,
    configPath: options.repo.configPath,
    configSourceRef: options.repo.configSourceRef,
    configFile: options.repo.configFile,
    configWorktreePath: options.repo.configWorktreePath,
    operationalState,
  }));
  app.use("/api", (_req, res) => {
    res.status(404).json({
      message: "API route not found. Restart the server to pick up newly added endpoints.",
    });
  });

  if (isDevelopment) {
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

  const preferredPort = resolvePreferredPort(options.port, config.preferredPort);
  const resolvedHost = resolveServerHost({
    requestedHost: options.host,
    dangerouslyExposeToNetwork: options.dangerouslyExposeToNetwork,
    networkInterfaces: options.networkInterfaces,
  });
  const { port, fellBackFrom } = await resolveStartupPort(preferredPort, options.port == null, resolvedHost.listenHost);
  const prepareInitialTerminalSession = options.prepareInitialTerminalSession ?? ensureTerminalSession;

  const formatStartupError = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const code = typeof error === "object" && error && "code" in error ? String((error as { code?: unknown }).code) : null;

    if (code === "EADDRINUSE") {
      return `Port ${port} is already in use on ${resolvedHost.listenHost}. Stop the existing server or start worktreeman with --port <port>.`;
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
      void operationalState.appendShutdownInfo(message);
    };
    const logError = (message: string) => {
      process.stderr.write(`${message}\n`);
      void operationalState.appendShutdownError(message);
    };

    let shutdownError: unknown = null;

    try {
      await operationalState.beginShutdown("[shutdown] Closing worktreeman server...");
      process.stdout.write("[shutdown] Closing worktreeman server...\n");

      await loadShutdownConfig().catch((error) => {
        logError(
          `[shutdown] Failed to reload config for shutdown: ${error instanceof Error ? error.message : String(error)}`,
        );
      });

      const activeRuntimes = await operationalState.listRuntimes();
      if (activeRuntimes.length > 0) {
        logInfo(`[shutdown] Stopping ${activeRuntimes.length} active runtime${activeRuntimes.length === 1 ? "" : "s"}...`);
      }

      for (const runtime of activeRuntimes) {
        logInfo(`[shutdown] Stopping runtime ${runtime.branch}...`);

        try {
          logInfo(`[shutdown] stopping background commands for ${runtime.branch}...`);
          await stopAllBackgroundCommandsForShutdown(options.repo.repoRoot, runtime);
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

        await operationalState.deleteRuntimeById(runtime.id);
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

      await waitForActiveAiCommandJobs(options.repo.repoRoot, { timeoutMs: 500 });

      if (vite) {
        logInfo("[shutdown] Closing Vite dev server...");
        await vite.close();
      }
      await operationalState.completeShutdown("[shutdown] Shutdown complete.");
      process.stdout.write("[shutdown] Shutdown complete.\n");
    } catch (error) {
      shutdownError = error;
      const message = `[shutdown] Shutdown failed: ${error instanceof Error ? error.message : String(error)}`;
      process.stderr.write(`${message}\n`);
      await operationalState.failShutdown(message).catch(() => undefined);
    } finally {
      await stopOperationalStateStore(options.repo.repoRoot).catch(() => undefined);
    }

    if (shutdownError) {
      throw shutdownError;
    }
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
    await stopOperationalStateStore(options.repo.repoRoot).catch(() => undefined);
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
      server.listen(port, resolvedHost.listenHost);
    });

    terminalService = createTerminalService({
      server,
      getTerminalTarget: async (worktreeId) => {
        const worktrees = await listWorktrees(options.repo.repoRoot);
        const worktree = worktrees.find((entry) => entry.id === worktreeId);
        if (!worktree) {
          return undefined;
        }

        return {
          repoRoot: options.repo.repoRoot,
          id: worktree.id,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          runtime: (await operationalState.getRuntimeById(worktreeId)) ?? undefined,
        };
      },
    });

    if (fellBackFrom !== undefined) {
      process.stdout.write(
        `[startup] Port ${fellBackFrom} is already in use on ${resolvedHost.listenHost}. Using ${port} instead.\n`,
      );
    }

    if (resolvedHost.warning) {
      process.stdout.write(`${resolvedHost.warning}\n`);
    }

    process.stdout.write(`[startup] Host selection: ${resolvedHost.detail}.\n`);

    const startupWorktrees = await listWorktrees(options.repo.repoRoot);
    const startupWorktree = startupWorktrees.find((entry) => entry.branch === DEFAULT_WORKTREEMAN_MAIN_BRANCH)
      ?? startupWorktrees[0];

    if (startupWorktree) {
      try {
        await prepareInitialTerminalSession({
          repoRoot: options.repo.repoRoot,
          id: startupWorktree.id,
          branch: startupWorktree.branch,
          worktreePath: startupWorktree.worktreePath,
        });
      } catch (error) {
        throw new Error(
          `Failed to prepare tmux session for startup worktree ${startupWorktree.branch}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const url = formatServerUrl(resolvedHost.urlHost, port);
    if (options.openBrowser ?? true) {
      await open(url);
    }
  } catch (error) {
    await cleanupFailedStart(error).catch(() => undefined);
    throw new Error(formatStartupError(error));
  }

  return {
    port,
    host: resolvedHost.listenHost,
    url: formatServerUrl(resolvedHost.urlHost, port),
    close,
  };
}

function resolvePreferredPort(explicitPort?: number, configPreferredPort?: number): number {
  if (typeof explicitPort === "number" && Number.isInteger(explicitPort) && explicitPort > 0) {
    return explicitPort;
  }

  if (typeof configPreferredPort === "number" && Number.isInteger(configPreferredPort) && configPreferredPort > 0) {
    return configPreferredPort;
  }

  const envPort = Number(process.env.PORT);
  if (Number.isInteger(envPort) && envPort > 0) {
    return envPort;
  }

  return 4312;
}

async function resolveStartupPort(preferredPort: number, allowFallback: boolean, host: string): Promise<{
  port: number;
  fellBackFrom?: number;
}> {
  if (!allowFallback || await isHostPortAvailable(preferredPort, host)) {
    return { port: preferredPort };
  }

  return {
    port: await allocateHostPort(host),
    fellBackFrom: preferredPort,
  };
}

async function resolveFaviconPath(options: {
  appRoot: string;
  configPath: string;
  configFile: string;
  configWorktreePath: string;
  isDevelopment: boolean;
  repoRoot: string;
}): Promise<string | null> {
  const config = await loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitFile: options.configFile,
  });

  if (config.favicon) {
    const candidate = path.resolve(options.configWorktreePath, config.favicon);
    const relativeToRepo = path.relative(options.repoRoot, candidate);
    if (!relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo) && await fileExists(candidate)) {
      return candidate;
    }
  }

  const defaultPath = options.isDevelopment
    ? path.resolve(options.appRoot, "public/logo.png")
    : path.resolve(options.appRoot, "dist/web/logo.png");
  return await fileExists(defaultPath) ? defaultPath : null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isHostPortAvailable(port: number, host: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        resolve(false);
        return;
      }

      reject(error);
    });

    server.listen(port, host, () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(true);
      });
    });
  });
}

async function allocateHostPort(host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Unable to allocate a local port for the worktreeman server.")));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}
