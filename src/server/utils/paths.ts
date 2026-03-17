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
  configSourceRef: string;
  configWorktreePath?: string;
}

export interface RepoContextOptions {
  configRef?: string;
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

export async function findRepoContext(startDir: string, options: RepoContextOptions = {}): Promise<RepoContext> {
  const repoRoot = await findGitRoot(startDir);
  const gitDir = path.join(repoRoot, ".git");
  const preferredRef = options.configRef?.trim();
  const configRef = await resolveConfigRef(repoRoot, preferredRef);

  const configWorktreePath = await findWorktreePathForRef(repoRoot, configRef);
  if (configWorktreePath) {
    for (const candidate of CONFIG_CANDIDATES) {
      const configPath = path.join(configWorktreePath, candidate);
      if (await exists(configPath)) {
        return {
          repoRoot,
          gitDir,
          configPath,
          configRef: "WORKTREE",
          configFile: candidate,
          configSourceRef: configRef,
          configWorktreePath,
        };
      }
    }
  }

  for (const candidate of CONFIG_CANDIDATES) {
    if (await gitObjectExists(repoRoot, `${configRef}:${candidate}`)) {
      return {
        repoRoot,
        gitDir,
        configPath: `${candidate} @ ${configRef}`,
        configRef,
        configFile: candidate,
        configSourceRef: configRef,
      };
    }
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate);
    if (await exists(configPath)) {
      const currentBranch = await tryRunGit(repoRoot, ["branch", "--show-current"]);
      return {
        repoRoot,
        gitDir,
        configPath,
        configRef: "WORKTREE",
        configFile: candidate,
        configSourceRef: currentBranch ?? configRef,
        configWorktreePath: repoRoot,
      };
    }
  }

  throw new Error(
    `Git repository found at ${repoRoot}, but no worktree config was present in ${configRef} or the current worktree. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
  );
}

async function resolveConfigRef(repoRoot: string, preferredRef?: string): Promise<string> {
  const normalizedPreferredRef = preferredRef?.trim();
  if (normalizedPreferredRef) {
    return normalizedPreferredRef;
  }

  const configuredRef = await tryRunGit(repoRoot, ["config", "--local", "--get", "worktreemanager.configRef"]);
  if (configuredRef) {
    return configuredRef;
  }

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

export async function findWorktreePathForRef(repoRoot: string, ref: string): Promise<string | null> {
  const normalizedRef = normalizeBranchRef(ref);

  if (!normalizedRef) {
    return null;
  }

  const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], {
    cwd: repoRoot,
  });

  let currentWorktree: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    if (!line) {
      currentWorktree = null;
      continue;
    }

    if (line.startsWith("worktree ")) {
      currentWorktree = line.slice("worktree ".length);
      continue;
    }

    if (!currentWorktree || !line.startsWith("branch ")) {
      continue;
    }

    const branchRef = line.slice("branch ".length);
    if (normalizeBranchRef(branchRef) === normalizedRef) {
      return currentWorktree;
    }
  }

  return null;
}

function normalizeBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "").replace(/^origin\//, "").trim();
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
