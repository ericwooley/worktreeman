import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  ProjectManagementDocument,
  WorktreeRecord,
} from "@shared/types";
import { createProjectManagementDocumentWorktreeBranch } from "@shared/project-management-worktree";

export function getAiCommandLabel(commandId: AiCommandId): string {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

export function isAiCommandReady(aiCommands: AiCommandConfig | null, commandId: AiCommandId): boolean {
  return Boolean(aiCommands?.[commandId]?.includes("$WTM_AI_INPUT"));
}

export function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function summarizeDocumentText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

export function getCompletedAiDocumentRefreshTarget(options: {
  aiJob: AiCommandJob | null;
  documentId: string | null;
  hasWorkspaceRefresh: boolean;
}): "workspace" | "document" | null {
  const { aiJob, documentId, hasWorkspaceRefresh } = options;
  if (!aiJob || aiJob.status !== "completed" || !documentId || aiJob.documentId !== documentId) {
    return null;
  }

  return hasWorkspaceRefresh ? "workspace" : "document";
}

export function getProjectManagementDocumentRunDefaults(options: {
  document: ProjectManagementDocument | null;
  linkedWorktrees: WorktreeRecord[];
  selectedWorktreeBranch: string | null;
}) {
  const currentLinkedWorktree = options.selectedWorktreeBranch
    ? options.linkedWorktrees.find((entry) => entry.branch === options.selectedWorktreeBranch) ?? null
    : null;

  return {
    currentLinkedWorktree,
    canContinueCurrent: Boolean(currentLinkedWorktree),
    defaultStrategy: currentLinkedWorktree ? "continue-current" as const : "new" as const,
    generatedWorktreeName: options.document ? createProjectManagementDocumentWorktreeBranch(options.document) : "",
  };
}
