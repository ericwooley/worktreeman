import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandLogStreamEvent,
  ApiStateResponse,
  AiCommandJob,
  AiCommandId,
  AiCommandSettingsResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  GitComparisonResponse,
  ProjectManagementDocument,
  ProjectManagementHistoryEntry,
  ProjectManagementListResponse,
  RunAiCommandRequest,
  ShutdownStatus,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementDocumentRequest,
} from "@shared/types";
import {
  createProjectManagementDocument as createProjectManagementDocumentRequest,
  createWorktree,
  deleteWorktree,
  getProjectManagementDocument as fetchProjectManagementDocument,
  getProjectManagementHistory as fetchProjectManagementHistory,
  listProjectManagementDocuments as fetchProjectManagementDocuments,
  getConfigDocument as fetchConfigDocument,
  getBackgroundCommandLogs as fetchBackgroundCommandLogs,
  getBackgroundCommands as fetchBackgroundCommands,
  getAiCommandSettings as fetchAiCommandSettings,
  getAiCommandLog as fetchAiCommandLog,
  getAiCommandLogs as fetchAiCommandLogs,
  getGitComparison as fetchGitComparison,
  getState,
  cancelAiCommand as cancelAiCommandRequest,
  commitGitChanges as commitGitChangesRequest,
  mergeGitBranch as mergeGitBranchRequest,
  restartBackgroundCommand as restartBackgroundProcess,
  runAiCommand as runAiCommandRequest,
  saveAiCommandSettings as persistAiCommandSettings,
  saveConfigDocument as persistConfigDocument,
  startBackgroundCommand as startBackgroundProcess,
  startRuntime,
  stopBackgroundCommand as stopBackgroundProcess,
  stopRuntime,
  subscribeToAiCommandJob,
  subscribeToAiCommandLog,
  subscribeToBackgroundCommandLogs,
  subscribeToShutdownStatus,
  syncEnvFiles,
  updateProjectManagementDependencies as updateProjectManagementDependenciesRequest,
  updateProjectManagementDocument as updateProjectManagementDocumentRequest,
  type EnvSyncResponse,
} from "../lib/api";

const DASHBOARD_REFRESH_INTERVAL_MS = 5000;

function toAiCommandRequestPreview(request: string) {
  const normalized = request.replace(/\s+/g, " ").trim();
  return normalized.length <= 160 ? normalized : `${normalized.slice(0, 160)}...`;
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

export function useDashboardState() {
  const [state, setState] = useState<ApiStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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
  const [aiCommandLogs, setAiCommandLogs] = useState<AiCommandLogSummary[]>([]);
  const [aiCommandLogDetail, setAiCommandLogDetail] = useState<AiCommandLogEntry | null>(null);
  const [aiCommandLogsLoading, setAiCommandLogsLoading] = useState(false);
  const [runningAiCommandJobs, setRunningAiCommandJobs] = useState<AiCommandJob[]>([]);
  const [projectManagement, setProjectManagement] = useState<ProjectManagementListResponse | null>(null);
  const [projectManagementDocument, setProjectManagementDocument] = useState<ProjectManagementDocument | null>(null);
  const [projectManagementHistory, setProjectManagementHistory] = useState<ProjectManagementHistoryEntry[]>([]);
  const [projectManagementLoading, setProjectManagementLoading] = useState(false);
  const [projectManagementSaving, setProjectManagementSaving] = useState(false);
  const aiCommandSubscriptionRef = useRef<(() => void) | null>(null);
  const aiCommandLogSubscriptionRef = useRef<(() => void) | null>(null);
  const trackedAiCommandBranchRef = useRef<string | null>(null);
  const trackedAiCommandLogFileRef = useRef<string | null>(null);

  const refresh = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setLoading(true);
    }

    try {
      const payload = await getState();
      setState(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load state.");
    } finally {
      if (!options?.silent) {
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeToShutdownStatus(setShutdownStatus), []);

  useEffect(() => {
    if (busyBranch) {
      return;
    }

    const refreshIfVisible = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void refresh({ silent: true });
    };

    const interval = window.setInterval(refreshIfVisible, DASHBOARD_REFRESH_INTERVAL_MS);
    window.addEventListener("focus", refreshIfVisible);
    document.addEventListener("visibilitychange", refreshIfVisible);

    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshIfVisible);
      document.removeEventListener("visibilitychange", refreshIfVisible);
    };
  }, [busyBranch, refresh]);

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

  const clearTrackedAiCommandLogSubscription = useCallback(() => {
    aiCommandLogSubscriptionRef.current?.();
    aiCommandLogSubscriptionRef.current = null;
    trackedAiCommandLogFileRef.current = null;
  }, []);

  const applyAiLogStreamEvent = useCallback((event: AiCommandLogStreamEvent) => {
    if (!event.log) {
      setAiCommandLogDetail(null);
      return;
    }

    const log = event.log;

    setAiCommandLogDetail(log);
    setAiCommandLogs((current) => {
      const summary: AiCommandLogSummary = {
        jobId: log.jobId,
        fileName: log.fileName,
        timestamp: log.timestamp,
        branch: log.branch,
        documentId: log.documentId ?? null,
        commandId: log.commandId,
        worktreePath: log.worktreePath,
        command: log.command,
        requestPreview: toAiCommandRequestPreview(log.request),
        status: log.status,
        pid: log.pid ?? null,
      };
      const next = current.filter((entry) => entry.fileName !== summary.fileName);
      next.unshift(summary);
      return next.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    });

    setRunningAiCommandJobs((current) => {
      const next = current.filter((entry) => entry.fileName !== log.fileName && entry.branch !== log.branch);
      if (log.status === "running") {
        next.unshift({
          jobId: log.jobId,
          fileName: log.fileName,
          branch: log.branch,
          documentId: log.documentId ?? null,
          commandId: log.commandId,
          command: log.command,
          input: log.request,
          status: log.status,
          startedAt: log.timestamp,
          completedAt: log.completedAt,
          stdout: log.response.stdout,
          stderr: log.response.stderr,
          pid: log.pid ?? null,
          exitCode: log.exitCode ?? null,
          processName: log.processName ?? null,
          error: log.error?.message ?? null,
        });
      }
      return next.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    });
  }, []);

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

  useEffect(() => {
    return () => {
      aiCommandSubscriptionRef.current?.();
      clearTrackedAiCommandLogSubscription();
      aiCommandSubscriptionRef.current = null;
      trackedAiCommandBranchRef.current = null;
    };
  }, [clearTrackedAiCommandLogSubscription]);

  const loadProjectManagementDocumentsState = useCallback(async (options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setProjectManagementLoading(true);
    }

    try {
      const payload = await fetchProjectManagementDocuments();
      setProjectManagement(payload);
      setError(null);
      return payload;
    } catch (err) {
      setProjectManagement(null);
      setError(err instanceof Error ? err.message : "Failed to load project management documents.");
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
      setError(null);
      return documentPayload.document;
    } catch (err) {
      setProjectManagementDocument(null);
      setProjectManagementHistory([]);
      setError(err instanceof Error ? err.message : "Failed to load project management document.");
      return null;
    } finally {
      if (!options?.silent) {
        setProjectManagementLoading(false);
      }
    }
  }, []);

  const actions = useMemo(
    () => ({
      async create(branch: string) {
        setBusyBranch(branch);
        try {
          const result = await createWorktree(branch);
          await refresh();
          if (result) {
            setLastEnvSync({ branch, copiedFiles: result.copiedFiles });
          }
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to create worktree.");
        } finally {
          setBusyBranch(null);
        }
      },
      async remove(branch: string) {
        setBusyBranch(branch);
        try {
          await deleteWorktree(branch);
          await refresh();
          setError(null);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to delete worktree.");
        } finally {
          setBusyBranch(null);
        }
      },
      async start(branch: string) {
        setBusyBranch(branch);
        try {
          await startRuntime(branch);
          await refresh();
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
          await refresh();
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
          await refresh();
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
          await refresh({ silent: true });
          setError(null);
          return comparison;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to merge branch.");
          return null;
        } finally {
          setGitComparisonLoading(false);
        }
      },
      async commitGitChanges(branch: string, baseBranch?: string, commandId: AiCommandId = "simple") {
        setGitComparisonLoading(true);
        try {
          const result = await commitGitChangesRequest(branch, baseBranch ? { baseBranch, commandId } : { commandId });
          setGitComparison(result.comparison);
          await refresh({ silent: true });
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
          await refresh({ silent: true });
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
          await refresh({ silent: true });
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
          if (trackedAiCommandLogFileRef.current) {
            const selectedStillExists = payload.logs.some((entry) => entry.fileName === trackedAiCommandLogFileRef.current)
              || payload.runningJobs.some((entry) => entry.fileName === trackedAiCommandLogFileRef.current);
            if (!selectedStillExists) {
              clearTrackedAiCommandLogSubscription();
              setAiCommandLogDetail(null);
            }
          }
          setError(null);
          return payload;
        } catch (err) {
          setAiCommandLogs([]);
          setRunningAiCommandJobs([]);
          setError(err instanceof Error ? err.message : "Failed to load AI logs.");
          return null;
        } finally {
          if (!options?.silent) {
            setAiCommandLogsLoading(false);
          }
        }
      },
      async loadAiCommandLog(fileName: string, options?: { silent?: boolean }) {
        if (!options?.silent) {
          setAiCommandLogsLoading(true);
        }

        try {
          if (trackedAiCommandLogFileRef.current !== fileName) {
            clearTrackedAiCommandLogSubscription();
            trackedAiCommandLogFileRef.current = fileName;
            aiCommandLogSubscriptionRef.current = subscribeToAiCommandLog(fileName, applyAiLogStreamEvent);
          }

          const payload = await fetchAiCommandLog(fileName);
          setAiCommandLogDetail(payload.log);
          setError(null);
          return payload.log;
        } catch (err) {
          clearTrackedAiCommandLogSubscription();
          setAiCommandLogDetail(null);
          setError(err instanceof Error ? err.message : "Failed to load AI log.");
          return null;
        } finally {
          if (!options?.silent) {
            setAiCommandLogsLoading(false);
          }
        }
      },
      async runAiCommand(branch: string, payload: RunAiCommandRequest) {
        try {
          trackAiCommandJob(branch);
          const result = await runAiCommandRequest(branch, payload);
          setAiCommandJob(result.job);
          setAiCommandRunningBranch(result.job.status === "running" ? branch : null);
          upsertRunningAiJob(result.job);
          if (payload.documentId) {
            void loadProjectManagementDocumentsState({ silent: true });
          }
          setError(null);
          return result.job;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to run AI command.");
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
    }),
    [appendBackgroundLogs, applyAiLogStreamEvent, clearTrackedAiCommandLogSubscription, loadProjectManagementDocumentsState, loadProjectManagementDocumentState, refresh, trackAiCommandJob, upsertRunningAiJob],
  );

  return {
    state,
    error,
    loading,
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
    aiCommandLogs,
    aiCommandLogDetail,
    aiCommandLogsLoading,
    runningAiCommandJobs,
    projectManagement,
    projectManagementDocument,
    projectManagementHistory,
    projectManagementLoading,
    projectManagementSaving,
    clearLastEnvSync,
    clearBackgroundLogs,
    refresh,
    ...actions,
  };
}
