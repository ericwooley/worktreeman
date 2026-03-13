import fs from "node:fs/promises";
import path from "node:path";

const CONFIG_CANDIDATES = ["worktree.yml", "worktree.yaml", "worktreemanager.yml", "worktreemanager.yaml"];

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

export async function findRepoContext(startDir: string): Promise<RepoContext> {
  let current = path.resolve(startDir);

  while (true) {
    const gitDir = path.join(current, ".git");
    if (await exists(gitDir)) {
      for (const candidate of CONFIG_CANDIDATES) {
        const configPath = path.join(current, candidate);
        if (await exists(configPath)) {
          return { repoRoot: current, gitDir, configPath };
        }
      }

      throw new Error(
        `Git repository found at ${current}, but no worktree config was present. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
      );
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("Unable to locate a git repository with a worktree config from the current directory.");
    }
    current = parent;
  }
}

export function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}
