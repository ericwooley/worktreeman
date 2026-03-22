import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AppendProjectManagementBatchRequest,
  ApiStateResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  GitComparisonResponse,
  ProjectManagementBatchResponse,
  ProjectManagementDocument,
  ProjectManagementHistoryEntry,
  ProjectManagementListResponse,
  ShutdownStatus,
  UpdateProjectManagementDocumentRequest,
} from "@shared/types";
import {
  appendProjectManagementBatch as appendProjectManagementBatchRequest,
  createProjectManagementDocument as createProjectManagementDocumentRequest,
  createWorktree,
  deleteWorktree,
  getProjectManagementDocument as fetchProjectManagementDocument,
  getProjectManagementHistory as fetchProjectManagementHistory,
  listProjectManagementDocuments as fetchProjectManagementDocuments,
  getConfigDocument as fetchConfigDocument,
  getBackgroundCommandLogs as fetchBackgroundCommandLogs,
  getBackgroundCommands as fetchBackgroundCommands,
  getGitComparison as fetchGitComparison,
  getState,
  restartBackgroundCommand as restartBackgroundProcess,
  saveConfigDocument as persistConfigDocument,
  startBackgroundCommand as startBackgroundProcess,
  startRuntime,
  stopBackgroundCommand as stopBackgroundProcess,
  stopRuntime,
  subscribeToBackgroundCommandLogs,
  subscribeToShutdownStatus,
  syncEnvFiles,
  updateProjectManagementDocument as updateProjectManagementDocumentRequest,
  type EnvSyncResponse,
} from "../lib/api";

const DASHBOARD_REFRESH_INTERVAL_MS = 5000;

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
  const [projectManagement, setProjectManagement] = useState<ProjectManagementListResponse | null>(null);
  const [projectManagementDocument, setProjectManagementDocument] = useState<ProjectManagementDocument | null>(null);
  const [projectManagementHistory, setProjectManagementHistory] = useState<ProjectManagementHistoryEntry[]>([]);
  const [projectManagementLoading, setProjectManagementLoading] = useState(false);
  const [projectManagementSaving, setProjectManagementSaving] = useState(false);

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
      async create(branch: string, worktreePath?: string) {
        setBusyBranch(branch);
        try {
          const result = await createWorktree(branch, worktreePath);
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
      async appendProjectManagementBatch(payload: AppendProjectManagementBatchRequest) {
        setProjectManagementSaving(true);
        try {
          const response: ProjectManagementBatchResponse = await appendProjectManagementBatchRequest(payload);
          await loadProjectManagementDocumentsState({ silent: true });
          if (response.documentIds[0]) {
            await loadProjectManagementDocumentState(response.documentIds[0], { silent: true });
          }
          setError(null);
          return response;
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to append project management batch.");
          return null;
        } finally {
          setProjectManagementSaving(false);
        }
      },
    }),
    [appendBackgroundLogs, loadProjectManagementDocumentsState, loadProjectManagementDocumentState, refresh],
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
