import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type {
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { marked } from "marked";
import { MatrixBadge, MatrixDetailField, MatrixTabButton } from "./matrix-primitives";

const ProjectManagementBoardTab = lazy(async () => {
  const module = await import("./project-management-board-tab");
  return { default: module.ProjectManagementBoardTab };
});

const ProjectManagementHistoryTab = lazy(async () => {
  const module = await import("./project-management-history-tab");
  return { default: module.ProjectManagementHistoryTab };
});

const ProjectManagementCreateTab = lazy(async () => {
  const module = await import("./project-management-create-tab");
  return { default: module.ProjectManagementCreateTab };
});

const ProjectManagementWysiwyg = lazy(async () => {
  const module = await import("./project-management-wysiwyg");
  return { default: module.ProjectManagementWysiwyg };
});

const ProjectManagementMonacoEditor = lazy(async () => {
  const module = await import("./project-management-monaco-editor");
  return { default: module.ProjectManagementMonacoEditor };
});

export type ProjectManagementSubTab = "document" | "board" | "history" | "create";

interface ProjectManagementPanelProps {
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  availableStatuses: string[];
  activeSubTab: ProjectManagementSubTab;
  selectedDocumentId: string | null;
  document: ProjectManagementDocument | null;
  history: ProjectManagementHistoryEntry[];
  loading: boolean;
  saving: boolean;
  onSubTabChange: (tab: ProjectManagementSubTab) => void;
  onRefresh: (options?: { silent?: boolean }) => Promise<unknown>;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateDocument: (payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDocument: (documentId: string, payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function ProjectManagementPanel({
  documents,
  availableTags,
  availableStatuses,
  activeSubTab,
  selectedDocumentId,
  document,
  history,
  loading,
  saving,
  onSubTabChange,
  onRefresh,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
}: ProjectManagementPanelProps) {
  const statuses = availableStatuses.length ? availableStatuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES];
  const [documentViewMode, setDocumentViewMode] = useState<"document" | "edit">("document");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("");
  const [selectedAssigneeFilter, setSelectedAssigneeFilter] = useState<string>("");
  const [archiveFilter, setArchiveFilter] = useState<"active" | "archived" | "all">("active");
  const [showBacklogLane, setShowBacklogLane] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftStatus, setDraftStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [draftAssignee, setDraftAssignee] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [useMonacoEditor, setUseMonacoEditor] = useState(false);
  const [newTitle, setNewTitle] = useState("Project Outline");
  const [newTags, setNewTags] = useState("plan");
  const [newMarkdown, setNewMarkdown] = useState("# Project Outline\n");
  const [newStatus, setNewStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [newAssignee, setNewAssignee] = useState("");

  useEffect(() => {
    if (!document) {
      setDraftTitle("");
      setDraftMarkdown("");
      setDraftTags("");
      setDraftStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
      setDraftAssignee("");
      setDocumentViewMode("document");
      return;
    }

    setDraftTitle(document.title);
    setDraftMarkdown(document.markdown);
    setDraftTags(document.tags.join(", "));
    setDraftStatus(document.status);
    setDraftAssignee(document.assignee);
    setDocumentViewMode("document");
  }, [document]);

  const availableAssignees = useMemo(
    () => Array.from(new Set(documents.map((entry) => entry.assignee).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [documents],
  );

  const sortedDocuments = useMemo(
    () => [...documents].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [documents],
  );

  const filteredDocuments = useMemo(
    () => sortedDocuments.filter((entry) => {
      if (selectedTag && !entry.tags.includes(selectedTag)) {
        return false;
      }

      if (selectedStatusFilter && entry.status !== selectedStatusFilter) {
        return false;
      }

      if (selectedAssigneeFilter && entry.assignee !== selectedAssigneeFilter) {
        return false;
      }

      if (archiveFilter === "active" && entry.archived) {
        return false;
      }

      if (archiveFilter === "archived" && !entry.archived) {
        return false;
      }

      return true;
    }),
    [archiveFilter, selectedAssigneeFilter, selectedStatusFilter, selectedTag, sortedDocuments],
  );

  const laneStatuses = useMemo(
    () => statuses.filter((status) => status !== "reference" && (showBacklogLane || status !== "backlog")),
    [showBacklogLane, statuses],
  );

  const swimlaneDocuments = useMemo(
    () => laneStatuses.map((status) => ({
      status,
      documents: filteredDocuments.filter((entry) => entry.status === status),
    })),
    [filteredDocuments, laneStatuses],
  );

  const renderedMarkdown = useMemo(
    () => marked.parse(draftMarkdown || document?.markdown || ""),
    [document?.markdown, draftMarkdown],
  );

  const compactDocumentSummary = document
    ? [
      `#${document.number}`,
      document.status,
      document.assignee || "Unassigned",
      document.archived ? "Archived" : "Active",
      `${document.tags.length} tag${document.tags.length === 1 ? "" : "s"}`,
    ]
    : [];

  const emptyStateMessage = activeSubTab === "document"
    ? "Select a document from the left rail to inspect its markdown, tags, and history."
    : activeSubTab === "board"
      ? "No documents are available for the current filters."
      : activeSubTab === "history"
        ? "Select a document to inspect its timeline."
        : "Create a document to start outlining the project.";

  useEffect(() => {
    if (documents.length === 0 || document || selectedDocumentId) {
      return;
    }

    void onSelectDocument(documents[0].id, { silent: true });
  }, [document, documents, onSelectDocument, selectedDocumentId]);

  async function handleSelectDocument(documentId: string, options?: { silent?: boolean }) {
    onSubTabChange("document");
    setDocumentViewMode("document");
    return onSelectDocument(documentId, options);
  }

  async function handleCreateDocument() {
    const created = await onCreateDocument({
      title: newTitle,
      markdown: newMarkdown,
      tags: parseTags(newTags),
      status: newStatus,
      assignee: newAssignee,
    });
    if (!created) {
      return;
    }

    setNewTitle("");
    setNewTags("");
    setNewMarkdown("# New document\n");
    setNewStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
    setNewAssignee("");
    await handleSelectDocument(created.id, { silent: true });
  }

  async function handleMoveDocument(documentId: string, nextStatus: string) {
    const targetDocument = document?.id === documentId
      ? document
      : await onSelectDocument(documentId, { silent: true });

    if (!targetDocument || targetDocument.status === nextStatus) {
      return;
    }

    await onUpdateDocument(documentId, {
      title: targetDocument.title,
      markdown: targetDocument.markdown,
      tags: targetDocument.tags,
      status: nextStatus,
      assignee: targetDocument.assignee,
      archived: targetDocument.archived,
    });
  }

  const documentRail = (
    <div className="theme-inline-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="matrix-kicker">Project management</p>
          <h2 className="mt-1 text-xl font-semibold theme-text-strong">Documents</h2>
        </div>
        <button
          type="button"
          className="matrix-button rounded-none px-3 py-2 text-sm"
          onClick={() => void onRefresh()}
          disabled={loading || saving}
        >
          Refresh
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`matrix-button rounded-none px-3 py-1.5 text-xs ${selectedTag === "" ? "theme-pill-emphasis theme-text-strong" : ""}`}
          onClick={() => setSelectedTag("")}
        >
          All tags
        </button>
        {availableTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`matrix-button rounded-none px-3 py-1.5 text-xs ${selectedTag === tag ? "theme-pill-emphasis theme-text-strong" : ""}`}
            onClick={() => setSelectedTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-2">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
          <select
            value={selectedStatusFilter}
            onChange={(event) => setSelectedStatusFilter(event.target.value)}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          >
            <option value="">All statuses</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <select
            value={selectedAssigneeFilter}
            onChange={(event) => setSelectedAssigneeFilter(event.target.value)}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          >
            <option value="">All assignees</option>
            {availableAssignees.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["active", "archived", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`matrix-button rounded-none px-3 py-1.5 text-xs ${archiveFilter === value ? "theme-pill-emphasis theme-text-strong" : ""}`}
              onClick={() => setArchiveFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 space-y-2">
        {filteredDocuments.length ? filteredDocuments.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`w-full border px-3 py-2 text-left transition-colors ${document?.id === entry.id ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
            onClick={() => void handleSelectDocument(entry.id)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                <p className="mt-1 text-xs font-semibold theme-text-strong">#{entry.number}</p>
                <p className="mt-1 text-[11px] theme-text-muted">{entry.status} - {entry.assignee || "Unassigned"}</p>
              </div>
              <MatrixBadge tone={entry.archived ? "warning" : "neutral"} compact>
                {entry.archived ? "archived" : entry.historyCount}
              </MatrixBadge>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {entry.tags.slice(0, 3).map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
            </div>
          </button>
        )) : (
          <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
            No documents match the current filters.
          </div>
        )}
      </div>

      <button
        type="button"
        className="mt-4 w-full matrix-button rounded-none px-3 py-2 text-sm font-semibold"
        onClick={() => onSubTabChange("create")}
      >
        New document
        </button>
    </div>
  );

  return (
    <div className="mt-4 space-y-4">
      <div className="theme-inline-panel p-4">
        <div className="flex items-center justify-between gap-3 border-b theme-border-subtle pb-4">
          <div>
            <p className="matrix-kicker">Project management</p>
            <h2 className="mt-2 text-2xl font-semibold theme-text-strong">Workspace</h2>
          </div>
          {activeSubTab !== "document" ? (
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              onClick={() => void onRefresh()}
              disabled={loading || saving}
            >
              Refresh
            </button>
          ) : null}
        </div>

        <div className="theme-inline-panel p-4">
          <div className="flex flex-wrap gap-2 border-b theme-border-subtle pb-4">
            <MatrixTabButton active={activeSubTab === "document"} label="Document" onClick={() => onSubTabChange("document")} />
            <MatrixTabButton active={activeSubTab === "board"} label="Board" onClick={() => onSubTabChange("board")} />
            <MatrixTabButton active={activeSubTab === "history"} label="History" onClick={() => onSubTabChange("history")} />
            <MatrixTabButton active={activeSubTab === "create"} label="Create" onClick={() => onSubTabChange("create")} />
          </div>

          {activeSubTab === "document" ? (
            <div className="grid gap-4 pt-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
              {documentRail}
              <div>
          <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="matrix-kicker">Markdown document</p>
              <h2 className="mt-1 text-2xl font-semibold theme-text-strong">{document?.title ?? "Select a document"}</h2>
              {document ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {compactDocumentSummary.map((item) => <MatrixBadge key={item} tone="neutral" compact>{item}</MatrixBadge>)}
                  {document.tags.map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
                </div>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              {document ? (
                <div className="flex flex-wrap gap-2">
                  <MatrixTabButton active={documentViewMode === "document"} label="Document" onClick={() => setDocumentViewMode("document")} />
                  <MatrixTabButton active={documentViewMode === "edit"} label="Edit" onClick={() => setDocumentViewMode("edit")} />
                </div>
              ) : null}
              {documentViewMode === "edit" ? (
                <button
                  type="button"
                  className={`matrix-button rounded-none px-3 py-2 text-sm ${useMonacoEditor ? "theme-pill-emphasis theme-text-strong" : ""}`}
                  onClick={() => setUseMonacoEditor((current) => !current)}
                >
                  {useMonacoEditor ? "Use WYSIWYG" : "Use Monaco"}
                </button>
              ) : null}
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                disabled={!document || saving || documentViewMode !== "edit"}
                onClick={() => document ? void onUpdateDocument(document.id, {
                  title: draftTitle,
                  markdown: draftMarkdown,
                  tags: parseTags(draftTags),
                  status: draftStatus,
                  assignee: draftAssignee,
                  archived: document.archived,
                }) : undefined}
              >
                Save document
              </button>
            </div>
          </div>

          {document && documentViewMode === "edit" ? (
            <div className="mt-3 grid gap-3 xl:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="space-y-2 border theme-border-subtle p-3">
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="Document title"
                  className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                />
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  placeholder="bug, feature, plan"
                  className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                />
                <div className="grid gap-3 md:grid-cols-2">
                  <select
                    value={draftStatus}
                    onChange={(event) => setDraftStatus(event.target.value)}
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  >
                    {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                  <input
                    value={draftAssignee}
                    onChange={(event) => setDraftAssignee(event.target.value)}
                    placeholder="Assignee"
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    disabled={saving}
                    onClick={() => void onUpdateDocument(document.id, {
                      title: draftTitle,
                      markdown: draftMarkdown,
                      tags: parseTags(draftTags),
                      status: draftStatus,
                      assignee: draftAssignee,
                      archived: !document.archived,
                    })}
                  >
                    {document.archived ? "Restore" : "Archive"}
                  </button>
                  {document.archived ? <MatrixBadge tone="warning">Archived</MatrixBadge> : null}
                </div>
              </div>
              <div className="overflow-hidden border theme-border-subtle">
                  <Suspense fallback={<div className="px-4 py-6 text-sm theme-empty-note">Loading editor...</div>}>
                    {useMonacoEditor ? (
                      <ProjectManagementMonacoEditor value={draftMarkdown} onChange={setDraftMarkdown} height="68vh" />
                    ) : (
                      <ProjectManagementWysiwyg value={draftMarkdown} onChange={setDraftMarkdown} height="68vh" />
                    )}
                  </Suspense>
              </div>
            </div>
          ) : document ? (
            <div className="mt-3 border theme-border-subtle p-4">
                <div
                  className="pm-markdown text-sm theme-text"
                  dangerouslySetInnerHTML={{ __html: marked.parse(document.markdown) }}
                />
            </div>
          ) : (
            <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              {emptyStateMessage}
            </div>
          )}
              </div>
            </div>
          ) : activeSubTab === "board" ? (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading board...</div>}>
                <ProjectManagementBoardTab
                  swimlaneDocuments={swimlaneDocuments}
                  document={document}
                  showBacklogLane={showBacklogLane}
                  saving={saving}
                  onToggleBacklogLane={() => setShowBacklogLane((current) => !current)}
                  onSelectDocument={handleSelectDocument}
                  onMoveDocument={handleMoveDocument}
                />
              </Suspense>
            </div>
          ) : activeSubTab === "history" ? (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading history...</div>}>
                <ProjectManagementHistoryTab history={history} />
              </Suspense>
            </div>
          ) : (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading create form...</div>}>
                <ProjectManagementCreateTab
                  statuses={statuses}
                  saving={saving}
                  newTitle={newTitle}
                  newTags={newTags}
                  newMarkdown={newMarkdown}
                  newStatus={newStatus}
                  newAssignee={newAssignee}
                  onNewTitleChange={setNewTitle}
                  onNewTagsChange={setNewTags}
                  onNewMarkdownChange={setNewMarkdown}
                  onNewStatusChange={setNewStatus}
                  onNewAssigneeChange={setNewAssignee}
                  onCreate={handleCreateDocument}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
