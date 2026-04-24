import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AiCommandOrigin,
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  ProjectManagementUser,
  RunAiCommandRequest,
  ProjectManagementDocument,
  ProjectManagementDocumentSummaryResponse,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementUsersResponse,
  RunProjectManagementDocumentAiRequest,
  RunAiCommandResponse,
  UpdateProjectManagementUsersRequest,
  WorktreeRecord,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
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
import { ProjectManagementDocumentDetail } from "./project-management-document-detail";
import { MatrixCard, MatrixCardDescription, MatrixCardFooter, MatrixCardTitle } from "./matrix-card";
import { MatrixBadge, MatrixSectionIntro, MatrixSkeletonCard, MatrixSpinner, MatrixTabs, getMatrixTabPanelId } from "./matrix-primitives";
import { LoadingOverlay } from "./loading";
import { useItemLoading } from "../hooks/useItemLoading";
import { formatAutoRefreshStatus } from "../lib/auto-refresh-status";
import { ProjectManagementBoardTab } from "./project-management-board-tab";
import { ProjectManagementDependencyTreeTab } from "./project-management-dependency-tree-tab";
import { ProjectManagementHistoryTab } from "./project-management-history-tab";
import type { ProjectManagementDocumentPresentation } from "./project-management-document-route";
import {
  getAiCommandLabel,
  getCompletedAiDocumentRefreshTarget,
  getProjectManagementDocumentRunDefaults,
  isAiCommandReady,
  parseTags,
  summarizeDocumentText,
} from "./project-management-document-utils";

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
  documentPresentation: ProjectManagementDocumentPresentation;
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
  onUpdateDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocumentSummaryResponse | null>;
  onUpdateStatus: (documentId: string, status: string) => Promise<ProjectManagementDocumentSummaryResponse | null>;
  onUpdateUsers: (payload: UpdateProjectManagementUsersRequest) => Promise<ProjectManagementUsersResponse | null>;
  onBatchUpdateDocuments: (documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) => Promise<boolean>;
  onRunAiCommand: (payload: RunAiCommandRequest & {
    input: string;
    documentId: string;
    commandId: AiCommandId;
    reviewDocumentId?: string;
    origin?: AiCommandOrigin | null;
  }) => Promise<AiCommandJob | null>;
  onRunDocumentAi: (payload: { documentId: string; commandId: AiCommandId } & RunProjectManagementDocumentAiRequest) => Promise<RunAiCommandResponse | null>;
  onCancelDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onCancelAiCommand: () => Promise<AiCommandJob | null>;
  onOpenDocumentPage: (documentId: string, options?: { viewMode?: ProjectManagementDocumentViewMode }) => void;
  onCloseDocument: () => void;
  onRetryRefresh?: () => void | Promise<void>;
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

function normalizeProjectManagementUserEmail(value: string): string {
  return value.trim().toLowerCase();
}

export async function moveBoardDocument(options: {
  documents: ProjectManagementDocumentSummary[];
  documentId: string;
  nextStatus: string;
  onUpdateStatus: (documentId: string, status: string) => Promise<ProjectManagementDocumentSummaryResponse | null>;
}) {
  const targetDocument = options.documents.find((entry) => entry.id === options.documentId) ?? null;
  if (!targetDocument || targetDocument.status === options.nextStatus) {
    return null;
  }

  return options.onUpdateStatus(options.documentId, options.nextStatus);
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
  documentPresentation,
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
  onRunAiCommand,
  onRunDocumentAi,
  onCancelDocumentAiCommand,
  onCancelAiCommand,
  onOpenDocumentPage,
  onCloseDocument,
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
    setSelectedAiCommandId("simple");
    setDocumentRunFailureToast(null);
    setDocumentWorktreeModalOpen(false);
    setDocumentWorktreeInstructions("");
    setDocumentWorktreeStrategy(currentLinkedWorktree ? "continue-current" : "new");
    setDocumentWorktreeName(generatedWorktreeName);
  }, [currentLinkedWorktree, document, generatedWorktreeName, onEditFormTabChange]);

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
      if (refreshTarget === "workspace" && (activeSubTab === "document" || activeSubTab === "history")) {
        void onRetryRefresh?.();
      } else if (refreshTarget === "document" && document && (activeSubTab === "document" || activeSubTab === "history")) {
        void onSelectDocument(document.id, { silent: true });
      }
      return;
    }

    if (aiJob.status === "failed") {
      setAiRunSummary(null);
      setAiFailureToast(aiJob.error || aiJob.stderr || "⚡ request failed. Check the AI logs for details.");
    }
  }, [activeSubTab, aiJob, document, onRetryRefresh, onSelectDocument]);

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
    ? "Open a document to inspect its markdown, tags, and linked worktrees."
    : activeSubTab === "board"
      ? "No documents are available for the current filters."
      : activeSubTab === "history"
        ? "Select a document to inspect its timeline."
        : activeSubTab === "users"
          ? "No users yet. Git commit authors appear here automatically, or add a custom user below."
          : "Create a document to start outlining the project.";

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
    onSubTabChange(activeSubTab === "history" ? "history" : "document");
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
    await moveBoardDocument({
      documents,
      documentId,
      nextStatus,
      onUpdateStatus,
    });
  }

  async function handleBatchBoardUpdate(documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) {
    if (!documentIds.length) {
      return false;
    }

    const updated = await onBatchUpdateDocuments(documentIds, overrides);
    if (updated && document && documentIds.includes(document.id) && (activeSubTab === "document" || activeSubTab === "history")) {
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
      setDependencySelection(updated.document.dependencies);
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

    if (!isAiCommandReady(aiCommands, "simple")) {
      setAiFailureToast("Configure Simple AI with $WTM_AI_INPUT in settings first.");
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
    setAiRunSummary("Simple AI is starting. Live output will stream in the editor while the saved document updates.");

    const job = await onRunAiCommand({ input: requestedChange, documentId: document.id, reviewDocumentId: document.id, commandId: "simple" });
    if (!job) {
      setAiRunSummary(null);
      setAiFailureToast("Simple AI request failed. Check the AI command output for details.");
      return false;
    }

    setAiRunSummary(`Simple AI started for ${job.branch}. Live output is streaming below while the saved document updates on the server.`);
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

  const documentBrowserPanel = (
    <div className="space-y-4 pt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <MatrixSectionIntro
          kicker="Project management"
          title="Documents"
          description="Browse every document here, then open one in a modal or on its own page."
          status={refreshStatus}
          className="min-w-0 flex-1"
        />
        <button
          type="button"
          className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
          onClick={() => onSubTabChange("create")}
        >
          New document
        </button>
      </div>

      <ProjectManagementDocumentBrowser
        documents={documents}
        availableTags={availableTags}
        statuses={statuses}
        state={documentBrowser}
        emptyMessage={loading ? "" : "No documents match the current filters."}
        listMaxHeightClass="max-h-none"
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
              selected={selectedDocumentId === entry.id}
              interactive
              className={`p-3 ${loadingDocumentId === entry.id ? "matrix-card-loading" : ""}`}
            >
              <LoadingOverlay visible={loadingDocumentId === entry.id} label={`Loading document ${entry.title}…`} />
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
          <div role="status" aria-live="polite" aria-label="Loading documents…" className="mt-3 space-y-2">
            <MatrixSkeletonCard />
            <MatrixSkeletonCard />
            <MatrixSkeletonCard />
          </div>
        ) : null}
      />
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="theme-inline-panel p-4">
        <MatrixTabs
          groupId="project-management-workspace"
          ariaLabel="Project management workspace tabs"
          activeTabId={activeSubTab}
          onChange={onSubTabChange}
          className="theme-divider border-b pb-3"
          tabs={[
            { id: "document", label: "Document", panelId: getMatrixTabPanelId("project-management-workspace", "document") },
            { id: "board", label: "Board", panelId: getMatrixTabPanelId("project-management-workspace", "board") },
            { id: "dependency-tree", label: "Dependency tree", panelId: getMatrixTabPanelId("project-management-workspace", "dependency-tree") },
            { id: "history", label: "History", panelId: getMatrixTabPanelId("project-management-workspace", "history") },
            { id: "users", label: "Users", panelId: getMatrixTabPanelId("project-management-workspace", "users") },
            { id: "create", label: "Create", panelId: getMatrixTabPanelId("project-management-workspace", "create") },
          ]}
        />

        <MatrixSectionIntro
          kicker="Project management"
          title="Workspace"
          status={refreshStatus}
          className="mt-3"
        />

          {activeSubTab === "document" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "document")} role="tabpanel" aria-labelledby="project-management-workspace-document-tab" className="pt-4">
              {documentPresentation === "page" ? (
                <ProjectManagementDocumentDetail
                  presentation="page"
                  document={document}
                  documents={documents}
                  availableTags={availableTags}
                  statuses={statuses}
                  saving={saving}
                  aiCommands={aiCommands}
                  aiJob={aiJob}
                  documentRunJob={documentRunJob}
                  selectedWorktreeBranch={selectedWorktreeBranch}
                  documentViewMode={documentViewMode}
                  editFormTab={editFormTab}
                  editTitle={editTitle}
                  editSummary={editSummary}
                  editMarkdown={editMarkdown}
                  editTags={editTags}
                  editStatus={editStatus}
                  editAssignee={editAssignee}
                  dependencySelection={dependencySelection}
                  currentDependencyDocuments={currentDependencyDocuments}
                  aiRunSummary={aiRunSummary}
                  documentRunSummary={documentRunSummary}
                  aiFailureToast={aiFailureToast}
                  documentRunFailureToast={documentRunFailureToast}
                  aiRequestModalOpen={aiRequestModalOpen}
                  aiOutputModalOpen={aiOutputModalOpen}
                  dependencyModalOpen={dependencyModalOpen}
                  documentWorktreeModalOpen={documentWorktreeModalOpen}
                  selectedAiCommandId={selectedAiCommandId}
                  aiCommandOptions={aiCommandOptions}
                  linkedWorktrees={linkedWorktrees}
                  currentLinkedWorktree={currentLinkedWorktree}
                  canContinueCurrent={canContinueCurrent}
                  generatedWorktreeName={generatedWorktreeName}
                  documentWorktreeInstructions={documentWorktreeInstructions}
                  documentWorktreeStrategy={documentWorktreeStrategy}
                  documentWorktreeName={documentWorktreeName}
                  compactDocumentSummary={compactDocumentSummary}
                  metadataControlsDisabled={metadataControlsDisabled}
                  assigneeActionDisabled={assigneeActionDisabled}
                  selectedDocumentAiOutput={selectedDocumentAiOutput}
                  inlineSelectedAiOutput={inlineSelectedAiOutput}
                  onClose={onCloseDocument}
                  onOpenPage={() => undefined}
                  onDocumentViewModeChange={onDocumentViewModeChange}
                  onEditFormTabChange={onEditFormTabChange}
                  onEditTitleChange={setEditTitle}
                  onEditSummaryChange={setEditSummary}
                  onEditMarkdownChange={setEditMarkdown}
                  onEditTagsChange={setEditTags}
                  onEditStatusChange={setEditStatus}
                  onEditAssigneeChange={setEditAssignee}
                  onSetEditingState={setIsEditing}
                  onSaveDocument={handleSaveDocument}
                  onQuickDocumentUpdate={handleQuickDocumentUpdate}
                  onSaveAssignee={handleSaveAssignee}
                  onToggleArchive={handleToggleArchive}
                  onSelectWorktree={onSelectWorktree}
                  onOpenDependencyGraph={() => onSubTabChange("dependency-tree")}
                  onOpenDependencyModal={() => setDependencyModalOpen(true)}
                  onCloseDependencyModal={() => setDependencyModalOpen(false)}
                  onToggleDependencySelection={handleDependencySelectionToggle}
                  onOpenAiRequest={() => setAiRequestModalOpen(true)}
                  onCloseAiRequest={() => setAiRequestModalOpen(false)}
                  onAiChangeRequestChange={setAiChangeRequest}
                  aiChangeRequest={aiChangeRequest}
                  onSelectedAiCommandIdChange={setSelectedAiCommandId}
                  onRunUiMagic={handleRunUiMagic}
                  onCancelAiCommand={onCancelAiCommand}
                  onDismissAiFailureToast={() => setAiFailureToast(null)}
                  onDismissDocumentRunFailureToast={() => setDocumentRunFailureToast(null)}
                  onOpenDocumentWorktreeModal={openDocumentWorktreeModal}
                  onCloseDocumentWorktreeModal={() => setDocumentWorktreeModalOpen(false)}
                  onDocumentWorktreeInstructionsChange={setDocumentWorktreeInstructions}
                  onDocumentWorktreeStrategyChange={setDocumentWorktreeStrategy}
                  onDocumentWorktreeNameChange={setDocumentWorktreeName}
                  onRunDocumentWork={handleRunDocumentWork}
                  onCancelDocumentAiCommand={onCancelDocumentAiCommand}
                  onOpenAiOutputModal={() => setAiOutputModalOpen(true)}
                  onCloseAiOutputModal={() => setAiOutputModalOpen(false)}
                  onCancelSelectedDocumentAiOutput={handleCancelSelectedDocumentAiOutput}
                />
              ) : (
                <>
                  {documentBrowserPanel}
                  {selectedDocumentId ? (
                    <ProjectManagementDocumentDetail
                      presentation="modal"
                      document={document}
                      documents={documents}
                      availableTags={availableTags}
                      statuses={statuses}
                      saving={saving}
                      aiCommands={aiCommands}
                      aiJob={aiJob}
                      documentRunJob={documentRunJob}
                      selectedWorktreeBranch={selectedWorktreeBranch}
                      documentViewMode={documentViewMode}
                      editFormTab={editFormTab}
                      editTitle={editTitle}
                      editSummary={editSummary}
                      editMarkdown={editMarkdown}
                      editTags={editTags}
                      editStatus={editStatus}
                      editAssignee={editAssignee}
                      dependencySelection={dependencySelection}
                      currentDependencyDocuments={currentDependencyDocuments}
                      aiRunSummary={aiRunSummary}
                      documentRunSummary={documentRunSummary}
                      aiFailureToast={aiFailureToast}
                      documentRunFailureToast={documentRunFailureToast}
                      aiRequestModalOpen={aiRequestModalOpen}
                      aiOutputModalOpen={aiOutputModalOpen}
                      dependencyModalOpen={dependencyModalOpen}
                      documentWorktreeModalOpen={documentWorktreeModalOpen}
                      selectedAiCommandId={selectedAiCommandId}
                      aiCommandOptions={aiCommandOptions}
                      linkedWorktrees={linkedWorktrees}
                      currentLinkedWorktree={currentLinkedWorktree}
                      canContinueCurrent={canContinueCurrent}
                      generatedWorktreeName={generatedWorktreeName}
                      documentWorktreeInstructions={documentWorktreeInstructions}
                      documentWorktreeStrategy={documentWorktreeStrategy}
                      documentWorktreeName={documentWorktreeName}
                      compactDocumentSummary={compactDocumentSummary}
                      metadataControlsDisabled={metadataControlsDisabled}
                      assigneeActionDisabled={assigneeActionDisabled}
                      selectedDocumentAiOutput={selectedDocumentAiOutput}
                      inlineSelectedAiOutput={inlineSelectedAiOutput}
                      onClose={onCloseDocument}
                      onOpenPage={() => {
                        if (document) {
                          onOpenDocumentPage(document.id, { viewMode: documentViewMode });
                        }
                      }}
                      onDocumentViewModeChange={onDocumentViewModeChange}
                      onEditFormTabChange={onEditFormTabChange}
                      onEditTitleChange={setEditTitle}
                      onEditSummaryChange={setEditSummary}
                      onEditMarkdownChange={setEditMarkdown}
                      onEditTagsChange={setEditTags}
                      onEditStatusChange={setEditStatus}
                      onEditAssigneeChange={setEditAssignee}
                      onSetEditingState={setIsEditing}
                      onSaveDocument={handleSaveDocument}
                      onQuickDocumentUpdate={handleQuickDocumentUpdate}
                      onSaveAssignee={handleSaveAssignee}
                      onToggleArchive={handleToggleArchive}
                      onSelectWorktree={onSelectWorktree}
                      onOpenDependencyGraph={() => onSubTabChange("dependency-tree")}
                      onOpenDependencyModal={() => setDependencyModalOpen(true)}
                      onCloseDependencyModal={() => setDependencyModalOpen(false)}
                      onToggleDependencySelection={handleDependencySelectionToggle}
                      onOpenAiRequest={() => setAiRequestModalOpen(true)}
                      onCloseAiRequest={() => setAiRequestModalOpen(false)}
                      onAiChangeRequestChange={setAiChangeRequest}
                      aiChangeRequest={aiChangeRequest}
                      onSelectedAiCommandIdChange={setSelectedAiCommandId}
                      onRunUiMagic={handleRunUiMagic}
                      onCancelAiCommand={onCancelAiCommand}
                      onDismissAiFailureToast={() => setAiFailureToast(null)}
                      onDismissDocumentRunFailureToast={() => setDocumentRunFailureToast(null)}
                      onOpenDocumentWorktreeModal={openDocumentWorktreeModal}
                      onCloseDocumentWorktreeModal={() => setDocumentWorktreeModalOpen(false)}
                      onDocumentWorktreeInstructionsChange={setDocumentWorktreeInstructions}
                      onDocumentWorktreeStrategyChange={setDocumentWorktreeStrategy}
                      onDocumentWorktreeNameChange={setDocumentWorktreeName}
                      onRunDocumentWork={handleRunDocumentWork}
                      onCancelDocumentAiCommand={onCancelDocumentAiCommand}
                      onOpenAiOutputModal={() => setAiOutputModalOpen(true)}
                      onCloseAiOutputModal={() => setAiOutputModalOpen(false)}
                      onCancelSelectedDocumentAiOutput={handleCancelSelectedDocumentAiOutput}
                    />
                  ) : null}
                </>
              )}
            </div>
          ) : activeSubTab === "board" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "board")} role="tabpanel" aria-labelledby="project-management-workspace-board-tab" className="pt-4">
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
            </div>
          ) : activeSubTab === "dependency-tree" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "dependency-tree")} role="tabpanel" aria-labelledby="project-management-workspace-dependency-tree-tab" className="pt-4">
              <ProjectManagementDependencyTreeTab
                documents={filteredDocuments}
                selectedDocumentId={selectedDocumentId}
                saving={saving}
                onSelectDocument={handleSelectDocument}
                onUpdateDependencies={onUpdateDependencies}
              />
            </div>
          ) : activeSubTab === "history" ? (
            <div id={getMatrixTabPanelId("project-management-workspace", "history")} role="tabpanel" aria-labelledby="project-management-workspace-history-tab" className="pt-4">
              <ProjectManagementHistoryTab history={history} />
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
  );
}
