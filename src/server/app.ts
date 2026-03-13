import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import express from "express";
import open from "open";
import { createApiRouter } from "./routes/api.js";
import { createTerminalService } from "./services/terminal-service.js";
import { loadConfig } from "./services/config-service.js";
import { RuntimeStore } from "./state/runtime-store.js";
import type { RepoContext } from "./utils/paths.js";

export interface StartServerOptions {
  repo: RepoContext;
  port?: number;
  openBrowser?: boolean;
}

export async function startServer(options: StartServerOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const config = await loadConfig(options.repo.configPath);
  const runtimes = new RuntimeStore();
  const app = express();
  const server = http.createServer(app);

  app.use(express.json());
  app.use("/api", createApiRouter({
    repoRoot: options.repo.repoRoot,
    configPath: options.repo.configPath,
    config,
    runtimes,
  }));

  createTerminalService({
    server,
    getRuntime: (branch) => runtimes.get(branch),
  });

  const isDevelopment = process.env.NODE_ENV === "development";
  if (isDevelopment) {
    const { createServer } = await import("vite");
    const vite = await createServer({
      root: options.repo.repoRoot,
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const webDistPath = path.resolve(options.repo.repoRoot, "dist/web");
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

  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  if (options.openBrowser ?? true) {
    await open(url);
  }

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}
