import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  AiCommandOrigin,
  ApiStateResponse,
  WorktreeManagerConfig,
  WorktreeRecord,
  WorktreeRuntime,
} from "../../shared/types.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import {
  DEFAULT_GIT_AUTHOR_EMAIL,
  DEFAULT_GIT_AUTHOR_NAME,
} from "../../shared/constants.js";
import {
  startConfiguredBackgroundCommands,
  stopAllBackgroundCommands,
} from "../services/background-command-service.js";
import {
  getWorktreeDeletionState,
  listWorktrees,
} from "../services/git-service.js";
import {
  buildRuntimeProcessEnv,
  createRuntime,
  runStartupCommands,
} from "../services/runtime-service.js";
import { loadConfig } from "../services/config-service.js";
import {
  getAiCommandJob,
  startAiCommandJob,
  waitForAiCommandJob,
  type StartedAiCommandJob,
} from "../services/ai-command-service.js";
import {
  deleteAiCommandProcess,
  getAiCommandProcess,
  getAiCommandProcessName,
  isAiCommandProcessActive,
  startAiCommandProcess,
  waitForAiCommandProcess,
} from "../services/ai-command-process-service.js";
import { enqueueProjectManagementAiJob } from "../services/ai-command-job-manager-service.js";
import { completeAiCommandRun } from "../services/ai-command-completion-service.js";
import { buildWorktreeAiStartedComment } from "../services/project-management-comment-formatters.js";
import {
  ensureRuntimeTerminalSession,
  getTmuxSessionName,
  killTmuxSession,
  killTmuxSessionByName,
} from "../services/terminal-service.js";
import {
  addProjectManagementComment,
  listProjectManagementDocuments,
} from "../services/project-management-service.js";
import {
  attachWorktreeDocumentLinks,
  getWorktreeDocumentLinks,
} from "../services/worktree-link-service.js";
import { createAutoSyncService } from "../services/auto-sync-service.js";
import { runCommand } from "../utils/process.js";
import {
  formatDurationMs,
  logServerEvent,
} from "../utils/server-logger.js";
import {
  createAiLogIdentifiers as createAiLogIdentifiersFromHelpers,
  reconcileAiCommandLogEntry,
  readAiCommandLogEntryByIdentifier,
  resolveAiLogWorktreeId,
  runBackgroundTask,
  safeWriteAiRequestLog,
} from "./api-helpers.js";
import type {
  ApiAiProcesses,
  ApiRouterOptions,
} from "./api-types.js";

const CONFIG_COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_AUTHOR_NAME,
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || DEFAULT_GIT_AUTHOR_NAME,
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
};

export function createApiRouterContext(options: ApiRouterOptions) {
  const stateListeners = new Set<() => void>();
  const gitComparisonListeners = new Set<() => void>();
  const projectManagementDocumentsListeners = new Set<() => void>();
  const projectManagementUsersListeners = new Set<() => void>();
  const systemStatusListeners = new Set<() => void>();
  const tmuxClientsListenersByBranch = new Map<string, Set<() => void>>();
  const defaultAiProcesses: ApiAiProcesses = {
    startProcess: startAiCommandProcess,
    getProcess: getAiCommandProcess,
    waitForProcess: waitForAiCommandProcess,
    deleteProcess: deleteAiCommandProcess,
    isProcessActive: isAiCommandProcessActive,
  };
  const executionAiProcesses = options.aiProcesses ?? defaultAiProcesses;
  const hasInjectedAiProcesses = Boolean(options.aiProcesses);
  const passiveAiProcesses = options.aiProcesses
    ? options.aiProcesses
    : process.env.WTM_SERVER_ROLE === "worker"
      ? defaultAiProcesses
      : {
          ...defaultAiProcesses,
          getProcess: async () => null,
          waitForProcess: async () => null,
          isProcessActive: () => false,
        };
  const aiProcessPollIntervalMs = options.aiProcessPollIntervalMs ?? 250;
  const aiLogStreamPollIntervalMs = options.aiLogStreamPollIntervalMs ?? 500;
  const stateStreamFullRefreshIntervalMs = options.stateStreamFullRefreshIntervalMs ?? 120_000;
  const gitWatchDebounceMs = options.gitWatchDebounceMs ?? 150;
  const autoSyncIntervalMs = options.autoSyncIntervalMs ?? 30_000;
  const shouldReconcileAiJobs = process.env.WTM_SERVER_ROLE === "worker" || Boolean(options.aiProcesses);
  const aiJobReadOptions = {
    aiProcesses: {
      getProcess: passiveAiProcesses.getProcess,
      waitForProcess: passiveAiProcesses.waitForProcess,
      isProcessActive: passiveAiProcesses.isProcessActive,
    },
    reconcile: shouldReconcileAiJobs,
  };

  const loadCurrentConfig = () => loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitFile: options.configFile,
  });

  const findWorktree = async (branch: string): Promise<WorktreeRecord | undefined> => {
    const worktrees = await listWorktrees(options.repoRoot);
    return worktrees.find((entry) => entry.branch === branch);
  };

  const getRunningAiJobForBranch = async (worktree: WorktreeRecord): Promise<AiCommandJob | null> => {
    const job = await getAiCommandJob(options.repoRoot, worktree.id, aiJobReadOptions);
    return job?.status === "running" ? job : null;
  };

  const getDeleteAiLockReason = (branch: string) => `Cancel the running AI job on ${branch} before deleting this worktree.`;

  const getMergeAiLockReason = (branch: string) => `Cancel the running AI job on ${branch} before merging these branches.`;

  const buildDeletionState = async (worktree: WorktreeRecord) => {
    const deletion = await getWorktreeDeletionState(options.repoRoot, worktree);
    if (await getRunningAiJobForBranch(worktree)) {
      return {
        ...deletion,
        canDelete: false,
        reason: getDeleteAiLockReason(worktree.branch),
      };
    }

    return deletion;
  };

  const getMergeBlockedByAiReason = async (branches: Array<string | undefined>) => {
    for (const branch of branches) {
      if (!branch) {
        continue;
      }

      const worktree = await findWorktree(branch);
      if (!worktree) {
        continue;
      }

      if (await getRunningAiJobForBranch(worktree)) {
        return getMergeAiLockReason(branch);
      }
    }

    return null;
  };

  const emitStateRefresh = () => {
    for (const listener of stateListeners) {
      listener();
    }
  };

  const subscribeToStateRefresh = (listener: () => void) => {
    stateListeners.add(listener);
    return () => {
      stateListeners.delete(listener);
    };
  };

  const emitGitComparisonRefresh = () => {
    for (const listener of gitComparisonListeners) {
      listener();
    }
  };

  const emitGitStateRefresh = () => {
    emitGitComparisonRefresh();
    emitStateRefresh();
  };

  const autoSync = createAutoSyncService({
    repoRoot: options.repoRoot,
    operationalState: options.operationalState,
    loadCurrentConfig,
    emitStateRefresh,
    emitGitStateRefresh,
    intervalMs: autoSyncIntervalMs,
  });

  const gitWatchers = new Map<string, fs.FSWatcher>();
  let gitWatchRefreshTimer: NodeJS.Timeout | null = null;

  const scheduleGitWatchRefresh = () => {
    if (gitWatchRefreshTimer) {
      clearTimeout(gitWatchRefreshTimer);
    }

    gitWatchRefreshTimer = setTimeout(() => {
      gitWatchRefreshTimer = null;
      emitGitStateRefresh();
    }, gitWatchDebounceMs);
  };

  const addGitWatcher = (watchPath: string) => {
    const resolvedPath = path.resolve(watchPath);
    if (gitWatchers.has(resolvedPath)) {
      return;
    }

    try {
      const watcher = fs.watch(resolvedPath, { recursive: true }, () => {
        scheduleGitWatchRefresh();
      });
      watcher.on("error", () => {
        try {
          watcher.close();
        } catch {
          // Ignore cleanup failures while replacing a broken watcher.
        }
        gitWatchers.delete(resolvedPath);
      });
      gitWatchers.set(resolvedPath, watcher);
    } catch {
      // Ignore unavailable watch roots and fall back to interval refresh.
    }
  };

  const refreshGitWatchers = async () => {
    const nextPaths = new Set<string>([
      path.join(options.repoRoot, ".git"),
      path.join(options.repoRoot, "main"),
    ]);
    const worktrees = await listWorktrees(options.repoRoot).catch(() => []);
    for (const worktree of worktrees) {
      nextPaths.add(worktree.worktreePath);
    }

    for (const [watchPath, watcher] of gitWatchers.entries()) {
      if (nextPaths.has(watchPath)) {
        continue;
      }

      try {
        watcher.close();
      } catch {
        // Ignore close races while pruning watcher roots.
      }
      gitWatchers.delete(watchPath);
    }

    for (const watchPath of nextPaths) {
      addGitWatcher(watchPath);
    }
  };

  void refreshGitWatchers().catch(() => undefined);

  const dispose = async () => {
    await autoSync.dispose();

    if (gitWatchRefreshTimer) {
      clearTimeout(gitWatchRefreshTimer);
      gitWatchRefreshTimer = null;
    }

    for (const watcher of gitWatchers.values()) {
      try {
        watcher.close();
      } catch {
        // Ignore watcher shutdown races.
      }
    }
    gitWatchers.clear();
  };

  const subscribeToGitComparisonRefresh = (listener: () => void) => {
    gitComparisonListeners.add(listener);
    return () => {
      gitComparisonListeners.delete(listener);
    };
  };

  const emitProjectManagementDocumentsRefresh = () => {
    for (const listener of projectManagementDocumentsListeners) {
      listener();
    }
  };

  const subscribeToProjectManagementDocumentsRefresh = (listener: () => void) => {
    projectManagementDocumentsListeners.add(listener);
    return () => {
      projectManagementDocumentsListeners.delete(listener);
    };
  };

  const emitProjectManagementUsersRefresh = () => {
    for (const listener of projectManagementUsersListeners) {
      listener();
    }
  };

  const subscribeToProjectManagementUsersRefresh = (listener: () => void) => {
    projectManagementUsersListeners.add(listener);
    return () => {
      projectManagementUsersListeners.delete(listener);
    };
  };

  const emitSystemStatusRefresh = () => {
    for (const listener of systemStatusListeners) {
      listener();
    }
  };

  const subscribeToSystemStatusRefresh = (listener: () => void) => {
    systemStatusListeners.add(listener);
    return () => {
      systemStatusListeners.delete(listener);
    };
  };

  const emitTmuxClientsRefresh = (branch: string) => {
    const listeners = tmuxClientsListenersByBranch.get(branch);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener();
    }
  };

  const subscribeToTmuxClientsRefresh = (branch: string, listener: () => void) => {
    let listeners = tmuxClientsListenersByBranch.get(branch);
    if (!listeners) {
      listeners = new Set<() => void>();
      tmuxClientsListenersByBranch.set(branch, listeners);
    }

    listeners.add(listener);
    return () => {
      const current = tmuxClientsListenersByBranch.get(branch);
      if (!current) {
        return;
      }

      current.delete(listener);
      if (current.size === 0) {
        tmuxClientsListenersByBranch.delete(branch);
      }
    };
  };

  const emitRuntimeRefreshes = (branch: string) => {
    emitSystemStatusRefresh();
    emitTmuxClientsRefresh(branch);
  };

  const createWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    const startedAt = Date.now();
    logServerEvent("runtime", "start-requested", {
      worktreeId: worktree.id,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    });
    const { runtime } = await createRuntime(config, options.repoRoot, worktree);
    await options.operationalState.setRuntime(runtime);
    await ensureRuntimeTerminalSession(runtime, options.repoRoot);
    await runStartupCommands(config.startupCommands, worktree.worktreePath, buildRuntimeProcessEnv(runtime));
    await startConfiguredBackgroundCommands({
      config,
      repoRoot: options.repoRoot,
      worktree,
      runtime,
    });
    await refreshGitWatchers();
    emitGitStateRefresh();
    emitRuntimeRefreshes(worktree.branch);
    logServerEvent("runtime", "start-completed", {
      worktreeId: worktree.id,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
    });
    return runtime;
  };

  const ensureWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    const existingRuntime = await options.operationalState.getRuntimeById(worktree.id);
    if (existingRuntime) {
      return existingRuntime;
    }

    return createWorktreeRuntime(config, worktree);
  };

  const stopWorktreeRuntime = async (worktree: Pick<WorktreeRecord, "id" | "branch" | "worktreePath">): Promise<void> => {
    const startedAt = Date.now();
    logServerEvent("runtime", "stop-requested", {
      worktreeId: worktree.id,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    });
    const runtime = await options.operationalState.getRuntimeById(worktree.id);
    if (!runtime) {
      await killTmuxSessionByName(getTmuxSessionName(options.repoRoot, worktree.id), worktree.worktreePath);
      logServerEvent("runtime", "stop-skipped", {
        worktreeId: worktree.id,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        duration: formatDurationMs(Date.now() - startedAt),
      });
      return;
    }

    let stopError: unknown = null;

    try {
      await stopAllBackgroundCommands(options.repoRoot, runtime);
    } catch (error) {
      stopError = error;
    }

    try {
      await killTmuxSession(runtime);
    } catch (error) {
      stopError ??= error;
    }

    await options.operationalState.deleteRuntimeById(runtime.id);
    await refreshGitWatchers();
    emitGitStateRefresh();
    emitRuntimeRefreshes(runtime.branch);

    if (stopError) {
      logServerEvent("runtime", "stop-failed", {
        worktreeId: runtime.id,
        branch: runtime.branch,
        worktreePath: runtime.worktreePath,
        duration: formatDurationMs(Date.now() - startedAt),
        error: stopError instanceof Error ? stopError.message : String(stopError),
      }, "error");
      throw stopError;
    }

    logServerEvent("runtime", "stop-completed", {
      worktreeId: runtime.id,
      branch: runtime.branch,
      worktreePath: runtime.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
    });
  };

  const restartWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    await stopWorktreeRuntime(worktree);
    return createWorktreeRuntime(config, worktree);
  };

  const scheduleRuntimeStopAfterAiJob = (details: {
    worktree: Pick<WorktreeRecord, "id" | "branch" | "worktreePath">;
    jobId: string;
    shouldStopRuntime: boolean;
  }) => {
    if (!details.shouldStopRuntime) {
      return;
    }

    runBackgroundTask(async () => {
      await waitForAiCommandJob(options.repoRoot, details.worktree.id, details.jobId).catch(() => null);
      await stopWorktreeRuntime(details.worktree);
    }, (error) => {
      logServerEvent("ai-command", "runtime-stop-after-job-failed", {
        worktreeId: details.worktree.id,
        branch: details.worktree.branch,
        jobId: details.jobId,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    });
  };

  const commitConfigEdit = async (message: string) => {
    const relativeConfigPath = options.configFile;
    const worktreePath = options.configWorktreePath;

    const stagedBeforeCommit = await runCommand("git", ["status", "--short", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
    if (!stagedBeforeCommit.stdout.trim()) {
      return;
    }

    await runCommand("git", ["add", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });

    const stagedConfigDiff = await runCommand("git", ["diff", "--cached", "--name-only", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
    if (!stagedConfigDiff.stdout.trim()) {
      return;
    }

    await runCommand("git", ["commit", "-m", message, "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
  };

  const loadResolvedAiLog = async (identifier: string) => {
    const entry = await readAiCommandLogEntryByIdentifier(options.repoRoot, identifier);
    return reconcileAiCommandLogEntry({
      entry,
      repoRoot: options.repoRoot,
      aiProcesses: passiveAiProcesses,
      reconcileJobs: shouldReconcileAiJobs,
    });
  };

  const writeImmediateAiFailureLog = async (details: {
    worktreeId?: WorktreeId;
    branch: string;
    documentId?: string | null;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    worktreePath: string;
    renderedCommand: string;
    input: string;
    error: Error;
  }) => {
    const { jobId, fileName, startedAt } = createAiLogIdentifiersFromHelpers(resolveAiLogWorktreeId(details));
    return safeWriteAiRequestLog({
      fileName,
      jobId,
      repoRoot: options.repoRoot,
      worktreeId: details.worktreeId,
      branch: details.branch,
      documentId: details.documentId ?? null,
      commandId: details.commandId,
      origin: details.origin ?? null,
      worktreePath: details.worktreePath,
      renderedCommand: details.renderedCommand,
      input: details.input,
      startedAt,
      completedAt: startedAt,
      pid: null,
      exitCode: null,
      processName: null,
      error: details.error,
    });
  };

  const startAiProcessJob = async (details: {
    worktreeId: WorktreeId;
    branch: string;
    documentId?: string | null;
    commandId: AiCommandId;
    aiCommands: AiCommandConfig;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    applyDocumentUpdateToDocumentId?: string | null;
    commentDocumentId?: string | null;
    commentRequestSummary?: string | null;
    autoCommitDirtyWorktree?: boolean;
  }): Promise<StartedAiCommandJob> => startAiCommandJob({
    worktreeId: details.worktreeId,
    branch: details.branch,
    documentId: details.documentId ?? null,
    commandId: details.commandId,
    origin: details.origin ?? null,
    input: details.input,
    command: details.renderedCommand,
    repoRoot: options.repoRoot,
    worktreePath: details.worktreePath,
    execute: async (payload) => {
      const processName = getAiCommandProcessName(payload.jobId);
      const processInfo = await executionAiProcesses.startProcess({
        processName,
        command: details.renderedCommand,
        input: details.input,
        worktreePath: details.worktreePath,
        env: details.env,
        hooks: payload.hooks,
      });

      await payload.hooks.onSpawn?.({
        pid: processInfo.pid ?? null,
        processName,
      });

      const completedProcess = await executionAiProcesses.waitForProcess(processName);
      if (!completedProcess) {
        await payload.hooks.onExit?.({ exitCode: null });
        throw new Error("AI process no longer available.");
      }

      await payload.hooks.onExit?.({ exitCode: completedProcess.exitCode ?? null });
      if ((completedProcess.exitCode ?? 0) !== 0) {
        throw new Error(`AI process exited with code ${completedProcess.exitCode ?? "unknown"}.`);
      }
    },
    onComplete: details.applyDocumentUpdateToDocumentId || details.commentDocumentId || details.autoCommitDirtyWorktree
      ? async ({ stdout, stderr }) => {
          await completeAiCommandRun({
            repoRoot: options.repoRoot,
            branch: details.branch,
            commandId: details.commandId,
            aiCommands: details.aiCommands,
            env: details.env,
            stdout,
            stderr,
            applyDocumentUpdateToDocumentId: details.applyDocumentUpdateToDocumentId,
            commentDocumentId: details.commentDocumentId,
            commentRequestSummary: details.commentRequestSummary,
            autoCommitDirtyWorktree: details.autoCommitDirtyWorktree,
          });
        }
      : undefined,
  });

  const enqueueProjectManagementDocumentAiJob = async (details: {
    worktreeId: WorktreeId;
    branch: string;
    documentId: string;
    commandId: AiCommandId;
    aiCommands: AiCommandConfig;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    applyDocumentUpdateToDocumentId?: string | null;
    commentDocumentId?: string | null;
    commentRequestSummary?: string | null;
    autoCommitDirtyWorktree?: boolean;
  }) => enqueueProjectManagementAiJob({
    repoRoot: options.repoRoot,
    payload: {
      worktreeId: details.worktreeId,
      branch: details.branch,
      commandId: details.commandId,
      aiCommands: details.aiCommands,
      origin: details.origin ?? null,
      worktreePath: details.worktreePath,
      input: details.input,
      renderedCommand: details.renderedCommand,
      env: Object.fromEntries(Object.entries(details.env).filter(([, value]) => typeof value === "string")) as Record<string, string>,
      documentId: details.documentId,
      applyDocumentUpdateToDocumentId: details.applyDocumentUpdateToDocumentId ?? null,
      commentDocumentId: details.commentDocumentId ?? null,
      commentRequestSummary: details.commentRequestSummary ?? null,
      autoCommitDirtyWorktree: details.autoCommitDirtyWorktree ?? false,
    },
  });

  const addWorktreeAiStartedComment = async (details: {
    branch: string;
    commandId: AiCommandId;
    commentDocumentId?: string | null;
    requestSummary?: string | null;
  }) => {
    if (!details.commentDocumentId) {
      return;
    }

    try {
      await addProjectManagementComment(options.repoRoot, details.commentDocumentId, {
        body: buildWorktreeAiStartedComment({
          branch: details.branch,
          commandId: details.commandId,
          requestSummary: details.requestSummary,
        }),
      });
    } catch (error) {
      logServerEvent("project-management-comment", "failed", {
        branch: details.branch,
        documentId: details.commentDocumentId,
        stage: "ai-started",
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    }
  };

  const resolveEnvSyncSourceRoot = async (_worktrees: Awaited<ReturnType<typeof listWorktrees>>) => options.configWorktreePath;

  const buildWorktreePayload = async (worktrees: Awaited<ReturnType<typeof listWorktrees>>) => {
    const merged = await options.operationalState.mergeInto(worktrees);
    const [documentsPayload, links] = await Promise.all([
      listProjectManagementDocuments(options.repoRoot),
      getWorktreeDocumentLinks(options.repoRoot),
    ]);
    const linkedWorktrees = attachWorktreeDocumentLinks(merged, links, documentsPayload.documents);
    return await Promise.all(linkedWorktrees.map(async (worktree) => ({
      ...worktree,
      deletion: await buildDeletionState(worktree),
    })));
  };

  const loadState = async (): Promise<ApiStateResponse> => {
    const config = await loadCurrentConfig();
    const worktrees = await listWorktrees(options.repoRoot);
    return {
      repoRoot: options.repoRoot,
      configPath: options.configPath,
      configFile: options.configFile,
      configSourceRef: options.configSourceRef,
      configWorktreePath: options.configWorktreePath,
      config,
      worktrees: await buildWorktreePayload(worktrees),
    };
  };

  return {
    repoRoot: options.repoRoot,
    configPath: options.configPath,
    configSourceRef: options.configSourceRef,
    configFile: options.configFile,
    configWorktreePath: options.configWorktreePath,
    operationalState: options.operationalState,
    aiProcessPollIntervalMs,
    aiLogStreamPollIntervalMs,
    stateStreamFullRefreshIntervalMs,
    gitWatchDebounceMs,
    autoSyncIntervalMs,
    hasInjectedAiProcesses,
    executionAiProcesses,
    passiveAiProcesses,
    shouldReconcileAiJobs,
    aiJobReadOptions,
    dispose,
    loadCurrentConfig,
    findWorktree,
    getRunningAiJobForBranch,
    buildDeletionState,
    getMergeBlockedByAiReason,
    createWorktreeRuntime,
    ensureWorktreeRuntime,
    stopWorktreeRuntime,
    restartWorktreeRuntime,
    autoSync,
    scheduleRuntimeStopAfterAiJob,
    emitGitStateRefresh,
    emitStateRefresh,
    subscribeToStateRefresh,
    emitGitComparisonRefresh,
    subscribeToGitComparisonRefresh,
    emitProjectManagementDocumentsRefresh,
    subscribeToProjectManagementDocumentsRefresh,
    emitProjectManagementUsersRefresh,
    subscribeToProjectManagementUsersRefresh,
    listProjectManagementDocuments: () => listProjectManagementDocuments(options.repoRoot),
    emitSystemStatusRefresh,
    subscribeToSystemStatusRefresh,
    emitTmuxClientsRefresh,
    subscribeToTmuxClientsRefresh,
    commitConfigEdit,
    loadResolvedAiLog,
    writeImmediateAiFailureLog,
    startAiProcessJob,
    enqueueProjectManagementDocumentAiJob,
    addWorktreeAiStartedComment,
    resolveEnvSyncSourceRoot,
    buildWorktreePayload,
    loadState,
  };
}

export type ApiRouterContext = ReturnType<typeof createApiRouterContext>;

export function createConfigCommitEnv() {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || DEFAULT_GIT_AUTHOR_NAME,
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || DEFAULT_GIT_AUTHOR_NAME,
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || DEFAULT_GIT_AUTHOR_EMAIL,
  };
}
