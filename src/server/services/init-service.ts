import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import {
  DEFAULT_WORKTREE_BASE_DIR,
  DEFAULT_WORKTREEMAN_SETTINGS_BRANCH,
} from "../../shared/constants.js";
import { CONFIG_CANDIDATES, fileExists, findGitRoot } from "../utils/paths.js";
import { listWorktrees } from "./git-service.js";
import { ensureBranchWorktree as ensureManagedBranchWorktree } from "./repository-layout-service.js";

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
  const branch = DEFAULT_WORKTREEMAN_SETTINGS_BRANCH;

  const force = options.force ?? false;
  const baseDir = options.baseDir?.trim() || DEFAULT_WORKTREE_BASE_DIR;
  const runtimePorts = Array.from(
    new Set(
      (options.runtimePorts ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  );
  const currentRepoRoot = await findGitRoot(startDir);
  const { worktreePath, createdWorktree } = await ensureBranchWorktree(currentRepoRoot, branch);

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
      repoRoot: currentRepoRoot,
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
    repoRoot: currentRepoRoot,
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

  const targetPath = await ensureManagedBranchWorktree(repoRoot, branch);

  return {
    worktreePath: targetPath,
    createdWorktree: true,
  };
}
