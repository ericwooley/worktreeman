import path from "node:path";
import os from "node:os";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const cpuCount = Math.max(1, os.cpus().length);
// Leave a couple of cores for the host when running full suites.
const maxForks = Math.min(12, Math.max(2, cpuCount - 2));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "#test-runtime": path.resolve(__dirname, "src/shared/test-runtime.ts"),
      "@shared": path.resolve(__dirname, "src/shared"),
      "@web": path.resolve(__dirname, "src/web"),
    },
  },
  test: {
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["dist/**", "node_modules/**"],
    fileParallelism: true,
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: false,
        maxForks,
        minForks: 1,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
    setupFiles: [path.resolve(__dirname, "vitest.setup.ts")],
  },
});
