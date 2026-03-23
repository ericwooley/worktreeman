import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type {
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandJob,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { marked } from "marked";
import { MatrixBadge, MatrixModal, MatrixTabButton } from "./matrix-primitives";

const ProjectManagementBoardTab = lazy(async () => {
  const module = await import("./project-management-board-tab");
  return { default: module.ProjectManagementBoardTab };
});

const ProjectManagementDependencyTreeTab = lazy(async () => {
  const module = await import("./project-management-dependency-tree-tab");
  return { default: module.ProjectManagementDependencyTreeTab };
});

const ProjectManagementHistoryTab = lazy(async () => {
  const module = await import("./project-management-history-tab");
  return { default: module.ProjectManagementHistoryTab };
});

const ProjectManagementCreateTab = lazy(async () => {
  const module = await import("./project-management-create-tab");
  return { default: module.ProjectManagementCreateTab };
});

const ProjectManagementAiLogTab = lazy(async () => {
  const module = await import("./project-management-ai-log-tab");
  return { default: module.ProjectManagementAiLogTab };
});

const ProjectManagementWysiwyg = lazy(async () => {
  const module = await import("./project-management-wysiwyg");
  return { default: module.ProjectManagementWysiwyg };
});

const ProjectManagementMonacoEditor = lazy(async () => {
  const module = await import("./project-management-monaco-editor");
  return { default: module.ProjectManagementMonacoEditor };
});

export type ProjectManagementSubTab = "document" | "board" | "dependency-tree" | "history" | "create" | "ai-log";

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
  aiCommandConfigured: boolean;
  aiJob: AiCommandJob | null;
  aiLogs: AiCommandLogSummary[];
  aiLogDetail: AiCommandLogEntry | null;
  aiLogsLoading: boolean;
  runningAiJobs: AiCommandJob[];
  selectedWorktreeBranch: string | null;
  onSubTabChange: (tab: ProjectManagementSubTab) => void;
  onRefresh: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadAiLogs: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadAiLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateDocument: (payload: {
    title: string;
    markdown: string;
    tags: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDocument: (documentId: string, payload: {
    title: string;
    markdown: string;
    tags: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocument | null>;
  onRunAiCommand: (payload: { input: string; documentId: string }) => Promise<AiCommandJob | null>;
  onCancelAiCommand: () => Promise<AiCommandJob | null>;
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
  aiCommandConfigured,
  aiJob,
  aiLogs,
  aiLogDetail,
  aiLogsLoading,
  runningAiJobs,
  selectedWorktreeBranch,
  onSubTabChange,
  onRefresh,
  onLoadAiLogs,
  onLoadAiLog,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
  onUpdateDependencies,
  onRunAiCommand,
  onCancelAiCommand,
}: ProjectManagementPanelProps) {
  const statuses = availableStatuses.length ? availableStatuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES];
  const [documentViewMode, setDocumentViewMode] = useState<"document" | "edit">("document");
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState<string>("");
  const [selectedAssigneeFilter, setSelectedAssigneeFilter] = useState<string>("");
  const [archiveFilter, setArchiveFilter] = useState<"active" | "archived" | "all">("active");
  const [showBacklogLane, setShowBacklogLane] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editMarkdown, setEditMarkdown] = useState("");
  const [editTags, setEditTags] = useState("");
  const [dependencySelection, setDependencySelection] = useState<string[]>([]);
  const [editStatus, setEditStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [editAssignee, setEditAssignee] = useState("");
  const [useMonacoEditor, setUseMonacoEditor] = useState(false);
  const [newTitle, setNewTitle] = useState("Project Outline");
  const [newTags, setNewTags] = useState("plan");
  const [newMarkdown, setNewMarkdown] = useState("# Project Outline\n");
  const [newStatus, setNewStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [newAssignee, setNewAssignee] = useState("");
  const [aiRunSummary, setAiRunSummary] = useState<string | null>(null);
  const [aiChangeRequest, setAiChangeRequest] = useState("");
  const [aiFailureToast, setAiFailureToast] = useState<string | null>(null);
  const [aiRequestModalOpen, setAiRequestModalOpen] = useState(false);
  const aiRunning = aiJob?.status === "running";

  useEffect(() => {
    if (!document) {
      setEditTitle("");
      setEditMarkdown("");
      setEditTags("");
      setDependencySelection([]);
      setEditStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
      setEditAssignee("");
      setDocumentViewMode("document");
      setAiChangeRequest("");
      return;
    }

    setEditTitle(document.title);
    setEditMarkdown(document.markdown);
    setEditTags(document.tags.join(", "));
    setDependencySelection(Array.isArray(document.dependencies) ? document.dependencies : []);
    setEditStatus(document.status);
    setEditAssignee(document.assignee);
    setDocumentViewMode("document");
    setAiFailureToast(null);
    setAiRequestModalOpen(false);
  }, [document]);

  useEffect(() => {
    if (!aiJob) {
      return;
    }

    if (aiJob.status === "completed") {
      setAiRunSummary(`AI updated the saved document on ${aiJob.branch}. Use history to roll back if needed.`);
      setAiChangeRequest("");
      setAiRequestModalOpen(false);
      if (document && aiJob.documentId === document.id) {
        void onSelectDocument(document.id, { silent: true });
      }
      return;
    }

    if (aiJob.status === "failed") {
      setAiRunSummary(null);
      setAiFailureToast(aiJob.error || aiJob.stderr || "⚡ request failed. Check the AI logs for details.");
    }
  }, [aiJob]);

  useEffect(() => {
    if (!aiFailureToast) {
      return;
    }

    const timeout = window.setTimeout(() => setAiFailureToast(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [aiFailureToast]);

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
    () => marked.parse(editMarkdown || document?.markdown || ""),
    [document?.markdown, editMarkdown],
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
      dependencies: [],
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
      dependencies: targetDocument.dependencies,
      status: nextStatus,
      assignee: targetDocument.assignee,
      archived: targetDocument.archived,
    });
  }

  const dependencyOptions = useMemo(
    () => documents
      .filter((entry) => entry.id !== document?.id)
      .sort((left, right) => left.number - right.number),
    [document?.id, documents],
  );

  async function handleDependencySelectionToggle(dependencyId: string) {
    if (!document || aiRunning) {
      return;
    }

    const nextDependencies = dependencySelection.includes(dependencyId)
      ? dependencySelection.filter((entry) => entry !== dependencyId)
      : [...dependencySelection, dependencyId];

    const updated = await onUpdateDependencies(document.id, nextDependencies);
    if (updated) {
      setDependencySelection(updated.dependencies);
    }
  }

  async function handleRunUiMagic() {
    if (!document) {
      setAiFailureToast("Select a document before running \u26a1.");
      return false;
    }

    if (!selectedWorktreeBranch) {
      setAiFailureToast("Select a worktree before running \u26a1.");
      return false;
    }

    if (!aiCommandConfigured) {
      setAiFailureToast("Configure an AI Command with $WTM_AI_INPUT in settings first.");
      return false;
    }

    if (aiRunning) {
      setAiFailureToast("\u26a1 is already running for this worktree.");
      return false;
    }

    const requestedChange = aiChangeRequest.trim();
    if (!requestedChange) {
      setAiFailureToast("Tell \u26a1 what to change before running it.");
      return false;
    }

    setAiRunSummary(null);
    setAiFailureToast(null);

    const job = await onRunAiCommand({ input: requestedChange, documentId: document.id });
    if (!job) {
      setAiFailureToast("\u26a1 request failed. Check the AI command output for details.");
      return false;
    }

    setAiRunSummary(`AI started for ${job.branch}. The saved document will update on the server when it finishes.`);
    setAiRequestModalOpen(false);
    return true;
  }

  useEffect(() => {
    if (activeSubTab !== "ai-log") {
      return;
    }

    void onLoadAiLogs({ silent: true });
  }, [activeSubTab, onLoadAiLogs]);

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
            <MatrixTabButton active={activeSubTab === "dependency-tree"} label="Dependency tree" onClick={() => onSubTabChange("dependency-tree")} />
            <MatrixTabButton active={activeSubTab === "history"} label="History" onClick={() => onSubTabChange("history")} />
            <MatrixTabButton active={activeSubTab === "ai-log"} label="AI Log" onClick={() => onSubTabChange("ai-log")} />
            <MatrixTabButton active={activeSubTab === "create"} label="Create" onClick={() => onSubTabChange("create")} />
          </div>

          {activeSubTab === "document" ? (
            <div className="grid gap-4 pt-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
              {documentRail}
              <div>
          {aiFailureToast ? (
            <div className="pm-inline-toast mb-3 flex items-center justify-between gap-3 border px-3 py-2 text-sm">
              <span>{aiFailureToast}</span>
              <button
                type="button"
                className="matrix-button rounded-none px-2 py-1 text-xs"
                onClick={() => setAiFailureToast(null)}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="flex flex-col gap-2 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="matrix-kicker">Markdown document</p>
              <h2 className="mt-1 text-2xl font-semibold theme-text-strong">{document?.title ?? "Select a document"}</h2>
              {document ? (
                <div className="mt-2 flex flex-wrap gap-1">
                  {compactDocumentSummary.map((item) => <MatrixBadge key={item} tone="neutral" compact>{item}</MatrixBadge>)}
                  {document.tags.map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
                  <MatrixBadge tone="neutral" compact>
                    {document.dependencies.length} dependenc{document.dependencies.length === 1 ? "y" : "ies"}
                  </MatrixBadge>
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
                  disabled={aiRunning}
                >
                  {useMonacoEditor ? "Use WYSIWYG" : "Use Monaco"}
                </button>
              ) : null}
              {documentViewMode === "edit" ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`matrix-button rounded-none px-3 py-2 text-sm font-semibold ${aiRunning ? "pm-ai-button-running" : ""}`}
                    onClick={() => setAiRequestModalOpen(true)}
                    title={aiRunning ? "\u26a1 is running" : "Open AI request"}
                    disabled={!document || aiRunning}
                  >
                    {aiRunning ? "⚡ Running..." : "⚡ AI"}
                  </button>
                  {aiRunning ? (
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      onClick={() => void onCancelAiCommand()}
                    >
                      Cancel AI
                    </button>
                  ) : null}
                </div>
              ) : null}
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                disabled={!document || saving || aiRunning || documentViewMode !== "edit"}
                onClick={() => document ? void onUpdateDocument(document.id, {
                  title: editTitle,
                  markdown: editMarkdown,
                  tags: parseTags(editTags),
                  dependencies: document.dependencies,
                  status: editStatus,
                  assignee: editAssignee,
                  archived: document.archived,
                }) : undefined}
              >
                Save document
              </button>
            </div>
          </div>

          {document ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {!aiCommandConfigured ? <MatrixBadge tone="warning">Configure AI Command in settings</MatrixBadge> : null}
               {aiRunning ? <MatrixBadge tone="warning">Document editing locked while AI updates the saved document</MatrixBadge> : null}
               {aiRunSummary ? <MatrixBadge tone="active">{aiRunSummary}</MatrixBadge> : null}
            </div>
          ) : null}

          {document && documentViewMode === "edit" ? (
            <div className="mt-3 grid gap-3 xl:grid-cols-[18rem_minmax(0,1fr)]">
              <div className="space-y-2 border theme-border-subtle p-3">
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Title</span>
                  <input
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    placeholder="Document title"
                    disabled={aiRunning}
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                </label>
                <label className="block space-y-1">
                  <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Tags</span>
                  <input
                    value={editTags}
                    onChange={(event) => setEditTags(event.target.value)}
                    placeholder="bug, feature, plan"
                    disabled={aiRunning}
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                </label>
                <div className="grid gap-3 md:grid-cols-2">
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Status</span>
                    <select
                      value={editStatus}
                      onChange={(event) => setEditStatus(event.target.value)}
                      disabled={aiRunning}
                      className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                    >
                      {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Assignee</span>
                    <input
                      value={editAssignee}
                      onChange={(event) => setEditAssignee(event.target.value)}
                      placeholder="Assignee"
                      disabled={aiRunning}
                      className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                    />
                  </label>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    disabled={saving || aiRunning}
                    onClick={() => void onUpdateDocument(document.id, {
                        title: editTitle,
                        markdown: editMarkdown,
                        tags: parseTags(editTags),
                        dependencies: document.dependencies,
                        status: editStatus,
                        assignee: editAssignee,
                        archived: !document.archived,
                     })}
                  >
                    {document.archived ? "Restore" : "Archive"}
                  </button>
                  {document.archived ? <MatrixBadge tone="warning">Archived</MatrixBadge> : null}
                </div>
              </div>
              <div className="overflow-hidden border theme-border-subtle">
                {aiRunning ? (
                  <div className="pm-ai-running-state flex h-[68vh] flex-col items-center justify-center gap-4 px-6 text-center">
                    <div className="pm-ai-spinner" aria-hidden="true" />
                    <div>
                      <p className="text-lg font-semibold theme-text-strong">AI Running</p>
                      <p className="mt-2 text-sm theme-text-muted">
                        The saved document is being updated on the server. You can leave this view and come back later.
                      </p>
                      <button
                        type="button"
                        className="matrix-button mt-4 rounded-none px-3 py-2 text-sm"
                        onClick={() => void onCancelAiCommand()}
                      >
                        Cancel AI job
                      </button>
                    </div>
                  </div>
                ) : (
                  <Suspense fallback={<div className="px-4 py-6 text-sm theme-empty-note">Loading editor...</div>}>
                    {useMonacoEditor ? (
                      <ProjectManagementMonacoEditor value={editMarkdown} onChange={setEditMarkdown} height="68vh" readOnly={aiRunning} />
                    ) : (
                      <ProjectManagementWysiwyg value={editMarkdown} onChange={setEditMarkdown} height="68vh" readOnly={aiRunning} />
                    )}
                  </Suspense>
                )}
              </div>
            </div>
          ) : document ? (
            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="border theme-border-subtle p-4">
                <div
                  className="pm-markdown text-sm theme-text"
                  dangerouslySetInnerHTML={{ __html: marked.parse(document.markdown) }}
                />
              </div>
              <div className="border theme-border-subtle p-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Dependencies</p>
                    <p className="mt-1 text-sm theme-text-muted">Pick prerequisite documents without opening the graph.</p>
                  </div>
                  <button
                    type="button"
                    className="matrix-button rounded-none px-2 py-1 text-xs"
                    onClick={() => onSubTabChange("dependency-tree")}
                  >
                    Open graph
                  </button>
                </div>
                <div className="mt-3 space-y-2 max-h-[28rem] overflow-y-auto pr-1">
                  {dependencyOptions.length ? dependencyOptions.map((entry) => {
                    const checked = dependencySelection.includes(entry.id);
                    return (
                      <label
                        key={entry.id}
                        className={`flex cursor-pointer items-start gap-3 border px-3 py-2 text-left ${checked ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
                      >
                        <input
                            type="checkbox"
                            className="mt-1"
                            checked={checked}
                            disabled={saving || aiRunning}
                            onChange={() => void handleDependencySelectionToggle(entry.id)}
                          />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold theme-text-strong">{entry.title}</span>
                          <span className="mt-1 block text-xs theme-text-muted">#{entry.number} - {entry.status}</span>
                        </span>
                      </label>
                    );
                  }) : (
                    <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                      No other documents are available.
                    </div>
                  )}
                </div>
              </div>
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
          ) : activeSubTab === "dependency-tree" ? (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading dependency tree...</div>}>
                <ProjectManagementDependencyTreeTab
                  documents={filteredDocuments}
                  selectedDocumentId={selectedDocumentId}
                  saving={saving}
                  onSelectDocument={handleSelectDocument}
                  onUpdateDependencies={onUpdateDependencies}
                />
              </Suspense>
            </div>
          ) : activeSubTab === "history" ? (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading history...</div>}>
                <ProjectManagementHistoryTab history={history} />
              </Suspense>
            </div>
          ) : activeSubTab === "ai-log" ? (
            <div className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading AI logs...</div>}>
                <ProjectManagementAiLogTab
                  logs={aiLogs}
                  logDetail={aiLogDetail}
                  loading={aiLogsLoading}
                  runningJobs={runningAiJobs}
                  onRefresh={onLoadAiLogs}
                  onSelectLog={onLoadAiLog}
                  onCancelJob={onCancelAiCommand}
                />
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

      {aiRequestModalOpen && document && documentViewMode === "edit" ? (
        <MatrixModal
          kicker="AI request"
          title={<>Update `{document.title}`</>}
          description="Describe the change you want, then run AI to update the saved document on the server for this worktree."
          closeLabel="Close AI request"
          maxWidthClass="max-w-2xl"
          onClose={() => setAiRequestModalOpen(false)}
          footer={(
            <button
              type="submit"
              form="pm-ai-request-form"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={aiRunning}
            >
              {aiRunning ? "\u26a1 Running..." : "Run \u26a1"}
            </button>
          )}
        >
          <form
            id="pm-ai-request-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRunUiMagic();
            }}
          >
            <div>
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">What should change?</span>
                <textarea
                  value={aiChangeRequest}
                  onChange={(event) => setAiChangeRequest(event.target.value)}
                  placeholder="Example: tighten this into a runnable implementation checklist, call out blocked steps, and turn vague notes into concrete tasks."
                  disabled={aiRunning}
                  rows={10}
                  autoFocus
                  className="matrix-input min-h-[16rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                />
              </label>
            </div>
          </form>
        </MatrixModal>
      ) : null}
    </div>
  );
}
