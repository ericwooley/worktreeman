import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import open from "open";
import { createApiRouter } from "./routes/api.js";
import { createTerminalService } from "./services/terminal-service.js";
import { loadConfig } from "./services/config-service.js";
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

  app.use(express.json());
  app.use("/api", createApiRouter({
    repoRoot: options.repo.repoRoot,
    configPath: options.repo.configPath,
    configRef: options.repo.configRef,
    configFile: options.repo.configFile,
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

  const close = async () => {
    if (terminalService) {
      await new Promise<void>((resolve) => {
        terminalService?.close(() => resolve());
      });
    }

    if (server.listening) {
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
