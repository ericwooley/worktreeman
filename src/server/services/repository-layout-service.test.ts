import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFAULT_WORKTREEMAN_MAIN_BRANCH,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
  WORKTREEMAN_BARE_DIR,
  WORKTREEMAN_GIT_FILE,
  WORKTREEMAN_GIT_FILE_CONTENT,
} from "../../shared/constants.js";
import { runCommand } from "../utils/process.js";
import { createBareRepoLayout, ensureBranchWorktree, ensurePrimaryWorktrees } from "./repository-layout-service.js";

test("createBareRepoLayout writes linked .git file and bare repository", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-layout-"));

  try {
    await createBareRepoLayout({ rootDir });

    const gitFile = await fs.readFile(path.join(rootDir, WORKTREEMAN_GIT_FILE), "utf8");
    const bareStat = await fs.stat(path.join(rootDir, WORKTREEMAN_BARE_DIR));
    const result = await runCommand("git", ["rev-parse", "--is-bare-repository"], {
      cwd: path.join(rootDir, WORKTREEMAN_BARE_DIR),
    });

    assert.equal(gitFile, WORKTREEMAN_GIT_FILE_CONTENT);
    assert.equal(bareStat.isDirectory(), true);
    assert.equal(result.stdout.trim(), "true");
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("ensurePrimaryWorktrees bootstraps main and wtm-settings in the repo root", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-layout-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });

    await fs.access(path.join(rootDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH));
    await fs.access(path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH));

    const status = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: rootDir });
    assert.match(status.stdout, /branch refs\/heads\/main/);
    assert.match(status.stdout, /branch refs\/heads\/wtm-settings/);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("ensurePrimaryWorktrees fails in clone mode when wtm-settings is missing", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-layout-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensureBranchWorktree(rootDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH, { createIfMissing: true });

    await assert.rejects(
      () => ensurePrimaryWorktrees({ rootDir, createMissingBranches: false }),
      /Required branch wtm-settings was not found in the bare repository\./,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
