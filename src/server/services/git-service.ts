import fs from "node:fs/promises";
import path from "node:path";
import type {
  CreateWorktreeRequest,
  GitBranchOption,
  GitCompareCommit,
  GitComparisonResponse,
  GitWorkingTreeSummary,
  WorktreeManagerConfig,
  WorktreeRecord,
} from "../../shared/types.js";
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
  return parsePorcelain(stdout).filter((entry) => {
    if (entry.isBare) {
      return false;
    }

    return path.basename(entry.worktreePath) === sanitizeBranchName(entry.branch);
  });
}

export async function createWorktree(
  repoRoot: string,
  config: WorktreeManagerConfig,
  request: CreateWorktreeRequest,
): Promise<WorktreeRecord> {
  const baseDir = resolveWorktreeBaseDir(repoRoot, config.worktrees.baseDir);
  const safeBranch = sanitizeBranchName(request.branch);
  const targetPath = path.join(baseDir, safeBranch);

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

function parseGitBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

function parseCommitLines(stdout: string): GitCompareCommit[] {
  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, shortHash, authorName, authoredAt, subject] = line.split("\t");
      return {
        hash,
        shortHash,
        authorName,
        authoredAt,
        subject,
      };
    });
}

async function resolveDefaultBranch(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await runCommand("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repoRoot });
    const branch = parseGitBranchName(stdout);
    if (branch) {
      return branch;
    }
  } catch {
    // ignore
  }

  for (const ref of ["main", "master", "origin/main", "origin/master"]) {
    try {
      await runCommand("git", ["cat-file", "-e", ref], { cwd: repoRoot });
      return parseGitBranchName(ref);
    } catch {
      // ignore
    }
  }

  const { stdout } = await runCommand("git", ["branch", "--show-current"], { cwd: repoRoot });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error("Unable to determine the default branch for git comparison.");
  }

  return branch;
}

async function listBranchOptions(repoRoot: string, worktrees: WorktreeRecord[], defaultBranch: string): Promise<GitBranchOption[]> {
  const { stdout } = await runCommand("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes/origin"], {
    cwd: repoRoot,
  });

  const currentWorktreeBranches = new Set(worktrees.map((entry) => entry.branch));
  const branchNames = Array.from(new Set(stdout.split(/\r?\n/).filter(Boolean).map(parseGitBranchName))).sort((left, right) => left.localeCompare(right));

  return branchNames.map((name) => ({
    name,
    default: name === defaultBranch,
    hasWorktree: currentWorktreeBranches.has(name),
  }));
}

async function getWorkingTreeSummary(worktreePath: string): Promise<GitWorkingTreeSummary> {
  const { stdout } = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
  const lines = stdout.split(/\r?\n/).filter(Boolean);

  let staged = false;
  let unstaged = false;
  let untracked = false;
  let changedFiles = 0;
  let untrackedFiles = 0;

  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const isUntracked = x === "?" && y === "?";

    if (isUntracked) {
      untracked = true;
      untrackedFiles += 1;
      continue;
    }

    if (x !== " ") {
      staged = true;
    }

    if (y !== " ") {
      unstaged = true;
    }

    changedFiles += 1;
  }

  return {
    dirty: lines.length > 0,
    staged,
    unstaged,
    untracked,
    changedFiles,
    untrackedFiles,
  };
}

async function getWorkingTreeDiff(worktreePath: string): Promise<string> {
  const [stagedResult, unstagedResult, untrackedResult] = await Promise.all([
    runCommand("git", ["diff", "--cached"], { cwd: worktreePath }),
    runCommand("git", ["diff"], { cwd: worktreePath }),
    runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath }),
  ]);

  const sections: string[] = [];
  if (unstagedResult.stdout.trim()) {
    sections.push("# Unstaged changes\n", unstagedResult.stdout.trimEnd());
  }

  if (stagedResult.stdout.trim()) {
    sections.push("# Staged changes\n", stagedResult.stdout.trimEnd());
  }

  const untrackedFiles = untrackedResult.stdout.split(/\r?\n/).filter(Boolean);
  if (untrackedFiles.length > 0) {
    const untrackedDiffs = await Promise.all(
      untrackedFiles.map(async (filePath) => {
        const { stdout } = await runCommand("git", ["diff", "--no-index", "--", "/dev/null", filePath], {
          cwd: worktreePath,
          allowExitCodes: [1],
        });
        return stdout.trimEnd();
      }),
    );

    const renderedUntracked = untrackedDiffs.filter(Boolean).join("\n\n");
    if (renderedUntracked) {
      sections.push("# Untracked files\n", renderedUntracked);
    }
  }

  return sections.join("\n\n").trim();
}

export async function getGitComparison(repoRoot: string, compareBranch: string, baseBranch?: string): Promise<GitComparisonResponse> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  const normalizedCompareBranch = parseGitBranchName(compareBranch);
  const normalizedBaseBranch = parseGitBranchName(baseBranch ?? defaultBranch);
  const worktrees = await listWorktrees(repoRoot);
  const selectedWorktree = worktrees.find((entry) => entry.branch === normalizedCompareBranch);
  const compareCwd = selectedWorktree?.worktreePath ?? repoRoot;

  const { stdout: mergeBaseStdout } = await runCommand("git", ["merge-base", normalizedBaseBranch, normalizedCompareBranch], { cwd: repoRoot });
  const mergeBaseHash = mergeBaseStdout.trim();

  const { stdout: leftRightStdout } = await runCommand("git", ["rev-list", "--left-right", "--count", `${normalizedBaseBranch}...${normalizedCompareBranch}`], {
    cwd: repoRoot,
  });
  const [behindRaw, aheadRaw] = leftRightStdout.trim().split(/\s+/);

  const commitFormat = "%H%x09%h%x09%an%x09%aI%x09%s";
  const [baseCommitsResult, compareCommitsResult, diffResult, mergeBaseResult, branches, workingTreeDiff, workingTreeSummary] = await Promise.all([
    runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, `${mergeBaseHash}..${normalizedBaseBranch}`], { cwd: repoRoot }),
    runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, `${mergeBaseHash}..${normalizedCompareBranch}`], { cwd: repoRoot }),
    runCommand("git", ["diff", `${normalizedBaseBranch}...${normalizedCompareBranch}`], { cwd: repoRoot }),
    runCommand("git", ["show", "-s", `--format=${commitFormat}`, mergeBaseHash], { cwd: repoRoot }),
    listBranchOptions(repoRoot, worktrees, defaultBranch),
    getWorkingTreeDiff(compareCwd),
    getWorkingTreeSummary(compareCwd),
  ]);

  const branchDiff = diffResult.stdout.trim();
  const localDiff = workingTreeDiff.trim();

  return {
    defaultBranch,
    baseBranch: normalizedBaseBranch,
    compareBranch: normalizedCompareBranch,
    mergeBase: mergeBaseHash ? parseCommitLines(mergeBaseResult.stdout)[0] ?? null : null,
    ahead: Number(aheadRaw ?? 0),
    behind: Number(behindRaw ?? 0),
    branches,
    baseCommits: parseCommitLines(baseCommitsResult.stdout),
    compareCommits: parseCommitLines(compareCommitsResult.stdout),
    diff: diffResult.stdout,
    workingTreeDiff,
    effectiveDiff: [branchDiff, localDiff].filter(Boolean).join("\n\n"),
    workingTreeSummary,
  };
}
