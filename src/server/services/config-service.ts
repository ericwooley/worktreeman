import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import type { WorktreeManagerConfig } from "../../shared/types.js";

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

export async function loadConfig(configPath: string): Promise<WorktreeManagerConfig> {
  const raw = await fs.readFile(configPath, "utf8");
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
    startupCommands,
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
      derivedEnv: ensureRecord((docker as { derivedEnv?: unknown }).derivedEnv, "docker.derivedEnv"),
    },
  };
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
