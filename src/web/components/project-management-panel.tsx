import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandJob,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  RunAiCommandResponse,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { marked } from "marked";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import {
  ProjectManagementDocumentForm,
  type ProjectManagementDocumentFormEditorMode,
} from "./project-management-document-form";
import {
  ProjectManagementDocumentBrowser,
  formatDocumentTimestamp,
  useProjectManagementDocumentBrowserState,
} from "./project-management-document-browser";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
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

const ProjectManagementAiLogTab = lazy(async () => {
  const module = await import("./project-management-ai-log-tab");
  return { default: module.ProjectManagementAiLogTab };
});

export type ProjectManagementSubTab = "document" | "board" | "dependency-tree" | "history" | "create" | "ai-log";
export type ProjectManagementDocumentViewMode = "document" | "edit";

interface ProjectManagementPanelProps {
  documents: ProjectManagementDocumentSummary[];
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
  aiLogs: AiCommandLogSummary[];
  aiLogDetail: AiCommandLogEntry | null;
  aiLogsLoading: boolean;
  runningAiJobs: AiCommandJob[];
  selectedWorktreeBranch: string | null;
  onSubTabChange: (tab: ProjectManagementSubTab) => void;
  onDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
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
  onRunAiCommand: (payload: { input: string; documentId: string; commandId: AiCommandId }) => Promise<AiCommandJob | null>;
  onRunDocumentAi: (payload: { documentId: string; input?: string; commandId: AiCommandId }) => Promise<RunAiCommandResponse | null>;
  onCancelDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onCancelAiCommand: () => Promise<AiCommandJob | null>;
}

function getAiCommandLabel(commandId: AiCommandId): string {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

function isAiCommandReady(aiCommands: AiCommandConfig | null, commandId: AiCommandId): boolean {
  return Boolean(aiCommands?.[commandId]?.includes("$WTM_AI_INPUT"));
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function getAiJobTone(status: AiCommandJob["status"]) {
  if (status === "running") {
    return "warning" as const;
  }

  if (status === "failed") {
    return "danger" as const;
  }

  return "active" as const;
}

function getAiOutputText(job: AiCommandJob): string {
  if (job.stdout && job.stderr) {
    return `${job.stdout}\n\n--- stderr ---\n${job.stderr}`;
  }

  if (job.stdout) {
    return job.stdout;
  }

  if (job.stderr) {
    return job.stderr;
  }

  return job.status === "running" ? "Waiting for live output..." : "No output captured.";
}

interface ProjectManagementAiOutputViewerProps {
  source: "worktree" | "document";
  job: AiCommandJob;
  summary: string | null;
  expanded?: boolean;
  onCancel: () => void;
  onOpenModal?: () => void;
}

function ProjectManagementAiOutputViewer({
  source,
  job,
  summary,
  expanded = false,
  onCancel,
  onOpenModal,
}: ProjectManagementAiOutputViewerProps) {
  const running = job.status === "running";
  const title = source === "worktree" ? "Worktree AI" : "Document AI";
  const description = source === "worktree"
    ? running
      ? `Streaming live output from ${job.branch} while the worktree run is active.`
      : summary ?? `Captured output from ${job.branch}.`
    : running
      ? `Updating the saved document in ${job.branch}.`
      : summary ?? `Captured output from ${job.branch}.`;

  return (
    <div className={`pm-ai-output-shell border theme-border-subtle ${running ? "pm-ai-output-shell-running" : ""} ${expanded ? "p-5" : "p-4"}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pm-ai-live-orb ${running ? "pm-ai-live-orb-running" : ""}`} aria-hidden="true" />
            <p className="matrix-kicker">{title}</p>
            <MatrixBadge tone={getAiJobTone(job.status)} compact>{running ? "live" : job.status}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{job.branch}</MatrixBadge>
            {job.pid ? <MatrixBadge tone="neutral" compact>{`PID ${job.pid}`}</MatrixBadge> : null}
          </div>
          <h3 className={`mt-2 font-semibold theme-text-strong ${expanded ? "text-xl" : "text-lg"}`}>
            {running ? `${title} is working` : `${title} output`}
          </h3>
          <p className="mt-1 text-sm theme-text-muted">{description}</p>
          {summary ? <p className="mt-2 text-xs theme-text-soft">{summary}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              onClick={onCancel}
            >
              Cancel AI
            </button>
          ) : null}
          {onOpenModal ? (
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              onClick={onOpenModal}
            >
              Open output modal
            </button>
          ) : null}
        </div>
      </div>

      {running ? (
        <div className="pm-ai-output-activity mt-4" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}

      <pre className={`pm-ai-output-pre mt-4 overflow-auto px-4 py-4 font-mono text-xs leading-6 ${expanded ? "max-h-[65vh]" : "max-h-[24rem]"}`}>
        {getAiOutputText(job)}
      </pre>
    </div>
  );
}

export function ProjectManagementPanel({
  documents,
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
  aiLogs,
  aiLogDetail,
  aiLogsLoading,
  runningAiJobs,
  selectedWorktreeBranch,
  onSubTabChange,
  onDocumentViewModeChange,
  onRefresh,
  onLoadAiLogs,
  onLoadAiLog,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
  onUpdateDependencies,
  onRunAiCommand,
  onRunDocumentAi,
  onCancelDocumentAiCommand,
  onCancelAiCommand,
}: ProjectManagementPanelProps) {
  const statuses = availableStatuses.length ? availableStatuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES];
  const [showBacklogLane, setShowBacklogLane] = useState(false);
  const [editTitle, setEditTitle] = useState(() => document?.title ?? "");
  const [editMarkdown, setEditMarkdown] = useState(() => document?.markdown ?? "");
  const [editTags, setEditTags] = useState(() => document?.tags.join(", ") ?? "");
  const [dependencySelection, setDependencySelection] = useState<string[]>(() => Array.isArray(document?.dependencies) ? document.dependencies : []);
  const [editStatus, setEditStatus] = useState<string>(() => document?.status ?? PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [editAssignee, setEditAssignee] = useState(() => document?.assignee ?? "");
  const [editEditorMode, setEditEditorMode] = useState<ProjectManagementDocumentFormEditorMode>("wysiwyg");
  const [newTitle, setNewTitle] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newMarkdown, setNewMarkdown] = useState("");
  const [newStatus, setNewStatus] = useState<string>("");
  const [newAssignee, setNewAssignee] = useState("");
  const [createEditorMode, setCreateEditorMode] = useState<ProjectManagementDocumentFormEditorMode>("markdown");
  const [aiRunSummary, setAiRunSummary] = useState<string | null>(null);
  const [aiChangeRequest, setAiChangeRequest] = useState("");
  const [aiFailureToast, setAiFailureToast] = useState<string | null>(null);
  const [aiRequestModalOpen, setAiRequestModalOpen] = useState(false);
  const [aiOutputModalOpen, setAiOutputModalOpen] = useState(false);
  const [dependencyModalOpen, setDependencyModalOpen] = useState(false);
  const [selectedAiCommandId, setSelectedAiCommandId] = useState<AiCommandId>("simple");
  const [documentRunSummary, setDocumentRunSummary] = useState<string | null>(null);
  const [documentRunFailureToast, setDocumentRunFailureToast] = useState<string | null>(null);
  const aiRunning = aiJob?.status === "running";
  const documentRunInProgress = documentRunJob?.status === "running";
  const activeDocumentRunTargetsSelectedDocument = Boolean(document && documentRunJob?.documentId === document.id);
  const documentBrowser = useProjectManagementDocumentBrowserState(documents, statuses);
  const aiCommandOptions = useMemo<MatrixDropdownOption[]>(() => ([
    {
      value: "smart",
      label: "Smart AI",
      description: "Best quality rewrite path",
      badgeLabel: isAiCommandReady(aiCommands, "smart") ? "Ready" : "Missing",
      badgeTone: isAiCommandReady(aiCommands, "smart") ? "active" : "idle",
    },
    {
      value: "simple",
      label: "Simple AI",
      description: "Faster lightweight rewrite path",
      badgeLabel: isAiCommandReady(aiCommands, "simple") ? "Ready" : "Missing",
      badgeTone: isAiCommandReady(aiCommands, "simple") ? "active" : "idle",
    },
  ]), [aiCommands]);
  const documentEditorOptions = useMemo(
    () => [
      { value: "markdown", label: "Markdown" },
      { value: "wysiwyg", label: "WYSIWYG" },
      { value: "monaco", label: "Monaco" },
    ] satisfies Array<{ value: ProjectManagementDocumentFormEditorMode; label: string }>,
    [],
  );

  useEffect(() => {
    if (!document) {
      setEditTitle("");
      setEditMarkdown("");
      setEditTags("");
      setDependencySelection([]);
      setEditStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
      setEditAssignee("");
      setEditEditorMode("wysiwyg");
      setAiChangeRequest("");
      setSelectedAiCommandId("simple");
      setDependencyModalOpen(false);
      return;
    }

    setEditTitle(document.title);
    setEditMarkdown(document.markdown);
    setEditTags(document.tags.join(", "));
    setDependencySelection(Array.isArray(document.dependencies) ? document.dependencies : []);
    setEditStatus(document.status);
    setEditAssignee(document.assignee);
    setEditEditorMode("wysiwyg");
    setAiFailureToast(null);
    setAiRequestModalOpen(false);
    setDependencyModalOpen(false);
    setSelectedAiCommandId("simple");
    setDocumentRunFailureToast(null);
  }, [document]);

  useEffect(() => {
    if (!aiJob) {
      return;
    }

    if (aiJob.status === "completed") {
      setAiRunSummary(`${getAiCommandLabel(aiJob.commandId)} updated the saved document on ${aiJob.branch}. Use history to roll back if needed.`);
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
    if (!documentRunJob) {
      return;
    }

    if (documentRunJob.status === "completed") {
      setDocumentRunSummary(`${getAiCommandLabel(documentRunJob.commandId)} finished in ${documentRunJob.branch}.`);
      return;
    }

    if (documentRunJob.status === "failed") {
      setDocumentRunSummary(null);
      setDocumentRunFailureToast(documentRunJob.error || documentRunJob.stderr || "Worktree AI request failed. Check the AI logs for details.");
    }
  }, [documentRunJob]);

  useEffect(() => {
    if (!aiFailureToast) {
      return;
    }

    const timeout = window.setTimeout(() => setAiFailureToast(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [aiFailureToast]);

  useEffect(() => {
    if (!documentRunFailureToast) {
      return;
    }

    const timeout = window.setTimeout(() => setDocumentRunFailureToast(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [documentRunFailureToast]);

  const filteredDocuments = documentBrowser.filteredDocuments;

  const selectedDocumentAiOutput = useMemo(() => {
    if (!document) {
      return null;
    }

    const matchingWorktreeJob = documentRunJob?.documentId === document.id ? documentRunJob : null;
    const matchingDocumentJob = aiJob?.documentId === document.id ? aiJob : null;

    if (matchingWorktreeJob?.status === "running") {
      return { source: "worktree" as const, job: matchingWorktreeJob, summary: documentRunSummary };
    }

    if (matchingDocumentJob?.status === "running") {
      return { source: "document" as const, job: matchingDocumentJob, summary: aiRunSummary };
    }

    if (matchingWorktreeJob) {
      return { source: "worktree" as const, job: matchingWorktreeJob, summary: documentRunSummary };
    }

    if (matchingDocumentJob) {
      return { source: "document" as const, job: matchingDocumentJob, summary: aiRunSummary };
    }

    return null;
  }, [aiJob, aiRunSummary, document, documentRunJob, documentRunSummary]);

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

  useEffect(() => {
    if (selectedDocumentAiOutput) {
      return;
    }

    setAiOutputModalOpen(false);
  }, [selectedDocumentAiOutput]);

  async function handleSelectDocument(documentId: string, options?: { silent?: boolean }) {
    onSubTabChange("document");
    onDocumentViewModeChange("document");
    return onSelectDocument(documentId, options);
  }

  async function handleCreateDocument() {
    const created = await onCreateDocument({
      title: newTitle,
      markdown: newMarkdown,
      tags: parseTags(newTags),
      dependencies: [],
      status: newStatus || undefined,
      assignee: newAssignee || undefined,
    });
    if (!created) {
      return;
    }

    setNewTitle("");
    setNewTags("");
    setNewMarkdown("");
    setNewStatus("");
    setNewAssignee("");
    setCreateEditorMode("markdown");
    await handleSelectDocument(created.id, { silent: true });
  }

  async function handleSaveDocument() {
    if (!document) {
      return;
    }

    await onUpdateDocument(document.id, {
      title: editTitle,
      markdown: editMarkdown,
      tags: parseTags(editTags),
      dependencies: document.dependencies,
      status: editStatus,
      assignee: editAssignee,
      archived: document.archived,
    });
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
  const dependencyDocumentMap = useMemo(
    () => new Map(dependencyOptions.map((entry) => [entry.id, entry])),
    [dependencyOptions],
  );
  const currentDependencyDocuments = useMemo(
    () => dependencySelection.map((dependencyId) => dependencyDocumentMap.get(dependencyId)).filter((entry): entry is ProjectManagementDocumentSummary => Boolean(entry)),
    [dependencyDocumentMap, dependencySelection],
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

    if (!isAiCommandReady(aiCommands, selectedAiCommandId)) {
      setAiFailureToast(`Configure ${getAiCommandLabel(selectedAiCommandId)} with $WTM_AI_INPUT in settings first.`);
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

    const job = await onRunAiCommand({ input: requestedChange, documentId: document.id, commandId: selectedAiCommandId });
    if (!job) {
      setAiFailureToast(`${getAiCommandLabel(selectedAiCommandId)} request failed. Check the AI command output for details.`);
      return false;
    }

    setAiRunSummary(`${getAiCommandLabel(selectedAiCommandId)} started for ${job.branch}. The saved document will update on the server when it finishes.`);
    setAiRequestModalOpen(false);
    return true;
  }

  async function handleRunDocumentWork() {
    if (!document) {
      setDocumentRunFailureToast("Select a document before starting work.");
      return false;
    }

    if (!isAiCommandReady(aiCommands, "smart")) {
      setDocumentRunFailureToast("Configure Smart AI with $WTM_AI_INPUT in settings first.");
      return false;
    }

    if (documentRunInProgress) {
      setDocumentRunFailureToast("A document worktree AI run is already in progress.");
      return false;
    }

    setDocumentRunSummary(null);
    setDocumentRunFailureToast(null);

    const result = await onRunDocumentAi({
      documentId: document.id,
      commandId: "smart",
    });
    if (!result) {
      setDocumentRunFailureToast("Smart AI request failed. Check the AI command output for details.");
      return false;
    }

    setDocumentRunSummary(`Smart AI started in ${result.job.branch}. This worktree is now selected, its runtime is running, and live output is streaming in the work panel on the right.`);
    return true;
  }

  async function handleCancelSelectedDocumentAiOutput() {
    if (!selectedDocumentAiOutput) {
      return;
    }

    if (selectedDocumentAiOutput.source === "worktree") {
      await onCancelDocumentAiCommand(selectedDocumentAiOutput.job.branch);
      return;
    }

    await onCancelAiCommand();
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

      <ProjectManagementDocumentBrowser
        documents={documents}
        availableTags={availableTags}
        statuses={statuses}
        state={documentBrowser}
        emptyMessage="No documents match the current filters."
        renderDocument={(entry) => (
          <button
            key={entry.id}
            type="button"
            className={`pm-document-card w-full border px-3 py-3 text-left transition-colors ${document?.id === entry.id ? "pm-document-card-active theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
            onClick={() => void handleSelectDocument(entry.id)}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] theme-text-soft">#{entry.number}</p>
                  {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                </div>
                <p className="mt-2 text-sm font-semibold theme-text-strong">{entry.title}</p>
                <p className="mt-2 text-[11px] theme-text-muted">{entry.assignee || "Unassigned"}</p>
                <p className="mt-1 text-[11px] theme-text-muted">{formatDocumentTimestamp(entry.updatedAt)}</p>
              </div>
              <MatrixBadge tone={entry.archived ? "warning" : "neutral"} compact>
                {entry.archived ? "archived" : `${entry.historyCount} rev`}
              </MatrixBadge>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {entry.tags.slice(0, 2).map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
              {entry.tags.length > 2 ? <MatrixBadge tone="idle" compact>{`+${entry.tags.length - 2}`}</MatrixBadge> : null}
            </div>
          </button>
        )}
      />

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
          {documentRunFailureToast ? (
            <div className="pm-inline-toast mb-3 flex items-center justify-between gap-3 border px-3 py-2 text-sm">
              <span>{documentRunFailureToast}</span>
              <button
                type="button"
                className="matrix-button rounded-none px-2 py-1 text-xs"
                onClick={() => setDocumentRunFailureToast(null)}
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
                  <MatrixTabButton active={documentViewMode === "document"} label="Document" onClick={() => onDocumentViewModeChange("document")} />
                  <MatrixTabButton active={documentViewMode === "edit"} label="Edit" onClick={() => onDocumentViewModeChange("edit")} />
                </div>
              ) : null}
              {documentViewMode === "document" ? (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={`matrix-button rounded-none px-3 py-2 text-sm font-semibold ${documentRunInProgress ? "pm-ai-button-running" : ""}`}
                    onClick={() => void handleRunDocumentWork()}
                    title={documentRunInProgress ? "Worktree AI is running" : "Start worktree AI"}
                    disabled={!document || documentRunInProgress}
                  >
                    {documentRunInProgress ? "Start Worktree AI (running)" : "Start Worktree AI"}
                  </button>
                  {documentRunInProgress && activeDocumentRunTargetsSelectedDocument && documentRunJob?.branch ? (
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      onClick={() => void onCancelDocumentAiCommand(documentRunJob.branch)}
                    >
                      Cancel worktree AI
                    </button>
                  ) : null}
                </div>
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
                onClick={() => void handleSaveDocument()}
              >
                Save document
              </button>
            </div>
          </div>

          {document ? (
            <div className="mt-3 flex flex-wrap gap-2 text-xs">
              {!isAiCommandReady(aiCommands, "smart") ? <MatrixBadge tone="warning">Configure Smart AI in settings</MatrixBadge> : null}
              {!isAiCommandReady(aiCommands, "simple") ? <MatrixBadge tone="warning">Configure Simple AI in settings</MatrixBadge> : null}
              {aiRunning ? <MatrixBadge tone="warning">Document editing locked while AI updates the saved document</MatrixBadge> : null}
              {activeDocumentRunTargetsSelectedDocument && documentRunInProgress ? <MatrixBadge tone="warning">Document worktree AI run in progress</MatrixBadge> : null}
              {aiRunSummary ? <MatrixBadge tone="active">{aiRunSummary}</MatrixBadge> : null}
              {documentRunSummary ? <MatrixBadge tone="active">{documentRunSummary}</MatrixBadge> : null}
            </div>
          ) : null}

          {document && selectedDocumentAiOutput ? (
            <div className="mt-3">
              <ProjectManagementAiOutputViewer
                source={selectedDocumentAiOutput.source}
                job={selectedDocumentAiOutput.job}
                summary={selectedDocumentAiOutput.summary}
                onCancel={() => void handleCancelSelectedDocumentAiOutput()}
                onOpenModal={() => setAiOutputModalOpen(true)}
              />
            </div>
          ) : null}

          {document && documentViewMode === "edit" ? (
            <div className="mt-3">
              <ProjectManagementDocumentForm
                mode="edit"
                title={editTitle}
                tags={editTags}
                markdown={editMarkdown}
                status={editStatus}
                assignee={editAssignee}
                statuses={statuses}
                saving={saving}
                disabled={aiRunning}
                submitDisabled={!document}
                editorMode={editEditorMode}
                editorOptions={documentEditorOptions}
                onEditorModeChange={setEditEditorMode}
                onTitleChange={setEditTitle}
                onTagsChange={setEditTags}
                onMarkdownChange={setEditMarkdown}
                onStatusChange={setEditStatus}
                onAssigneeChange={setEditAssignee}
                onSubmit={handleSaveDocument}
                sidebarFooter={(
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
                )}
                editorBlockedState={aiRunning ? (
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
                ) : undefined}
              />
            </div>
          ) : document ? (
            <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
              <div className="border theme-border-subtle p-4">
                <div
                  className="pm-markdown text-sm theme-text"
                  dangerouslySetInnerHTML={{ __html: marked.parse(document.markdown) }}
                />
              </div>
              <div className="space-y-3">
                  <div className="border theme-border-subtle p-3">
                    <div className="flex items-center justify-between gap-2">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Dependencies</p>
                        <p className="mt-1 text-sm theme-text-muted">Pick prerequisite documents without opening the graph.</p>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className="matrix-button rounded-none px-2 py-1 text-xs"
                          onClick={() => setDependencyModalOpen(true)}
                          disabled={saving || aiRunning}
                        >
                          Manage dependencies
                        </button>
                        <button
                          type="button"
                          className="matrix-button rounded-none px-2 py-1 text-xs"
                          onClick={() => onSubTabChange("dependency-tree")}
                        >
                          Open graph
                        </button>
                      </div>
                    </div>
                    <div className="mt-3 space-y-2">
                      {currentDependencyDocuments.length ? currentDependencyDocuments.map((entry) => (
                        <div key={entry.id} className="border theme-pill-emphasis px-3 py-3">
                          <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] theme-text-soft">#{entry.number}</p>
                                <MatrixBadge tone="neutral" compact>{entry.status}</MatrixBadge>
                              </div>
                              <p className="mt-2 text-sm font-semibold theme-text-strong">{entry.title}</p>
                              <p className="mt-1 text-[11px] theme-text-muted">{entry.assignee || "Unassigned"}</p>
                            </div>
                            <button
                              type="button"
                              className="matrix-button rounded-none px-2 py-1 text-xs"
                              onClick={() => void handleDependencySelectionToggle(entry.id)}
                              disabled={saving || aiRunning}
                            >
                              Remove
                            </button>
                          </div>
                        </div>
                      )) : (
                        <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                          No prerequisites yet. Open the picker to add them.
                        </div>
                      )}
                    </div>
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
                <ProjectManagementDocumentForm
                  mode="create"
                  title={newTitle}
                  tags={newTags}
                  markdown={newMarkdown}
                  status={newStatus}
                  assignee={newAssignee}
                  statuses={statuses}
                  saving={saving}
                  submitDisabled={!newTitle.trim()}
                  editorMode={createEditorMode}
                  editorOptions={documentEditorOptions}
                  onEditorModeChange={setCreateEditorMode}
                  onTitleChange={setNewTitle}
                  onTagsChange={setNewTags}
                  onMarkdownChange={setNewMarkdown}
                  onStatusChange={setNewStatus}
                  onAssigneeChange={setNewAssignee}
                  onSubmit={handleCreateDocument}
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
          description="Pick Smart AI or Simple AI, describe the change you want, then run it to update the saved document on the server for this worktree."
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
              <MatrixDropdown
                label="AI command"
                value={selectedAiCommandId}
                options={aiCommandOptions}
                placeholder="Choose AI command"
                onChange={(value) => setSelectedAiCommandId(value === "simple" ? "simple" : "smart")}
                disabled={aiRunning}
              />
            </div>
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

      {aiOutputModalOpen && document && selectedDocumentAiOutput ? (
        <MatrixModal
          kicker="AI output"
          title={selectedDocumentAiOutput.source === "worktree" ? <>Live worktree output for `{document.title}`</> : <>Live document output for `{document.title}`</>}
          description="Expanded command output for the selected document. Keep this open while the job streams, or close it and come back later."
          closeLabel="Close AI output"
          maxWidthClass="max-w-6xl"
          onClose={() => setAiOutputModalOpen(false)}
        >
          <ProjectManagementAiOutputViewer
            source={selectedDocumentAiOutput.source}
            job={selectedDocumentAiOutput.job}
            summary={selectedDocumentAiOutput.summary}
            expanded
            onCancel={() => void handleCancelSelectedDocumentAiOutput()}
          />
        </MatrixModal>
      ) : null}

      {dependencyModalOpen && document ? (
        <ProjectManagementDependencyPickerModal
          document={document}
          documents={documents}
          availableTags={availableTags}
          statuses={statuses}
          dependencyIds={dependencySelection}
          disabled={saving || aiRunning}
          onClose={() => setDependencyModalOpen(false)}
          onOpenGraph={() => {
            setDependencyModalOpen(false);
            onSubTabChange("dependency-tree");
          }}
          onToggleDependency={(dependencyId) => {
            void handleDependencySelectionToggle(dependencyId);
          }}
        />
      ) : null}

    </div>
  );
}
