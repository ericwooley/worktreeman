import { useMemo, useState } from "react";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary } from "@shared/types";
import { MatrixBadge } from "./matrix-primitives";

interface ProjectManagementBoardTabProps {
  swimlaneDocuments: Array<{
    status: string;
    documents: ProjectManagementDocumentSummary[];
  }>;
  document: ProjectManagementDocument | null;
  showBacklogLane: boolean;
  saving: boolean;
  onToggleBacklogLane: () => void;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onMoveDocument: (documentId: string, nextStatus: string) => Promise<void>;
}

export function ProjectManagementBoardTab({
  swimlaneDocuments,
  document,
  showBacklogLane,
  saving,
  onToggleBacklogLane,
  onSelectDocument,
  onMoveDocument,
}: ProjectManagementBoardTabProps) {
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [movingDocumentId, setMovingDocumentId] = useState<string | null>(null);

  const draggedDocument = useMemo(
    () => swimlaneDocuments.flatMap((lane) => lane.documents).find((entry) => entry.id === draggedDocumentId) ?? null,
    [draggedDocumentId, swimlaneDocuments],
  );

  async function moveDocument(documentId: string, nextStatus: string) {
    setDropTargetStatus(null);
    setMovingDocumentId(documentId);
    try {
      await onMoveDocument(documentId, nextStatus);
    } finally {
      setMovingDocumentId(null);
      setDraggedDocumentId(null);
    }
  }

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
          <div
            key={lane.status}
            className={`min-w-[16rem] flex-1 border p-3 xl:min-w-0 ${dropTargetStatus === lane.status ? "theme-pill-emphasis" : "theme-border-subtle"}`}
            onDragOver={(event) => {
              if (!draggedDocument || saving || movingDocumentId) {
                return;
              }
              event.preventDefault();
              if (draggedDocument.status !== lane.status) {
                setDropTargetStatus(lane.status);
              }
            }}
            onDragLeave={() => {
              if (dropTargetStatus === lane.status) {
                setDropTargetStatus(null);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const documentId = event.dataTransfer.getData("text/project-management-document-id") || draggedDocumentId;
              if (!documentId || saving || movingDocumentId) {
                setDropTargetStatus(null);
                return;
              }

              const sourceStatus = draggedDocument?.status;
              if (sourceStatus === lane.status) {
                setDropTargetStatus(null);
                setDraggedDocumentId(null);
                return;
              }

              void moveDocument(documentId, lane.status);
            }}
          >
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">{lane.status}</p>
              <MatrixBadge tone="neutral" compact>{lane.documents.length}</MatrixBadge>
            </div>
            {dropTargetStatus === lane.status && draggedDocument ? (
              <div className="mt-2 border theme-border-emphasis px-2 py-2 text-[11px] uppercase tracking-[0.14em] theme-text-accent">
                Move #{draggedDocument.number} here
              </div>
            ) : null}
            <div className="mt-3 space-y-2">
              {lane.documents.length ? lane.documents.map((entry) => (
                <button
                  key={`${lane.status}:${entry.id}`}
                  type="button"
                  draggable={!saving && movingDocumentId !== entry.id}
                  className={`w-full border px-3 py-3 text-left ${document?.id === entry.id ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
                  onClick={() => void onSelectDocument(entry.id)}
                  onDragStart={(event) => {
                    setDraggedDocumentId(entry.id);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/project-management-document-id", entry.id);
                  }}
                  onDragEnd={() => {
                    setDraggedDocumentId(null);
                    setDropTargetStatus(null);
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <p className="min-w-0 truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                    <div className="flex items-center gap-1">
                      {movingDocumentId === entry.id ? <MatrixBadge tone="active" compact>moving</MatrixBadge> : null}
                      {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                    </div>
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
