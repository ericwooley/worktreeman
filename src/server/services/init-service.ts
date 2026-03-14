import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { InitEnvNameStyle } from "../../shared/types.js";
import { CONFIG_CANDIDATES, fileExists, findGitRoot } from "../utils/paths.js";

const COMPOSE_CANDIDATES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
];

export interface InitResult {
  repoRoot: string;
  configPath: string;
  composeFile?: string;
  created: boolean;
}

export interface InitOptions {
  force?: boolean;
  envNameStyle?: InitEnvNameStyle;
}

interface ComposeDetection {
  relativePath: string;
  services: string[];
}

function pickPortEnvName(
  serviceName: string,
  containerPort: number,
  envNameStyle: InitEnvNameStyle,
): string {
  const normalized = serviceName
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();

  if (envNameStyle === "service-port") {
    return `${normalized || "SERVICE"}_PORT`;
  }

  if (envNameStyle === "service-port-suffix") {
    return `${normalized || "SERVICE"}_PORT_${containerPort}`;
  }

  return `${normalized || "SERVICE"}_${containerPort}_PORT`;
}

function extractPortMappings(
  serviceName: string,
  service: Record<string, unknown>,
  envNameStyle: InitEnvNameStyle,
) {
  const ports = Array.isArray(service.ports) ? service.ports : [];

  return ports
    .map((entry) => {
      if (typeof entry === "string") {
        const segments = entry.split(":");
        const containerSegment = segments.at(-1)?.split("/")[0];
        const protocol =
          (segments.at(-1)?.split("/")[1] as "tcp" | "udp" | undefined) ??
          "tcp";
        const containerPort = Number(containerSegment);

        if (!Number.isFinite(containerPort)) {
          return null;
        }

        return {
          service: serviceName,
          containerPort,
          protocol,
          envName: pickPortEnvName(serviceName, containerPort, envNameStyle),
        };
      }

      if (typeof entry === "object" && entry && !Array.isArray(entry)) {
        const mapping = entry as Record<string, unknown>;
        const target = Number(mapping.target);
        if (!Number.isFinite(target)) {
          return null;
        }

        return {
          service: serviceName,
          containerPort: target,
          protocol: (mapping.protocol as "tcp" | "udp" | undefined) ?? "tcp",
          envName: pickPortEnvName(serviceName, target, envNameStyle),
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
  envNameStyle: InitEnvNameStyle,
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
          envNameStyle,
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
    worktrees: {
      baseDir: ".worktrees",
    },
    docker: {
      composeFile: compose?.relativePath,
      projectPrefix: "wt",
      portMappings,
      servicePorts: {},
      derivedEnv: {},
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
  options: InitOptions = {},
): Promise<InitResult> {
  const force = options.force ?? false;
  const envNameStyle = options.envNameStyle ?? "service-port-number";
  const repoRoot = await findGitRoot(startDir);

  const existingConfig = await Promise.all(
    CONFIG_CANDIDATES.map(async (candidate: string) => {
      const absolutePath = path.join(repoRoot, candidate);
      return (await fileExists(absolutePath)) ? absolutePath : null;
    }),
  );

  const existingConfigPath = existingConfig.find(
    (entry: string | null): entry is string => entry !== null,
  );
  const configPath = path.join(repoRoot, "worktree.yml");
  if (existingConfigPath && !force) {
    return {
      repoRoot,
      configPath: existingConfigPath,
      composeFile: undefined,
      created: false,
    };
  }

  const compose = await detectComposeFile(repoRoot);
  const contents = await buildConfigYaml(repoRoot, compose, envNameStyle);
  await fs.writeFile(configPath, contents, "utf8");

  return {
    repoRoot,
    configPath,
    composeFile: compose?.relativePath,
    created: true,
  };
}
