import fs from "node:fs/promises";
import path from "node:path";
import type { CreateWorktreeRequest, WorktreeManagerConfig, WorktreeRecord } from "../../shared/types.js";
import { runCommand } from "../utils/process.js";
import { resolveWorktreeBaseDir } from "./config-service.js";
import { sanitizeBranchName } from "../utils/paths.js";

interface ParsedPorcelainEntry {
  worktreePath: string;
  branch: string;
  headSha?: string;
  isBare: boolean;
  isDetached: boolean;
  locked: boolean;
  prunable: boolean;
}

function parsePorcelain(output: string): ParsedPorcelainEntry[] {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const entries: ParsedPorcelainEntry[] = [];
  let current: ParsedPorcelainEntry | null = null;

  for (const line of lines) {
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");

    if (key === "worktree") {
      if (current) {
        entries.push(current);
      }
      current = {
        worktreePath: value,
        branch: path.basename(value),
        isBare: false,
        isDetached: false,
        locked: false,
        prunable: false,
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (key === "HEAD") {
      current.headSha = value;
    } else if (key === "branch") {
      current.branch = value.replace("refs/heads/", "");
    } else if (key === "bare") {
      current.isBare = true;
    } else if (key === "detached") {
      current.isDetached = true;
    } else if (key === "locked") {
      current.locked = true;
    } else if (key === "prunable") {
      current.prunable = true;
    }
  }

  if (current) {
    entries.push(current);
  }

  return entries;
}

export async function listWorktrees(repoRoot: string): Promise<WorktreeRecord[]> {
  const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  return parsePorcelain(stdout);
}

export async function createWorktree(
  repoRoot: string,
  config: WorktreeManagerConfig,
  request: CreateWorktreeRequest,
): Promise<WorktreeRecord> {
  const baseDir = resolveWorktreeBaseDir(repoRoot, config.worktrees.baseDir);
  const safeBranch = sanitizeBranchName(request.branch);
  const targetPath = request.path ? path.resolve(repoRoot, request.path) : path.join(baseDir, safeBranch);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runCommand("git", ["worktree", "add", targetPath, "-b", request.branch], { cwd: repoRoot });

  const worktrees = await listWorktrees(repoRoot);
  const created = worktrees.find((item) => path.resolve(item.worktreePath) === path.resolve(targetPath));

  if (!created) {
    throw new Error(`Worktree created at ${targetPath}, but it was not found in git worktree list.`);
  }

  return created;
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  await runCommand("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoRoot });
}
