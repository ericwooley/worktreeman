import { useEffect, useRef } from "react";

type UseAiLogAutoSelectOptions = {
  loading: boolean;
  selectedJobId: string | null;
  primaryCandidateJobId: string | null;
  onSelectLog: (jobId: string, options?: { silent?: boolean }) => Promise<unknown>;
};

type ShouldAutoSelectAiLogOptions = {
  loading: boolean;
  selectedJobId: string | null;
  primaryCandidateJobId: string | null;
  lastAutoSelectedJobId: string | null;
};

export function shouldAutoSelectAiLog({
  loading,
  selectedJobId,
  primaryCandidateJobId,
  lastAutoSelectedJobId,
}: ShouldAutoSelectAiLogOptions) {
  if (loading || !primaryCandidateJobId) {
    return false;
  }

  if (selectedJobId) {
    return false;
  }

  if (lastAutoSelectedJobId === primaryCandidateJobId) {
    return false;
  }

  return true;
}

export function useAiLogAutoSelect({
  loading,
  selectedJobId,
  primaryCandidateJobId,
  onSelectLog,
}: UseAiLogAutoSelectOptions) {
  const autoSelectedJobRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedJobId) {
      autoSelectedJobRef.current = selectedJobId;
    }
  }, [selectedJobId]);

  useEffect(() => {
    const nextJobId = primaryCandidateJobId;
    if (!nextJobId || !shouldAutoSelectAiLog({
      loading,
      selectedJobId,
      primaryCandidateJobId: nextJobId,
      lastAutoSelectedJobId: autoSelectedJobRef.current,
    })) {
      return;
    }

    autoSelectedJobRef.current = nextJobId;
    void onSelectLog(nextJobId, { silent: true });
  }, [loading, onSelectLog, primaryCandidateJobId, selectedJobId]);
}
