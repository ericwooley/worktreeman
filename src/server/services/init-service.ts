import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_CANDIDATES, fileExists, findGitRoot, sanitizeBranchName } from "../utils/paths.js";
import { listWorktrees } from "./git-service.js";
import { runCommand } from "../utils/process.js";

const DEFAULT_INIT_ENV_NAME_STYLE = "service-port-number" as const;

const COMPOSE_CANDIDATES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

export interface InitResult {
  branch: string;
  repoRoot: string;
  worktreePath: string;
  configPath: string;
  composeFile?: string;
  created: boolean;
  createdWorktree: boolean;
}

export interface InitOptions {
  branch: string;
  baseDir?: string;
  runtimePorts?: string[];
  force?: boolean;
}

interface ComposeDetection {
  relativePath: string;
  services: string[];
}

function pickPortEnvName(
  serviceName: string,
  containerPort: number,
): string {
  const normalized = serviceName
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  return `${normalized || "SERVICE"}_${containerPort}_PORT`;
}

function splitComposePortSpec(entry: string): string[] {
  const segments: string[] = [];
  let current = "";
  let braceDepth = 0;

  for (const char of entry) {
    if (char === "$" && current.endsWith("$")) {
      current += char;
      continue;
    }

    if (char === "{") {
      braceDepth += 1;
      current += char;
      continue;
    }

    if (char === "}" && braceDepth > 0) {
      braceDepth -= 1;
      current += char;
      continue;
    }

    if (char === ":" && braceDepth === 0) {
      segments.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  segments.push(current);
  return segments;
}

function extractEnvNameFromPortValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const interpolationMatch = value.match(/\$\{\s*([A-Za-z_][A-Za-z0-9_]*)[^}]*\}/);
  if (interpolationMatch?.[1]) {
    return interpolationMatch[1];
  }

  const directEnvMatch = value.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/);
  return directEnvMatch?.[1];
}

function extractPortMappings(
  serviceName: string,
  service: Record<string, unknown>,
) {
  const ports = Array.isArray(service.ports) ? service.ports : [];

  return ports
    .map((entry) => {
      if (typeof entry === "string") {
        const segments = splitComposePortSpec(entry);
        const containerSegment = segments.at(-1)?.split("/")[0];
        const protocol =
          (segments.at(-1)?.split("/")[1] as "tcp" | "udp" | undefined) ??
          "tcp";
        const containerPort = Number(containerSegment);
        const envName = segments
          .slice(0, -1)
          .map((segment) => extractEnvNameFromPortValue(segment))
          .find((segment): segment is string => Boolean(segment));

        if (!Number.isFinite(containerPort)) {
          return null;
        }

        return {
          service: serviceName,
          containerPort,
          protocol,
          envName: envName ?? pickPortEnvName(serviceName, containerPort),
        };
      }

      if (typeof entry === "object" && entry && !Array.isArray(entry)) {
        const mapping = entry as Record<string, unknown>;
        const target = Number(mapping.target);
        const envName = extractEnvNameFromPortValue(mapping.published);
        if (!Number.isFinite(target)) {
          return null;
        }

        return {
          service: serviceName,
          containerPort: target,
          protocol: (mapping.protocol as "tcp" | "udp" | undefined) ?? "tcp",
          envName: envName ?? pickPortEnvName(serviceName, target),
        };
      }

      return null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

async function detectComposeFile(
  repoRoot: string,
): Promise<ComposeDetection | undefined> {
  for (const candidate of COMPOSE_CANDIDATES) {
    const absolutePath = path.join(repoRoot, candidate);
    if (!(await fileExists(absolutePath))) {
      continue;
    }

    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed =
      (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
    const servicesNode = parsed.services;

    if (
      !servicesNode ||
      typeof servicesNode !== "object" ||
      Array.isArray(servicesNode)
    ) {
      return { relativePath: candidate, services: [] };
    }

    return {
      relativePath: candidate,
      services: Object.keys(servicesNode),
    };
  }

  return undefined;
}

async function buildConfigYaml(
  repoRoot: string,
  compose: ComposeDetection | undefined,
  baseDir: string,
  runtimePorts: string[],
): Promise<string> {
  const portMappings: Array<Record<string, unknown>> = [];

  if (compose?.relativePath) {
    const absolutePath = path.join(repoRoot, compose.relativePath);
    const raw = await fs.readFile(absolutePath, "utf8");
    const parsed =
      (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};
    const servicesNode = parsed.services;

    if (
      servicesNode &&
      typeof servicesNode === "object" &&
      !Array.isArray(servicesNode)
    ) {
      for (const [serviceName, serviceValue] of Object.entries(servicesNode)) {
        if (
          !serviceValue ||
          typeof serviceValue !== "object" ||
          Array.isArray(serviceValue)
        ) {
          continue;
        }

        for (const mapping of extractPortMappings(
          serviceName,
          serviceValue as Record<string, unknown>,
        )) {
          portMappings.push(mapping);
        }
      }
    }
  }

  const config = {
    env: {
      NODE_ENV: "development",
    },
    runtimePorts,
    worktrees: {
      baseDir,
    },
    docker: {
      composeFile: compose?.relativePath,
      projectPrefix: "wt",
      portMappings,
      servicePorts: {},
      derivedEnv: {},
      quickLinks: {},
    },
    startupCommands: [],
  };

  return yaml.dump(config, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  });
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
  await runCommand("git", ["config", "--local", "worktreemanager.configRef", branch], {
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
      composeFile: undefined,
      created: false,
      createdWorktree,
    };
  }

  const compose = await detectComposeFile(worktreePath);
  const contents = await buildConfigYaml(worktreePath, compose, baseDir, runtimePorts);
  await fs.writeFile(configPath, contents, "utf8");

  return {
    branch,
    repoRoot: worktreePath,
    worktreePath,
    configPath,
    composeFile: compose?.relativePath,
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
