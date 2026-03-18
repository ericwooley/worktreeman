import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ApiStateResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ShutdownStatus,
} from "@shared/types";
import {
  createWorktree,
  deleteWorktree,
  getBackgroundCommandLogs as fetchBackgroundCommandLogs,
  getBackgroundCommands as fetchBackgroundCommands,
  getState,
  startBackgroundCommand as startBackgroundProcess,
  startRuntime,
  stopBackgroundCommand as stopBackgroundProcess,
  stopRuntime,
  subscribeToBackgroundCommandLogs,
  subscribeToShutdownStatus,
  syncEnvFiles,
  type EnvSyncResponse,
} from "../lib/api";

export function useDashboardState() {
  const [state, setState] = useState<ApiStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);
  const [lastEnvSync, setLastEnvSync] = useState<{ branch: string; copiedFiles: string[] } | null>(null);
  const [shutdownStatus, setShutdownStatus] = useState<ShutdownStatus | null>(null);
  const [backgroundCommands, setBackgroundCommands] = useState<BackgroundCommandState[]>([]);
  const [backgroundLogs, setBackgroundLogs] = useState<BackgroundCommandLogsResponse | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await getState();
      setState(payload);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load state.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => subscribeToShutdownStatus(setShutdownStatus), []);

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
    }),
    [appendBackgroundLogs, refresh],
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
    clearLastEnvSync,
    clearBackgroundLogs,
    refresh,
    ...actions,
  };
}
