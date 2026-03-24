import fs from "node:fs/promises";
import path from "node:path";
import yaml from "js-yaml";
import { DEFAULT_WORKTREE_BASE_DIR } from "../../shared/constants.js";
import type { AiCommandConfig, BackgroundCommandConfigEntry, QuickLinkConfigEntry, WorktreeManagerConfig } from "../../shared/types.js";
import { runCommand } from "../utils/process.js";

export const WORKTREE_CONFIG_SCHEMA_URL = "https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json";

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

function parseQuickLinks(value: unknown): QuickLinkConfigEntry[] {
  if (value == null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("quickLinks must be an array.");
  }

  return value.map((entry, index) => {
    if (typeof entry !== "object" || !entry || Array.isArray(entry)) {
      throw new Error(`quickLinks[${index}] must be a mapping/object.`);
    }

    const quickLink = entry as Record<string, unknown>;
    return {
      name: String(quickLink.name ?? ""),
      url: String(quickLink.url ?? ""),
    };
  });
}

function parseAiCommands(value: unknown, legacyAiCommand: unknown): AiCommandConfig {
  const smart = typeof legacyAiCommand === "string" ? legacyAiCommand : "";

  if (value == null) {
    return {
      smart,
      simple: "",
    };
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("aiCommands must be a mapping/object.");
  }

  const aiCommands = value as Record<string, unknown>;
  return {
    smart: typeof aiCommands.smart === "string" ? aiCommands.smart : smart,
    simple: typeof aiCommands.simple === "string" ? aiCommands.simple : "",
  };
}

export async function loadConfig(configSource: string | ConfigSource, repoRoot?: string): Promise<WorktreeManagerConfig> {
  const source = typeof configSource === "string" ? { path: configSource, repoRoot } : configSource;
  const raw = await readConfigContents(source);
  return parseConfigContents(raw);
}

export function parseConfigContents(raw: string): WorktreeManagerConfig {
  const parsed = (yaml.load(raw) as Record<string, unknown> | undefined) ?? {};

  const env = ensureRecord(parsed.env, "env");
  const startupCommands = Array.isArray(parsed.startupCommands)
    ? parsed.startupCommands.map((entry) => String(entry))
    : [];

  const worktrees = typeof parsed.worktrees === "object" && parsed.worktrees && !Array.isArray(parsed.worktrees)
    ? parsed.worktrees
    : {};

  return {
    env,
    runtimePorts: Array.isArray(parsed.runtimePorts)
      ? parsed.runtimePorts.map((entry) => String(entry)).filter(Boolean)
      : [],
    derivedEnv: ensureRecord(parsed.derivedEnv, "derivedEnv"),
    quickLinks: parseQuickLinks(parsed.quickLinks),
    aiCommands: parseAiCommands(parsed.aiCommands, parsed.aiCommand),
    startupCommands,
    backgroundCommands: parseBackgroundCommands(parsed.backgroundCommands),
    worktrees: {
      baseDir: String((worktrees as { baseDir?: string }).baseDir ?? DEFAULT_WORKTREE_BASE_DIR),
    },
  };
}

function extractSchemaHeader(raw: string): { header: string; body: string } {
  const match = raw.match(/^(# yaml-language-server: \$schema=.*\n\n?)([\s\S]*)$/);
  if (!match) {
    return { header: "", body: raw };
  }

  return {
    header: match[1].endsWith("\n\n") ? match[1] : `${match[1]}\n`,
    body: match[2],
  };
}

export function serializeConfigContents(config: Record<string, unknown>, options?: { includeSchemaHeader?: boolean }): string {
  const { $schema: _ignoredSchema, ...rest } = config;
  const normalizedConfig = {
    $schema: WORKTREE_CONFIG_SCHEMA_URL,
    ...rest,
  };

  const body = yaml.dump(normalizedConfig, {
    noRefs: true,
    lineWidth: 120,
    sortKeys: false,
  });

  if (!options?.includeSchemaHeader) {
    return body;
  }

  return `# yaml-language-server: $schema=${WORKTREE_CONFIG_SCHEMA_URL}\n\n${body}`;
}

export function updateAiCommandInConfigContents(raw: string, aiCommands: AiCommandConfig): string {
  const { body } = extractSchemaHeader(raw);
  const parsed = (yaml.load(body) as Record<string, unknown> | undefined) ?? {};

  const nextAiCommands: AiCommandConfig = {
    smart: typeof aiCommands.smart === "string" ? aiCommands.smart : "",
    simple: typeof aiCommands.simple === "string" ? aiCommands.simple : "",
  };

  if (nextAiCommands.smart.trim() || nextAiCommands.simple.trim()) {
    parsed.aiCommands = nextAiCommands;
  } else {
    delete parsed.aiCommands;
  }

  delete parsed.aiCommand;

  const nextContents = serializeConfigContents(parsed, { includeSchemaHeader: true });
  parseConfigContents(nextContents);
  return nextContents;
}

export async function readConfigContents(source: ConfigSource): Promise<string> {
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
      renderTemplate(template, sourceEnv),
    ]),
  );
}

export function renderTemplate(template: string, sourceEnv: Record<string, string>): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, variable: string) => sourceEnv[variable] ?? "");
}
