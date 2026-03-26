import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig, updateAiCommandInConfigContents } from "./config-service.js";

test("loadConfig parses runtime env, links, and background commands", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-config-"));
  const configPath = path.join(tempDir, "worktree.yml");

  try {
    await fs.writeFile(
      configPath,
      [
        "favicon: assets/brand.png",
        "preferredPort: 4800",
        "env:",
        "  NODE_ENV: development",
        "runtimePorts:",
        "  - PORT",
        "derivedEnv:",
        "  APP_URL: http://localhost:${PORT}",
        "quickLinks:",
        "  - name: App",
        "    url: http://localhost:${PORT}",
        "aiCommands:",
        "  smart: opencode run $WTM_AI_INPUT",
        "  simple: opencode run --model gpt-5-mini $WTM_AI_INPUT",
        "backgroundCommands:",
        "  Web dev:",
        "    command: bun run dev",
        "  Worker: bun run worker",
        "worktrees:",
        "  baseDir: .",
        "startupCommands:",
        "  - bun install",
        "",
      ].join("\n"),
      "utf8",
    );

     const config = await loadConfig(configPath);

      assert.equal(config.favicon, "assets/brand.png");
      assert.equal(config.preferredPort, 4800);
      assert.deepEqual(config.runtimePorts, ["PORT"]);
     assert.deepEqual(config.aiCommands, {
       smart: "opencode run $WTM_AI_INPUT",
       simple: "opencode run --model gpt-5-mini $WTM_AI_INPUT",
     });
     assert.deepEqual(config.backgroundCommands, {
       "Web dev": { command: "bun run dev" },
       Worker: { command: "bun run worker" },
     });
     assert.deepEqual(config.quickLinks, [{ name: "App", url: "http://localhost:${PORT}" }]);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("loadConfig falls back from legacy aiCommand to smart ai command", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-config-legacy-"));
  const configPath = path.join(tempDir, "worktree.yml");

  try {
    await fs.writeFile(
      configPath,
      [
        "aiCommand: opencode run $WTM_AI_INPUT",
        "worktrees:",
        "  baseDir: .",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(configPath);

    assert.deepEqual(config.aiCommands, {
      smart: "opencode run $WTM_AI_INPUT",
      simple: "",
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("updateAiCommandInConfigContents preserves schema header and upserts aiCommands", () => {
  const nextContents = updateAiCommandInConfigContents(
    [
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json",
      "",
      "env:",
      "  NODE_ENV: development",
      "worktrees:",
      "  baseDir: .worktrees",
    ].join("\n"),
    {
      smart: "opencode run $WTM_AI_INPUT",
      simple: "opencode run --model gpt-5-mini $WTM_AI_INPUT",
    },
  );

  assert.match(nextContents, /^# yaml-language-server: \$schema=/);
  assert.match(nextContents, /aiCommands:\n  smart: opencode run \$WTM_AI_INPUT\n  simple: opencode run --model gpt-5-mini \$WTM_AI_INPUT/);
  assert.doesNotMatch(nextContents, /\naiCommand:/);
});

test("loadConfig rejects invalid preferredPort values", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-config-invalid-port-"));
  const configPath = path.join(tempDir, "worktree.yml");

  try {
    await fs.writeFile(
      configPath,
      [
        "preferredPort: nope",
        "worktrees:",
        "  baseDir: .",
        "",
      ].join("\n"),
      "utf8",
    );

    await assert.rejects(() => loadConfig(configPath), /preferredPort must be a positive integer/);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
