import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiStateResponse } from "@shared/types";
import { createWorktree, deleteWorktree, getState, startRuntime, stopRuntime } from "../lib/api";

export function useDashboardState() {
  const [state, setState] = useState<ApiStateResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyBranch, setBusyBranch] = useState<string | null>(null);

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

  const actions = useMemo(
    () => ({
      async create(branch: string, worktreePath?: string) {
        setBusyBranch(branch);
        try {
          await createWorktree(branch, worktreePath);
          await refresh();
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
    }),
    [refresh],
  );

  return {
    state,
    error,
    loading,
    busyBranch,
    refresh,
    ...actions,
  };
}
