import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "./config-service.js";

test("loadConfig parses runtime env, links, and background commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-config-"));
  const configPath = path.join(tempDir, "worktree.yml");

  try {
    await fs.writeFile(
      configPath,
      [
        "env:",
        "  NODE_ENV: development",
        "runtimePorts:",
        "  - PORT",
        "derivedEnv:",
        "  APP_URL: http://localhost:${PORT}",
        "quickLinks:",
        "  - name: App",
        "    url: http://localhost:${PORT}",
        "backgroundCommands:",
        "  Web dev:",
        "    command: pnpm run dev",
        "  Worker: pnpm run worker",
        "worktrees:",
        "  baseDir: .worktrees",
        "startupCommands:",
        "  - pnpm install",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(configPath);

    assert.deepEqual(config.runtimePorts, ["PORT"]);
    assert.deepEqual(config.backgroundCommands, {
      "Web dev": { command: "pnpm run dev" },
      Worker: { command: "pnpm run worker" },
    });
    assert.deepEqual(config.quickLinks, [{ name: "App", url: "http://localhost:${PORT}" }]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
