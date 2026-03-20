import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_CANDIDATES, fileExists, findGitRoot, sanitizeBranchName } from "../utils/paths.js";
import { listWorktrees } from "./git-service.js";
import { runCommand } from "../utils/process.js";

const WORKTREE_CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json";

export interface InitResult {
  branch: string;
  repoRoot: string;
  worktreePath: string;
  configPath: string;
  created: boolean;
  createdWorktree: boolean;
}

export interface InitOptions {
  branch: string;
  baseDir?: string;
  runtimePorts?: string[];
  force?: boolean;
}

function buildConfigYaml(
  baseDir: string,
  runtimePorts: string[],
): string {
  const config = {
    env: {
      NODE_ENV: "development",
    },
    runtimePorts,
    derivedEnv: {},
    quickLinks: [],
    backgroundCommands: {},
    worktrees: {
      baseDir,
    },
    startupCommands: [],
  };

  return yaml.dump(config, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  });
}

function withSchemaHeader(contents: string): string {
  return `# yaml-language-server: $schema=${WORKTREE_CONFIG_SCHEMA_URL}\n\n${contents}`;
}

export async function initRepository(
  startDir: string,
  options: InitOptions,
): Promise<InitResult> {
  const branch = options.branch.trim();
  if (!branch) {
    throw new Error("A branch name is required for init.");
  }

  const force = options.force ?? false;
  const baseDir = options.baseDir?.trim() || ".worktrees";
  const runtimePorts = Array.from(
    new Set(
      (options.runtimePorts ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  const currentRepoRoot = await findGitRoot(startDir);
  const { worktreePath, createdWorktree } = await ensureBranchWorktree(currentRepoRoot, branch);
  await runCommand("git", ["config", "--local", "worktreeman.configRef", branch], {
    cwd: worktreePath,
  });

  const existingConfig = await Promise.all(
    CONFIG_CANDIDATES.map(async (candidate: string) => {
      const absolutePath = path.join(worktreePath, candidate);
      return (await fileExists(absolutePath)) ? absolutePath : null;
    }),
  );

  const existingConfigPath = existingConfig.find(
    (entry: string | null): entry is string => entry !== null,
  );
  const configPath = path.join(worktreePath, "worktree.yml");
  if (existingConfigPath && !force) {
    return {
      branch,
      repoRoot: worktreePath,
      worktreePath,
      configPath: existingConfigPath,
      created: false,
      createdWorktree,
    };
  }

  const contents = withSchemaHeader(
    buildConfigYaml(baseDir, runtimePorts),
  );
  await fs.writeFile(configPath, contents, "utf8");

  return {
    branch,
    repoRoot: worktreePath,
    worktreePath,
    configPath,
    created: true,
    createdWorktree,
  };
}

async function ensureBranchWorktree(
  repoRoot: string,
  branch: string,
): Promise<{ worktreePath: string; createdWorktree: boolean }> {
  const existing = (await listWorktrees(repoRoot)).find((entry) => entry.branch === branch);
  if (existing) {
    return {
      worktreePath: existing.worktreePath,
      createdWorktree: false,
    };
  }

  const targetPath = path.join(path.dirname(repoRoot), sanitizeBranchName(branch));
  await fs.mkdir(path.dirname(targetPath), { recursive: true });

  if (await gitRefExists(repoRoot, `refs/heads/${branch}`)) {
    await runCommand("git", ["worktree", "add", targetPath, branch], { cwd: repoRoot });
  } else if (await gitRefExists(repoRoot, `refs/remotes/origin/${branch}`)) {
    await runCommand("git", ["worktree", "add", "-b", branch, targetPath, `origin/${branch}`], {
      cwd: repoRoot,
    });
  } else {
    throw new Error(
      `Branch ${branch} does not exist locally or on origin, so init cannot create a worktree for it.`,
    );
  }

  return {
    worktreePath: targetPath,
    createdWorktree: true,
  };
}

async function gitRefExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await runCommand("git", ["show-ref", "--verify", "--quiet", ref], { cwd: repoRoot });
    return true;
  } catch {
    return false;
  }
}
