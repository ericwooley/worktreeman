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
import { WORKTREE_CONFIG_SCHEMA_URL } from "./config-service.js";
import { runCommand } from "../utils/process.js";
import { createBareRepoLayout, ensureBranchWorktree, ensurePrimaryWorktrees, resolveCloneRootDir } from "./repository-layout-service.js";
import { initRepository } from "./init-service.js";

const GIT_TEST_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "worktreeman-tests",
  GIT_AUTHOR_EMAIL: "worktreeman@example.com",
  GIT_COMMITTER_NAME: "worktreeman-tests",
  GIT_COMMITTER_EMAIL: "worktreeman@example.com",
};

async function commitAll(repoRoot: string, message: string): Promise<void> {
  await runCommand("git", ["add", "."], { cwd: repoRoot, env: GIT_TEST_ENV });
  await runCommand("git", ["commit", "-m", message], { cwd: repoRoot, env: GIT_TEST_ENV });
}

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

test("clone flow checks out main and wtm-settings from a remote", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-clone-"));
  const sourceDir = path.join(tempRoot, "source");
  const remoteDir = path.join(tempRoot, "remote.git");
  const targetDir = path.join(tempRoot, "target");

  try {
    await fs.mkdir(sourceDir, { recursive: true });
    await runCommand("git", ["init", `--initial-branch=${DEFAULT_WORKTREEMAN_MAIN_BRANCH}`], { cwd: sourceDir });

    await fs.writeFile(path.join(sourceDir, "README.md"), "# test repo\n", "utf8");
    await commitAll(sourceDir, "initial main commit");

    await runCommand("git", ["checkout", "-b", DEFAULT_WORKTREEMAN_SETTINGS_BRANCH], { cwd: sourceDir });
    await fs.writeFile(path.join(sourceDir, "worktree.yml"), "worktrees:\n  baseDir: .\n", "utf8");
    await commitAll(sourceDir, "add settings config");

    await runCommand("git", ["clone", "--bare", sourceDir, remoteDir], { cwd: tempRoot });

    await createBareRepoLayout({ rootDir: targetDir, remoteUrl: remoteDir });
    await ensurePrimaryWorktrees({ rootDir: targetDir, createMissingBranches: false });

    await fs.access(path.join(targetDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH));
    await fs.access(path.join(targetDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, "worktree.yml"));

    const settingsStatus = await runCommand("git", ["status", "--short", "--branch"], {
      cwd: path.join(targetDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH),
    });

    assert.match(settingsStatus.stdout, /## wtm-settings/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("clone flow bootstraps missing primary branches when the remote does not have them", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-clone-"));
  const sourceDir = path.join(tempRoot, "source");
  const remoteDir = path.join(tempRoot, "remote.git");
  const targetDir = path.join(tempRoot, "target");

  try {
    await fs.mkdir(sourceDir, { recursive: true });
    await runCommand("git", ["init", "--bare", remoteDir], { cwd: tempRoot });

    await createBareRepoLayout({ rootDir: targetDir, remoteUrl: remoteDir });
    await ensurePrimaryWorktrees({ rootDir: targetDir, createMissingBranches: true });

    await fs.access(path.join(targetDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH));
    await fs.access(path.join(targetDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH));

    const status = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: targetDir });
    assert.match(status.stdout, /branch refs\/heads\/main/);
    assert.match(status.stdout, /branch refs\/heads\/wtm-settings/);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("clone flow can initialize settings config after bootstrapping missing primary branches", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-clone-"));
  const remoteDir = path.join(tempRoot, "remote.git");
  const targetDir = path.join(tempRoot, "target");

  try {
    await runCommand("git", ["init", "--bare", remoteDir], { cwd: tempRoot });

    await createBareRepoLayout({ rootDir: targetDir, remoteUrl: remoteDir });
    await ensurePrimaryWorktrees({ rootDir: targetDir, createMissingBranches: true });

    const initResult = await initRepository(targetDir, {
      runtimePorts: [],
      force: false,
    });

    assert.equal(initResult.created, true);
    const configPath = path.join(targetDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, "worktree.yml");
    await fs.access(configPath);
    const configContents = await fs.readFile(configPath, "utf8");
    assert.match(configContents, /^# yaml-language-server: \$schema=/);
    assert.match(configContents, new RegExp(`^\\$schema: ${WORKTREE_CONFIG_SCHEMA_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m"));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCloneRootDir matches git clone style defaults", () => {
  assert.equal(
    resolveCloneRootDir("/tmp/root", "https://github.com/acme/widgets.git"),
    path.resolve("/tmp/root", "widgets"),
  );
  assert.equal(
    resolveCloneRootDir("/tmp/root", "git@github.com:acme/widgets.git"),
    path.resolve("/tmp/root", "widgets"),
  );
  assert.equal(
    resolveCloneRootDir("/tmp/root", "https://github.com/acme/widgets.git", "."),
    path.resolve("/tmp/root"),
  );
  assert.equal(
    resolveCloneRootDir("/tmp/root", "https://github.com/acme/widgets.git", "./someotherfolder"),
    path.resolve("/tmp/root", "someotherfolder"),
  );
});
