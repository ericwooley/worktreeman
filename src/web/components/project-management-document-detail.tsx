import { marked } from "marked";
import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  WorktreeRecord,
} from "@shared/types";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import {
  MatrixBadge,
  MatrixModal,
  MatrixSectionIntro,
  MatrixTabs,
  getMatrixTabPanelId,
} from "./matrix-primitives";
import {
  ProjectManagementDocumentForm,
  type ProjectManagementDocumentFormViewMode,
} from "./project-management-document-form";
import { ProjectManagementAiStreamViewer } from "./project-management-ai-stream-viewer";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
import type { ProjectManagementDocumentViewMode } from "./project-management-panel";
import type { ProjectManagementDocumentPresentation } from "./project-management-document-route";
import { formatDocumentTimestamp } from "./project-management-document-browser";
import { getAiCommandLabel, isAiCommandReady } from "./project-management-document-utils";

interface SelectedDocumentAiOutput {
  source: "document" | "worktree";
  job: AiCommandJob;
  summary: string | null;
}

interface ProjectManagementDocumentDetailProps {
  presentation: ProjectManagementDocumentPresentation;
  document: ProjectManagementDocument | null;
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  statuses: string[];
  saving: boolean;
  aiCommands: AiCommandConfig | null;
  aiJob: AiCommandJob | null;
  documentRunJob: AiCommandJob | null;
  selectedWorktreeBranch: string | null;
  documentViewMode: ProjectManagementDocumentViewMode;
  editFormTab: ProjectManagementDocumentFormViewMode;
  editTitle: string;
  editSummary: string;
  editMarkdown: string;
  editTags: string;
  editStatus: string;
  editAssignee: string;
  dependencySelection: string[];
  currentDependencyDocuments: ProjectManagementDocumentSummary[];
  aiRunSummary: string | null;
  documentRunSummary: string | null;
  aiFailureToast: string | null;
  documentRunFailureToast: string | null;
  aiRequestModalOpen: boolean;
  aiOutputModalOpen: boolean;
  dependencyModalOpen: boolean;
  documentWorktreeModalOpen: boolean;
  selectedAiCommandId: AiCommandId;
  aiCommandOptions: MatrixDropdownOption[];
  linkedWorktrees: WorktreeRecord[];
  currentLinkedWorktree: WorktreeRecord | null;
  canContinueCurrent: boolean;
  generatedWorktreeName: string;
  documentWorktreeInstructions: string;
  documentWorktreeStrategy: "new" | "continue-current";
  documentWorktreeName: string;
  compactDocumentSummary: string[];
  metadataControlsDisabled: boolean;
  assigneeActionDisabled: boolean;
  selectedDocumentAiOutput: SelectedDocumentAiOutput | null;
  inlineSelectedAiOutput: SelectedDocumentAiOutput | null;
  onClose: () => void;
  onOpenPage: () => void;
  onDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
  onEditFormTabChange: (mode: ProjectManagementDocumentFormViewMode) => void;
  onEditTitleChange: (value: string) => void;
  onEditSummaryChange: (value: string) => void;
  onEditMarkdownChange: (value: string) => void;
  onEditTagsChange: (value: string) => void;
  onEditStatusChange: (value: string) => void;
  onEditAssigneeChange: (value: string) => void;
  onSetEditingState: (editing: boolean) => void;
  onSaveDocument: () => Promise<void>;
  onQuickDocumentUpdate: (overrides: { status?: string; assignee?: string; archived?: boolean }) => Promise<void>;
  onSaveAssignee: () => Promise<void>;
  onToggleArchive: () => Promise<void>;
  onSelectWorktree: (branch: string) => void;
  onOpenDependencyGraph: () => void;
  onOpenDependencyModal: () => void;
  onCloseDependencyModal: () => void;
  onToggleDependencySelection: (dependencyId: string) => Promise<void>;
  onOpenAiRequest: () => void;
  onCloseAiRequest: () => void;
  onAiChangeRequestChange: (value: string) => void;
  aiChangeRequest: string;
  onSelectedAiCommandIdChange: (commandId: AiCommandId) => void;
  onRunUiMagic: () => Promise<boolean>;
  onCancelAiCommand: () => Promise<AiCommandJob | null>;
  onDismissAiFailureToast: () => void;
  onDismissDocumentRunFailureToast: () => void;
  onOpenDocumentWorktreeModal: () => void;
  onCloseDocumentWorktreeModal: () => void;
  onDocumentWorktreeInstructionsChange: (value: string) => void;
  onDocumentWorktreeStrategyChange: (value: "new" | "continue-current") => void;
  onDocumentWorktreeNameChange: (value: string) => void;
  onRunDocumentWork: () => Promise<boolean>;
  onCancelDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onOpenAiOutputModal: () => void;
  onCloseAiOutputModal: () => void;
  onCancelSelectedDocumentAiOutput: () => Promise<void>;
}

export function ProjectManagementDocumentDetail({
  presentation,
  document,
  documents,
  availableTags,
  statuses,
  saving,
  aiCommands,
  aiJob,
  documentRunJob,
  selectedWorktreeBranch,
  documentViewMode,
  editFormTab,
  editTitle,
  editSummary,
  editMarkdown,
  editTags,
  editStatus,
  editAssignee,
  dependencySelection,
  currentDependencyDocuments,
  aiRunSummary,
  documentRunSummary,
  aiFailureToast,
  documentRunFailureToast,
  aiRequestModalOpen,
  aiOutputModalOpen,
  dependencyModalOpen,
  documentWorktreeModalOpen,
  selectedAiCommandId,
  aiCommandOptions,
  linkedWorktrees,
  currentLinkedWorktree,
  canContinueCurrent,
  generatedWorktreeName,
  documentWorktreeInstructions,
  documentWorktreeStrategy,
  documentWorktreeName,
  compactDocumentSummary,
  metadataControlsDisabled,
  assigneeActionDisabled,
  selectedDocumentAiOutput,
  inlineSelectedAiOutput,
  onClose,
  onOpenPage,
  onDocumentViewModeChange,
  onEditFormTabChange,
  onEditTitleChange,
  onEditSummaryChange,
  onEditMarkdownChange,
  onEditTagsChange,
  onEditStatusChange,
  onEditAssigneeChange,
  onSetEditingState,
  onSaveDocument,
  onQuickDocumentUpdate,
  onSaveAssignee,
  onToggleArchive,
  onSelectWorktree,
  onOpenDependencyGraph,
  onOpenDependencyModal,
  onCloseDependencyModal,
  onToggleDependencySelection,
  onOpenAiRequest,
  onCloseAiRequest,
  onAiChangeRequestChange,
  aiChangeRequest,
  onSelectedAiCommandIdChange,
  onRunUiMagic,
  onCancelAiCommand,
  onDismissAiFailureToast,
  onDismissDocumentRunFailureToast,
  onOpenDocumentWorktreeModal,
  onCloseDocumentWorktreeModal,
  onDocumentWorktreeInstructionsChange,
  onDocumentWorktreeStrategyChange,
  onDocumentWorktreeNameChange,
  onRunDocumentWork,
  onCancelDocumentAiCommand,
  onOpenAiOutputModal,
  onCloseAiOutputModal,
  onCancelSelectedDocumentAiOutput,
}: ProjectManagementDocumentDetailProps) {
  const documentViewGroupId = presentation === "modal"
    ? "project-management-document-view"
    : "project-management-document-page-view";
  const editFormTabsId = presentation === "modal"
    ? "project-management-edit-form"
    : "project-management-document-page-edit-form";
  const aiRunning = aiJob?.status === "running";
  const documentRunInProgress = documentRunJob?.status === "running";
  const documentRunTargetsSelectedDocument = Boolean(document && documentRunJob?.documentId === document.id);
  const documentRunTargetsSelectedWorktree = Boolean(selectedWorktreeBranch && documentRunJob?.branch === selectedWorktreeBranch);
  const activeDocumentRunInSelectedWorktree = documentRunInProgress && documentRunTargetsSelectedDocument && documentRunTargetsSelectedWorktree;
  const activeDocumentRunForSelectedDocument = documentRunInProgress && documentRunTargetsSelectedDocument;

  const content = (
    <>
      {aiFailureToast ? (
        <div className="pm-inline-toast mb-3 flex items-center justify-between gap-3 border px-3 py-2 text-sm">
          <span>{aiFailureToast}</span>
          <button type="button" className="matrix-button rounded-none px-2 py-1 text-xs" onClick={onDismissAiFailureToast}>
            Dismiss
          </button>
        </div>
      ) : null}

      {documentRunFailureToast ? (
        <div className="pm-inline-toast mb-3 flex items-center justify-between gap-3 border px-3 py-2 text-sm">
          <span>{documentRunFailureToast}</span>
          <button type="button" className="matrix-button rounded-none px-2 py-1 text-xs" onClick={onDismissDocumentRunFailureToast}>
            Dismiss
          </button>
        </div>
      ) : null}

      {document ? (
        <MatrixTabs
          groupId={documentViewGroupId}
          ariaLabel="Project document view tabs"
          activeTabId={documentViewMode}
          onChange={onDocumentViewModeChange}
          className="theme-divider border-b pb-3"
          tabs={[
            { id: "document", label: "Document", panelId: getMatrixTabPanelId(documentViewGroupId, "document") },
            { id: "edit", label: "Edit", panelId: getMatrixTabPanelId(documentViewGroupId, "edit") },
          ]}
        />
      ) : null}

      <MatrixSectionIntro
        kicker={presentation === "page" ? "Project management document" : "Document modal"}
        title={document?.title ?? "Select a document"}
        status={document ? (
          <div className="flex flex-wrap gap-1">
            {compactDocumentSummary.map((item) => <MatrixBadge key={item} tone="neutral" compact>{item}</MatrixBadge>)}
            {document.tags.map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
            <MatrixBadge tone="neutral" compact>
              {document.dependencies.length} dependenc{document.dependencies.length === 1 ? "y" : "ies"}
            </MatrixBadge>
          </div>
        ) : undefined}
        actions={(
          <>
            <div className="flex flex-wrap gap-2">
              {presentation === "modal" ? (
                <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={onOpenPage}>
                  Open full page
                </button>
              ) : (
                <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={onClose}>
                  Back to documents
                </button>
              )}
            </div>
            {documentViewMode === "document" ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className={`matrix-button rounded-none px-3 py-2 text-sm font-semibold ${activeDocumentRunInSelectedWorktree ? "pm-ai-button-running" : ""}`}
                  onClick={onOpenDocumentWorktreeModal}
                  title={activeDocumentRunInSelectedWorktree ? "Worktree AI is running" : "Start worktree AI"}
                  disabled={!document || activeDocumentRunForSelectedDocument}
                >
                  {activeDocumentRunInSelectedWorktree ? "Start Worktree AI (running)" : "Start Worktree AI"}
                </button>
                {activeDocumentRunInSelectedWorktree && documentRunJob?.branch ? (
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    onClick={() => void onCancelDocumentAiCommand(documentRunJob.branch!)}
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
                  onClick={onOpenAiRequest}
                  title={aiRunning ? "⚡ is running" : "Open AI request"}
                  disabled={!document || aiRunning}
                >
                  {aiRunning ? "⚡ Running..." : "⚡ AI"}
                </button>
                {aiRunning ? (
                  <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={() => void onCancelAiCommand()}>
                    Cancel AI
                  </button>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={!document || saving || aiRunning || documentViewMode !== "edit"}
              onClick={() => void onSaveDocument()}
            >
              Save document
            </button>
          </>
        )}
        className="mt-3"
      />

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
                options={statuses.map((entry) => ({ value: entry, label: entry, description: "Board lane" }))}
                placeholder="Select lane"
                disabled={metadataControlsDisabled}
                onChange={(value) => {
                  onEditStatusChange(value);
                  void onQuickDocumentUpdate({ status: value });
                }}
              />
            </div>
            <form
              className="flex min-w-0 flex-1 flex-col gap-2 sm:flex-row sm:items-end"
              onSubmit={(event) => {
                event.preventDefault();
                void onSaveAssignee();
              }}
            >
              <label className="min-w-0 flex-1 space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Assignee</span>
                <input
                  value={editAssignee}
                  onChange={(event) => onEditAssigneeChange(event.target.value)}
                  placeholder="Assignee"
                  disabled={metadataControlsDisabled}
                  className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <button type="submit" className="matrix-button h-10 rounded-none px-3 text-sm font-semibold" disabled={assigneeActionDisabled}>
                {editAssignee ? "Save assignee" : document.assignee ? "Clear assignee" : "Save assignee"}
              </button>
            </form>
            <div className="flex flex-wrap gap-2 xl:flex-none">
              <button
                type="button"
                className="matrix-button h-10 rounded-none px-3 text-sm font-semibold"
                disabled={metadataControlsDisabled}
                onClick={() => void onToggleArchive()}
              >
                {document.archived ? "Restore document" : "Archive document"}
              </button>
              {document.archived ? <MatrixBadge tone="warning">Archived</MatrixBadge> : null}
            </div>
          </div>
          <p className="mt-3 text-xs theme-text-muted">Update the lane, assignee, or archive state here without leaving the document view.</p>
        </div>
      ) : null}

      {inlineSelectedAiOutput ? (
        <div className="mt-3">
          <ProjectManagementAiStreamViewer
            source={inlineSelectedAiOutput.source}
            jobId={inlineSelectedAiOutput.job.jobId}
            summary={inlineSelectedAiOutput.summary}
            fallbackJob={inlineSelectedAiOutput.job}
            onCancel={() => void onCancelSelectedDocumentAiOutput()}
            onOpenModal={onOpenAiOutputModal}
          />
        </div>
      ) : null}

      {document && documentViewMode === "edit" ? (
        <div className="mt-3">
          <ProjectManagementDocumentForm
            tabsId={editFormTabsId}
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
            onTitleChange={onEditTitleChange}
            onSummaryChange={onEditSummaryChange}
            onTagsChange={onEditTagsChange}
            onMarkdownChange={onEditMarkdownChange}
            onStatusChange={onEditStatusChange}
            onAssigneeChange={onEditAssigneeChange}
            onSubmit={onSaveDocument}
            onEditingStateChange={onSetEditingState}
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
              <p className="mt-2 whitespace-pre-wrap text-sm theme-text-muted">{document.summary || "No short summary yet."}</p>
            </div>
            <div className="border theme-border-subtle p-4">
              <div className="pm-markdown text-sm theme-text" dangerouslySetInnerHTML={{ __html: marked.parse(document.markdown) }} />
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
                  <button type="button" className="matrix-button rounded-none px-2 py-1 text-xs" onClick={onOpenDependencyModal} disabled={saving || aiRunning}>
                    Manage dependencies
                  </button>
                  <button type="button" className="matrix-button rounded-none px-2 py-1 text-xs" onClick={onOpenDependencyGraph}>
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
                        onClick={() => void onToggleDependencySelection(entry.id)}
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
          Select a document to inspect its markdown, tags, and linked worktrees.
        </div>
      )}

      {aiRequestModalOpen && document && documentViewMode === "edit" ? (
        <MatrixModal
          kicker="AI request"
          title={<>Update `{document.title}`</>}
          description="Pick Smart AI or Simple AI, describe the change you want, then run it to update the saved document on the server for this worktree."
          closeLabel="Close AI request"
          maxWidthClass="max-w-2xl"
          onClose={onCloseAiRequest}
          footer={(
            <button type="submit" form="pm-ai-request-form" className="matrix-button rounded-none px-3 py-2 text-sm font-semibold" disabled={aiRunning}>
              {aiRunning ? "⚡ Running..." : "Run ⚡"}
            </button>
          )}
        >
          <form
            id="pm-ai-request-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onRunUiMagic();
            }}
          >
            <div>
              <MatrixDropdown
                label="AI command"
                value={selectedAiCommandId}
                options={aiCommandOptions}
                placeholder="Choose AI command"
                onChange={(value) => onSelectedAiCommandIdChange(value === "simple" ? "simple" : "smart")}
                disabled={aiRunning}
              />
            </div>
            <div>
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">What should change?</span>
                <textarea
                  value={aiChangeRequest}
                  onChange={(event) => onAiChangeRequestChange(event.target.value)}
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
          onClose={onCloseDocumentWorktreeModal}
          footer={(
            <button type="submit" form="pm-document-worktree-form" className="matrix-button rounded-none px-3 py-2 text-sm font-semibold" disabled={activeDocumentRunForSelectedDocument}>
              {activeDocumentRunForSelectedDocument ? "Worktree AI running..." : "Start Worktree AI"}
            </button>
          )}
        >
          <form
            id="pm-document-worktree-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void onRunDocumentWork();
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
                    onChange={() => onDocumentWorktreeStrategyChange("continue-current")}
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
                    onChange={() => onDocumentWorktreeStrategyChange("new")}
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
                  onChange={(event) => onDocumentWorktreeNameChange(event.target.value)}
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
                onChange={(event) => onDocumentWorktreeInstructionsChange(event.target.value)}
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
          onClose={onCloseAiOutputModal}
        >
          <ProjectManagementAiStreamViewer
            source={selectedDocumentAiOutput.source}
            jobId={selectedDocumentAiOutput.job.jobId}
            summary={selectedDocumentAiOutput.summary}
            fallbackJob={selectedDocumentAiOutput.job}
            expanded
            onCancel={() => void onCancelSelectedDocumentAiOutput()}
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
          onClose={onCloseDependencyModal}
          onOpenGraph={onOpenDependencyGraph}
          onToggleDependency={(dependencyId) => {
            void onToggleDependencySelection(dependencyId);
          }}
        />
      ) : null}
    </>
  );

  if (presentation === "modal") {
    return (
      <MatrixModal
        kicker="Project management"
        title={document ? <>#{document.number} {document.title}</> : <>Document</>}
        description={document ? `Updated ${formatDocumentTimestamp(document.updatedAt)}.` : "Open a document to view or edit it."}
        closeLabel="Close document"
        maxWidthClass="max-w-6xl"
        onClose={onClose}
      >
        {content}
      </MatrixModal>
    );
  }

  return <div>{content}</div>;
}
