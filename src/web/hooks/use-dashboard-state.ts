import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type {
  AddProjectManagementCommentRequest,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandLogStreamEvent,
  ApiStateResponse,
  ApiStateStreamEvent,
  AiCommandJob,
  AiCommandId,
  AiCommandSettingsResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  CommitGitChangesResponse,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  DeleteWorktreeRequest,
  GenerateGitCommitMessageResponse,
  GitComparisonResponse,
  ProjectManagementBatchUpdateEntry,
  ProjectManagementDocument,
  ProjectManagementHistoryEntry,
  ProjectManagementListResponse,
  ProjectManagementUsersResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  RunProjectManagementDocumentAiRequest,
  ShutdownStatus,
  SystemStatusResponse,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementDocumentRequest,
  UpdateProjectManagementStatusRequest,
  UpdateProjectManagementUsersRequest,
} from "@shared/types";
import {
  addProjectManagementComment as addProjectManagementCommentRequest,
  appendProjectManagementBatch as appendProjectManagementBatchRequest,
  createProjectManagementDocument as createProjectManagementDocumentRequest,
  createWorktree,
  deleteWorktree,
  generateGitCommitMessage as generateGitCommitMessageRequest,
  getProjectManagementDocument as fetchProjectManagementDocument,
  getProjectManagementHistory as fetchProjectManagementHistory,
  listProjectManagementDocuments as fetchProjectManagementDocuments,
  getProjectManagementUsers as fetchProjectManagementUsers,
  getConfigDocument as fetchConfigDocument,
  getBackgroundCommandLogs as fetchBackgroundCommandLogs,
  getBackgroundCommands as fetchBackgroundCommands,
  getAiCommandSettings as fetchAiCommandSettings,
  getAiCommandLogs as fetchAiCommandLogs,
  getGitComparison as fetchGitComparison,
  getSystemStatus as fetchSystemStatus,
  subscribeToState,
  cancelAiCommand as cancelAiCommandRequest,
  commitGitChanges as commitGitChangesRequest,
  mergeGitBranch as mergeGitBranchRequest,
  resolveGitMergeConflicts as resolveGitMergeConflictsRequest,
  restartBackgroundCommand as restartBackgroundProcess,
  runAiCommand as runAiCommandRequest,
  runProjectManagementDocumentAi as runProjectManagementDocumentAiRequest,
  saveAiCommandSettings as persistAiCommandSettings,
  saveConfigDocument as persistConfigDocument,
  startBackgroundCommand as startBackgroundProcess,
  startRuntime,
  stopBackgroundCommand as stopBackgroundProcess,
  stopRuntime,
  subscribeToAiCommandJob,
  subscribeToAiCommandLog,
  subscribeToBackgroundCommandLogs,
  subscribeToGitComparison as subscribeToGitComparisonStream,
  subscribeToProjectManagementDocuments,
  subscribeToProjectManagementUsers,
  subscribeToShutdownStatus,
  subscribeToSystemStatus,
  syncEnvFiles,
  updateProjectManagementDependencies as updateProjectManagementDependenciesRequest,
  updateProjectManagementDocument as updateProjectManagementDocumentRequest,
  updateProjectManagementStatus as updateProjectManagementStatusRequest,
  updateProjectManagementUsers as updateProjectManagementUsersRequest,
  type EnvSyncResponse,
} from "../lib/api";
import { startSequentialPoll } from "../lib/sequential-poll";
import {
  buildProjectManagementStatusFallbackPayload,
  shouldFallbackProjectManagementStatusUpdate,
} from "../lib/project-management-status-update";
import { useAiCommandLogStream } from "./useAiCommandLogStream";

const DASHBOARD_REFRESH_INTERVAL_MS = 15000;

type DashboardStateValue = ReturnType<typeof useDashboardStateInternal>;

const DashboardStateContext = createContext<DashboardStateValue | null>(null);

function toAiCommandRequestPreview(request: string) {
  const normalized = request.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 160)}...`;
}

function toAiCommandLogSummary(log: AiCommandLogEntry): AiCommandLogSummary {
  return {
    jobId: log.jobId,
    fileName: log.fileName,
    timestamp: log.timestamp,
    worktreeId: log.worktreeId,
    branch: log.branch,
    documentId: log.documentId ?? null,
    commandId: log.commandId,
    origin: log.origin ?? null,
    worktreePath: log.worktreePath,
    command: log.command,
    requestPreview: toAiCommandRequestPreview(log.request),
    status: log.status,
    pid: log.pid ?? null,
  };
}

function areGitComparisonsEqual(left: GitComparisonResponse | null, right: GitComparisonResponse | null) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  return JSON.stringify(left) === JSON.stringify(right);
}

export type CommitChangesPayload = {
  baseBranch?: string;
  commandId?: AiCommandId;
  message?: string;
};

function useDashboardStateInternal() {
  const [state, setState] = useState<ApiStateResponse | null>(null);
  const [stateStreamConnected, setStateStreamConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasLoadedInitialState, setHasLoadedInitialState] = useState(false);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [lastEnvSync, setLastEnvSync] = useState<{ branch: string; copiedFiles: string[] } | null>(null);
  const [shutdownStatus, setShutdownStatus] = useState<ShutdownStatus | null>(null);
  const [backgroundCommands, setBackgroundCommands] = useState<BackgroundCommandState[]>([]);
  const [backgroundLogs, setBackgroundLogs] = useState<BackgroundCommandLogsResponse | null>(null);
  const [gitComparison, setGitComparison] = useState<GitComparisonResponse | null>(null);
  const [gitComparisonLoading, setGitComparisonLoading] = useState(false);
  const [configDocument, setConfigDocument] = useState<ConfigDocumentResponse | null>(null);
  const [configDocumentLoading, setConfigDocumentLoading] = useState(false);
  const [aiCommandSettings, setAiCommandSettings] = useState<AiCommandSettingsResponse | null>(null);
  const [aiCommandSettingsLoading, setAiCommandSettingsLoading] = useState(false);
  const [aiCommandJob, setAiCommandJob] = useState<AiCommandJob | null>(null);
  const [aiCommandRunningBranch, setAiCommandRunningBranch] = useState<string | null>(null);
  const [projectManagementDocumentAiJob, setProjectManagementDocumentAiJob] = useState<AiCommandJob | null>(null);
  const [projectManagementDocumentAiRunningBranch, setProjectManagementDocumentAiRunningBranch] = useState<string | null>(null);
  const [aiCommandLogs, setAiCommandLogs] = useState<AiCommandLogSummary[]>([]);
  const [aiCommandLogDetail, setAiCommandLogDetail] = useState<AiCommandLogEntry | null>(null);
  const [aiCommandLogsLoading, setAiCommandLogsLoading] = useState(false);
  const [aiCommandLogsError, setAiCommandLogsError] = useState<string | null>(null);
  const [aiCommandLogsLastUpdatedAt, setAiCommandLogsLastUpdatedAt] = useState<string | null>(null);
  const [runningAiCommandJobs, setRunningAiCommandJobs] = useState<AiCommandJob[]>([]);
  const [systemStatus, setSystemStatus] = useState<SystemStatusResponse | null>(null);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [systemLastUpdatedAt, setSystemLastUpdatedAt] = useState<string | null>(null);
  const [projectManagement, setProjectManagement] = useState<ProjectManagementListResponse | null>(null);
  const [projectManagementUsers, setProjectManagementUsers] = useState<ProjectManagementUsersResponse | null>(null);
  const [projectManagementDocument, setProjectManagementDocument] = useState<ProjectManagementDocument | null>(null);
  const [projectManagementHistory, setProjectManagementHistory] = useState<ProjectManagementHistoryEntry[]>([]);
  const [projectManagementLoading, setProjectManagementLoading] = useState(false);
  const [projectManagementError, setProjectManagementError] = useState<string | null>(null);
  const [projectManagementLastUpdatedAt, setProjectManagementLastUpdatedAt] = useState<string | null>(null);
  const [projectManagementSaving, setProjectManagementSaving] = useState(false);
  const aiCommandSubscriptionRef = useRef<(() => void) | null>(null);
  const projectManagementDocumentAiSubscriptionRef = useRef<(() => void) | null>(null);
  const trackedAiCommandBranchRef = useRef<string | null>(null);
  const trackedProjectManagementDocumentAiBranchRef = useRef<string | null>(null);

  useEffect(() => subscribeToState(
    (event: ApiStateStreamEvent) => {
      setState(event.state);
      setHasLoadedInitialState(true);
      setLoading(false);
      setStateStreamConnected(true);
      setError(null);
    },
    (connected) => {
      setStateStreamConnected(connected);
      if (!connected) {
        setLoading(true);
      }
    },
  ), []);

  useEffect(() => subscribeToShutdownStatus(setShutdownStatus), []);

  useEffect(() => subscribeToProjectManagementDocuments((event) => {
    setProjectManagement(event.documents);
    setProjectManagementError(null);
    setProjectManagementLastUpdatedAt(new Date().toISOString());
    setProjectManagementLoading(false);
    setError(null);
  }), []);

  useEffect(() => subscribeToProjectManagementUsers((event) => {
    setProjectManagementUsers(event.users);
    setProjectManagementError(null);
    setProjectManagementLastUpdatedAt(new Date().toISOString());
    setProjectManagementLoading(false);
    setError(null);
  }), []);

  useEffect(() => subscribeToSystemStatus((event) => {
    setSystemStatus(event.status);
    setSystemError(null);
    setSystemLastUpdatedAt(new Date().toISOString());
    setSystemLoading(false);
    setError(null);
  }), []);

  useEffect(() => {
    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (!stateStreamConnected) {
        setLoading(true);
      }
    };

    const pollController = startSequentialPoll(() => {
      if (!stateStreamConnected) {
        setLoading(true);
      }
    }, {
      intervalMs: DASHBOARD_REFRESH_INTERVAL_MS,
    });

    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    if (busyBranch || stateStreamConnected) {
      return () => {
        window.removeEventListener("focus", refreshIfVisible);
        document.removeEventListener("visibilitychange", refreshIfVisible);
      };
    }

    return () => {
      pollController.stop();
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [busyBranch, stateStreamConnected]);

  const appendBackgroundLogs = useCallback((event: BackgroundCommandLogStreamEvent) => {
    setBackgroundLogs((current) => {
      if (event.type === "snapshot") {
        return {
          commandName: event.commandName,
          lines: event.lines,
        };
      }

      if (!current || current.commandName !== event.commandName) {
        return {
          commandName: event.commandName,
          lines: event.lines,
        };
      }

      return {
        commandName: current.commandName,
        lines: [...current.lines, ...event.lines].slice(-800),
      };
    });
  }, []);

  const clearLastEnvSync = useCallback(() => {
    setLastEnvSync(null);
  }, []);

  const clearBackgroundLogs = useCallback(() => {
    setBackgroundLogs(null);
  }, []);

  const {
    applyAiLogStreamEvent,
    clearTrackedAiCommandLogSubscription,
    getTrackedAiCommandLogJobId,
    loadAiCommandLog,
  } = useAiCommandLogStream({
    subscribe: subscribeToAiCommandLog,
    toSummary: toAiCommandLogSummary,
    setAiCommandLogDetail,
    setAiCommandLogs,
    setRunningAiCommandJobs,
    setAiCommandLogsLoading,
    setAiCommandLogsError,
    setAiCommandLogsLastUpdatedAt,
    setError,
  });

  const upsertRunningAiJob = useCallback((job: AiCommandJob | null) => {
    if (!job) {
      return;
    }

    setRunningAiCommandJobs((current) => {
      const next = current.filter((entry) => entry.branch !== job.branch);
      if (job.status === "running") {
        next.push(job);
      }

      return next.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    });
  }, []);

  const trackAiCommandJob = useCallback((branch: string | null) => {
    if (trackedAiCommandBranchRef.current === branch) {
      return;
    }

    aiCommandSubscriptionRef.current?.();
    aiCommandSubscriptionRef.current = null;
    trackedAiCommandBranchRef.current = branch;
    setAiCommandJob(null);
    setAiCommandRunningBranch(null);

    if (!branch) {
      return;
    }

    aiCommandSubscriptionRef.current = subscribeToAiCommandJob(branch, (event) => {
      setAiCommandJob(event.job);
      setAiCommandRunningBranch(event.job?.status === "running" ? branch : null);
      upsertRunningAiJob(event.job);

      if (event.job?.status === "failed") {
        setError(event.job.error || event.job.stderr || `AI command failed for ${branch}.`);
      }
    });
  }, [upsertRunningAiJob]);

  const trackProjectManagementDocumentAiJob = useCallback((branch: string | null) => {
    if (trackedProjectManagementDocumentAiBranchRef.current === branch) {
      return;
    }

    projectManagementDocumentAiSubscriptionRef.current?.();
    projectManagementDocumentAiSubscriptionRef.current = null;
    trackedProjectManagementDocumentAiBranchRef.current = branch;
    setProjectManagementDocumentAiJob(null);
    setProjectManagementDocumentAiRunningBranch(null);

    if (!branch) {
      return;
    }

    projectManagementDocumentAiSubscriptionRef.current = subscribeToAiCommandJob(branch, (event) => {
      setProjectManagementDocumentAiJob(event.job);
      setProjectManagementDocumentAiRunningBranch(event.job?.status === "running" ? branch : null);
      upsertRunningAiJob(event.job);

      if (event.job?.status === "failed") {
        setError(event.job.error || event.job.stderr || `AI command failed for ${branch}.`);
      }
    });
  }, [upsertRunningAiJob]);

  useEffect(() => {
    return () => {
      aiCommandSubscriptionRef.current?.();
      projectManagementDocumentAiSubscriptionRef.current?.();
      clearTrackedAiCommandLogSubscription();
      aiCommandSubscriptionRef.current = null;
      projectManagementDocumentAiSubscriptionRef.current = null;
      trackedAiCommandBranchRef.current = null;
      trackedProjectManagementDocumentAiBranchRef.current = null;
    };
  }, [clearTrackedAiCommandLogSubscription]);

  const loadProjectManagementDocumentsState = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setProjectManagementLoading(true);
    }

    try {
      const payload = await fetchProjectManagementDocuments();
      setProjectManagement(payload);
      setProjectManagementError(null);
      setProjectManagementLastUpdatedAt(new Date().toISOString());
      setError(null);
      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load project management documents.";
      setProjectManagement(null);
      setProjectManagementError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setProjectManagementLoading(false);
      }
    }
  }, []);

  const loadProjectManagementDocumentState = useCallback(async (documentId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setProjectManagementLoading(true);
    }

    try {
      const [documentPayload, historyPayload] = await Promise.all([
        fetchProjectManagementDocument(documentId),
        fetchProjectManagementHistory(documentId),
      ]);
      setProjectManagementDocument(documentPayload.document);
      setProjectManagementHistory(historyPayload.history);
      setProjectManagementError(null);
      setProjectManagementLastUpdatedAt(new Date().toISOString());
      setError(null);
      return documentPayload.document;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load project management document.";
      setProjectManagementDocument(null);
      setProjectManagementHistory([]);
      setProjectManagementError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setProjectManagementLoading(false);
      }
    }
  }, []);

  const loadProjectManagementUsersState = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setProjectManagementLoading(true);
    }

    try {
      const payload = await fetchProjectManagementUsers();
      setProjectManagementUsers(payload);
      setProjectManagementError(null);
      setProjectManagementLastUpdatedAt(new Date().toISOString());
      setError(null);
      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load project management users.";
      setProjectManagementUsers(null);
      setProjectManagementError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setProjectManagementLoading(false);
      }
    }
  }, []);

  const loadSystemStatusState = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setSystemLoading(true);
    }

    try {
      const payload = await fetchSystemStatus();
      setSystemStatus(payload);
      setSystemError(null);
      setSystemLastUpdatedAt(new Date().toISOString());
      setError(null);
      return payload;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to load system status.";
      setSystemStatus(null);
      setSystemError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setSystemLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void loadProjectManagementDocumentsState({ silent: true });
  }, [loadProjectManagementDocumentsState]);

  useEffect(() => {
    void loadProjectManagementUsersState({ silent: true });
  }, [loadProjectManagementUsersState]);

  useEffect(() => {
    void loadSystemStatusState({ silent: true });
  }, [loadSystemStatusState]);

  const actions = useMemo(
    () => ({
      async create(branch: string, documentId?: string | null) {
        setBusyBranch(branch);
        try {
          const result = await createWorktree(branch, documentId);
          if (result) {
            setLastEnvSync({ branch, copiedFiles: result.copiedFiles });
          }
          if (documentId) {
            void loadProjectManagementDocumentsState({ silent: true });
          }
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create worktree.");
        } finally {
          setBusyBranch(null);
        }
      },
      async remove(branch: string, payload?: DeleteWorktreeRequest) {
        setBusyBranch(branch);
        try {
          await deleteWorktree(branch, payload);
          setError(null);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to delete worktree.";
          setError(message);
          throw err instanceof Error ? err : new Error(message);
        } finally {
          setBusyBranch(null);
        }
      },
      async start(branch: string) {
        setBusyBranch(branch);
        try {
          await startRuntime(branch);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to start runtime.");
        } finally {
          setBusyBranch(null);
        }
      },
      async stop(branch: string) {
        setBusyBranch(branch);
        try {
          await stopRuntime(branch);
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to stop runtime.");
        } finally {
          setBusyBranch(null);
        }
      },
      async syncEnv(branch: string) {
        setBusyBranch(branch);
        try {
          const result: EnvSyncResponse = await syncEnvFiles(branch);
          setLastEnvSync({ branch, copiedFiles: result.copiedFiles });
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to sync env files.");
        } finally {
          setBusyBranch(null);
        }
      },
      async loadBackgroundCommands(branch: string) {
        try {
          const commands = await fetchBackgroundCommands(branch);
          setBackgroundCommands(commands);
          setError(null);
          return commands;
        } catch (err) {
          setBackgroundCommands([]);
          setError(err instanceof Error ? err.message : "Failed to load background commands.");
          return [];
        }
      },
      async startBackgroundCommand(branch: string, commandName: string) {
        setBusyBranch(branch);
        try {
          const commands = await startBackgroundProcess(branch, commandName);
          setBackgroundCommands(commands);
          setError(null);
          return commands;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to start background command.");
          return [];
        } finally {
          setBusyBranch(null);
        }
      },
      async stopBackgroundCommand(branch: string, commandName: string) {
        setBusyBranch(branch);
        try {
          const commands = await stopBackgroundProcess(branch, commandName);
          setBackgroundCommands(commands);
          setError(null);
          return commands;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to stop background command.");
          return [];
        } finally {
          setBusyBranch(null);
        }
      },
      async restartBackgroundCommand(branch: string, commandName: string) {
        setBusyBranch(branch);
        try {
          const commands = await restartBackgroundProcess(branch, commandName);
          setBackgroundCommands(commands);
          setError(null);
          return commands;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to restart background command.");
          return [];
        } finally {
          setBusyBranch(null);
        }
      },
      async loadBackgroundLogs(branch: string, commandName: string) {
        try {
          const logs = await fetchBackgroundCommandLogs(branch, commandName);
          setBackgroundLogs(logs);
          setError(null);
          return logs;
        } catch (err) {
          setBackgroundLogs({ commandName, lines: [] });
          setError(err instanceof Error ? err.message : "Failed to load background logs.");
          return { commandName, lines: [] };
        }
      },
      subscribeToBackgroundLogs(branch: string, commandName: string, onEvent?: (event: BackgroundCommandLogStreamEvent) => void) {
        return subscribeToBackgroundCommandLogs(branch, commandName, (event) => {
          onEvent?.(event);
          appendBackgroundLogs(event);
        });
      },
      subscribeToGitComparison(compareBranch: string, baseBranch?: string) {
        return subscribeToGitComparisonStream(compareBranch, baseBranch, (event) => {
          setGitComparison((current) => areGitComparisonsEqual(current, event.comparison) ? current : event.comparison);
          setGitComparisonLoading(false);
          setError(null);
        });
      },
      async loadGitComparison(compareBranch: string, baseBranch?: string, options?: { silent?: boolean }) {
        if (!options?.silent) {
          setGitComparisonLoading(true);
        }

        try {
          const comparison = await fetchGitComparison(compareBranch, baseBranch);
          setGitComparison((current) => areGitComparisonsEqual(current, comparison) ? current : comparison);
          setError(null);
          return comparison;
        } catch (err) {
          setGitComparison(null);
          setError(err instanceof Error ? err.message : "Failed to load git comparison.");
          return null;
        } finally {
          if (!options?.silent) {
            setGitComparisonLoading(false);
          }
        }
      },
      async mergeGitBranch(compareBranch: string, baseBranch?: string) {
        setGitComparisonLoading(true);
        try {
          const comparison = await mergeGitBranchRequest(compareBranch, baseBranch ? { baseBranch } : undefined);
          setGitComparison(comparison);
          setError(null);
          return comparison;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to merge branch.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async mergeBaseBranchIntoWorktree(branch: string, baseBranch: string) {
        setGitComparisonLoading(true);
        try {
          await mergeGitBranchRequest(baseBranch, { baseBranch: branch });
          const comparison = await fetchGitComparison(branch, baseBranch);
          setGitComparison((current) => areGitComparisonsEqual(current, comparison) ? current : comparison);
          setError(null);
          return comparison;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to merge base branch into worktree.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async resolveGitMergeConflicts(branch: string, baseBranch?: string, commandId: AiCommandId = "smart") {
        setGitComparisonLoading(true);
        try {
          const comparison = await resolveGitMergeConflictsRequest(branch, baseBranch ? { baseBranch, commandId } : { commandId });
          setGitComparison(comparison);
          setError(null);
          return comparison;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to resolve merge conflicts.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async generateGitCommitMessage(branch: string, baseBranch?: string, commandId: AiCommandId = "simple"): Promise<GenerateGitCommitMessageResponse | null> {
        setGitComparisonLoading(true);
        try {
          const result = await generateGitCommitMessageRequest(branch, baseBranch ? { baseBranch, commandId } : { commandId });
          setError(null);
          return result;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to generate commit message.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async commitGitChanges(
        branch: string,
        payload?: { baseBranch?: string; commandId?: AiCommandId; message?: string },
      ): Promise<CommitGitChangesResponse | null> {
        setGitComparisonLoading(true);
        try {
          const result = await commitGitChangesRequest(branch, payload ?? {});
          setGitComparison(result.comparison);
          setError(null);
          return result;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to commit changes.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async loadConfigDocument(options?: { silent?: boolean }) {
        if (!options?.silent) {
          setConfigDocumentLoading(true);
        }

        try {
          const document = await fetchConfigDocument();
          setConfigDocument(document);
          setError(null);
          return document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load config document.");
          return null;
        } finally {
          if (!options?.silent) {
            setConfigDocumentLoading(false);
          }
        }
      },
      async saveConfigDocument(contents: string) {
        setConfigDocumentLoading(true);
        try {
          const document = await persistConfigDocument(contents);
          setConfigDocument(document);
          setError(null);
          return document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to save config document.");
          return null;
        } finally {
          setConfigDocumentLoading(false);
        }
      },
      async loadAiCommandSettings(options?: { silent?: boolean }) {
        if (!options?.silent) {
          setAiCommandSettingsLoading(true);
        }

        try {
          const settings = await fetchAiCommandSettings();
          setAiCommandSettings(settings);
          setError(null);
          return settings;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to load AI command settings.");
          return null;
        } finally {
          if (!options?.silent) {
            setAiCommandSettingsLoading(false);
          }
        }
      },
      async saveAiCommandSettings(payload: UpdateAiCommandSettingsRequest) {
        setAiCommandSettingsLoading(true);
        try {
          const settings = await persistAiCommandSettings(payload);
          setAiCommandSettings(settings);
          setError(null);
          return settings;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to save AI command settings.");
          return null;
        } finally {
          setAiCommandSettingsLoading(false);
        }
      },
      async loadAiCommandLogs(options?: { silent?: boolean }) {
        if (!options?.silent) {
          setAiCommandLogsLoading(true);
        }

        try {
          const payload = await fetchAiCommandLogs();
          setAiCommandLogs(payload.logs);
          setRunningAiCommandJobs(payload.runningJobs);
          const trackedAiCommandLogJobId = getTrackedAiCommandLogJobId();
          if (trackedAiCommandLogJobId) {
            const selectedStillExists = payload.logs.some((entry) => entry.jobId === trackedAiCommandLogJobId)
              || payload.runningJobs.some((entry) => entry.jobId === trackedAiCommandLogJobId);
            if (!selectedStillExists) {
              clearTrackedAiCommandLogSubscription();
              setAiCommandLogDetail(null);
            }
          }
          setAiCommandLogsError(null);
          setAiCommandLogsLastUpdatedAt(new Date().toISOString());
          setError(null);
          return payload;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to load AI logs.";
          setAiCommandLogs([]);
          setRunningAiCommandJobs([]);
          setAiCommandLogsError(message);
          setError(message);
          return null;
        } finally {
          if (!options?.silent) {
            setAiCommandLogsLoading(false);
          }
        }
      },
      loadSystemStatus: loadSystemStatusState,
      loadAiCommandLog,
      async runAiCommand(branch: string, payload: RunAiCommandRequest) {
        try {
          trackAiCommandJob(branch);
          const result = await runAiCommandRequest(branch, payload);
          setAiCommandJob(result.job);
          setAiCommandRunningBranch(result.job.status === "running" ? branch : null);
          upsertRunningAiJob(result.job);
          if (payload.documentId || payload.commentDocumentId) {
            void loadProjectManagementDocumentsState({ silent: true });
          }
          setError(null);
          return result.job;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to run AI command.");
          return null;
        }
      },
      async runProjectManagementDocumentAi(documentId: string, payload: RunProjectManagementDocumentAiRequest) {
        try {
          trackProjectManagementDocumentAiJob(null);
          const result = await runProjectManagementDocumentAiRequest(documentId, payload);
          setProjectManagementDocumentAiJob(result.job);
          setProjectManagementDocumentAiRunningBranch(result.job.status === "running" ? result.job.branch : null);
          upsertRunningAiJob(result.job);
          trackProjectManagementDocumentAiJob(result.job.branch);
          void loadProjectManagementDocumentsState({ silent: true });
          setError(null);
          return result;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to run project management AI command.");
          return null;
        }
      },
      async cancelProjectManagementDocumentAi(branch: string) {
        try {
          const result = await cancelAiCommandRequest(branch);
          setProjectManagementDocumentAiJob(result.job);
          setProjectManagementDocumentAiRunningBranch(result.job.status === "running" ? branch : null);
          upsertRunningAiJob(result.job);
          const payload = await fetchAiCommandLogs();
          setAiCommandLogs(payload.logs);
          setRunningAiCommandJobs(payload.runningJobs);
          setError(null);
          return result.job;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to cancel project management AI command.");
          return null;
        }
      },
      async cancelAiCommand(branch: string) {
        try {
          const result = await cancelAiCommandRequest(branch);
          setAiCommandJob(result.job);
          setAiCommandRunningBranch(result.job.status === "running" ? branch : null);
          upsertRunningAiJob(result.job);
          const payload = await fetchAiCommandLogs();
          setAiCommandLogs(payload.logs);
          setRunningAiCommandJobs(payload.runningJobs);
          setError(null);
          return result.job;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to cancel AI command.");
          return null;
        }
      },
      trackAiCommandJob,
      loadProjectManagementDocuments: loadProjectManagementDocumentsState,
      loadProjectManagementUsers: loadProjectManagementUsersState,
      loadProjectManagementDocument: loadProjectManagementDocumentState,
      async createProjectManagementDocument(payload: CreateProjectManagementDocumentRequest) {
        setProjectManagementSaving(true);
        try {
          const response = await createProjectManagementDocumentRequest(payload);
          await loadProjectManagementDocumentsState({ silent: true });
          setProjectManagementDocument(response.document);
          const history = await fetchProjectManagementHistory(response.document.id);
          setProjectManagementHistory(history.history);
          setError(null);
          return response.document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create project management document.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async updateProjectManagementDocument(documentId: string, payload: UpdateProjectManagementDocumentRequest) {
        setProjectManagementSaving(true);
        try {
          const response = await updateProjectManagementDocumentRequest(documentId, payload);
          await loadProjectManagementDocumentsState({ silent: true });
          setProjectManagementDocument(response.document);
          const history = await fetchProjectManagementHistory(documentId);
          setProjectManagementHistory(history.history);
          setError(null);
          return response.document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update project management document.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async updateProjectManagementDependencies(documentId: string, payload: UpdateProjectManagementDependenciesRequest) {
        setProjectManagementSaving(true);
        try {
          const response = await updateProjectManagementDependenciesRequest(documentId, payload);
          await loadProjectManagementDocumentsState({ silent: true });
          setProjectManagementDocument(response.document);
          const history = await fetchProjectManagementHistory(documentId);
          setProjectManagementHistory(history.history);
          setError(null);
          return response.document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update project management dependencies.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async updateProjectManagementStatus(documentId: string, payload: UpdateProjectManagementStatusRequest) {
        setProjectManagementSaving(true);
        try {
          let response;
          try {
            response = await updateProjectManagementStatusRequest(documentId, payload);
          } catch (err) {
            if (shouldFallbackProjectManagementStatusUpdate(err)) {
              const currentDocument = projectManagementDocument?.id === documentId
                ? projectManagementDocument
                : (await fetchProjectManagementDocument(documentId)).document;

              response = await updateProjectManagementDocumentRequest(
                documentId,
                buildProjectManagementStatusFallbackPayload(currentDocument, payload.status),
              );
            } else {
              throw err;
            }
          }
          await loadProjectManagementDocumentsState({ silent: true });
          setProjectManagementDocument(response.document);
          const history = await fetchProjectManagementHistory(documentId);
          setProjectManagementHistory(history.history);
          setError(null);
          return response.document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update project management status.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async batchUpdateProjectManagementDocuments(documentIds: string[], overrides: {
        status?: string;
        archived?: boolean;
      }) {
        const uniqueDocumentIds = [...new Set(documentIds.map((entry) => entry.trim()).filter(Boolean))];
        if (!uniqueDocumentIds.length) {
          return true;
        }

        setProjectManagementSaving(true);
        try {
          const documentsToUpdate = await Promise.all(
            uniqueDocumentIds.map(async (documentId) => {
              if (projectManagementDocument?.id === documentId) {
                return projectManagementDocument;
              }

              const response = await fetchProjectManagementDocument(documentId);
              return response.document;
            }),
          );

          const entries: ProjectManagementBatchUpdateEntry[] = documentsToUpdate.map((document) => ({
            documentId: document.id,
            title: document.title,
            summary: document.summary || undefined,
            markdown: document.markdown,
            tags: document.tags,
            dependencies: document.dependencies,
            status: overrides.status ?? document.status,
            assignee: document.assignee || undefined,
            archived: overrides.archived ?? document.archived,
          }));

          await appendProjectManagementBatchRequest({ entries });
          const listResponse = await loadProjectManagementDocumentsState({ silent: true });
          const currentSelectedDocumentId = projectManagementDocument?.id;
          if (currentSelectedDocumentId && uniqueDocumentIds.includes(currentSelectedDocumentId)) {
            const refreshedDocument = await fetchProjectManagementDocument(currentSelectedDocumentId);
            setProjectManagementDocument(refreshedDocument.document);
            const history = await fetchProjectManagementHistory(currentSelectedDocumentId);
            setProjectManagementHistory(history.history);
          }

          if (!currentSelectedDocumentId && listResponse && projectManagementDocument) {
            setProjectManagementDocument(null);
          }

          setError(null);
          return true;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update project management documents.");
          return false;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async addProjectManagementComment(documentId: string, payload: AddProjectManagementCommentRequest) {
        setProjectManagementSaving(true);
        try {
          const response = await addProjectManagementCommentRequest(documentId, payload);
          await loadProjectManagementDocumentsState({ silent: true });
          setProjectManagementDocument(response.document);
          const history = await fetchProjectManagementHistory(documentId);
          setProjectManagementHistory(history.history);
          setError(null);
          return response.document;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to add project management comment.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
      async updateProjectManagementUsers(payload: UpdateProjectManagementUsersRequest) {
        setProjectManagementSaving(true);
        try {
          const response = await updateProjectManagementUsersRequest(payload);
          setProjectManagementUsers(response);
          setProjectManagementError(null);
          setProjectManagementLastUpdatedAt(new Date().toISOString());
          setError(null);
          return response;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to update project management users.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
    }),
    [appendBackgroundLogs, clearTrackedAiCommandLogSubscription, getTrackedAiCommandLogJobId, loadAiCommandLog, loadProjectManagementDocumentsState, loadProjectManagementDocumentState, loadProjectManagementUsersState, loadSystemStatusState, trackAiCommandJob, upsertRunningAiJob],
  );

  return {
    state,
    error,
    loading,
    hasLoadedInitialState,
    busyBranch,
    lastEnvSync,
    shutdownStatus,
    backgroundCommands,
    backgroundLogs,
    gitComparison,
    gitComparisonLoading,
    configDocument,
    configDocumentLoading,
      aiCommandSettings,
      aiCommandSettingsLoading,
      aiCommandJob,
      aiCommandRunningBranch,
    projectManagementDocumentAiJob,
    projectManagementDocumentAiRunningBranch,
      aiCommandLogs,
      aiCommandLogDetail,
      aiCommandLogsLoading,
    aiCommandLogsError,
    aiCommandLogsLastUpdatedAt,
    runningAiCommandJobs,
    systemStatus,
    systemLoading,
    systemError,
    systemLastUpdatedAt,
    projectManagement,
    projectManagementUsers,
    projectManagementDocument,
    projectManagementHistory,
    projectManagementLoading,
    projectManagementError,
    projectManagementLastUpdatedAt,
    projectManagementSaving,
    clearLastEnvSync,
    clearBackgroundLogs,
    ...actions,
  };
}

export function DashboardStateProvider({ children }: { children: ReactNode }) {
  const value = useDashboardStateInternal();
  return createElement(DashboardStateContext.Provider, { value }, children);
}

export function useDashboardState() {
  const value = useContext(DashboardStateContext);
  if (!value) {
    throw new Error("useDashboardState must be used within DashboardStateProvider.");
  }

  return value;
}
