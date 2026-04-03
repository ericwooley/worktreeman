import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "#test-runtime";
import { DEFAULT_WORKTREEMAN_MAIN_BRANCH, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { getTmuxRepoName, getTmuxSessionName } from "../../shared/tmux.js";
import { worktreeId } from "../../shared/worktree-id.js";
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

test("findRepoContext fails when wtm-settings exists but no config file is present", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-paths-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });

    await assert.rejects(
      () => findRepoContext(rootDir),
      /no worktree config was present/,
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("findRepoContext resolves once initRepository creates the missing settings config", async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-paths-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });

    await assert.rejects(
      () => findRepoContext(rootDir),
      /no worktree config was present/,
    );

    await initRepository(rootDir, { baseDir: ".", runtimePorts: [], force: false });

    const repo = await findRepoContext(rootDir);
    assert.equal(repo.configPath, path.join(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, "worktree.yml"));
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("tmux session names include repository identity and worktree id", () => {
  assert.equal(getTmuxRepoName("/home/alice/projects/whatever"), "projects_whatever");
  const whateverId = worktreeId("/home/alice/projects/whatever/main");
  const clientAId = worktreeId("/home/alice/client-a/main");
  const clientBId = worktreeId("/home/alice/client-b/main");
  assert.equal(getTmuxSessionName("/home/alice/projects/whatever", whateverId), `wt-projects_whatever-${whateverId}`);
  assert.equal(getTmuxSessionName("/home/alice/client-a", clientAId), `wt-client-a-${clientAId}`);
  assert.equal(getTmuxSessionName("/home/alice/client-b", clientBId), `wt-client-b-${clientBId}`);
});

test("tmux session names normalize Windows and nested paths consistently", () => {
  assert.equal(getTmuxRepoName("C:\\Users\\alice\\src\\some-other-repo"), "src_some-other-repo");
  const nestedId = worktreeId("/srv/repos/example-app/feature/add search");
  assert.equal(getTmuxSessionName("/srv/repos/example-app", nestedId), `wt-repos_example-app-${nestedId}`);
});
