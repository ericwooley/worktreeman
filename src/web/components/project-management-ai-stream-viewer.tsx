import type { AiCommandJob, AiCommandLogEntry } from "@shared/types";

import { useAiCommandLogViewer } from "../hooks/useAiCommandLogViewer";
import { ProjectManagementAiOutputViewer } from "./project-management-ai-output-viewer";

interface ProjectManagementAiStreamViewerProps {
  source: "worktree" | "document";
  jobId: string | null;
  summary: string | null;
  fallbackJob?: AiCommandJob | null;
  initialLogDetail?: AiCommandLogEntry | null;
  expanded?: boolean;
  onCancel: () => void;
  onOpenModal?: () => void;
}

export function ProjectManagementAiStreamViewer({
  source,
  jobId,
  summary,
  fallbackJob = null,
  initialLogDetail = null,
  expanded = false,
  onCancel,
  onOpenModal,
}: ProjectManagementAiStreamViewerProps) {
  const { job: streamedJob } = useAiCommandLogViewer(jobId, initialLogDetail);
  const job = streamedJob ?? fallbackJob;
  if (!job) {
    return null;
  }

  return (
    <ProjectManagementAiOutputViewer
      source={source}
      job={job}
      summary={summary}
      expanded={expanded}
      onCancel={onCancel}
      onOpenModal={onOpenModal}
    />
  );
}
