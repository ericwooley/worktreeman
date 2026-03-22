import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
  WORKTREEMAN_BARE_DIR,
  WORKTREEMAN_GIT_FILE,
  WORKTREEMAN_GIT_FILE_CONTENT,
} from "../../shared/constants.js";
import { runCommand } from "./process.js";

export const CONFIG_CANDIDATES = ["worktree.yml", "worktree.yaml", "worktreeman.yml", "worktreeman.yaml"];

export interface RepoContext {
  repoRoot: string;
  gitDir: string;
  bareDir: string;
  configPath: string;
  configFile: string;
  configSourceRef: string;
  configWorktreePath: string;
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
    const gitPath = path.join(current, WORKTREEMAN_GIT_FILE);
    if (await isWorktreemanBareLayoutRoot(current)) {
      return current;
    }

    if (await exists(gitPath)) {
      throw new Error(
        `Git repository found at ${current}, but it is not a valid worktreeman bare layout. Expected ${WORKTREEMAN_GIT_FILE} to contain exactly \`${WORKTREEMAN_GIT_FILE_CONTENT.trim()}\` and ${WORKTREEMAN_BARE_DIR}/ to be a bare repository.`,
      );
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Unable to locate a worktreeman bare repository layout from ${startDir}. Expected a root containing ${WORKTREEMAN_GIT_FILE} and ${WORKTREEMAN_BARE_DIR}/.`,
      );
    }
    current = parent;
  }
}

export async function findRepoContext(startDir: string): Promise<RepoContext> {
  const repoRoot = await findGitRoot(startDir);
  const gitDir = path.join(repoRoot, WORKTREEMAN_GIT_FILE);
  const bareDir = path.join(repoRoot, WORKTREEMAN_BARE_DIR);
  const configWorktreePath = await findWorktreePathForRef(repoRoot, DEFAULT_WORKTREEMAN_SETTINGS_BRANCH);
  if (!configWorktreePath) {
    throw new Error(
      `Git repository found at ${repoRoot}, but the required settings worktree \`${DEFAULT_WORKTREEMAN_SETTINGS_BRANCH}\` is not checked out. Run \`worktreeman init\` first.`,
    );
  }

  for (const candidate of CONFIG_CANDIDATES) {
    const configPath = path.join(configWorktreePath, candidate);
    if (await exists(configPath)) {
      return {
        repoRoot,
        gitDir,
        bareDir,
        configPath,
        configFile: candidate,
        configSourceRef: DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
        configWorktreePath,
      };
    }
  }

  throw new Error(
    `Git repository found at ${repoRoot}, but no worktree config was present in ${configWorktreePath}. Expected one of: ${CONFIG_CANDIDATES.join(", ")}`,
  );
}

export async function isWorktreemanBareLayoutRoot(repoRoot: string): Promise<boolean> {
  const gitFilePath = path.join(repoRoot, WORKTREEMAN_GIT_FILE);
  const bareDir = path.join(repoRoot, WORKTREEMAN_BARE_DIR);

  try {
    const [gitFileContents, bareStat] = await Promise.all([
      fs.readFile(gitFilePath, "utf8"),
      fs.stat(bareDir),
    ]);

    if (!bareStat.isDirectory()) {
      return false;
    }

    if (gitFileContents !== WORKTREEMAN_GIT_FILE_CONTENT) {
      return false;
    }

    const result = await runCommand("git", ["rev-parse", "--is-bare-repository"], { cwd: bareDir });
    return result.stdout.trim() === "true";
  } catch {
    return false;
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
