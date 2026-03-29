import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCommandJob,
  AiCommandOrigin,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  RunAiCommandResponse,
} from "@shared/types";
import { MatrixDropdown } from "./matrix-dropdown";
import { MatrixBadge } from "./matrix-primitives";

interface ProjectManagementBoardTabProps {
  swimlaneDocuments: Array<{
    status: string;
    documents: ProjectManagementDocumentSummary[];
  }>;
  document: ProjectManagementDocument | null;
  documentRunJob: AiCommandJob | null;
  runningAiJobs: AiCommandJob[];
  showBacklogLane: boolean;
  saving: boolean;
  smartAiReady: boolean;
  onToggleBacklogLane: () => void;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onMoveDocument: (documentId: string, nextStatus: string) => Promise<void>;
  onBatchUpdateDocuments: (documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) => Promise<boolean>;
  onRunDocumentAi: (payload: {
    documentId: string;
    input?: string;
    commandId: "smart" | "simple";
    origin?: AiCommandOrigin | null;
  }) => Promise<RunAiCommandResponse | null>;
}

export function ProjectManagementBoardTab({
  swimlaneDocuments,
  document,
  documentRunJob,
  runningAiJobs,
  showBacklogLane,
  saving,
  smartAiReady,
  onToggleBacklogLane,
  onSelectDocument,
  onMoveDocument,
  onBatchUpdateDocuments,
  onRunDocumentAi,
}: ProjectManagementBoardTabProps) {
  const [draggedDocumentId, setDraggedDocumentId] = useState<string | null>(null);
  const [dropTargetStatus, setDropTargetStatus] = useState<string | null>(null);
  const [movingDocumentId, setMovingDocumentId] = useState<string | null>(null);
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<string[]>([]);
  const [pendingMoveStatus, setPendingMoveStatus] = useState<string | null>(null);
  const [startingAiDocumentId, setStartingAiDocumentId] = useState<string | null>(null);
  const draggedDocumentRef = useRef<ProjectManagementDocumentSummary | null>(null);

  const allDocuments = useMemo(
    () => swimlaneDocuments.flatMap((lane) => lane.documents),
    [swimlaneDocuments],
  );

  const documentMap = useMemo(
    () => new Map(allDocuments.map((entry) => [entry.id, entry])),
    [allDocuments],
  );

  const draggedDocument = useMemo(
    () => allDocuments.find((entry) => entry.id === draggedDocumentId) ?? null,
    [allDocuments, draggedDocumentId],
  );

  const selectedDocuments = useMemo(
    () => selectedDocumentIds.map((documentId) => documentMap.get(documentId)).filter((entry): entry is ProjectManagementDocumentSummary => Boolean(entry)),
    [documentMap, selectedDocumentIds],
  );

  const visibleDocumentIds = useMemo(
    () => allDocuments.map((entry) => entry.id),
    [allDocuments],
  );

  const allVisibleSelected = visibleDocumentIds.length > 0 && visibleDocumentIds.every((documentId) => selectedDocumentIds.includes(documentId));
  const archiveActionLabel = selectedDocuments.length > 0 && selectedDocuments.every((entry) => entry.archived)
    ? "Restore selected"
    : "Archive selected";

  const moveOptions = useMemo(
    () => swimlaneDocuments.map((lane) => ({
      value: lane.status,
      label: lane.status,
      description: `${lane.documents.length} document${lane.documents.length === 1 ? "" : "s"}`,
    })),
    [swimlaneDocuments],
  );

  const runningDocumentAiJobByDocumentId = useMemo(() => {
    const entries = runningAiJobs
      .filter((job) => job.status === "running" && job.documentId && job.origin?.kind === "project-management-document-run")
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt));

    return new Map(entries.map((job) => [job.documentId as string, job]));
  }, [runningAiJobs]);

  useEffect(() => {
    setSelectedDocumentIds((current) => current.filter((documentId) => documentMap.has(documentId)));
  }, [documentMap]);

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

  function toggleDocumentSelection(documentId: string) {
    setSelectedDocumentIds((current) => current.includes(documentId)
      ? current.filter((entry) => entry !== documentId)
      : [...current, documentId]);
  }

  async function handleArchiveSelected() {
    if (!selectedDocuments.length) {
      return;
    }

    const updated = await onBatchUpdateDocuments(
      selectedDocuments.map((entry) => entry.id),
      { archived: !selectedDocuments.every((entry) => entry.archived) },
    );

    if (updated) {
      setSelectedDocumentIds([]);
    }
  }

  async function handleMoveSelected(nextStatus: string) {
    if (!selectedDocuments.length) {
      setPendingMoveStatus(null);
      return;
    }

    const updated = await onBatchUpdateDocuments(
      selectedDocuments.map((entry) => entry.id),
      { status: nextStatus },
    );

    if (updated) {
      setSelectedDocumentIds([]);
    }
    setPendingMoveStatus(null);
  }

  async function handleStartDocumentAi(entry: ProjectManagementDocumentSummary) {
    if (!smartAiReady || saving || startingAiDocumentId) {
      return;
    }

    setStartingAiDocumentId(entry.id);
    try {
      await onRunDocumentAi({
        documentId: entry.id,
        commandId: "smart",
        origin: {
          kind: "project-management-document-run",
          label: "Project management board run",
          description: `#${entry.number} ${entry.title}`,
          location: {
            tab: "project-management",
            projectManagementSubTab: "board",
            documentId: entry.id,
            projectManagementDocumentViewMode: "document",
          },
        },
      });
    } finally {
      setStartingAiDocumentId(null);
    }
  }

  return (
    <div className="border theme-border-subtle p-4">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="matrix-kicker">Swim lane</p>
          <h3 className="mt-2 text-xl font-semibold theme-text-strong">Status board</h3>
          <p className="mt-2 text-sm theme-text-muted">Track active work by status, assignee, archive state, and board quick actions.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="matrix-button rounded-none px-3 py-2 text-sm"
            onClick={() => setSelectedDocumentIds(allVisibleSelected ? [] : visibleDocumentIds)}
            disabled={!visibleDocumentIds.length || saving}
          >
            {allVisibleSelected ? "Clear visible selection" : "Select all visible"}
          </button>
          <button
            type="button"
            className={`matrix-button rounded-none px-3 py-2 text-sm ${showBacklogLane ? "theme-pill-emphasis theme-text-strong" : ""}`}
            onClick={onToggleBacklogLane}
          >
            {showBacklogLane ? "Hide backlog" : "Show backlog"}
          </button>
        </div>
      </div>

      <div className="mt-4 border theme-border-subtle p-3">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Board selection</p>
            <p className="mt-1 text-sm theme-text-muted">
              {selectedDocuments.length
                ? `${selectedDocuments.length} selected for move or archive.`
                : "Select one or more cards to move or archive them together."}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="sm:w-56">
              <MatrixDropdown
                label="Move selected"
                value={pendingMoveStatus}
                options={moveOptions}
                placeholder="Choose lane"
                disabled={saving || selectedDocuments.length === 0}
                onChange={(value) => {
                  setPendingMoveStatus(value);
                  void handleMoveSelected(value);
                }}
              />
            </div>
            <button
              type="button"
              className="matrix-button h-10 rounded-none px-3 text-sm font-semibold"
              disabled={saving || selectedDocuments.length === 0}
              onClick={() => void handleArchiveSelected()}
            >
              {archiveActionLabel}
            </button>
            {selectedDocuments.length ? (
              <button
                type="button"
                className="matrix-button h-10 rounded-none px-3 text-sm"
                onClick={() => setSelectedDocumentIds([])}
              >
                Clear selection
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {!smartAiReady ? (
        <div className="mt-3 border theme-border-subtle px-3 py-2 text-xs theme-text-muted">
          Configure Smart AI in settings to use the board quick action.
        </div>
      ) : null}

      <div className="mt-4 flex gap-3 overflow-x-auto pb-2">
        {swimlaneDocuments.map((lane) => (
          <div
            key={lane.status}
            className={`min-w-[16rem] flex-1 border p-3 xl:min-w-0 ${dropTargetStatus === lane.status ? "theme-pill-emphasis" : "theme-border-subtle"}`}
            onDragOver={(event) => {
              const activeDraggedDocument = draggedDocumentRef.current ?? draggedDocument;
              if (!activeDraggedDocument || saving || movingDocumentId) {
                return;
              }
              event.preventDefault();
              if (activeDraggedDocument.status !== lane.status) {
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
              const activeDraggedDocument = draggedDocumentRef.current ?? draggedDocument;
              const documentId = event.dataTransfer.getData("text/project-management-document-id")
                || event.dataTransfer.getData("text/plain")
                || activeDraggedDocument?.id
                || draggedDocumentId;
              if (!documentId || saving || movingDocumentId) {
                setDropTargetStatus(null);
                return;
              }

              const sourceStatus = event.dataTransfer.getData("text/project-management-document-status")
                || activeDraggedDocument?.status;
              if (sourceStatus === lane.status) {
                setDropTargetStatus(null);
                setDraggedDocumentId(null);
                draggedDocumentRef.current = null;
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
              {lane.documents.length ? lane.documents.map((entry) => {
                const runningJobForCard = runningDocumentAiJobByDocumentId.get(entry.id)
                  ?? (documentRunJob?.status === "running" && documentRunJob.documentId === entry.id ? documentRunJob : null);
                const aiRunningForCard = Boolean(runningJobForCard);

                return (
                  <div
                    key={`${lane.status}:${entry.id}`}
                    draggable={!saving && movingDocumentId !== entry.id}
                    className={`border px-3 py-3 ${document?.id === entry.id ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
                    onDragStart={(event) => {
                      draggedDocumentRef.current = entry;
                      setDraggedDocumentId(entry.id);
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", entry.id);
                      event.dataTransfer.setData("text/project-management-document-id", entry.id);
                      event.dataTransfer.setData("text/project-management-document-status", entry.status);
                    }}
                    onDragEnd={() => {
                      draggedDocumentRef.current = null;
                      setDraggedDocumentId(null);
                      setDropTargetStatus(null);
                    }}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        <input
                          type="checkbox"
                          className="mt-1 h-4 w-4"
                          checked={selectedDocumentIds.includes(entry.id)}
                          onChange={() => toggleDocumentSelection(entry.id)}
                          aria-label={`Select ${entry.title}`}
                          disabled={saving}
                        />
                        <button
                          type="button"
                          className="min-w-0 flex-1 text-left"
                          onClick={() => void onSelectDocument(entry.id)}
                        >
                          <p className="min-w-0 truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                          <p className="mt-1 text-xs font-semibold theme-text-muted">#{entry.number}</p>
                          <p className="mt-1 text-xs theme-text-muted">{entry.assignee || "Unassigned"}</p>
                        </button>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        <div className="flex items-center gap-1">
                          {movingDocumentId === entry.id ? <MatrixBadge tone="active" compact>moving</MatrixBadge> : null}
                          {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                          {aiRunningForCard ? <MatrixBadge tone="warning" compact>AI running</MatrixBadge> : null}
                        </div>
                        <button
                          type="button"
                          className="matrix-button rounded-none px-2 py-1 text-xs"
                          disabled={!smartAiReady || saving || startingAiDocumentId === entry.id || aiRunningForCard}
                          onClick={() => void handleStartDocumentAi(entry)}
                          title={runningJobForCard ? `AI is already running in ${runningJobForCard.branch}` : "Start AI"}
                        >
                          {aiRunningForCard ? "AI running" : startingAiDocumentId === entry.id ? "Starting AI..." : "Start AI"}
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1">
                      {entry.tags.slice(0, 2).map((tag) => <MatrixBadge key={`${entry.id}:${tag}`} tone="active" compact>{tag}</MatrixBadge>)}
                    </div>
                  </div>
                );
              }) : (
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
