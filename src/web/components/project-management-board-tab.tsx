import type { ProjectManagementDocument, ProjectManagementDocumentSummary } from "@shared/types";
import { MatrixBadge } from "./matrix-primitives";

interface ProjectManagementBoardTabProps {
  swimlaneDocuments: Array<{
    status: string;
    documents: ProjectManagementDocumentSummary[];
  }>;
  document: ProjectManagementDocument | null;
  showBacklogLane: boolean;
  onToggleBacklogLane: () => void;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
}

export function ProjectManagementBoardTab({
  swimlaneDocuments,
  document,
  showBacklogLane,
  onToggleBacklogLane,
  onSelectDocument,
}: ProjectManagementBoardTabProps) {
  return (
    <div className="border theme-border-subtle p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="matrix-kicker">Swim lane</p>
          <h3 className="mt-2 text-xl font-semibold theme-text-strong">Status board</h3>
          <p className="mt-2 text-sm theme-text-muted">Track active work by status, assignee, and archive state.</p>
        </div>
        <button
          type="button"
          className={`matrix-button rounded-none px-3 py-2 text-sm ${showBacklogLane ? "theme-pill-emphasis theme-text-strong" : ""}`}
          onClick={onToggleBacklogLane}
        >
          {showBacklogLane ? "Hide backlog" : "Show backlog"}
        </button>
      </div>

      <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
        {swimlaneDocuments.map((lane) => (
          <div key={lane.status} className="min-w-[16rem] flex-1 border theme-border-subtle p-3 xl:min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">{lane.status}</p>
              <MatrixBadge tone="neutral" compact>{lane.documents.length}</MatrixBadge>
            </div>
            <div className="mt-3 space-y-2">
              {lane.documents.length ? lane.documents.map((entry) => (
                <button
                  key={`${lane.status}:${entry.id}`}
                  type="button"
                  className={`w-full border px-3 py-3 text-left ${document?.id === entry.id ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
                  onClick={() => void onSelectDocument(entry.id)}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                    {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                  </div>
                  <p className="mt-1 text-xs font-semibold theme-text-muted">#{entry.number}</p>
                  <p className="mt-1 text-xs theme-text-muted">{entry.assignee || "Unassigned"}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {entry.tags.slice(0, 2).map((tag) => <MatrixBadge key={`${entry.id}:${tag}`} tone="active" compact>{tag}</MatrixBadge>)}
                  </div>
                </button>
              )) : (
                <div className="matrix-command rounded-none px-3 py-3 text-xs theme-empty-note">
                  No matching documents.
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
