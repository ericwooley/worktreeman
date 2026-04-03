import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "#test-runtime";
import {
  loadConfig,
  updateAiCommandInConfigContents,
  updateProjectManagementUsersInConfigContents,
} from "./config-service.js";

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
       autoStartRuntime: false,
     });
     assert.deepEqual(config.backgroundCommands, {
       "Web dev": { command: "bun run dev" },
       Worker: { command: "bun run worker" },
     });
     assert.deepEqual(config.quickLinks, [{ name: "App", url: "http://localhost:${PORT}" }]);
     assert.deepEqual(config.projectManagement.users, {
       customUsers: [],
       archivedUserIds: [],
     });
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
      autoStartRuntime: false,
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
      autoStartRuntime: false,
    },
  );

  assert.match(nextContents, /^# yaml-language-server: \$schema=/);
  assert.match(nextContents, /aiCommands:\n  smart: opencode run \$WTM_AI_INPUT\n  simple: opencode run --model gpt-5-mini \$WTM_AI_INPUT/);
  assert.doesNotMatch(nextContents, /\naiCommand:/);
});

test("loadConfig parses project management users config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-config-pm-users-"));
  const configPath = path.join(tempDir, "worktree.yml");

  try {
    await fs.writeFile(
      configPath,
      [
        "projectManagement:",
        "  users:",
        "    customUsers:",
        "      - name:  Jane Doe  ",
        "        email:  JANE@example.com  ",
        "      - name: ''",
        "        email: ''",
        "    archivedUserIds:",
        "      - abc",
        "      - abc",
        "worktrees:",
        "  baseDir: .",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = await loadConfig(configPath);

    assert.deepEqual(config.projectManagement.users, {
      customUsers: [{ name: "Jane Doe", email: "jane@example.com" }],
      archivedUserIds: ["abc"],
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});

test("updateProjectManagementUsersInConfigContents preserves schema header and removes empty overlay", () => {
  const source = [
    "# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json",
    "",
    "worktrees:",
    "  baseDir: .worktrees",
    "",
  ].join("\n");

  const populated = updateProjectManagementUsersInConfigContents(source, {
    customUsers: [{ name: "Jane Doe", email: "JANE@example.com" }],
    archivedUserIds: ["abc", "abc"],
  });

  assert.match(populated, /^# yaml-language-server: \$schema=/);
  assert.match(populated, /projectManagement:\n  users:\n    customUsers:\n      - name: Jane Doe\n        email: jane@example.com\n    archivedUserIds:\n      - abc/);

  const emptied = updateProjectManagementUsersInConfigContents(populated, {
    customUsers: [],
    archivedUserIds: [],
  });

  assert.match(emptied, /^# yaml-language-server: \$schema=/);
  assert.doesNotMatch(emptied, /projectManagement:/);
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
