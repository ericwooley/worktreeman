import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_WORKTREEMAN_MAIN_BRANCH, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { initRepository } from "../services/init-service.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "../services/repository-layout-service.js";
import { runCommand } from "./process.js";
import { findGitRoot, findRepoContext, isWorktreemanBareLayoutRoot } from "./paths.js";

test("findGitRoot rejects a standard git repository layout", async () => {
  const parentDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-paths-"));
  const repoDir = path.join(parentDir, "repo");

  try {
    await fs.mkdir(repoDir, { recursive: true });
    await runCommand("git", ["init", repoDir], { cwd: parentDir });

    await assert.rejects(
      () => findGitRoot(repoDir),
      /not a valid worktreeman bare layout/,
    );
  } finally {
    await fs.rm(parentDir, { recursive: true, force: true });
  }
});

test("findRepoContext resolves config from the bare-layout root", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-paths-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
    await initRepository(rootDir, { baseDir: ".", runtimePorts: ["PORT"], force: false });

    const repoRoot = await findGitRoot(rootDir);
    const repo = await findRepoContext(rootDir);

    assert.equal(await isWorktreemanBareLayoutRoot(rootDir), true);
    assert.equal(repoRoot, rootDir);
    assert.equal(repo.repoRoot, rootDir);
    assert.equal(repo.configSourceRef, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH);
    assert.equal(repo.configWorktreePath, path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH));
    assert.equal(repo.configPath, path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, "worktree.yml"));
    assert.equal(repo.bareDir, path.join(rootDir, ".bare"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
