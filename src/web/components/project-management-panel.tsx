import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCommandOrigin,
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  ProjectManagementUser,
  RunAiCommandRequest,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementUsersResponse,
  RunProjectManagementDocumentAiRequest,
  RunAiCommandResponse,
  UpdateProjectManagementUsersRequest,
  WorktreeRecord,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { createProjectManagementDocumentWorktreeBranch } from "@shared/project-management-worktree";
import { marked } from "marked";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import {
  ProjectManagementDocumentForm,
  type ProjectManagementDocumentFormViewMode,
} from "./project-management-document-form";
import {
  ProjectManagementDocumentBrowser,
  formatDocumentTimestamp,
  useProjectManagementDocumentBrowserState,
} from "./project-management-document-browser";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
import { MatrixCard, MatrixCardDescription, MatrixCardFooter, MatrixCardTitle } from "./matrix-card";
import { MatrixBadge, MatrixModal, MatrixSkeletonCard, MatrixSpinner, MatrixTabs, getMatrixTabPanelId } from "./matrix-primitives";
import { LoadingOverlay } from "./loading";
import { useItemLoading } from "../hooks/useItemLoading";
import { formatAutoRefreshStatus } from "../lib/auto-refresh-status";
import { ProjectManagementAiStreamViewer } from "./project-management-ai-stream-viewer";

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

export type ProjectManagementSubTab = "document" | "board" | "dependency-tree" | "history" | "create" | "users";
export type ProjectManagementDocumentViewMode = "document" | "edit";

interface ProjectManagementPanelProps {
  documents: ProjectManagementDocumentSummary[];
  worktrees: WorktreeRecord[];
  availableTags: string[];
  availableStatuses: string[];
  projectManagementUsers: ProjectManagementUsersResponse | null;
  activeSubTab: ProjectManagementSubTab;
  selectedDocumentId: string | null;
  documentViewMode: ProjectManagementDocumentViewMode;
  editFormTab: ProjectManagementDocumentFormViewMode;
  createFormTab: ProjectManagementDocumentFormViewMode;
  document: ProjectManagementDocument | null;
  history: ProjectManagementHistoryEntry[];
  loading: boolean;
  refreshError?: string | null;
  lastUpdatedAt?: string | null;
  saving: boolean;
  aiCommands: AiCommandConfig | null;
  aiJob: AiCommandJob | null;
  documentRunJob: AiCommandJob | null;
  runningAiJobs: AiCommandJob[];
  selectedWorktreeBranch: string | null;
  onSelectWorktree: (branch: string) => void;
  onSubTabChange: (tab: ProjectManagementSubTab) => void;
  onDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
  onEditFormTabChange: (mode: ProjectManagementDocumentFormViewMode) => void;
  onCreateFormTabChange: (mode: ProjectManagementDocumentFormViewMode) => void;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateDocument: (payload: {
    title: string;
    summary?: string;
    markdown: string;
    tags: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDocument: (documentId: string, payload: {
    title: string;
    summary?: string;
    markdown: string;
    tags: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocument | null>;
  onUpdateStatus: (documentId: string, status: string) => Promise<ProjectManagementDocument | null>;
  onUpdateUsers: (payload: UpdateProjectManagementUsersRequest) => Promise<ProjectManagementUsersResponse | null>;
  onBatchUpdateDocuments: (documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) => Promise<boolean>;
  onAddComment: (documentId: string, payload: { body: string }) => Promise<ProjectManagementDocument | null>;
  onRunAiCommand: (payload: RunAiCommandRequest & {
    input: string;
    documentId: string;
    commandId: AiCommandId;
    commentDocumentId?: string;
    origin?: AiCommandOrigin | null;
  }) => Promise<AiCommandJob | null>;
  onRunDocumentAi: (payload: { documentId: string; commandId: AiCommandId } & RunProjectManagementDocumentAiRequest) => Promise<RunAiCommandResponse | null>;
  onCancelDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onCancelAiCommand: () => Promise<AiCommandJob | null>;
  onRetryRefresh?: () => void | Promise<void>;
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

function summarizeDocumentText(value: string, maxLength = 140): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 3)}...` : normalized;
}

function normalizeProjectManagementUserEmail(value: string): string {
  return value.trim().toLowerCase();
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

export function ProjectManagementPanel({
  documents,
  worktrees,
  availableTags,
  availableStatuses,
  projectManagementUsers,
  activeSubTab,
  selectedDocumentId,
  documentViewMode,
  editFormTab,
  createFormTab,
  document,
  history,
  loading,
  refreshError = null,
  lastUpdatedAt = null,
  saving,
  aiCommands,
  aiJob,
  documentRunJob,
  runningAiJobs,
  selectedWorktreeBranch,
  onSelectWorktree,
  onSubTabChange,
  onDocumentViewModeChange,
  onEditFormTabChange,
  onCreateFormTabChange,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
  onUpdateDependencies,
  onUpdateStatus,
  onUpdateUsers,
  onBatchUpdateDocuments,
  onAddComment,
  onRunAiCommand,
  onRunDocumentAi,
  onCancelDocumentAiCommand,
  onCancelAiCommand,
  onRetryRefresh,
}: ProjectManagementPanelProps) {
  const statuses = availableStatuses.length ? availableStatuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES];
  const [showBacklogLane, setShowBacklogLane] = useState(false);
  const { loadingId: loadingDocumentId, startLoading: startLoadingDocument, stopLoading: stopLoadingDocument } = useItemLoading();
  const [editTitle, setEditTitle] = useState(() => document?.title ?? "");
  const [editSummary, setEditSummary] = useState(() => document?.summary ?? "");
  const [editMarkdown, setEditMarkdown] = useState(() => document?.markdown ?? "");
  const [editTags, setEditTags] = useState(() => document?.tags.join(", ") ?? "");
  const [dependencySelection, setDependencySelection] = useState<string[]>(() => Array.isArray(document?.dependencies) ? document.dependencies : []);
  const [editStatus, setEditStatus] = useState<string>(() => document?.status ?? PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [editAssignee, setEditAssignee] = useState(() => document?.assignee ?? "");
  // Track whether the user is actively editing to prevent poll-driven field resets
  const isEditingRef = useRef(false);
  const aiRequestModalOpenRef = useRef(false);
  const documentWorktreeModalOpenRef = useRef(false);
  const prevDocumentIdRef = useRef<string | null>(null);
  const setIsEditing = useCallback((editing: boolean) => {
    isEditingRef.current = editing;
  }, []);
  const [newTitle, setNewTitle] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [newTags, setNewTags] = useState("");
  const [newMarkdown, setNewMarkdown] = useState("");
  const [newStatus, setNewStatus] = useState<string>("");
  const [newAssignee, setNewAssignee] = useState("");
  const [newUserName, setNewUserName] = useState("");
  const [newUserEmail, setNewUserEmail] = useState("");
  const [userFormError, setUserFormError] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState("");
  const [aiRunSummary, setAiRunSummary] = useState<string | null>(null);
  const [aiChangeRequest, setAiChangeRequest] = useState("");
  const [aiFailureToast, setAiFailureToast] = useState<string | null>(null);
  const [aiRequestModalOpen, setAiRequestModalOpenState] = useState(false);
  const setAiRequestModalOpen = useCallback((open: boolean) => {
    aiRequestModalOpenRef.current = open;
    setAiRequestModalOpenState(open);
  }, []);
  const [aiOutputModalOpen, setAiOutputModalOpen] = useState(false);
  const [dependencyModalOpen, setDependencyModalOpen] = useState(false);
  const [selectedAiCommandId, setSelectedAiCommandId] = useState<AiCommandId>("simple");
  const [documentRunSummary, setDocumentRunSummary] = useState<string | null>(null);
  const [documentRunFailureToast, setDocumentRunFailureToast] = useState<string | null>(null);
  const [documentWorktreeModalOpenState, setDocumentWorktreeModalOpenState] = useState(false);
  const setDocumentWorktreeModalOpen = useCallback((open: boolean) => {
    documentWorktreeModalOpenRef.current = open;
    setDocumentWorktreeModalOpenState(open);
  }, []);
  const [documentWorktreeInstructions, setDocumentWorktreeInstructions] = useState("");
  const [documentWorktreeStrategy, setDocumentWorktreeStrategy] = useState<"new" | "continue-current">("new");
  const [documentWorktreeName, setDocumentWorktreeName] = useState("");
  const documentWorktreeModalOpen = documentWorktreeModalOpenState;
  const aiRunning = aiJob?.status === "running";
  const documentRunInProgress = documentRunJob?.status === "running";
  const documentRunTargetsSelectedDocument = Boolean(document && documentRunJob?.documentId === document.id);
  const documentRunTargetsSelectedWorktree = Boolean(selectedWorktreeBranch && documentRunJob?.branch === selectedWorktreeBranch);
  const activeDocumentRunInSelectedWorktree = documentRunInProgress && documentRunTargetsSelectedDocument && documentRunTargetsSelectedWorktree;
  const activeDocumentRunForSelectedDocument = documentRunInProgress && documentRunTargetsSelectedDocument;
  const linkedWorktrees = useMemo(
    () => document
      ? worktrees.filter((entry) => entry.linkedDocument?.id === document.id)
      : [],
    [document, worktrees],
  );
  const {
    currentLinkedWorktree,
    canContinueCurrent,
    defaultStrategy: defaultDocumentWorktreeStrategy,
    generatedWorktreeName,
  } = useMemo(() => getProjectManagementDocumentRunDefaults({
    document,
    linkedWorktrees,
    selectedWorktreeBranch,
  }), [document, linkedWorktrees, selectedWorktreeBranch]);
  const documentBrowser = useProjectManagementDocumentBrowserState(documents, statuses, {
    selectedDocumentId,
  });
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
  useEffect(() => {
    if (!document) {
      prevDocumentIdRef.current = null;
      isEditingRef.current = false;
      setEditTitle("");
      setEditSummary("");
      setEditMarkdown("");
      setEditTags("");
      setDependencySelection([]);
      setEditStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
      setEditAssignee("");
      onEditFormTabChange("write");
      setAiChangeRequest("");
      setSelectedAiCommandId("simple");
      setDependencyModalOpen(false);
      return;
    }

    const documentSwitched = prevDocumentIdRef.current !== document.id;
    prevDocumentIdRef.current = document.id;

    // If this is a poll refresh (same document) and the user is actively editing
    // or has the AI request modal open, do not overwrite their in-progress changes.
    if (!documentSwitched && (isEditingRef.current || aiRequestModalOpenRef.current || documentWorktreeModalOpenRef.current)) {
      return;
    }

    setEditTitle(document.title);
    setEditSummary(document.summary);
    setEditMarkdown(document.markdown);
    setEditTags(document.tags.join(", "));
    setDependencySelection(Array.isArray(document.dependencies) ? document.dependencies : []);
    setEditStatus(document.status);
    setEditAssignee(document.assignee);
    onEditFormTabChange("write");
    setAiFailureToast(null);
    setAiRequestModalOpen(false);
    setDependencyModalOpen(false);
    setCommentDraft("");
    setSelectedAiCommandId("simple");
    setDocumentRunFailureToast(null);
    setDocumentWorktreeModalOpen(false);
    setDocumentWorktreeInstructions("");
    setDocumentWorktreeStrategy(currentLinkedWorktree ? "continue-current" : "new");
    setDocumentWorktreeName(document ? createProjectManagementDocumentWorktreeBranch(document) : "");
  }, [document]);

  useEffect(() => {
    if (!document || documentWorktreeModalOpen) {
      return;
    }

    setDocumentWorktreeStrategy(defaultDocumentWorktreeStrategy);
    setDocumentWorktreeName(generatedWorktreeName);
  }, [defaultDocumentWorktreeStrategy, document?.id, documentWorktreeModalOpen, generatedWorktreeName]);

  useEffect(() => {
    if (!aiJob) {
      return;
    }

    if (aiJob.status === "completed") {
      setAiRunSummary(`${getAiCommandLabel(aiJob.commandId)} updated the saved document on ${aiJob.branch}. Use history to roll back if needed.`);
      setAiChangeRequest("");
      setAiRequestModalOpen(false);
      const refreshTarget = getCompletedAiDocumentRefreshTarget({
        aiJob,
        documentId: document?.id ?? null,
        hasWorkspaceRefresh: Boolean(onRetryRefresh),
      });
      if (refreshTarget === "workspace") {
        void onRetryRefresh?.();
      } else if (refreshTarget === "document" && document) {
        void onSelectDocument(document.id, { silent: true });
      }
      return;
    }

    if (aiJob.status === "failed") {
      setAiRunSummary(null);
      setAiFailureToast(aiJob.error || aiJob.stderr || "⚡ request failed. Check the AI logs for details.");
    }
  }, [aiJob, document, onRetryRefresh, onSelectDocument]);

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
  const refreshStatusLabel = formatAutoRefreshStatus(lastUpdatedAt);
  const refreshStatus = refreshError ? (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <MatrixBadge tone="danger" compact>Sync issue</MatrixBadge>
      <span className="theme-text-danger">{refreshError}</span>
      {onRetryRefresh ? (
        <button
          type="button"
          className="matrix-button rounded-none px-2 py-1 text-xs"
          onClick={() => void onRetryRefresh()}
        >
          Retry
        </button>
      ) : null}
    </div>
  ) : (
    <div className="flex flex-wrap items-center gap-2 text-xs theme-text-muted">
      {loading ? <MatrixBadge tone="warning" compact>Loading…</MatrixBadge> : <MatrixBadge tone="neutral" compact>{refreshStatusLabel}</MatrixBadge>}
      {!loading && lastUpdatedAt ? <span>{refreshStatusLabel}</span> : null}
      {loading && lastUpdatedAt ? <span>{refreshStatusLabel}</span> : null}
      {!loading && !lastUpdatedAt ? <span>{refreshStatusLabel}</span> : null}
    </div>
  );

  const selectedDocumentAiOutput = useMemo(() => {
    if (!document) {
      return null;
    }

    const matchingWorktreeJob = documentRunJob?.documentId === document.id && documentRunJob.branch === selectedWorktreeBranch
      ? documentRunJob
      : null;
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
  }, [aiJob, aiRunSummary, document, documentRunJob, documentRunSummary, selectedWorktreeBranch]);
  const showInlineSelectedAiOutput = Boolean(
    document
    && selectedDocumentAiOutput
    && !(documentViewMode === "edit" && selectedDocumentAiOutput.source === "document" && aiRunning),
  );
  const inlineSelectedAiOutput = showInlineSelectedAiOutput ? selectedDocumentAiOutput : null;

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
  const projectManagementUsersConfig = projectManagementUsers?.config ?? { customUsers: [], archivedUserIds: [] };
  const activeUsers = useMemo(
    () => (projectManagementUsers?.users ?? []).filter((entry) => !entry.archived),
    [projectManagementUsers?.users],
  );
  const archivedUsers = useMemo(
    () => (projectManagementUsers?.users ?? []).filter((entry) => entry.archived),
    [projectManagementUsers?.users],
  );
  const customUserEmails = useMemo(
    () => new Set(projectManagementUsersConfig.customUsers.map((entry) => normalizeProjectManagementUserEmail(entry.email)).filter(Boolean)),
    [projectManagementUsersConfig.customUsers],
  );

  const emptyStateMessage = activeSubTab === "document"
    ? "Select a document from the left rail to inspect its markdown, tags, and history."
    : activeSubTab === "board"
      ? "No documents are available for the current filters."
      : activeSubTab === "history"
        ? "Select a document to inspect its timeline."
        : activeSubTab === "users"
          ? "No users yet. Git commit authors appear here automatically, or add a custom user below."
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
    if (!options?.silent) {
      startLoadingDocument(documentId);
    }
    onSubTabChange("document");
    onDocumentViewModeChange("document");
    try {
      return await onSelectDocument(documentId, options);
    } finally {
      stopLoadingDocument();
    }
  }

  async function handleCreateDocument() {
    const created = await onCreateDocument({
      title: newTitle,
      summary: newSummary || undefined,
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
    setNewSummary("");
    setNewTags("");
    setNewMarkdown("");
    setNewStatus("");
    setNewAssignee("");
    onCreateFormTabChange("write");
    await handleSelectDocument(created.id, { silent: true });
  }

  async function handleSaveDocument() {
    if (!document) {
      return;
    }

    await onUpdateDocument(document.id, {
      title: editTitle,
      summary: editSummary || undefined,
      markdown: editMarkdown,
      tags: parseTags(editTags),
      dependencies: dependencySelection,
      status: editStatus,
      assignee: editAssignee,
      archived: document.archived,
    });
  }

  async function handleQuickDocumentUpdate(overrides: {
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) {
    if (!document) {
      return;
    }

    await onUpdateDocument(document.id, {
      title: editTitle,
      summary: editSummary || undefined,
      markdown: editMarkdown,
      tags: parseTags(editTags),
      dependencies: dependencySelection,
      status: overrides.status ?? editStatus,
      assignee: overrides.assignee ?? editAssignee,
      archived: overrides.archived ?? document.archived,
    });
  }

  async function handleSaveAssignee() {
    if (!document || editAssignee === document.assignee) {
      return;
    }

    await handleQuickDocumentUpdate({ assignee: editAssignee });
  }

  async function handleToggleArchive() {
    if (!document) {
      return;
    }

    await handleQuickDocumentUpdate({ archived: !document.archived });
  }

  async function handleMoveDocument(documentId: string, nextStatus: string) {
    const targetDocument = documents.find((entry) => entry.id === documentId) ?? null;
    if (!targetDocument || targetDocument.status === nextStatus) {
      return;
    }

    await onUpdateStatus(documentId, nextStatus);

    if (document?.id === documentId) {
      void onSelectDocument(documentId, { silent: true });
    }
  }

  async function handleBatchBoardUpdate(documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) {
    if (!documentIds.length) {
      return false;
    }

    const updated = await onBatchUpdateDocuments(documentIds, overrides);
    if (updated && document && documentIds.includes(document.id)) {
      void onSelectDocument(document.id, { silent: true });
    }
    return updated;
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
  const metadataControlsDisabled = !document || saving || aiRunning;
  const assigneeActionDisabled = !document || saving || aiRunning || editAssignee === document.assignee;

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

  async function handleAddComment() {
    if (!document || !commentDraft.trim()) {
      return;
    }

    const updated = await onAddComment(document.id, { body: commentDraft });
    if (updated) {
      setCommentDraft("");
    }
  }

  async function handleRunUiMagic() {
    if (!document) {
      setAiFailureToast("Select a document before running ⚡.");
      return false;
    }

    if (!selectedWorktreeBranch) {
      setAiFailureToast("Select a worktree before running ⚡.");
      return false;
    }

    if (!isAiCommandReady(aiCommands, selectedAiCommandId)) {
      setAiFailureToast(`Configure ${getAiCommandLabel(selectedAiCommandId)} with $WTM_AI_INPUT in settings first.`);
      return false;
    }

    if (aiRunning) {
      setAiFailureToast("⚡ is already running for this worktree.");
      return false;
    }

    const requestedChange = aiChangeRequest.trim();
    if (!requestedChange) {
      setAiFailureToast("Tell ⚡ what to change before running it.");
      return false;
    }

    setAiRunSummary(null);
    setAiFailureToast(null);
    setAiRequestModalOpen(false);
    setAiRunSummary(`${getAiCommandLabel(selectedAiCommandId)} is starting. Live output will stream in the editor while the saved document updates.`);

    const job = await onRunAiCommand({ input: requestedChange, documentId: document.id, commandId: selectedAiCommandId });
    if (!job) {
      setAiRunSummary(null);
      setAiFailureToast(`${getAiCommandLabel(selectedAiCommandId)} request failed. Check the AI command output for details.`);
      return false;
    }

    setAiRunSummary(`${getAiCommandLabel(selectedAiCommandId)} started for ${job.branch}. Live output is streaming below while the saved document updates on the server.`);
    return true;
  }

  function openDocumentWorktreeModal() {
    if (!document) {
      setDocumentRunFailureToast("Select a document before starting work.");
      return;
    }

    if (!isAiCommandReady(aiCommands, "smart")) {
      setDocumentRunFailureToast("Configure Smart AI with $WTM_AI_INPUT in settings first.");
      return;
    }

    if (activeDocumentRunForSelectedDocument) {
      setDocumentRunFailureToast(documentRunJob?.branch
        ? `This document already has a worktree AI run in ${documentRunJob.branch}.`
        : "This document already has a worktree AI run in progress.");
      return;
    }

    setDocumentRunFailureToast(null);
    setDocumentWorktreeInstructions("");
    setDocumentWorktreeStrategy(defaultDocumentWorktreeStrategy);
    setDocumentWorktreeName(generatedWorktreeName);
    setDocumentWorktreeModalOpen(true);
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

    if (activeDocumentRunForSelectedDocument) {
      setDocumentRunFailureToast(documentRunJob?.branch
        ? `This document already has a worktree AI run in ${documentRunJob.branch}.`
        : "This document already has a worktree AI run in progress.");
      return false;
    }

    if (documentWorktreeStrategy === "continue-current" && !currentLinkedWorktree) {
      setDocumentRunFailureToast("Select a linked worktree to continue, or start a new one.");
      return false;
    }

    const requestedWorktreeName = documentWorktreeName.trim();
    if (documentWorktreeStrategy === "new" && !requestedWorktreeName) {
      setDocumentRunFailureToast("Name the new worktree before starting work.");
      return false;
    }

    setDocumentRunSummary(null);
    setDocumentRunFailureToast(null);
    setDocumentWorktreeModalOpen(false);

    const result = await onRunDocumentAi({
      documentId: document.id,
      commandId: "smart",
      input: documentWorktreeInstructions.trim() || undefined,
      worktreeStrategy: documentWorktreeStrategy,
      targetBranch: documentWorktreeStrategy === "continue-current" ? currentLinkedWorktree?.branch : undefined,
      worktreeName: documentWorktreeStrategy === "new" ? requestedWorktreeName : undefined,
    });
    if (!result) {
      setDocumentRunFailureToast("Smart AI request failed. Check the AI command output for details.");
      return false;
    }

    setDocumentWorktreeInstructions("");
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

  async function handleToggleUserArchive(user: ProjectManagementUser) {
    const archivedUserIds = user.archived
      ? projectManagementUsersConfig.archivedUserIds.filter((entry) => entry !== user.id)
      : [...projectManagementUsersConfig.archivedUserIds, user.id];

    setUserFormError(null);
    await onUpdateUsers({
      config: {
        ...projectManagementUsersConfig,
        archivedUserIds: [...new Set(archivedUserIds)],
      },
    });
  }

  async function handleAddCustomUser() {
    const name = newUserName.trim();
    const email = normalizeProjectManagementUserEmail(newUserEmail);

    if (!name || !email) {
      setUserFormError("Add a name and email to save a custom user.");
      return;
    }

    const nextCustomUsers = projectManagementUsersConfig.customUsers.some((entry) => normalizeProjectManagementUserEmail(entry.email) === email)
      ? projectManagementUsersConfig.customUsers.map((entry) => normalizeProjectManagementUserEmail(entry.email) === email ? { name, email } : entry)
      : [...projectManagementUsersConfig.customUsers, { name, email }];

    const response = await onUpdateUsers({
      config: {
        ...projectManagementUsersConfig,
        customUsers: nextCustomUsers,
      },
    });

    if (response) {
      setNewUserName("");
      setNewUserEmail("");
      setUserFormError(null);
    }
  }

  async function handleRemoveCustomUser(user: ProjectManagementUser) {
    const normalizedEmail = normalizeProjectManagementUserEmail(user.email);
    const nextCustomUsers = projectManagementUsersConfig.customUsers.filter(
      (entry) => normalizeProjectManagementUserEmail(entry.email) !== normalizedEmail,
    );
    const nextArchivedUserIds = user.source === "config" && user.commitCount === 0
      ? projectManagementUsersConfig.archivedUserIds.filter((entry) => entry !== user.id)
      : projectManagementUsersConfig.archivedUserIds;

    await onUpdateUsers({
      config: {
        customUsers: nextCustomUsers,
        archivedUserIds: nextArchivedUserIds,
      },
    });
  }

  function renderUserCard(user: ProjectManagementUser) {
    const hasCustomEntry = customUserEmails.has(normalizeProjectManagementUserEmail(user.email));

    return (
      <div key={user.id} className="border theme-border-subtle px-3 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-start gap-3">
              <img
                src={user.avatarUrl}
                alt=""
                className="h-10 w-10 shrink-0 border theme-border-subtle object-cover"
                loading="lazy"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-semibold theme-text-strong">{user.name || user.email}</p>
                  <MatrixBadge tone={user.archived ? "warning" : "active"} compact>
                    {user.archived ? "archived" : "active"}
                  </MatrixBadge>
                  <MatrixBadge tone="neutral" compact>{user.source === "git" ? "Git history" : "Custom"}</MatrixBadge>
                  {hasCustomEntry ? <MatrixBadge tone="idle" compact>config override</MatrixBadge> : null}
                </div>
                <p className="mt-1 break-all text-xs theme-text-muted">{user.email}</p>
                <div className="mt-2 flex flex-wrap gap-2 text-xs theme-text-muted">
                  <span>{user.commitCount} commit{user.commitCount === 1 ? "" : "s"}</span>
                  <span>{user.lastCommitAt ? `Last commit ${formatDocumentTimestamp(user.lastCommitAt)}` : "No commits yet"}</span>
                </div>
              </div>
            </div>
          </div>
          <div className="flex flex-wrap gap-2 lg:justify-end">
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              disabled={saving}
              onClick={() => void handleToggleUserArchive(user)}
            >
              {user.archived ? "Unarchive user" : "Archive user"}
            </button>
            {hasCustomEntry ? (
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                disabled={saving}
                onClick={() => void handleRemoveCustomUser(user)}
              >
                Remove custom entry
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const documentRail = (
    <div className="theme-inline-panel p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="matrix-kicker">Project management</p>
          <h2 className="mt-1 text-xl font-semibold theme-text-strong">Documents</h2>
          <div className="mt-2">{refreshStatus}</div>
        </div>
      </div>

      <ProjectManagementDocumentBrowser
        documents={documents}
        availableTags={availableTags}
        statuses={statuses}
        state={documentBrowser}
        emptyMessage={loading ? "" : "No documents match the current filters."}
        renderDocument={(entry) => (
          <button
            key={entry.id}
            type="button"
            className="w-full text-left"
            disabled={loadingDocumentId !== null}
            aria-busy={loadingDocumentId === entry.id}
            onClick={() => void handleSelectDocument(entry.id)}
          >
            <MatrixCard
              as="div"
              selected={document?.id === entry.id}
              interactive
              className={`p-3 ${loadingDocumentId === entry.id ? "matrix-card-loading" : ""}`}
            >
              <LoadingOverlay
                visible={loadingDocumentId === entry.id}
                label={`Loading document ${entry.title}…`}
              />
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] theme-text-soft">#{entry.number}</p>
                    {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                    {loadingDocumentId === entry.id ? <MatrixSpinner label="Loading document…" /> : null}
                  </div>
                  <MatrixCardTitle className="mt-2" lines={2} title={entry.title}>{entry.title}</MatrixCardTitle>
                  {entry.summary ? (
                    <MatrixCardDescription className="mt-2" lines={3} title={entry.summary}>
                      {summarizeDocumentText(entry.summary, 220)}
                    </MatrixCardDescription>
                  ) : null}
                  <MatrixCardFooter className="mt-3 justify-between gap-x-3 gap-y-1 text-[11px] theme-text-muted">
                    <span className="min-w-0 truncate">{entry.assignee || "Unassigned"}</span>
                    <span className="shrink-0">{formatDocumentTimestamp(entry.updatedAt)}</span>
                  </MatrixCardFooter>
                </div>
                <MatrixBadge tone={entry.archived ? "warning" : "neutral"} compact>
                  {entry.archived ? "archived" : `${entry.historyCount} rev`}
                </MatrixBadge>
              </div>
              <MatrixCardFooter className="mt-3 gap-1">
                {entry.tags.slice(0, 2).map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
                {entry.tags.length > 2 ? <MatrixBadge tone="idle" compact>{`+${entry.tags.length - 2}`}</MatrixBadge> : null}
              </MatrixCardFooter>
            </MatrixCard>
          </button>
        )}
        skeletonSlot={loading && documents.length === 0 ? (
          <div
            role="status"
            aria-live="polite"
            aria-label="Loading documents…"
            className="space-y-2 mt-3"
          >
            <MatrixSkeletonCard />
            <MatrixSkeletonCard />
            <MatrixSkeletonCard />
          </div>
        ) : null}
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
          <div className="shrink-0">{refreshStatus}</div>
        </div>

        <div className="theme-inline-panel p-4">
          <div className="border-b theme-border-subtle pb-4">
            <MatrixTabs
              groupId="project-management-workspace"
              ariaLabel="Project management workspace tabs"
              activeTabId={activeSubTab}
              onChange={onSubTabChange}
              tabs={[
                { id: "document", label: "Document", panelId: getMatrixTabPanelId("project-management-workspace", "document") },
                { id: "board", label: "Board", panelId: getMatrixTabPanelId("project-management-workspace", "board") },
                { id: "dependency-tree", label: "Dependency tree", panelId: getMatrixTabPanelId("project-management-workspace", "dependency-tree") },
                { id: "history", label: "History", panelId: getMatrixTabPanelId("project-management-workspace", "history") },
                { id: "users", label: "Users", panelId: getMatrixTabPanelId("project-management-workspace", "users") },
                { id: "create", label: "Create", panelId: getMatrixTabPanelId("project-management-workspace", "create") },
              ]}
            />
          </div>

          {activeSubTab === "document" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "document")} role="tabpanel" aria-labelledby="project-management-workspace-document-tab" className="grid gap-4 pt-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
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
                      <MatrixTabs
                        groupId="project-management-document-view"
                        ariaLabel="Project document view tabs"
                        activeTabId={documentViewMode}
                        onChange={onDocumentViewModeChange}
                        tabs={[
                          { id: "document", label: "Document", panelId: getMatrixTabPanelId("project-management-document-view", "document") },
                          { id: "edit", label: "Edit", panelId: getMatrixTabPanelId("project-management-document-view", "edit") },
                        ]}
                      />
                    ) : null}
                    {documentViewMode === "document" ? (
                      <div className="flex flex-wrap gap-2">
                        <button
                          type="button"
                          className={`matrix-button rounded-none px-3 py-2 text-sm font-semibold ${activeDocumentRunInSelectedWorktree ? "pm-ai-button-running" : ""}`}
                          onClick={openDocumentWorktreeModal}
                          title={activeDocumentRunInSelectedWorktree ? "Worktree AI is running" : "Start worktree AI"}
                          disabled={!document || activeDocumentRunForSelectedDocument}
                        >
                          {activeDocumentRunInSelectedWorktree ? "Start Worktree AI (running)" : "Start Worktree AI"}
                        </button>
                        {activeDocumentRunInSelectedWorktree && documentRunJob?.branch ? (
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
                          title={aiRunning ? "⚡ is running" : "Open AI request"}
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
                    {activeDocumentRunInSelectedWorktree ? <MatrixBadge tone="warning">Document worktree AI run in progress</MatrixBadge> : null}
                    {aiRunSummary ? <MatrixBadge tone="active">{aiRunSummary}</MatrixBadge> : null}
                    {documentRunSummary ? <MatrixBadge tone="active">{documentRunSummary}</MatrixBadge> : null}
                  </div>
                ) : null}

                {document ? (
                  <div className="mt-3 border theme-border-subtle p-3">
                    <div className="flex flex-col gap-3 xl:flex-row xl:items-end">
                      <div className="xl:w-56 xl:flex-none">
                        <MatrixDropdown
                          label="Lane"
                          value={editStatus}
                          options={statuses.map((entry) => ({
                            value: entry,
                            label: entry,
                            description: "Board lane",
                          }))}
                          placeholder="Select lane"
                          disabled={metadataControlsDisabled}
                          onChange={(value) => {
                            setEditStatus(value);
                            void handleQuickDocumentUpdate({ status: value });
                          }}
                        />
                      </div>
                      <form
                        className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-end"
                        onSubmit={(event) => {
                          event.preventDefault();
                          void handleSaveAssignee();
                        }}
                      >
                        <label className="min-w-0 flex-1 space-y-2">
                          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Assignee</span>
                          <input
                            value={editAssignee}
                            onChange={(event) => setEditAssignee(event.target.value)}
                            placeholder="Assignee"
                            disabled={metadataControlsDisabled}
                            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                          />
                        </label>
                        <button
                          type="submit"
                          className="matrix-button h-10 rounded-none px-3 text-sm font-semibold"
                          disabled={assigneeActionDisabled}
                        >
                          {editAssignee ? "Save assignee" : document.assignee ? "Clear assignee" : "Save assignee"}
                        </button>
                      </form>
                      <div className="flex flex-wrap gap-2 xl:flex-none">
                        <button
                          type="button"
                          className="matrix-button h-10 rounded-none px-3 text-sm font-semibold"
                          disabled={metadataControlsDisabled}
                          onClick={() => void handleToggleArchive()}
                        >
                          {document.archived ? "Restore document" : "Archive document"}
                        </button>
                        {document.archived ? <MatrixBadge tone="warning">Archived</MatrixBadge> : null}
                      </div>
                    </div>
                    <p className="mt-3 text-xs theme-text-muted">
                      Update the lane, assignee, or archive state here without leaving the document view.
                    </p>
                  </div>
                ) : null}

                {inlineSelectedAiOutput ? (
                  <div className="mt-3">
                    <ProjectManagementAiStreamViewer
                      source={inlineSelectedAiOutput.source}
                      jobId={inlineSelectedAiOutput.job.jobId}
                      summary={inlineSelectedAiOutput.summary}
                      fallbackJob={inlineSelectedAiOutput.job}
                      onCancel={() => void handleCancelSelectedDocumentAiOutput()}
                      onOpenModal={() => setAiOutputModalOpen(true)}
                    />
                  </div>
                ) : null}

                {document && documentViewMode === "edit" ? (
                  <div className="mt-3">
                      <ProjectManagementDocumentForm
                        tabsId="project-management-edit-form"
                        mode="edit"
                      title={editTitle}
                      summary={editSummary}
                      tags={editTags}
                      markdown={editMarkdown}
                      status={editStatus}
                      assignee={editAssignee}
                      statuses={statuses}
                      saving={saving}
                      disabled={aiRunning}
                      showMetadataFields={false}
                      submitDisabled={!document}
                      viewMode={editFormTab}
                      onViewModeChange={onEditFormTabChange}
                      onTitleChange={setEditTitle}
                      onSummaryChange={setEditSummary}
                      onTagsChange={setEditTags}
                      onMarkdownChange={setEditMarkdown}
                      onStatusChange={setEditStatus}
                      onAssigneeChange={setEditAssignee}
                      onSubmit={handleSaveDocument}
                      onEditingStateChange={setIsEditing}
                       editorBlockedState={aiRunning && selectedDocumentAiOutput?.source === "document" ? (
                          <ProjectManagementAiStreamViewer
                            source="document"
                            jobId={selectedDocumentAiOutput.job.jobId}
                            summary={selectedDocumentAiOutput.summary}
                            fallbackJob={selectedDocumentAiOutput.job}
                            expanded
                            onCancel={() => void onCancelAiCommand()}
                          />
                       ) : undefined}
                     />
                   </div>
                 ) : document ? (
                  <div className="mt-3 grid gap-3 xl:grid-cols-[minmax(0,1fr)_18rem]">
                    <div className="space-y-3">
                      <div className="border theme-border-subtle p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Linked worktrees</p>
                            <p className="mt-1 text-sm theme-text-muted">Open the linked branch context for this document without leaving the document view.</p>
                          </div>
                          <MatrixBadge tone="neutral" compact>{linkedWorktrees.length} worktree{linkedWorktrees.length === 1 ? "" : "s"}</MatrixBadge>
                        </div>
                        <div className="mt-3 space-y-2">
                          {linkedWorktrees.length ? linkedWorktrees.map((entry) => {
                            const isActiveWorktree = selectedWorktreeBranch === entry.branch;

                            return (
                              <div key={entry.branch} className="border theme-border-subtle px-3 py-3">
                                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                                  <div className="min-w-0 flex-1">
                                    <div className="flex flex-wrap items-center gap-2">
                                      <p className="font-mono text-sm theme-text-strong">{entry.branch}</p>
                                      <MatrixBadge tone={entry.runtime ? "active" : "neutral"} compact>
                                        {entry.runtime ? "runtime active" : "idle"}
                                      </MatrixBadge>
                                      {isActiveWorktree ? <MatrixBadge tone="warning" compact>active worktree</MatrixBadge> : null}
                                    </div>
                                    <p className="mt-2 break-all text-[11px] theme-text-muted">{entry.worktreePath}</p>
                                  </div>
                                  <button
                                    type="button"
                                    className="matrix-button rounded-none px-3 py-2 text-sm"
                                    disabled={isActiveWorktree}
                                    onClick={() => onSelectWorktree(entry.branch)}
                                  >
                                    {isActiveWorktree ? "Active worktree" : "Make active"}
                                  </button>
                                </div>
                              </div>
                            );
                          }) : (
                            <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                              No linked worktrees yet.
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="border theme-border-subtle p-4">
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Summary</p>
                        <p className="mt-2 whitespace-pre-wrap text-sm theme-text-muted">
                          {document.summary || "No short summary yet."}
                        </p>
                      </div>
                      <div className="border theme-border-subtle p-4">
                        <div
                          className="pm-markdown text-sm theme-text"
                          dangerouslySetInnerHTML={{ __html: marked.parse(document.markdown) }}
                        />
                      </div>
                      <div className="border theme-border-subtle p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Comments</p>
                            <p className="mt-1 text-sm theme-text-muted">Discuss the document here. Comments are attributed to the repo git user.</p>
                          </div>
                          <MatrixBadge tone="neutral" compact>{document.comments.length} comment{document.comments.length === 1 ? "" : "s"}</MatrixBadge>
                        </div>
                        <div className="mt-3 space-y-3">
                          {document.comments.length ? document.comments.map((comment) => (
                            <div key={comment.id} className="border theme-border-subtle px-3 py-3">
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold theme-text-strong">{comment.authorName}</p>
                                <p className="text-xs theme-text-muted">{comment.authorEmail}</p>
                                <p className="text-xs theme-text-soft">{new Date(comment.createdAt).toLocaleString()}</p>
                              </div>
                              <p className="mt-2 whitespace-pre-wrap text-sm theme-text">{comment.body}</p>
                            </div>
                          )) : (
                            <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                              No comments yet. Add context, blockers, or implementation notes here.
                            </div>
                          )}
                        </div>
                        <div className="mt-3 border-t theme-border-subtle pt-3">
                          <label className="block space-y-2">
                            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Add comment</span>
                            <textarea
                              value={commentDraft}
                              onChange={(event) => setCommentDraft(event.target.value)}
                              placeholder="Leave an implementation note, blocker, or follow-up."
                              rows={4}
                              disabled={saving || aiRunning}
                              className="matrix-input min-h-[7rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                            />
                          </label>
                          <div className="mt-2 flex items-center justify-between gap-3">
                            <p className="text-xs theme-text-muted">Saved with your repo git `user.name` and `user.email`.</p>
                            <button
                              type="button"
                              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                              disabled={saving || aiRunning || !commentDraft.trim()}
                              onClick={() => void handleAddComment()}
                            >
                              Add comment
                            </button>
                          </div>
                        </div>
                      </div>
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
            <div id={getMatrixTabPanelId("project-management-workspace", "board")} role="tabpanel" aria-labelledby="project-management-workspace-board-tab" className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading board...</div>}>
                <ProjectManagementBoardTab
                  swimlaneDocuments={swimlaneDocuments}
                  document={document}
                  documentRunJob={documentRunJob}
                  runningAiJobs={runningAiJobs}
                  showBacklogLane={showBacklogLane}
                  saving={saving}
                  smartAiReady={isAiCommandReady(aiCommands, "smart")}
                  onToggleBacklogLane={() => setShowBacklogLane((current) => !current)}
                  onSelectDocument={handleSelectDocument}
                  onMoveDocument={handleMoveDocument}
                  onBatchUpdateDocuments={handleBatchBoardUpdate}
                  onRunDocumentAi={onRunDocumentAi}
                />
              </Suspense>
            </div>
          ) : activeSubTab === "dependency-tree" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "dependency-tree")} role="tabpanel" aria-labelledby="project-management-workspace-dependency-tree-tab" className="pt-4">
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
            <div id={getMatrixTabPanelId("project-management-workspace", "history")} role="tabpanel" aria-labelledby="project-management-workspace-history-tab" className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading history...</div>}>
                <ProjectManagementHistoryTab history={history} />
              </Suspense>
            </div>
          ) : activeSubTab === "users" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "users")} role="tabpanel" aria-labelledby="project-management-workspace-users-tab" className="pt-4">
              <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
                <div className="space-y-4">
                  <div className="border theme-border-subtle p-4">
                    <p className="matrix-kicker">People</p>
                    <h3 className="mt-2 text-lg font-semibold theme-text-strong">Manage users</h3>
                    <p className="mt-2 text-sm theme-text-muted">
                      Git commit authors appear here automatically. Archive users to hide them from active planning, or add custom users in config.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2 text-xs">
                      <MatrixBadge tone="neutral" compact>{activeUsers.length} active</MatrixBadge>
                      <MatrixBadge tone="warning" compact>{archivedUsers.length} archived</MatrixBadge>
                      <MatrixBadge tone="idle" compact>{projectManagementUsersConfig.customUsers.length} custom entries</MatrixBadge>
                    </div>
                  </div>

                  <div className="border theme-border-subtle p-4">
                    <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Add custom user</p>
                    <p className="mt-1 text-sm theme-text-muted">Use this for people who should appear in planning before they have git history in this repo.</p>
                    <div className="mt-3 space-y-3">
                      <label className="block space-y-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Name</span>
                        <input
                          value={newUserName}
                          onChange={(event) => setNewUserName(event.target.value)}
                          placeholder="Jane Doe"
                          disabled={saving}
                          className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                        />
                      </label>
                      <label className="block space-y-2">
                        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Email</span>
                        <input
                          value={newUserEmail}
                          onChange={(event) => setNewUserEmail(event.target.value)}
                          placeholder="jane@example.com"
                          disabled={saving}
                          className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                        />
                      </label>
                      {userFormError ? <p className="text-xs theme-text-danger">{userFormError}</p> : null}
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                        disabled={saving}
                        onClick={() => void handleAddCustomUser()}
                      >
                        Save custom user
                      </button>
                    </div>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="border theme-border-subtle p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Active users</p>
                        <p className="mt-1 text-sm theme-text-muted">These users can be assigned or referenced in project planning right now.</p>
                      </div>
                      <MatrixBadge tone="neutral" compact>{activeUsers.length}</MatrixBadge>
                    </div>
                    <div className="mt-3 space-y-3">
                      {activeUsers.length ? activeUsers.map((user) => renderUserCard(user)) : (
                        <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                          {emptyStateMessage}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="border theme-border-subtle p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Archived users</p>
                        <p className="mt-1 text-sm theme-text-muted">Keep old contributors on record without showing them in the active planning list.</p>
                      </div>
                      <MatrixBadge tone="warning" compact>{archivedUsers.length}</MatrixBadge>
                    </div>
                    <div className="mt-3 space-y-3">
                      {archivedUsers.length ? archivedUsers.map((user) => renderUserCard(user)) : (
                        <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                          No archived users yet.
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div id={getMatrixTabPanelId("project-management-workspace", "create")} role="tabpanel" aria-labelledby="project-management-workspace-create-tab" className="pt-4">
              <Suspense fallback={<div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">Loading create form...</div>}>
                <ProjectManagementDocumentForm
                  tabsId="project-management-create-form"
                  mode="create"
                  title={newTitle}
                  summary={newSummary}
                  tags={newTags}
                  markdown={newMarkdown}
                  status={newStatus}
                  assignee={newAssignee}
                  statuses={statuses}
                  saving={saving}
                  submitDisabled={!newTitle.trim()}
                  viewMode={createFormTab}
                  onViewModeChange={onCreateFormTabChange}
                  onTitleChange={setNewTitle}
                  onSummaryChange={setNewSummary}
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
              {aiRunning ? "⚡ Running..." : "Run ⚡"}
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

      {documentWorktreeModalOpen && document && documentViewMode === "document" ? (
        <MatrixModal
          kicker="Worktree AI"
          title={<>Start work for `{document.title}`</>}
          description="Add any extra instructions, then choose whether to continue in the current linked worktree or start a new one for this document."
          closeLabel="Close worktree AI setup"
          maxWidthClass="max-w-3xl"
          onClose={() => setDocumentWorktreeModalOpen(false)}
          footer={(
            <button
              type="submit"
              form="pm-document-worktree-form"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={activeDocumentRunForSelectedDocument}
            >
              {activeDocumentRunForSelectedDocument ? "Worktree AI running..." : "Start Worktree AI"}
            </button>
          )}
        >
          <form
            id="pm-document-worktree-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleRunDocumentWork();
            }}
          >
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Run in</span>
                <label className="flex items-start gap-3 border theme-border-subtle px-3 py-3">
                  <input
                    type="radio"
                    name="pm-document-worktree-strategy"
                    value="continue-current"
                    checked={documentWorktreeStrategy === "continue-current"}
                    disabled={!canContinueCurrent}
                    onChange={() => setDocumentWorktreeStrategy("continue-current")}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold theme-text-strong">Continue current worktree</span>
                    <span className="block text-xs theme-text-muted">
                      {currentLinkedWorktree
                        ? `Keep working in ${currentLinkedWorktree.branch}.`
                        : "Select one of this document's linked worktrees to continue here."}
                    </span>
                  </span>
                </label>
                <label className="flex items-start gap-3 border theme-border-subtle px-3 py-3">
                  <input
                    type="radio"
                    name="pm-document-worktree-strategy"
                    value="new"
                    checked={documentWorktreeStrategy === "new"}
                    onChange={() => setDocumentWorktreeStrategy("new")}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-semibold theme-text-strong">Start a new worktree</span>
                    <span className="block text-xs theme-text-muted">Create a separate worktree for this run.</span>
                  </span>
                </label>
              </div>

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Worktree name</span>
                <input
                  value={documentWorktreeStrategy === "continue-current" ? currentLinkedWorktree?.branch ?? generatedWorktreeName : documentWorktreeName}
                  onChange={(event) => setDocumentWorktreeName(event.target.value)}
                  placeholder="pm-doc-1-project-outline"
                  disabled={documentWorktreeStrategy === "continue-current"}
                  className="matrix-input w-full rounded-none px-3 py-2 text-sm outline-none"
                />
                <p className="text-xs theme-text-muted">
                  {documentWorktreeStrategy === "continue-current"
                    ? "The current worktree name is fixed while you continue in that branch."
                    : "This becomes the branch and worktree name base for the new run."}
                </p>
              </label>
            </div>

            <div className="border theme-border-subtle px-3 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Linked worktrees</p>
              <div className="mt-3 space-y-2">
                {linkedWorktrees.length ? linkedWorktrees.map((entry) => {
                  const isSelectedLinkedWorktree = currentLinkedWorktree?.branch === entry.branch;

                  return (
                    <div key={entry.branch} className="flex flex-wrap items-center justify-between gap-2 border theme-border-subtle px-3 py-2 text-sm">
                      <div className="min-w-0">
                        <p className="font-mono theme-text-strong">{entry.branch}</p>
                        <p className="mt-1 text-xs theme-text-muted">{entry.runtime ? "Runtime active" : "Runtime idle"}</p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {isSelectedLinkedWorktree ? <MatrixBadge tone="warning" compact>current</MatrixBadge> : null}
                        {selectedWorktreeBranch === entry.branch ? <MatrixBadge tone="active" compact>selected</MatrixBadge> : null}
                      </div>
                    </div>
                  );
                }) : (
                  <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                    No linked worktrees yet. Start a new worktree to create one for this document.
                  </div>
                )}
              </div>
            </div>

            <label className="block space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Additional instructions</span>
              <textarea
                value={documentWorktreeInstructions}
                onChange={(event) => setDocumentWorktreeInstructions(event.target.value)}
                placeholder="Example: continue the current implementation, keep the existing approach, and focus on finishing the modal and tests first."
                rows={8}
                autoFocus
                className="matrix-input min-h-[12rem] w-full rounded-none px-3 py-3 text-sm outline-none"
              />
            </label>
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
          <ProjectManagementAiStreamViewer
            source={selectedDocumentAiOutput.source}
            jobId={selectedDocumentAiOutput.job.jobId}
            summary={selectedDocumentAiOutput.summary}
            fallbackJob={selectedDocumentAiOutput.job}
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
