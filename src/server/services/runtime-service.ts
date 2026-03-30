import process from "node:process";
import type { QuickLinkConfigEntry, WorktreeManagerConfig, WorktreeRuntime } from "../../shared/types.js";
import { renderDerivedEnv, renderTemplate } from "./config-service.js";
import { allocateRuntimePorts } from "./runtime-port-service.js";
import { runCommand } from "../utils/process.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";
import { getTmuxSessionName } from "./terminal-service.js";

export interface RuntimeResult {
  runtime: WorktreeRuntime;
}

function renderQuickLinks(quickLinks: QuickLinkConfigEntry[], sourceEnv: Record<string, string>): QuickLinkConfigEntry[] {
  return quickLinks.map((entry) => ({
    name: entry.name,
    url: renderTemplate(entry.url, sourceEnv),
  }));
}

export function buildRuntimeProcessEnv(runtime: WorktreeRuntime): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...runtime.env,
    WORKTREE_BRANCH: runtime.branch,
    WORKTREE_PATH: runtime.worktreePath,
    TMUX_SESSION_NAME: runtime.tmuxSession,
  };
}

export async function runStartupCommands(
  commands: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  for (const command of commands) {
    const startedAt = Date.now();
    logServerEvent("runtime", "startup-command-started", {
      cwd,
      command,
    });
    await runCommand(process.env.SHELL || "bash", ["-lc", command], { cwd, env });
    logServerEvent("runtime", "startup-command-completed", {
      cwd,
      command,
      duration: formatDurationMs(Date.now() - startedAt),
    });
  }
}

export async function createRuntime(
  config: WorktreeManagerConfig,
  repoRoot: string,
  branch: string,
  worktreePath: string,
): Promise<RuntimeResult> {
  const startedAt = Date.now();
  const allocatedPortEntries = await allocateRuntimePorts(config.runtimePorts);
  const allocatedPorts = Object.fromEntries(allocatedPortEntries.map((entry) => [entry.envName, entry.port]));
  const baseEnv = {
    ...config.env,
    ...Object.fromEntries(Object.entries(allocatedPorts).map(([key, value]) => [key, String(value)])),
  };
  const env = {
    ...baseEnv,
    ...renderDerivedEnv(config.derivedEnv ?? {}, baseEnv),
  };
  const quickLinks = renderQuickLinks(config.quickLinks ?? [], env);

  const runtime = {
    branch,
    worktreePath,
    env,
    quickLinks,
    allocatedPorts,
    tmuxSession: getTmuxSessionName(repoRoot, branch),
    runtimeStartedAt: new Date().toISOString(),
  };

  logServerEvent("runtime", "runtime-created", {
    branch,
    worktreePath,
    ports: Object.keys(allocatedPorts).length,
    quickLinks: quickLinks.length,
    duration: formatDurationMs(Date.now() - startedAt),
  });

  return {
    runtime: {
      ...runtime,
    },
  };
}
