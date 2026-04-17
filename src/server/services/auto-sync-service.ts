import type {
  AutoSyncConfig,
  WorktreeAutoSyncSshAgentStatus,
  WorktreeAutoSyncState,
  WorktreeManagerConfig,
  WorktreeRecord,
} from "../../shared/types.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import type { OperationalStateStore } from "./operational-state-service.js";
import { getWorkingTreeSummary, listWorktrees } from "./git-service.js";
import { runCommand } from "../utils/process.js";
import { logServerEvent } from "../utils/server-logger.js";

const DOCUMENTS_BRANCH = "documents";

type AutoSyncServiceOptions = {
  repoRoot: string;
  operationalState: OperationalStateStore;
  loadCurrentConfig: () => Promise<WorktreeManagerConfig>;
  emitStateRefresh: () => void;
  emitGitStateRefresh: () => void;
  intervalMs?: number;
};

type SshAgentCheckResult = {
  status: WorktreeAutoSyncSshAgentStatus;
  message: string | null;
};

function isSshRemote(remoteUrl: string): boolean {
  const value = remoteUrl.trim();
  return value.startsWith("git@") || value.startsWith("ssh://") || /^[^@\s]+@[^:\s]+:.+/.test(value);
}

function createState(
  worktree: Pick<WorktreeRecord, "id" | "branch" | "worktreePath">,
  config: AutoSyncConfig,
  overrides?: Partial<WorktreeAutoSyncState>,
): WorktreeAutoSyncState {
  return {
    worktreeId: worktree.id,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    enabled: false,
    status: "disabled",
    remote: config.remote,
    message: null,
    sshAgentStatus: "not-required",
    ...overrides,
  };
}

async function getCurrentBranch(worktreePath: string): Promise<string> {
  const result = await runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath });
  return result.stdout.trim();
}

async function getRemoteUrl(worktreePath: string, remote: string): Promise<string> {
  const result = await runCommand("git", ["remote", "get-url", remote], { cwd: worktreePath });
  return result.stdout.trim();
}

async function checkSshAgent(remoteUrl: string): Promise<SshAgentCheckResult> {
  if (!isSshRemote(remoteUrl)) {
    return { status: "not-required", message: null };
  }

  if (!process.env.SSH_AUTH_SOCK) {
    return {
      status: "missing",
      message: "SSH agent is required for the selected remote. Start ssh-agent and load your key with ssh-add.",
    };
  }

  const result = await runCommand("ssh-add", ["-l"], {
    cwd: options.repoRoot,
    allowExitCodes: [0, 1, 2],
    env: process.env,
  });

  if (result.exitCode === 0) {
    return { status: "ready", message: null };
  }

  if (result.exitCode === 1) {
    return {
      status: "missing",
      message: "ssh-agent is running but no identities are loaded. Add your key with ssh-add before auto sync runs.",
    };
  }

  return {
    status: "unavailable",
    message: (result.stderr || result.stdout || "SSH agent is unavailable.").trim(),
  };
}

async function getAheadBehind(worktreePath: string, remote: string, branch: string): Promise<{ ahead: number; behind: number }> {
  const result = await runCommand("git", ["rev-list", "--left-right", "--count", `HEAD...${remote}/${branch}`], {
    cwd: worktreePath,
  });
  const [aheadRaw = "0", behindRaw = "0"] = result.stdout.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw, 10) || 0,
    behind: Number.parseInt(behindRaw, 10) || 0,
  };
}

export function createAutoSyncService(options: AutoSyncServiceOptions) {
  const intervalMs = options.intervalMs ?? 30_000;
  const inFlight = new Set<WorktreeId>();
  let interval: NodeJS.Timeout | null = null;
  let disposed = false;

  const persistState = async (state: WorktreeAutoSyncState, emitGitRefresh = false) => {
    await options.operationalState.setAutoSync(state);
    if (emitGitRefresh) {
      options.emitGitStateRefresh();
      return;
    }
    options.emitStateRefresh();
  };

  const disableWithState = async (
    worktree: Pick<WorktreeRecord, "id" | "branch" | "worktreePath">,
    config: AutoSyncConfig,
    overrides?: Partial<WorktreeAutoSyncState>,
  ) => {
    const state = createState(worktree, config, {
      enabled: false,
      status: "paused",
      ...overrides,
    });
    await persistState(state);
    return state;
  };

  const syncWorktree = async (
    worktree: Pick<WorktreeRecord, "id" | "branch" | "worktreePath">,
    currentState: WorktreeAutoSyncState,
    config: AutoSyncConfig,
  ) => {
    if (inFlight.has(worktree.id) || disposed) {
      return;
    }

    inFlight.add(worktree.id);
    try {
      if (!currentState.enabled) {
        return;
      }

      const checkedOutBranch = await getCurrentBranch(worktree.worktreePath);
      if (checkedOutBranch !== DOCUMENTS_BRANCH || worktree.branch !== DOCUMENTS_BRANCH) {
        await disableWithState(worktree, config, {
          branch: checkedOutBranch,
          message: "Auto sync stopped because this worktree is no longer on the documents branch.",
          sshAgentStatus: currentState.sshAgentStatus,
        });
        return;
      }

      const startedAt = new Date().toISOString();
      await persistState({
        ...currentState,
        branch: checkedOutBranch,
        worktreePath: worktree.worktreePath,
        remote: config.remote,
        status: "running",
        message: "Syncing documents branch.",
        lastRunAt: startedAt,
      });

      const summary = await getWorkingTreeSummary(worktree.worktreePath);
      if (summary.dirty) {
        await disableWithState(worktree, config, {
          lastRunAt: startedAt,
          lastErrorAt: startedAt,
          sshAgentStatus: currentState.sshAgentStatus,
          message: "Auto sync paused because this worktree has local changes. Commit, stash, or clean the worktree before re-enabling it.",
        });
        return;
      }

      const remoteUrl = await getRemoteUrl(worktree.worktreePath, config.remote);
      const sshAgent = await checkSshAgent(remoteUrl);
      if (sshAgent.status === "missing" || sshAgent.status === "unavailable") {
        await disableWithState(worktree, config, {
          lastRunAt: startedAt,
          lastErrorAt: startedAt,
          sshAgentStatus: sshAgent.status,
          message: sshAgent.message,
        });
        return;
      }

      await runCommand("git", ["fetch", config.remote, checkedOutBranch], { cwd: worktree.worktreePath, env: process.env });

      let pulledAt: string | undefined;
      let pushedAt: string | undefined;
      const initialCounts = await getAheadBehind(worktree.worktreePath, config.remote, checkedOutBranch);
      if (initialCounts.behind > 0) {
        await runCommand("git", ["pull", "--ff-only", config.remote, checkedOutBranch], {
          cwd: worktree.worktreePath,
          env: process.env,
        });
        pulledAt = new Date().toISOString();
      }

      const finalCounts = await getAheadBehind(worktree.worktreePath, config.remote, checkedOutBranch);
      if (finalCounts.ahead > 0) {
        await runCommand("git", ["push", config.remote, checkedOutBranch], {
          cwd: worktree.worktreePath,
          env: process.env,
        });
        pushedAt = new Date().toISOString();
      }

      await persistState({
        ...currentState,
        branch: checkedOutBranch,
        worktreePath: worktree.worktreePath,
        enabled: true,
        status: "idle",
        remote: config.remote,
        sshAgentStatus: sshAgent.status,
        message: pulledAt || pushedAt
          ? "Documents branch synced successfully."
          : "Documents branch is already up to date.",
        lastRunAt: startedAt,
        lastSuccessAt: new Date().toISOString(),
        lastPulledAt: pulledAt ?? currentState.lastPulledAt,
        lastPushedAt: pushedAt ?? currentState.lastPushedAt,
      }, true);
    } catch (error) {
      const timestamp = new Date().toISOString();
      const message = error instanceof Error ? error.message : String(error);
      await disableWithState(worktree, config, {
        lastRunAt: timestamp,
        lastErrorAt: timestamp,
        message: `Auto sync paused: ${message}`,
      });
      logServerEvent("auto-sync", "sync-failed", {
        worktreeId: worktree.id,
        branch: worktree.branch,
        remote: config.remote,
        error: message,
      }, "error");
    } finally {
      inFlight.delete(worktree.id);
    }
  };

  const tick = async () => {
    const [config, worktrees, states] = await Promise.all([
      options.loadCurrentConfig(),
      listWorktrees(options.repoRoot),
      options.operationalState.listAutoSyncStates(),
    ]);
    const worktreesById = new Map(worktrees.map((worktree) => [worktree.id, worktree]));

    await Promise.all(states.map(async (state) => {
      if (!state.enabled) {
        return;
      }
      const worktree = worktreesById.get(state.worktreeId);
      if (!worktree) {
        await options.operationalState.setAutoSync({
          ...state,
          enabled: false,
          status: "paused",
          message: "Auto sync stopped because the worktree is no longer available.",
          lastErrorAt: new Date().toISOString(),
        });
        options.emitStateRefresh();
        return;
      }

      await syncWorktree(worktree, state, config.autoSync);
    }));
  };

  const scheduleTick = () => {
    if (disposed) {
      return;
    }

    Promise.resolve(tick()).catch((error) => {
      logServerEvent("auto-sync", "tick-failed", {
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    });
  };

  interval = setInterval(scheduleTick, intervalMs);
  scheduleTick();

  return {
    async enable(worktree: WorktreeRecord) {
      const config = (await options.loadCurrentConfig()).autoSync;
      if (worktree.branch !== DOCUMENTS_BRANCH) {
        throw new Error("Auto sync is only available on the documents branch.");
      }

      const state = createState(worktree, config, {
        enabled: true,
        status: "idle",
        message: `Auto sync is enabled for ${config.remote}/${worktree.branch}.`,
      });
      await persistState(state);
      await syncWorktree(worktree, state, config);
      return state;
    },
    async disable(worktree: WorktreeRecord) {
      const config = (await options.loadCurrentConfig()).autoSync;
      const existing = await options.operationalState.getAutoSyncById(worktree.id);
      const state = createState(worktree, config, {
        ...existing,
        enabled: false,
        status: "disabled",
        message: "Auto sync is turned off.",
        remote: config.remote,
      });
      await persistState(state);
      return state;
    },
    async runNow(worktree: WorktreeRecord) {
      const config = (await options.loadCurrentConfig()).autoSync;
      const currentState = await options.operationalState.getAutoSyncById(worktree.id)
        ?? createState(worktree, config, {
          enabled: true,
          status: "idle",
          message: `Auto sync is enabled for ${config.remote}/${worktree.branch}.`,
        });
      await syncWorktree(worktree, currentState, config);
    },
    async dispose() {
      disposed = true;
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
    },
  };
}
