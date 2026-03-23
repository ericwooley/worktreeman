import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_WORKTREEMAN_MAIN_BRANCH,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
  WORKTREEMAN_BARE_DIR,
  WORKTREEMAN_GIT_FILE,
  WORKTREEMAN_GIT_FILE_CONTENT,
} from "../../shared/constants.js";
import { runCommand } from "../utils/process.js";
import { sanitizeBranchName } from "../utils/paths.js";

interface EnsureLayoutOptions {
  rootDir: string;
}

interface EnsurePrimaryWorktreesOptions extends EnsureLayoutOptions {
  createMissingBranches?: boolean;
}

interface CreateLayoutOptions extends EnsureLayoutOptions {
  remoteUrl?: string;
}

export function resolveCloneRootDir(baseDir: string, remoteUrl: string, directory?: string): string {
  if (directory?.trim()) {
    return path.resolve(baseDir, directory);
  }

  const trimmedRemote = remoteUrl.trim().replace(/[\\/]+$/, "");
  const lastSegment = trimmedRemote.split(/[/:]/).filter(Boolean).pop() ?? "repo";
  const repoName = lastSegment.replace(/\.git$/i, "") || "repo";
  return path.resolve(baseDir, repoName);
}

export async function createBareRepoLayout(options: CreateLayoutOptions): Promise<void> {
  const rootDir = path.resolve(options.rootDir);
  const bareDir = path.join(rootDir, WORKTREEMAN_BARE_DIR);

  await fs.mkdir(rootDir, { recursive: true });

  if (options.remoteUrl) {
    await runCommand("git", ["clone", "--bare", options.remoteUrl, bareDir], { cwd: rootDir });
  } else {
    await runCommand("git", ["init", "--bare", `--initial-branch=${DEFAULT_WORKTREEMAN_MAIN_BRANCH}`, bareDir], { cwd: rootDir });
  }

  await fs.writeFile(path.join(rootDir, WORKTREEMAN_GIT_FILE), WORKTREEMAN_GIT_FILE_CONTENT, "utf8");
}

export async function ensurePrimaryWorktrees(options: EnsurePrimaryWorktreesOptions): Promise<void> {
  const rootDir = path.resolve(options.rootDir);
  const createMissingBranches = options.createMissingBranches ?? true;

  await ensureBranchWorktree(rootDir, DEFAULT_WORKTREEMAN_MAIN_BRANCH, { createIfMissing: createMissingBranches });
  await ensureBranchWorktree(rootDir, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH, { createIfMissing: createMissingBranches });
}

export async function ensureBranchWorktree(
  repoRoot: string,
  branch: string,
  options: { createIfMissing?: boolean } = {},
): Promise<string> {
  const targetPath = path.join(repoRoot, sanitizeBranchName(branch));

  try {
    await fs.access(targetPath);
    return targetPath;
  } catch {
    // continue
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (await gitRefExists(repoRoot, `refs/heads/${branch}`)) {
    await runCommand("git", ["worktree", "add", targetPath, branch], { cwd: repoRoot });
    return targetPath;
  }

  if (options.createIfMissing === false) {
    throw new Error(`Required branch ${branch} was not found in the bare repository.`);
  }

  await runCommand("git", ["worktree", "add", targetPath, "--orphan", "-b", branch], { cwd: repoRoot });
  return targetPath;
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}
