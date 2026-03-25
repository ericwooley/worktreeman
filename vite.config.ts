import path from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

const DEFAULT_WEB_DEV_PORT = 5155;

function parsePort(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

function resolveWebDevPort(env: Record<string, string>): number {
  return parsePort(env.VITE_PORT) ?? DEFAULT_WEB_DEV_PORT;
}

function resolveProxyTarget(env: Record<string, string>): string | undefined {
  const backendPort = parsePort(env.BACKEND_SERVER_PORT) ?? parsePort(env.SERVER_PORT) ?? parsePort(env.PORT);
  return backendPort ? `http://127.0.0.1:${backendPort}` : undefined;
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, "");
  const proxyTarget = resolveProxyTarget(env);

  return {
    plugins: [react()],
    build: {
      outDir: "dist/web",
      emptyOutDir: false,
    },
    resolve: {
      alias: {
        "@shared": path.resolve(__dirname, "src/shared"),
        "@web": path.resolve(__dirname, "src/web"),
      },
    },
    server: {
      host: "127.0.0.1",
      port: resolveWebDevPort(env),
      watch: {
        ignored: ["**/.bare/**", "**/dist/**"],
      },
      proxy: proxyTarget
        ? {
            "/api": {
              target: proxyTarget,
            },
            "/ws": {
              target: proxyTarget,
              ws: true,
            },
          }
        : undefined,
    },
  };
});
