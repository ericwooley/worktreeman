import fs from "node:fs/promises";
import path from "node:path";

export const CONFIG_CANDIDATES = ["worktree.yml", "worktree.yaml", "worktreemanager.yml", "worktreemanager.yaml"];

export interface RepoContext {
  repoRoot: string;
  gitDir: string;
  configPath: string;
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

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(repoRoot, candidate);
    if (await exists(configPath)) {
      return { repoRoot, gitDir, configPath };
    }
  }

  throw new Error(
    `Git repository found at ${repoRoot}, but no worktree config was present. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
  );
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
