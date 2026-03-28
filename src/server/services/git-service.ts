import fs from "node:fs/promises";
import path from "node:path";
import type {
  AiCommandId,
  AiCommandConfig,
  CommitGitChangesResponse,
  CreateWorktreeRequest,
  DeleteWorktreeRequest,
  GenerateGitCommitMessageResponse,
  GitBranchOption,
  GitCompareCommit,
  GitComparisonResponse,
  GitMergeConflict,
  GitMergeStatus,
  GitWorkingTreeSummary,
  WorktreeDeletionState,
  WorktreeManagerConfig,
  WorktreeRecord,
} from "../../shared/types.js";
import {
  DEFAULT_WORKTREEMAN_MAIN_BRANCH,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
} from "../../shared/constants.js";
import { runCommand } from "../utils/process.js";
import { resolveWorktreeBaseDir } from "./config-service.js";
import { ensureBranchWorktree } from "./repository-layout-service.js";
import { sanitizeBranchName } from "../utils/paths.js";

const GIT_MERGE_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "worktreeman",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "worktreeman@example.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "worktreeman",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
};

const GIT_COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "worktreeman",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "worktreeman@example.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "worktreeman",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
};

const EMPTY_TREE_HASH = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function isInvalidWorktreeErrorMessage(message: string): boolean {
  return message.includes("must be run in a work tree")
    || message.includes("not a git repository")
    || message.includes("No such file or directory");
}

async function isUsableWorktreePath(worktreePath: string): Promise<boolean> {
  try {
    await fs.access(worktreePath);
  } catch {
    return false;
  }

  try {
    const { stdout } = await runCommand("git", ["rev-parse", "--is-inside-work-tree"], { cwd: worktreePath });
    return stdout.trim() === "true";
  } catch {
    return false;
  }
}

function createMergeStatus(overrides: Partial<GitMergeStatus> = {}): GitMergeStatus {
  return {
    canMerge: false,
    hasConflicts: false,
    reason: null,
    conflicts: [],
    ...overrides,
  };
}

function parseConflictPaths(output: string): string[] {
  const paths = output
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/^CONFLICT \([^)]*\): Merge conflict in (.+)$/);
      return match?.[1]?.trim() ?? "";
    })
    .filter(Boolean);
  return Array.from(new Set(paths));
}

async function buildConflictPreviews(repoRoot: string, treeSha: string, conflictPaths: string[]): Promise<GitMergeConflict[]> {
  return Promise.all(conflictPaths.map(async (conflictPath) => {
    try {
      const { stdout } = await runCommand("git", ["show", `${treeSha}:${conflictPath}`], { cwd: repoRoot });
      const preview = stdout.trimEnd();
      const truncated = preview.length > 4000;
      return {
        path: conflictPath,
        preview: truncated ? `${preview.slice(0, 4000).trimEnd()}\n...` : preview,
        truncated,
      } satisfies GitMergeConflict;
    } catch {
      return {
        path: conflictPath,
        preview: null,
        truncated: false,
      } satisfies GitMergeConflict;
    }
  }));
}

async function buildWorkingTreeConflictPreviews(worktreePath: string, conflictPaths: string[]): Promise<GitMergeConflict[]> {
  return Promise.all(conflictPaths.map(async (conflictPath) => {
    try {
      const preview = await fs.readFile(path.join(worktreePath, conflictPath), "utf8");
      const normalizedPreview = preview.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
      const truncated = normalizedPreview.length > 4000;
      return {
        path: conflictPath,
        preview: truncated ? `${normalizedPreview.slice(0, 4000).trimEnd()}\n...` : normalizedPreview,
        truncated,
      } satisfies GitMergeConflict;
    } catch {
      return {
        path: conflictPath,
        preview: null,
        truncated: false,
      } satisfies GitMergeConflict;
    }
  }));
}

export function formatMergeConflictResolutionPrompt(options: {
  branch: string;
  baseBranch: string;
  conflicts: GitMergeConflict[];
}) {
  const renderedConflicts = options.conflicts.map((conflict) => [
    `Conflict file: ${conflict.path}`,
    "Return the fully resolved file contents for this file.",
    "Do not include markdown fences, explanations, or any prose outside the file body.",
    "Conflict preview:",
    conflict.preview ?? "(preview unavailable)",
  ].join("\n")).join("\n\n---\n\n");

  return [
    `Resolve merge conflicts while merging ${options.baseBranch} into branch ${options.branch}.`,
    "You are resolving git merge conflict markers in one or more files.",
    "Preserve the intended behavior from both sides where possible.",
    "Return only the final resolved file contents as plain text for the requested file.",
    "Do not include markdown fences, headers, explanations, or commentary.",
    renderedConflicts,
  ].join("\n\n");
}

async function generateResolvedConflictContents(options: {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  conflict: GitMergeConflict;
  aiCommands: AiCommandConfig;
  commandId: AiCommandId;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const template = resolveAiCommandTemplate(options.aiCommands, options.commandId);
  if (!template) {
    throw new Error(`${options.commandId === "simple" ? "Simple AI" : "Smart AI"} is not configured.`);
  }

  if (!template.includes("$WTM_AI_INPUT")) {
    throw new Error(`${options.commandId === "simple" ? "Simple AI" : "Smart AI"} must include $WTM_AI_INPUT.`);
  }

  const prompt = formatMergeConflictResolutionPrompt({
    branch: options.branch,
    baseBranch: options.baseBranch,
    conflicts: [options.conflict],
  });
  const command = template.split("$WTM_AI_INPUT").join(quoteShellArg(prompt));
  const { stdout } = await runCommand(process.env.SHELL || "/usr/bin/bash", ["-lc", command], {
    cwd: options.worktreePath,
    env: options.env,
  });
  const normalized = stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
  if (!normalized.trim()) {
    throw new Error(`AI did not return resolved contents for ${options.conflict.path}.`);
  }
  return `${normalized}\n`;
}

async function getMergeStatus(
  repoRoot: string,
  baseBranch: string,
  compareBranch: string,
  options?: { allowDirtyCompareBranch?: boolean },
): Promise<GitMergeStatus> {
  if (!compareBranch) {
    return createMergeStatus({ reason: "Choose a branch to merge." });
  }

  if (!baseBranch) {
    return createMergeStatus({ reason: "Choose a base branch." });
  }

  if (baseBranch === compareBranch) {
    return createMergeStatus({ reason: "Select a different base branch to merge into." });
  }

  const worktrees = await listWorktrees(repoRoot);
  const compareWorktree = worktrees.find((entry) => entry.branch === compareBranch);
  if (compareWorktree && !options?.allowDirtyCompareBranch) {
    const compareSummary = await getWorkingTreeSummary(compareWorktree.worktreePath);
    if (compareSummary.dirty) {
      return createMergeStatus({ reason: `Commit or stash local changes on ${compareBranch} before merging.` });
    }
  }

  const baseWorktree = worktrees.find((entry) => entry.branch === baseBranch);
  if (baseWorktree) {
    const baseSummary = await getWorkingTreeSummary(baseWorktree.worktreePath);
    if (baseSummary.dirty) {
      return createMergeStatus({ reason: `Commit or stash local changes on ${baseBranch} before merging.` });
    }
  }

  const [baseHasCommit, compareHasCommit] = await Promise.all([
    gitRefHasCommit(repoRoot, baseBranch),
    gitRefHasCommit(repoRoot, compareBranch),
  ]);

  if (!compareHasCommit) {
    return createMergeStatus({ reason: "This branch does not have any commits to merge yet." });
  }

  if (!baseHasCommit) {
    return createMergeStatus({ canMerge: true });
  }

  const mergeTreeResult = await runCommand(
    "git",
    ["merge-tree", "--write-tree", "--messages", "--allow-unrelated-histories", baseBranch, compareBranch],
    { cwd: repoRoot, allowExitCodes: [1] },
  );
  const output = `${mergeTreeResult.stdout}\n${mergeTreeResult.stderr}`;
  const hasConflicts = /(^|\n)(?:CONFLICT \(|Auto-merging .*\nCONFLICT \()/m.test(output);

  if (hasConflicts) {
    const treeSha = mergeTreeResult.stdout.split(/\r?\n/)[0]?.trim() ?? "";
    const conflictPaths = parseConflictPaths(output);
    const conflicts = treeSha && conflictPaths.length > 0
      ? await buildConflictPreviews(repoRoot, treeSha, conflictPaths)
      : conflictPaths.map((conflictPath) => ({ path: conflictPath, preview: null, truncated: false }));
    return createMergeStatus({
      canMerge: false,
      hasConflicts: true,
      reason: `Resolve conflicts between ${compareBranch} and ${baseBranch} before merging.`,
      conflicts,
    });
  }

  return createMergeStatus({ canMerge: true });
}

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
  const entries = parsePorcelain(stdout);
  const usablePaths = await Promise.all(entries.map(async (entry) => ({
    entry,
    usable: await isUsableWorktreePath(entry.worktreePath),
  })));

  return usablePaths
    .filter(({ entry, usable }) => {
      if (entry.isBare || entry.prunable || !usable) {
        return false;
      }

      return path.basename(entry.worktreePath) === sanitizeBranchName(entry.branch);
    })
    .map(({ entry }) => entry);
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
  const branchRef = `refs/heads/${request.branch}`;
  const existingTargetPath = await gitRefExists(repoRoot, branchRef)
    ? await ensureBranchWorktree(repoRoot, request.branch, { createIfMissing: false })
    : null;

  if (existingTargetPath) {
    if (path.resolve(existingTargetPath) !== path.resolve(targetPath)) {
      await fs.rename(existingTargetPath, targetPath);
    }
  } else {
    try {
      await runCommand("git", ["worktree", "add", targetPath, "-b", request.branch], { cwd: repoRoot });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("invalid reference: HEAD")) {
        throw error;
      }

      await runCommand("git", ["worktree", "add", targetPath, "--orphan", "-b", request.branch], { cwd: repoRoot });
    }
  }

  const worktrees = await listWorktrees(repoRoot);
  const created = worktrees.find((item) => path.resolve(item.worktreePath) === path.resolve(targetPath));

  if (!created) {
    throw new Error(`Worktree created at ${targetPath}, but it was not found in git worktree list.`);
  }

  return created;
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}

export async function removeWorktree(repoRoot: string, worktreePath: string): Promise<void> {
  try {
    await runCommand("git", ["worktree", "remove", worktreePath, "--force"], { cwd: repoRoot });
    return;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("Directory not empty")) {
      throw error;
    }
  }

  await fs.rm(worktreePath, { recursive: true, force: true });
  await runCommand("git", ["worktree", "prune"], { cwd: repoRoot });

  const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], { cwd: repoRoot });
  const stillRegistered = parsePorcelain(stdout).some((entry) => path.resolve(entry.worktreePath) === path.resolve(worktreePath));
  if (stillRegistered) {
    throw new Error(`Failed to remove worktree ${worktreePath}: git still reports it after pruning.`);
  }
}

export async function deleteBranch(repoRoot: string, branch: string): Promise<void> {
  if (!(await gitRefExists(repoRoot, `refs/heads/${branch}`))) {
    return;
  }

  await runCommand("git", ["branch", "-D", branch], { cwd: repoRoot });
}

export async function getWorktreeDeletionState(repoRoot: string, worktree: WorktreeRecord): Promise<WorktreeDeletionState> {
  const defaultBranch = parseGitBranchName(await resolveDefaultBranch(repoRoot));
  const rootWorktreePath = path.resolve(repoRoot);
  const targetWorktreePath = path.resolve(worktree.worktreePath);
  const defaultBranchWorktreePath = path.resolve(repoRoot, sanitizeBranchName(defaultBranch));
  const primaryMainWorktreePath = path.resolve(repoRoot, sanitizeBranchName(DEFAULT_WORKTREEMAN_MAIN_BRANCH));
  const isSettingsWorktree = worktree.branch === DEFAULT_WORKTREEMAN_SETTINGS_BRANCH;
  const isDefaultBranch = worktree.branch === defaultBranch;
  const isDefaultWorktree = targetWorktreePath === rootWorktreePath
    || targetWorktreePath === defaultBranchWorktreePath
    || targetWorktreePath === primaryMainWorktreePath;
  const summary = await getWorkingTreeSummary(worktree.worktreePath);
  const hasLocalChanges = summary.dirty;

  let hasUnmergedCommits = false;
  try {
    const comparison = await getGitComparison(repoRoot, worktree.branch, defaultBranch);
    hasUnmergedCommits = comparison.ahead > 0;
  } catch {
    hasUnmergedCommits = false;
  }

  const requiresConfirmation = hasLocalChanges || hasUnmergedCommits;

  if (isSettingsWorktree) {
    return {
      canDelete: false,
      reason: "The settings worktree is managed by worktreeman and cannot be deleted from the UI.",
      requiresConfirmation,
      hasLocalChanges,
      hasUnmergedCommits,
      deleteBranchByDefault: false,
      isDefaultBranch,
      isDefaultWorktree,
      isSettingsWorktree,
    };
  }

  if (isDefaultBranch || isDefaultWorktree) {
    return {
      canDelete: false,
      reason: "The default branch worktree cannot be deleted from the UI.",
      requiresConfirmation,
      hasLocalChanges,
      hasUnmergedCommits,
      deleteBranchByDefault: false,
      isDefaultBranch,
      isDefaultWorktree,
      isSettingsWorktree,
    };
  }

  return {
    canDelete: true,
    reason: null,
    requiresConfirmation,
    hasLocalChanges,
    hasUnmergedCommits,
    deleteBranchByDefault: true,
    isDefaultBranch,
    isDefaultWorktree,
    isSettingsWorktree,
  };
}

export function validateDeleteWorktreeRequest(worktree: WorktreeRecord, deletion: WorktreeDeletionState, request: DeleteWorktreeRequest) {
  if (!deletion.canDelete) {
    throw new Error(deletion.reason ?? `Worktree ${worktree.branch} cannot be deleted.`);
  }

  if (deletion.requiresConfirmation && request.confirmWorktreeName !== worktree.branch) {
    throw new Error(`Type ${worktree.branch} to confirm deleting this worktree.`);
  }
}

function parseGitBranchName(raw: string): string {
  return raw
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/^refs\/remotes\//, "")
    .replace(/^origin\//, "");
}

function resolveAiCommandTemplate(aiCommands: AiCommandConfig, commandId: AiCommandId): string {
  return (aiCommands[commandId] ?? "").trim();
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatCommitMessagePrompt(options: { branch: string; baseBranch: string }): string {
  return [
    `Write a concise git commit message for the current changes on branch ${options.branch} relative to ${options.baseBranch}.`,
    "Inspect the repository state yourself, including staged, unstaged, and untracked changes as needed.",
    "Return only the final commit message text as plain text.",
    "Use 1 or 2 short sentences focused on why the change exists.",
    "Do not use markdown, bullets, quotes, prefixes, or code fences.",
    "Avoid mentioning generated output, AI, or the prompt.",
  ].join("\n");
}

function normalizeCommitMessage(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
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

  if ((await listWorktrees(repoRoot)).some((entry) => entry.branch === DEFAULT_WORKTREEMAN_MAIN_BRANCH)) {
    return DEFAULT_WORKTREEMAN_MAIN_BRANCH;
  }

  const { stdout } = await runCommand("git", ["branch", "--show-current"], { cwd: repoRoot });
  const branch = stdout.trim();
  if (!branch) {
    throw new Error("Unable to determine the default branch for git comparison.");
  }

  return branch;
}

async function gitRefHasCommit(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["rev-parse", "--verify", `${ref}^{commit}`], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
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
  let stdout = "";
  try {
    ({ stdout } = await runCommand("git", ["status", "--short"], { cwd: worktreePath }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInvalidWorktreeErrorMessage(message)) {
      throw error;
    }

    return {
      dirty: false,
      staged: false,
      unstaged: false,
      untracked: false,
      conflicted: false,
      changedFiles: 0,
      conflictedFiles: 0,
      untrackedFiles: 0,
    };
  }

  const lines = stdout.split(/\r?\n/).filter(Boolean);

  let staged = false;
  let unstaged = false;
  let untracked = false;
  let conflicted = false;
  let changedFiles = 0;
  let conflictedFiles = 0;
  let untrackedFiles = 0;

  for (const line of lines) {
    const x = line[0] ?? " ";
    const y = line[1] ?? " ";
    const isUntracked = x === "?" && y === "?";
    const isConflicted = x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D");

    if (isUntracked) {
      untracked = true;
      untrackedFiles += 1;
      continue;
    }

    if (isConflicted) {
      conflicted = true;
      conflictedFiles += 1;
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
    conflicted,
    changedFiles,
    conflictedFiles,
    untrackedFiles,
  };
}

async function getWorkingTreeConflicts(worktreePath: string): Promise<GitMergeConflict[]> {
  let stdout = "";
  try {
    ({ stdout } = await runCommand("git", ["diff", "--name-only", "--diff-filter=U"], { cwd: worktreePath }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInvalidWorktreeErrorMessage(message)) {
      throw error;
    }

    return [];
  }

  const conflictPaths = stdout.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (conflictPaths.length === 0) {
    return [];
  }

  return buildWorkingTreeConflictPreviews(worktreePath, conflictPaths);
}

async function getWorkingTreeDiff(worktreePath: string): Promise<string> {
  let stagedResult;
  let unstagedResult;
  let untrackedResult;

  try {
    [stagedResult, unstagedResult, untrackedResult] = await Promise.all([
      runCommand("git", ["diff", "--cached"], { cwd: worktreePath }),
      runCommand("git", ["diff"], { cwd: worktreePath }),
      runCommand("git", ["ls-files", "--others", "--exclude-standard"], { cwd: worktreePath }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!isInvalidWorktreeErrorMessage(message)) {
      throw error;
    }

    return "";
  }

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

async function generateCommitMessage(options: {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  aiCommands: AiCommandConfig;
  commandId: AiCommandId;
  env: NodeJS.ProcessEnv;
}): Promise<string> {
  const template = resolveAiCommandTemplate(options.aiCommands, options.commandId);
  if (!template) {
    throw new Error(`${options.commandId === "simple" ? "Simple AI" : "Smart AI"} is not configured.`);
  }

  if (!template.includes("$WTM_AI_INPUT")) {
    throw new Error(`${options.commandId === "simple" ? "Simple AI" : "Smart AI"} must include $WTM_AI_INPUT.`);
  }

  const prompt = formatCommitMessagePrompt({
    branch: options.branch,
    baseBranch: options.baseBranch,
  });
  const command = template.split("$WTM_AI_INPUT").join(quoteShellArg(prompt));
  const { stdout } = await runCommand(process.env.SHELL || "/usr/bin/bash", ["-lc", command], {
    cwd: options.worktreePath,
    env: options.env,
  });
  const message = normalizeCommitMessage(stdout);
  if (!message) {
    throw new Error("AI did not return a commit message.");
  }

  return message;
}

export async function getGitComparison(repoRoot: string, compareBranch: string, baseBranch?: string): Promise<GitComparisonResponse> {
  const defaultBranch = await resolveDefaultBranch(repoRoot);
  const normalizedCompareBranch = parseGitBranchName(compareBranch);
  const normalizedBaseBranch = parseGitBranchName(baseBranch ?? defaultBranch);
  const worktrees = await listWorktrees(repoRoot);
  const selectedWorktree = worktrees.find((entry) => entry.branch === normalizedCompareBranch);
  const compareCwd = selectedWorktree?.worktreePath ?? repoRoot;

  const commitFormat = "%H%x09%h%x09%an%x09%aI%x09%s";
  const [branches, workingTreeDiff, workingTreeSummary, workingTreeConflicts, baseHasCommit, compareHasCommit, mergeStatus, mergeIntoCompareStatus] = await Promise.all([
    listBranchOptions(repoRoot, worktrees, defaultBranch),
    getWorkingTreeDiff(compareCwd),
    getWorkingTreeSummary(compareCwd),
    getWorkingTreeConflicts(compareCwd),
    gitRefHasCommit(repoRoot, normalizedBaseBranch),
    gitRefHasCommit(repoRoot, normalizedCompareBranch),
    getMergeStatus(repoRoot, normalizedBaseBranch, normalizedCompareBranch, { allowDirtyCompareBranch: true }),
    getMergeStatus(repoRoot, normalizedCompareBranch, normalizedBaseBranch),
  ]);

  if (!baseHasCommit && !compareHasCommit) {
    return {
      defaultBranch,
      baseBranch: normalizedBaseBranch,
      compareBranch: normalizedCompareBranch,
      mergeBase: null,
      ahead: 0,
      behind: 0,
      branches,
      baseCommits: [],
      compareCommits: [],
      diff: "",
      workingTreeDiff,
      effectiveDiff: workingTreeDiff.trim(),
      workingTreeSummary,
      workingTreeConflicts,
      mergeStatus,
      mergeIntoCompareStatus,
    };
  }

  if (!baseHasCommit && compareHasCommit) {
    const [compareCommitsResult, diffResult, aheadResult] = await Promise.all([
      runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, normalizedCompareBranch], { cwd: repoRoot }),
      runCommand("git", ["diff", EMPTY_TREE_HASH, normalizedCompareBranch], { cwd: repoRoot }),
      runCommand("git", ["rev-list", "--count", normalizedCompareBranch], { cwd: repoRoot }),
    ]);
    const branchDiff = diffResult.stdout.trim();
    const localDiff = workingTreeDiff.trim();

    return {
      defaultBranch,
      baseBranch: normalizedBaseBranch,
      compareBranch: normalizedCompareBranch,
      mergeBase: null,
      ahead: Number(aheadResult.stdout.trim() || 0),
      behind: 0,
      branches,
      baseCommits: [],
      compareCommits: parseCommitLines(compareCommitsResult.stdout),
      diff: diffResult.stdout,
      workingTreeDiff,
      effectiveDiff: [branchDiff, localDiff].filter(Boolean).join("\n\n"),
      workingTreeSummary,
      workingTreeConflicts,
      mergeStatus,
      mergeIntoCompareStatus,
    };
  }

  if (baseHasCommit && !compareHasCommit) {
    const [baseCommitsResult, diffResult, behindResult] = await Promise.all([
      runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, normalizedBaseBranch], { cwd: repoRoot }),
      runCommand("git", ["diff", normalizedBaseBranch, EMPTY_TREE_HASH], { cwd: repoRoot }),
      runCommand("git", ["rev-list", "--count", normalizedBaseBranch], { cwd: repoRoot }),
    ]);
    const branchDiff = diffResult.stdout.trim();
    const localDiff = workingTreeDiff.trim();

    return {
      defaultBranch,
      baseBranch: normalizedBaseBranch,
      compareBranch: normalizedCompareBranch,
      mergeBase: null,
      ahead: 0,
      behind: Number(behindResult.stdout.trim() || 0),
      branches,
      baseCommits: parseCommitLines(baseCommitsResult.stdout),
      compareCommits: [],
      diff: diffResult.stdout,
      workingTreeDiff,
      effectiveDiff: [branchDiff, localDiff].filter(Boolean).join("\n\n"),
      workingTreeSummary,
      workingTreeConflicts,
      mergeStatus,
      mergeIntoCompareStatus,
    };
  }

  const { stdout: mergeBaseStdout } = await runCommand("git", ["merge-base", normalizedBaseBranch, normalizedCompareBranch], {
    cwd: repoRoot,
    allowExitCodes: [1],
  });
  const mergeBaseHash = mergeBaseStdout.trim();

  const { stdout: leftRightStdout } = await runCommand("git", ["rev-list", "--left-right", "--count", `${normalizedBaseBranch}...${normalizedCompareBranch}`], {
    cwd: repoRoot,
  });
  const [behindRaw, aheadRaw] = leftRightStdout.trim().split(/\s+/);

  if (!mergeBaseHash) {
    const [baseCommitsResult, compareCommitsResult, diffResult] = await Promise.all([
      runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, normalizedBaseBranch], { cwd: repoRoot }),
      runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, normalizedCompareBranch], { cwd: repoRoot }),
      runCommand("git", ["diff", normalizedBaseBranch, normalizedCompareBranch], { cwd: repoRoot }),
    ]);

    const branchDiff = diffResult.stdout.trim();
    const localDiff = workingTreeDiff.trim();

    return {
      defaultBranch,
      baseBranch: normalizedBaseBranch,
      compareBranch: normalizedCompareBranch,
      mergeBase: null,
      ahead: Number(aheadRaw ?? 0),
      behind: Number(behindRaw ?? 0),
      branches,
      baseCommits: parseCommitLines(baseCommitsResult.stdout),
      compareCommits: parseCommitLines(compareCommitsResult.stdout),
      diff: diffResult.stdout,
      workingTreeDiff,
      effectiveDiff: [branchDiff, localDiff].filter(Boolean).join("\n\n"),
      workingTreeSummary,
      workingTreeConflicts,
      mergeStatus,
      mergeIntoCompareStatus,
    };
  }

  const [baseCommitsResult, compareCommitsResult, diffResult, mergeBaseResult] = await Promise.all([
    runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, `${mergeBaseHash}..${normalizedBaseBranch}`], { cwd: repoRoot }),
    runCommand("git", ["log", "--reverse", `--format=${commitFormat}`, `${mergeBaseHash}..${normalizedCompareBranch}`], { cwd: repoRoot }),
    runCommand("git", ["diff", `${normalizedBaseBranch}...${normalizedCompareBranch}`], { cwd: repoRoot }),
    runCommand("git", ["show", "-s", `--format=${commitFormat}`, mergeBaseHash], { cwd: repoRoot }),
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
    workingTreeConflicts,
    mergeStatus,
    mergeIntoCompareStatus,
  };
}

export async function mergeGitBranch(repoRoot: string, compareBranch: string, baseBranch?: string): Promise<GitComparisonResponse> {
  const normalizedCompareBranch = parseGitBranchName(compareBranch);
  if (!normalizedCompareBranch) {
    throw new Error("A compare branch is required for merge.");
  }

  const normalizedBaseBranch = parseGitBranchName(baseBranch ?? await resolveDefaultBranch(repoRoot));
  if (!normalizedBaseBranch) {
    throw new Error("A base branch is required for merge.");
  }

  if (normalizedCompareBranch === normalizedBaseBranch) {
    throw new Error(`Cannot merge branch ${normalizedCompareBranch} into itself.`);
  }

  const mergeStatus = await getMergeStatus(repoRoot, normalizedBaseBranch, normalizedCompareBranch, {
    allowDirtyCompareBranch: true,
  });
  if (!mergeStatus.canMerge) {
    throw new Error(mergeStatus.reason ?? `Branch ${normalizedCompareBranch} cannot be merged into ${normalizedBaseBranch}.`);
  }

  const worktrees = await listWorktrees(repoRoot);
  const baseWorktreePath = worktrees.find((entry) => entry.branch === normalizedBaseBranch)?.worktreePath
    ?? await ensureBranchWorktree(repoRoot, normalizedBaseBranch);
  const baseSummary = await getWorkingTreeSummary(baseWorktreePath);
  if (baseSummary.dirty) {
    throw new Error(`Base branch ${normalizedBaseBranch} has uncommitted changes. Clean it up before merging.`);
  }

  try {
    await runCommand("git", ["merge", "--no-edit", normalizedCompareBranch], {
      cwd: baseWorktreePath,
      env: GIT_MERGE_ENV,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("refusing to merge unrelated histories")) {
      try {
        await runCommand("git", ["merge", "--no-edit", "--allow-unrelated-histories", normalizedCompareBranch], {
          cwd: baseWorktreePath,
          env: GIT_MERGE_ENV,
        });
        return getGitComparison(repoRoot, normalizedCompareBranch, normalizedBaseBranch);
      } catch (retryError) {
        try {
          await runCommand("git", ["merge", "--abort"], {
            cwd: baseWorktreePath,
            env: GIT_MERGE_ENV,
            allowExitCodes: [1],
          });
        } catch {
          // ignore abort cleanup errors
        }

        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        throw new Error(`Failed to merge ${normalizedCompareBranch} into ${normalizedBaseBranch}: ${retryMessage}`);
      }
    }

    try {
      await runCommand("git", ["merge", "--abort"], {
        cwd: baseWorktreePath,
        env: GIT_MERGE_ENV,
        allowExitCodes: [1],
      });
    } catch {
      // ignore abort cleanup errors
    }

    throw new Error(`Failed to merge ${normalizedCompareBranch} into ${normalizedBaseBranch}: ${message}`);
  }

  return getGitComparison(repoRoot, normalizedCompareBranch, normalizedBaseBranch);
}

export async function commitGitChanges(options: {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  aiCommands: AiCommandConfig;
  commandId: AiCommandId;
  env: NodeJS.ProcessEnv;
  message?: string;
}): Promise<CommitGitChangesResponse> {
  const normalizedBranch = parseGitBranchName(options.branch);
  if (!normalizedBranch) {
    throw new Error("A branch is required to create a commit.");
  }

  const worktrees = await listWorktrees(options.repoRoot);
  const worktree = worktrees.find((entry) => entry.branch === normalizedBranch);
  if (!worktree) {
    throw new Error(`Unknown worktree ${normalizedBranch}.`);
  }

  const baseBranch = parseGitBranchName(options.baseBranch ?? await resolveDefaultBranch(options.repoRoot));
  const workingTreeSummary = await getWorkingTreeSummary(worktree.worktreePath);
  if (!workingTreeSummary.dirty) {
    throw new Error(`Branch ${normalizedBranch} has no local changes to commit.`);
  }

  const message = options.message?.trim()
    ? normalizeCommitMessage(options.message)
    : await generateCommitMessage({
      worktreePath: worktree.worktreePath,
      branch: normalizedBranch,
      baseBranch,
      aiCommands: options.aiCommands,
      commandId: options.commandId,
      env: options.env,
    });

  if (!message) {
    throw new Error("Commit message is required.");
  }

  await runCommand("git", ["add", "-A"], {
    cwd: worktree.worktreePath,
    env: GIT_COMMIT_ENV,
  });
  await runCommand("git", ["commit", "-m", message], {
    cwd: worktree.worktreePath,
    env: GIT_COMMIT_ENV,
  });
  const { stdout: commitSha } = await runCommand("git", ["rev-parse", "HEAD"], {
    cwd: worktree.worktreePath,
    env: GIT_COMMIT_ENV,
  });

  return {
    branch: normalizedBranch,
    commandId: options.commandId,
    message,
    commitSha: commitSha.trim(),
    comparison: await getGitComparison(options.repoRoot, normalizedBranch, baseBranch),
  };
}

export async function generateGitCommitMessage(options: {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  aiCommands: AiCommandConfig;
  commandId: AiCommandId;
  env: NodeJS.ProcessEnv;
}): Promise<GenerateGitCommitMessageResponse> {
  const normalizedBranch = parseGitBranchName(options.branch);
  if (!normalizedBranch) {
    throw new Error("A branch is required to generate a commit message.");
  }

  const worktrees = await listWorktrees(options.repoRoot);
  const worktree = worktrees.find((entry) => entry.branch === normalizedBranch);
  if (!worktree) {
    throw new Error(`Unknown worktree ${normalizedBranch}.`);
  }

  const baseBranch = parseGitBranchName(options.baseBranch ?? await resolveDefaultBranch(options.repoRoot));
  const workingTreeSummary = await getWorkingTreeSummary(worktree.worktreePath);
  if (!workingTreeSummary.dirty) {
    throw new Error(`Branch ${normalizedBranch} has no local changes to commit.`);
  }

  const message = await generateCommitMessage({
    worktreePath: worktree.worktreePath,
    branch: normalizedBranch,
    baseBranch,
    aiCommands: options.aiCommands,
    commandId: options.commandId,
    env: options.env,
  });

  return {
    branch: normalizedBranch,
    commandId: options.commandId,
    message,
  };
}

export async function resolveMergeConflictsWithAi(options: {
  repoRoot: string;
  branch: string;
  baseBranch?: string;
  aiCommands: AiCommandConfig;
  commandId: AiCommandId;
  env: NodeJS.ProcessEnv;
}): Promise<GitComparisonResponse> {
  const normalizedBranch = parseGitBranchName(options.branch);
  if (!normalizedBranch) {
    throw new Error("A branch is required to resolve merge conflicts.");
  }

  const baseBranch = parseGitBranchName(options.baseBranch ?? await resolveDefaultBranch(options.repoRoot));
  const worktrees = await listWorktrees(options.repoRoot);
  const worktree = worktrees.find((entry) => entry.branch === normalizedBranch);
  if (!worktree) {
    throw new Error(`Unknown worktree ${normalizedBranch}.`);
  }

  const comparison = await getGitComparison(options.repoRoot, normalizedBranch, baseBranch);
  const conflictsToResolve = comparison.workingTreeConflicts.length > 0
    ? comparison.workingTreeConflicts
    : comparison.mergeIntoCompareStatus.conflicts;

  if (conflictsToResolve.length === 0) {
    throw new Error(`Branch ${normalizedBranch} does not currently expose merge conflicts against ${baseBranch}.`);
  }

  for (const conflict of conflictsToResolve) {
    const resolvedContents = await generateResolvedConflictContents({
      worktreePath: worktree.worktreePath,
      branch: normalizedBranch,
      baseBranch,
      conflict,
      aiCommands: options.aiCommands,
      commandId: options.commandId,
      env: options.env,
    });
    await fs.writeFile(path.join(worktree.worktreePath, conflict.path), resolvedContents, "utf8");
  }

  await runCommand("git", ["add", "--", ...conflictsToResolve.map((conflict) => conflict.path)], {
    cwd: worktree.worktreePath,
    env: GIT_COMMIT_ENV,
  });

  return getGitComparison(options.repoRoot, normalizedBranch, baseBranch);
}
