import fs from "node:fs/promises";
import path from "node:path";
import { runCommand } from "./process.js";

export const CONFIG_CANDIDATES = ["worktree.yml", "worktree.yaml", "worktreemanager.yml", "worktreemanager.yaml"];

export interface RepoContext {
  repoRoot: string;
  gitDir: string;
  configPath: string;
  configRef: string;
  configFile: string;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  return exists(filePath);
}

export async function findGitRoot(startDir: string): Promise<string> {
  let current = path.resolve(startDir);

  while (true) {
    const gitDir = path.join(current, ".git");
    if (await exists(gitDir)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate a git repository from the current directory.");
    }
    current = parent;
  }
}

export async function findRepoContext(startDir: string): Promise<RepoContext> {
  const repoRoot = await findGitRoot(startDir);
  const gitDir = path.join(repoRoot, ".git");
  const configRef = await resolveConfigRef(repoRoot);

  for (const candidate of CONFIG_CANDIDATES) {
    if (await gitObjectExists(repoRoot, `${configRef}:${candidate}`)) {
      return {
        repoRoot,
        gitDir,
        configPath: `${candidate} @ ${configRef}`,
        configRef,
        configFile: candidate,
      };
    }
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate);
    if (await exists(configPath)) {
      return {
        repoRoot,
        gitDir,
        configPath,
        configRef: "WORKTREE",
        configFile: candidate,
      };
    }
  }

  throw new Error(
    `Git repository found at ${repoRoot}, but no worktree config was present in ${configRef} or the current worktree. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
  );
}

async function resolveConfigRef(repoRoot: string): Promise<string> {
  const remoteHead = await tryRunGit(repoRoot, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (remoteHead) {
    return remoteHead;
  }

  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    if (await gitObjectExists(repoRoot, ref)) {
      return ref;
    }
  }

  const currentBranch = await tryRunGit(repoRoot, ["branch", "--show-current"]);
  if (currentBranch) {
    return currentBranch;
  }

  throw new Error(
    "Unable to determine which branch should be used for worktree config lookup. Expected origin/HEAD, main, or master.",
  );
}

async function gitObjectExists(repoRoot: string, objectName: string): Promise<boolean> {
  try {
    await runCommand("git", ["cat-file", "-e", objectName], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

async function tryRunGit(repoRoot: string, args: string[]): Promise<string | null> {
  try {
    const result = await runCommand("git", args, { cwd: repoRoot });
    const value = result.stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
