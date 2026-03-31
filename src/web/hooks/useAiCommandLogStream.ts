import { useCallback, useEffect, useRef } from "react";
import type {
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandLogStreamEvent,
} from "@shared/types";

export const AI_COMMAND_LOG_SNAPSHOT_TIMEOUT_MS = 5000;

type SubscribeToAiCommandLog = (
  jobId: string,
  onEvent: (event: AiCommandLogStreamEvent) => void,
) => () => void;

type SetTimeoutFn = (callback: () => void, timeoutMs: number) => number;
type ClearTimeoutFn = (timeoutId: number) => void;

type PendingLoad = {
  jobId: string;
  promise: Promise<AiCommandLogEntry | null>;
  reject: (reason?: unknown) => void;
  timeoutId: number;
};

type AiCommandLogStreamControllerOptions = {
  subscribe: SubscribeToAiCommandLog;
  applyEvent: (event: AiCommandLogStreamEvent) => void;
  getCurrentDetail: () => AiCommandLogEntry | null;
  timeoutMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
};

export class AiCommandLogLoadCancelledError extends Error {
  constructor(message = "Cancelled AI log stream load.") {
    super(message);
    this.name = "AiCommandLogLoadCancelledError";
  }
}

export function createAiCommandLogStreamController({
  subscribe,
  applyEvent,
  getCurrentDetail,
  timeoutMs = AI_COMMAND_LOG_SNAPSHOT_TIMEOUT_MS,
  setTimeoutFn = (callback, timeoutMsValue) => window.setTimeout(callback, timeoutMsValue),
  clearTimeoutFn = (timeoutId) => window.clearTimeout(timeoutId),
}: AiCommandLogStreamControllerOptions) {
  let trackedJobId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  let pendingLoad: PendingLoad | null = null;

  const clearPendingLoad = (reason: unknown) => {
    if (!pendingLoad) {
      return;
    }

    const activePendingLoad = pendingLoad;
    pendingLoad = null;
    clearTimeoutFn(activePendingLoad.timeoutId);
    activePendingLoad.reject(reason);
  };

  const clear = (reason: unknown = new AiCommandLogLoadCancelledError()) => {
    unsubscribe?.();
    unsubscribe = null;
    trackedJobId = null;
    clearPendingLoad(reason);
  };

  const load = (jobId: string) => {
    if (trackedJobId === jobId) {
      const currentDetail = getCurrentDetail();
      if (currentDetail?.jobId === jobId) {
        return Promise.resolve(currentDetail);
      }

      if (pendingLoad?.jobId === jobId) {
        return pendingLoad.promise;
      }
    }

    clear();
    trackedJobId = jobId;

    let resolvePendingLoad!: (value: AiCommandLogEntry | null) => void;
    let rejectPendingLoad!: (reason?: unknown) => void;
    const promise = new Promise<AiCommandLogEntry | null>((resolve, reject) => {
      resolvePendingLoad = resolve;
      rejectPendingLoad = reject;
    });

    const timeoutId = setTimeoutFn(() => {
      if (!pendingLoad || pendingLoad.jobId !== jobId) {
        return;
      }

      unsubscribe?.();
      unsubscribe = null;
      trackedJobId = null;
      clearPendingLoad(new Error(`Timed out waiting for the AI log stream for ${jobId}.`));
    }, timeoutMs);

    pendingLoad = {
      jobId,
      reject: rejectPendingLoad,
      timeoutId,
      promise,
    };

    unsubscribe = subscribe(jobId, (event) => {
      applyEvent(event);

      if (!pendingLoad || pendingLoad.jobId !== jobId) {
        return;
      }

      const activePendingLoad = pendingLoad;
      pendingLoad = null;
      clearTimeoutFn(activePendingLoad.timeoutId);
      resolvePendingLoad(event.log);
    });

    return promise;
  };

  return {
    clear,
    load,
    getTrackedJobId: () => trackedJobId,
  };
}

type UseAiCommandLogStreamOptions = {
  subscribe: SubscribeToAiCommandLog;
  toSummary: (log: AiCommandLogEntry) => AiCommandLogSummary;
  setAiCommandLogDetail: React.Dispatch<React.SetStateAction<AiCommandLogEntry | null>>;
  setAiCommandLogs: React.Dispatch<React.SetStateAction<AiCommandLogSummary[]>>;
  setRunningAiCommandJobs: React.Dispatch<React.SetStateAction<AiCommandJob[]>>;
  setAiCommandLogsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  setAiCommandLogsError: React.Dispatch<React.SetStateAction<string | null>>;
  setAiCommandLogsLastUpdatedAt: React.Dispatch<React.SetStateAction<string | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
};

export function useAiCommandLogStream({
  subscribe,
  toSummary,
  setAiCommandLogDetail,
  setAiCommandLogs,
  setRunningAiCommandJobs,
  setAiCommandLogsLoading,
  setAiCommandLogsError,
  setAiCommandLogsLastUpdatedAt,
  setError,
}: UseAiCommandLogStreamOptions) {
  const detailRef = useRef<AiCommandLogEntry | null>(null);

  const applyAiLogStreamEvent = useCallback((event: AiCommandLogStreamEvent) => {
    if (!event.log) {
      detailRef.current = null;
      setAiCommandLogDetail(null);
      return;
    }

    const log = event.log;
    detailRef.current = log;
    setAiCommandLogDetail(log);
    setAiCommandLogs((current) => {
      const next = current.filter((entry) => entry.jobId !== log.jobId);
      if (log.status !== "running") {
        next.unshift(toSummary(log));
      }
      return next.sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
    });

    setRunningAiCommandJobs((current) => {
      const next = current.filter((entry) => entry.jobId !== log.jobId);
      if (log.status === "running") {
        next.unshift({
          jobId: log.jobId,
          fileName: log.fileName,
          branch: log.branch,
          documentId: log.documentId ?? null,
          commandId: log.commandId,
          origin: log.origin ?? null,
          command: log.command,
          input: log.request,
          status: log.status,
          startedAt: log.timestamp,
          completedAt: log.completedAt,
          stdout: log.response.stdout,
          stderr: log.response.stderr,
          outputEvents: log.response.events?.map((entry) => ({ ...entry })) ?? [],
          pid: log.pid ?? null,
          exitCode: log.exitCode ?? null,
          processName: log.processName ?? null,
          error: log.error?.message ?? null,
        });
      }
      return next.sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));
    });
    setAiCommandLogsError(null);
    setAiCommandLogsLastUpdatedAt(new Date().toISOString());
  }, [setAiCommandLogDetail, setAiCommandLogs, setAiCommandLogsError, setAiCommandLogsLastUpdatedAt, setRunningAiCommandJobs, toSummary]);

  const applyAiLogStreamEventRef = useRef(applyAiLogStreamEvent);
  applyAiLogStreamEventRef.current = applyAiLogStreamEvent;

  const controllerRef = useRef<ReturnType<typeof createAiCommandLogStreamController> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = createAiCommandLogStreamController({
      subscribe,
      applyEvent: (event) => applyAiLogStreamEventRef.current(event),
      getCurrentDetail: () => detailRef.current,
    });
  }

  const clearTrackedAiCommandLogSubscription = useCallback(() => {
    controllerRef.current?.clear();
  }, []);

  useEffect(() => {
    return () => {
      controllerRef.current?.clear();
    };
  }, []);

  const loadAiCommandLog = useCallback(async (jobId: string, options?: { silent?: boolean }) => {
    if (!options?.silent) {
      setAiCommandLogsLoading(true);
    }

    try {
      const log = await controllerRef.current!.load(jobId);
      setAiCommandLogsError(null);
      setAiCommandLogsLastUpdatedAt(new Date().toISOString());
      setError(null);
      return log;
    } catch (err) {
      if (err instanceof AiCommandLogLoadCancelledError) {
        return null;
      }

      const message = err instanceof Error ? err.message : "Failed to load AI log.";
      controllerRef.current?.clear();
      detailRef.current = null;
      setAiCommandLogDetail(null);
      setAiCommandLogsError(message);
      setError(message);
      return null;
    } finally {
      if (!options?.silent) {
        setAiCommandLogsLoading(false);
      }
    }
  }, [setAiCommandLogDetail, setAiCommandLogsError, setAiCommandLogsLastUpdatedAt, setAiCommandLogsLoading, setError]);

  const getTrackedAiCommandLogJobId = useCallback(() => controllerRef.current?.getTrackedJobId() ?? null, []);

  return {
    applyAiLogStreamEvent,
    clearTrackedAiCommandLogSubscription,
    getTrackedAiCommandLogJobId,
    loadAiCommandLog,
  };
}
