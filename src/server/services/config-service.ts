import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { BackgroundCommandConfigEntry, NamedServicePort, WorktreeManagerConfig } from "../../shared/types.js";
import { runCommand } from "../utils/process.js";

export interface ConfigSource {
  path: string;
  repoRoot?: string;
  gitRef?: string;
  gitFile?: string;
}

function ensureRecord(value: unknown, label: string): Record<string, string> {
  if (value == null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping/object.`);
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (entry == null) {
        return [key, ""];
      }

      return [key, String(entry)];
    }),
  );
}

function parseNamedServicePorts(value: unknown): Record<string, NamedServicePort> {
  if (value == null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("docker.servicePorts must be a mapping/object.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => {
      if (typeof entry !== "object" || !entry || Array.isArray(entry)) {
        throw new Error(`docker.servicePorts.${name} must be a mapping/object.`);
      }

      const servicePort = entry as Record<string, unknown>;
      return [
        name,
        {
          service: String(servicePort.service),
          containerPort: Number(servicePort.containerPort),
          protocol: (servicePort.protocol as "tcp" | "udp" | undefined) ?? "tcp",
          envName: servicePort.envName == null ? undefined : String(servicePort.envName),
        },
      ];
    }),
  );
}

function parseBackgroundCommands(value: unknown): Record<string, BackgroundCommandConfigEntry> {
  if (value == null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("backgroundCommands must be a mapping/object.");
  }

  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => {
      if (typeof entry === "string") {
        return [name, { command: entry }];
      }

      if (typeof entry !== "object" || !entry || Array.isArray(entry)) {
        throw new Error(`backgroundCommands.${name} must be a string or mapping/object.`);
      }

      return [
        name,
        {
          command: String((entry as { command?: unknown }).command ?? ""),
        },
      ];
    }),
  );
}

export async function loadConfig(configSource: string | ConfigSource, repoRoot?: string): Promise<WorktreeManagerConfig> {
  const source = typeof configSource === "string" ? { path: configSource, repoRoot } : configSource;
  const raw = await readConfigContents(source);
  const parsed = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};

  const env = ensureRecord(parsed.env, "env");
  const startupCommands = Array.isArray(parsed.startupCommands)
    ? parsed.startupCommands.map((entry) => String(entry))
    : [];

  const worktrees = typeof parsed.worktrees === "object" && parsed.worktrees && !Array.isArray(parsed.worktrees)
    ? parsed.worktrees
    : {};

  const docker = typeof parsed.docker === "object" && parsed.docker && !Array.isArray(parsed.docker)
    ? parsed.docker
    : {};

  return {
    env,
    runtimePorts: Array.isArray(parsed.runtimePorts)
      ? parsed.runtimePorts.map((entry) => String(entry)).filter(Boolean)
      : [],
    derivedEnv: ensureRecord(parsed.derivedEnv, "derivedEnv"),
    quickLinks: ensureRecord(parsed.quickLinks, "quickLinks"),
    startupCommands,
    backgroundCommands: parseBackgroundCommands(parsed.backgroundCommands),
    worktrees: {
      baseDir: String((worktrees as { baseDir?: string }).baseDir ?? ".worktrees"),
    },
    docker: {
      composeFile: (docker as { composeFile?: string }).composeFile,
      projectPrefix: String((docker as { projectPrefix?: string }).projectPrefix ?? "wt"),
      portMappings: Array.isArray((docker as { portMappings?: unknown[] }).portMappings)
        ? ((docker as { portMappings: unknown[] }).portMappings.map((entry) => {
            const mapping = entry as Record<string, unknown>;
            return {
              service: String(mapping.service),
              containerPort: Number(mapping.containerPort),
              protocol: (mapping.protocol as "tcp" | "udp" | undefined) ?? "tcp",
              envName: String(mapping.envName),
            };
          }) ?? [])
        : [],
      servicePorts: parseNamedServicePorts((docker as { servicePorts?: unknown }).servicePorts),
    },
  };
}

async function readConfigContents(source: ConfigSource): Promise<string> {
  if (!source.gitRef || !source.gitFile) {
    return fs.readFile(source.path, "utf8");
  }

  if (!source.repoRoot) {
    throw new Error(`A repository root is required to load config from git ref ${source.gitRef}.`);
  }

  const result = await runCommand("git", ["show", `${source.gitRef}:${source.gitFile}`], {
    cwd: source.repoRoot,
  });
  return result.stdout;
}

export function resolveWorktreeBaseDir(repoRoot: string, baseDir: string): string {
  return path.resolve(repoRoot, baseDir);
}

export function renderDerivedEnv(
  derivedEnv: Record<string, string>,
  sourceEnv: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(derivedEnv).map(([key, template]) => [
      key,
      template.replace(/\$\{([^}]+)\}/g, (_, variable: string) => sourceEnv[variable] ?? ""),
    ]),
  );
}
