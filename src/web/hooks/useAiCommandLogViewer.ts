import { useEffect, useMemo, useState } from "react";
import type { AiCommandJob, AiCommandLogEntry } from "@shared/types";

import { subscribeToAiCommandLog } from "../lib/api";
import { toAiCommandJobFromLog } from "../lib/ai-command-log";

export function useAiCommandLogViewer(jobId: string | null, initialLogDetail: AiCommandLogEntry | null = null): {
  logDetail: AiCommandLogEntry | null;
  job: AiCommandJob | null;
} {
  const [logDetail, setLogDetail] = useState<AiCommandLogEntry | null>(() => (
    jobId && initialLogDetail?.jobId === jobId ? initialLogDetail : null
  ));

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

    return subscribeToAiCommandLog(jobId, (event) => {
      setLogDetail(event.log);
    });
  }, [initialLogDetail, jobId]);

  const job = useMemo(() => (logDetail ? toAiCommandJobFromLog(logDetail) : null), [logDetail]);

  return { logDetail, job };
}
