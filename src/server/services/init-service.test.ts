import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_WORKTREEMAN_MAIN_BRANCH, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { initRepository } from "./init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "./repository-layout-service.js";

test("initRepository creates the shared config in wtm-settings with root-level worktree defaults", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-init-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });

    const result = await initRepository(rootDir, {
      runtimePorts: ["PORT", " PORT ", "WEB_PORT"],
      force: false,
    });

    const configPath = path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, "worktree.yml");
    const configContents = await fs.readFile(configPath, "utf8");

    assert.equal(result.repoRoot, rootDir);
    assert.equal(result.branch, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH);
    assert.equal(result.created, true);
    assert.equal(result.worktreePath, path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH));
    assert.equal(result.configPath, configPath);
    assert.match(configContents, /baseDir: \./);
    assert.match(configContents, /runtimePorts:\n  - PORT\n  - WEB_PORT/);

    await fs.access(path.join(rootDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH));
    await fs.access(path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("initRepository preserves an existing config unless force is set", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-init-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });

    const first = await initRepository(rootDir, {
      runtimePorts: ["PORT"],
      force: false,
    });

    await fs.writeFile(first.configPath, "env:\n  CUSTOM: keep-me\nworktrees:\n  baseDir: .\n", "utf8");

    const second = await initRepository(rootDir, {
      runtimePorts: ["WEB_PORT"],
      force: false,
    });

    const preservedContents = await fs.readFile(first.configPath, "utf8");

    assert.equal(second.created, false);
    assert.equal(second.configPath, first.configPath);
    assert.match(preservedContents, /CUSTOM: keep-me/);

    await initRepository(rootDir, {
      runtimePorts: ["WEB_PORT"],
      force: true,
    });

    const overwrittenContents = await fs.readFile(first.configPath, "utf8");
    assert.doesNotMatch(overwrittenContents, /CUSTOM: keep-me/);
    assert.match(overwrittenContents, /runtimePorts:\n  - WEB_PORT/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
