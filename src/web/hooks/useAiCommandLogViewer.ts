import { useEffect, useMemo, useRef, useState } from "react";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogStreamEvent } from "@shared/types";

import { getAiCommandLog, subscribeToAiCommandLog } from "../lib/api";
import { toAiCommandJobFromLog } from "../lib/ai-command-log";

type SubscribeToAiCommandLog = (
  jobId: string,
  onEvent: (event: AiCommandLogStreamEvent) => void,
) => (() => void);

export function createAiCommandLogViewerSubscriptionController(options: {
  subscribe: SubscribeToAiCommandLog;
}) {
  let trackedJobId: string | null = null;
  let unsubscribe: (() => void) | null = null;

  return {
    getTrackedJobId() {
      return trackedJobId;
    },

    select(jobId: string | null, onEvent: (event: AiCommandLogStreamEvent) => void) {
      if (!jobId) {
        unsubscribe?.();
        unsubscribe = null;
        trackedJobId = null;
        return;
      }

      if (trackedJobId === jobId && unsubscribe) {
        return;
      }

      unsubscribe?.();
      trackedJobId = jobId;
      unsubscribe = options.subscribe(jobId, (event) => {
        if (trackedJobId !== jobId) {
          return;
        }

        onEvent(event);
      });
    },

    clear() {
      unsubscribe?.();
      unsubscribe = null;
      trackedJobId = null;
    },
  };
}

export function useAiCommandLogViewer(jobId: string | null, initialLogDetail: AiCommandLogEntry | null = null): {
  logDetail: AiCommandLogEntry | null;
  job: AiCommandJob | null;
} {
  const [logDetail, setLogDetail] = useState<AiCommandLogEntry | null>(() => (
    jobId && initialLogDetail?.jobId === jobId ? initialLogDetail : null
  ));
  const controllerRef = useRef<ReturnType<typeof createAiCommandLogViewerSubscriptionController> | null>(null);

  useEffect(() => {
    if (!jobId) {
      setLogDetail(null);
      return;
    }

    setLogDetail((current) => {
      if (current?.jobId === jobId) {
        return current;
      }

      return initialLogDetail?.jobId === jobId ? initialLogDetail : null;
    });
  }, [initialLogDetail, jobId]);

  useEffect(() => {
    if (!jobId) {
      return;
    }

    let cancelled = false;
    void getAiCommandLog(jobId)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setLogDetail((current) => (current?.jobId === jobId ? current : response.log));
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [jobId]);

  useEffect(() => {
    if (!controllerRef.current) {
      controllerRef.current = createAiCommandLogViewerSubscriptionController({
        subscribe: subscribeToAiCommandLog,
      });
    }

    controllerRef.current.select(jobId, (event) => {
      setLogDetail(event.log);
    });

    return () => {
      controllerRef.current?.clear();
    };
  }, [jobId]);

  const job = useMemo(() => (logDetail ? toAiCommandJobFromLog(logDetail) : null), [logDetail]);

  return { logDetail, job };
}
