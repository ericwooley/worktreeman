import { useEffect, useRef } from "react";

type UseAiLogAutoSelectOptions = {
  loading: boolean;
  selectedFileName: string | null;
  primaryCandidateFileName: string | null;
  onSelectLog: (fileName: string, options?: { silent?: boolean }) => Promise<unknown>;
};

type ShouldAutoSelectAiLogOptions = {
  loading: boolean;
  selectedFileName: string | null;
  primaryCandidateFileName: string | null;
  lastAutoSelectedFileName: string | null;
};

export function shouldAutoSelectAiLog({
  loading,
  selectedFileName,
  primaryCandidateFileName,
  lastAutoSelectedFileName,
}: ShouldAutoSelectAiLogOptions) {
  if (loading || !primaryCandidateFileName) {
    return false;
  }

  if (selectedFileName) {
    return false;
  }

  if (lastAutoSelectedFileName === primaryCandidateFileName) {
    return false;
  }

  return true;
}

export function useAiLogAutoSelect({
  loading,
  selectedFileName,
  primaryCandidateFileName,
  onSelectLog,
}: UseAiLogAutoSelectOptions) {
  const autoSelectedFileRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedFileName) {
      autoSelectedFileRef.current = selectedFileName;
    }
  }, [selectedFileName]);

  useEffect(() => {
    const nextFileName = primaryCandidateFileName;
    if (!nextFileName || !shouldAutoSelectAiLog({
      loading,
      selectedFileName,
      primaryCandidateFileName: nextFileName,
      lastAutoSelectedFileName: autoSelectedFileRef.current,
    })) {
      return;
    }

    autoSelectedFileRef.current = nextFileName;
    void onSelectLog(nextFileName, { silent: true });
  }, [loading, onSelectLog, primaryCandidateFileName, selectedFileName]);
}
