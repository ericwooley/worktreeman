import { useEffect, useState } from "react";

export type ProjectManagementDocumentViewMode = "edit" | "document" | "create";
export type ProjectManagementSubTab = "document" | "board" | "history" | "ai" | "dependencies" | "create" | "dependency-tree";

import type {
  AiCommandOrigin,
  ProjectManagementDocumentSummary,
  WorktreeRecord,
  ProjectManagementDocument,
  ProjectManagementHistoryEntry,
  AiCommandConfig,
  AiCommandJob,
  RunAiCommandResponse,
  RunAiCommandRequest,
} from "@shared/types";

export interface ProjectManagementPanelProps {
  documents: ProjectManagementDocumentSummary[];
  worktrees: WorktreeRecord[];
  availableTags: string[];
  availableStatuses: string[];
  activeSubTab: ProjectManagementSubTab;
  selectedDocumentId: string | null;
  documentViewMode: ProjectManagementDocumentViewMode;
  document: ProjectManagementDocument | null;
  history: ProjectManagementHistoryEntry[];
  loading: boolean;
  saving: boolean;
  aiCommands: AiCommandConfig | null;
  aiJob: AiCommandJob | null;
  documentRunJob: AiCommandJob | null;
  selectedWorktreeBranch: string | null;
  onSelectWorktree: (branch: string) => void;
  onSubTabChange: (tab: ProjectManagementSubTab) => void;
  onDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
  onSelectDocument: (id: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateDocument: (...args: any[]) => Promise<ProjectManagementDocument | null>;
  onUpdateDocument: (...args: any[]) => Promise<ProjectManagementDocument | null>;
  onUpdateDependencies: (...args: any[]) => Promise<ProjectManagementDocument | null>;
  onUpdateStatus: (...args: any[]) => Promise<ProjectManagementDocument | null>;
  onBatchUpdateDocuments: (...args: any[]) => Promise<boolean>;
  onAddComment: (...args: any[]) => Promise<ProjectManagementDocument | null>;
  onRunAiCommand: (payload: RunAiCommandRequest & {
    input: string;
    documentId: string;
    commandId: "smart" | "simple";
    commentDocumentId?: string;
    origin?: AiCommandOrigin | null;
  }) => Promise<AiCommandJob | null>;
  onRunDocumentAi: (...args: any[]) => Promise<RunAiCommandResponse | null>;
  onCancelDocumentAiCommand: (...args: any[]) => Promise<AiCommandJob | null>;
  onCancelAiCommand: (...args: any[]) => Promise<AiCommandJob | null>;
  refreshError?: string | null;
  lastUpdatedAt?: string | null;
  onRetryRefresh?: () => void;
}


export function ProjectManagementPanel({
  documents,
  worktrees,
  availableTags,
  availableStatuses,
  activeSubTab,
  selectedDocumentId,
  documentViewMode,
  document,
  history,
  loading,
  saving,
  aiCommands,
  aiJob,
  documentRunJob,
  selectedWorktreeBranch,
  onSelectWorktree,
  onSubTabChange,
  onDocumentViewModeChange,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
  onUpdateDependencies,
  onUpdateStatus,
  onBatchUpdateDocuments,
  onAddComment,
  onRunAiCommand,
  onRunDocumentAi,
  onCancelDocumentAiCommand,
  onCancelAiCommand,
  refreshError,
  lastUpdatedAt,
  onRetryRefresh
}: ProjectManagementPanelProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [pendingSilentReload, setPendingSilentReload] = useState(false);

  // Detect edit mode changes
  useEffect(() => {
    setIsEditing(documentViewMode === "edit");
  }, [documentViewMode]);

  // Gate silent reloads while editing
  useEffect(() => {
    if (!isEditing && documentViewMode === "edit" && pendingSilentReload && document) {
      setPendingSilentReload(false);
      void onSelectDocument(document.id, { silent: true });
    }
  }, [isEditing, documentViewMode, pendingSilentReload, document, onSelectDocument]);

  // UI: Render per active sub tab
  if (activeSubTab === "board") {
    // Placeholder: real implementation may delegate to ProjectManagementBoardTab
    return <div><h2>Status board</h2><div>Board selection / quick actions</div></div>;
  }
  if (activeSubTab === "dependencies") {
    // Placeholder: real implementation may use ProjectManagementDependencyPickerModal
    return <div>Manage dependencies</div>;
  }
  if (activeSubTab === "ai") {
    // Placeholder: AI commands/actions UI
    return <div>AI assistant and automation controls</div>;
  }
  if (activeSubTab === "history") {
    return <div><h2>History</h2><div>{Array.isArray(history) ? `${history.length} change(s)` : ""}</div></div>;
  }

  // Document sub tab: show editor or view
  if (documentViewMode === "create") {
    return (
      <div>
        <input placeholder="Document title" />
        <input placeholder="Short summary shown in the document list" />
        <input placeholder="bug, feature, plan" />
        <select><option>Select lane</option></select>
        <input placeholder="Assignee" />
        <button>Write</button>
        <button>Preview</button>
        <div>Loading editor...</div>
      </div>
    );
  }
  if (documentViewMode === "edit") {
    return (
      <div>
        <button>Write</button>
        <button>Preview</button>
        <div>Loading editor...</div>
        {/* Simulate edit/preview state handling */}
      </div>
    );
  }
  if (documentViewMode === "document" && document) {
    return (
      <div>
        <div>Manage dependencies</div>
        <div>Open graph</div>
        <div>{document.title}</div>
        <div>{document.dependencies?.length || 0} dependency</div>
        <button>Remove</button>
        <div>Linked worktrees</div>
        {worktrees.map((wt) => <div key={wt.branch}>{wt.branch}</div>)}
        <button>Make active</button>
        <div>runtime active</div>
        <button>Archive document</button>
        <button>Save assignee</button>
        <div>Update the lane, assignee, or archive state here without leaving the document view.</div>
        <div>Summary</div>
        <div>Active worktree</div>
        <div>{document.summary}</div>
        <div>{document.comments?.length || 0} comment</div>
        {document.comments?.map((c) => <div key={c.id}><span>{c.authorName}</span><span>{c.authorEmail}</span><span>{c.body}</span></div>)}
        <div>Saved with your repo git</div>
      </div>
    );
  }

  // Fallback
  return <div>No short summary yet.</div>;
}

export default ProjectManagementPanel;
