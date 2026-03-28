import { useEffect, useMemo, useState, type ReactNode } from "react";
import { marked } from "marked";
import type {
  AiCommandJob,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementPullRequestState,
  WorktreeRecord,
} from "@shared/types";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixDetailField } from "./matrix-primitives";

interface GitPullRequestPanelProps {
  worktree: WorktreeRecord | null;
  documents: ProjectManagementDocumentSummary[];
  document: ProjectManagementDocument | null;
  history: ProjectManagementHistoryEntry[];
  loading: boolean;
  saving: boolean;
  availableStatuses: string[];
  selectedDocumentId: string | null;
  branchOptions: MatrixDropdownOption[];
  defaultBaseBranch: string | null;
  comparisonWorkspace?: ReactNode;
  aiReviewJob?: AiCommandJob | null;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreatePullRequest: (payload: {
    title: string;
    summary?: string;
    markdown: string;
    status?: string;
    assignee?: string;
    baseBranch: string;
    compareBranch: string;
    draft: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdatePullRequest: (documentId: string, payload: {
    title: string;
    summary?: string;
    markdown: string;
    status?: string;
    assignee?: string;
    baseBranch: string;
    compareBranch: string;
    state: ProjectManagementPullRequestState;
    draft: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onAddComment: (documentId: string, payload: { body: string }) => Promise<ProjectManagementDocument | null>;
  onReviewByAi?: (payload: {
    documentId: string;
    baseBranch: string;
    compareBranch: string;
  }) => Promise<AiCommandJob | null>;
}

function getPullRequestTone(state: ProjectManagementPullRequestState) {
  if (state === "merged") {
    return "active" as const;
  }

  if (state === "closed") {
    return "danger" as const;
  }

  return "warning" as const;
}

function summarizeHistoryAction(entry: ProjectManagementHistoryEntry): string {
  if (entry.action === "comment") {
    return "Comment added";
  }

  if (entry.action === "archive") {
    return "Archived";
  }

  if (entry.action === "restore") {
    return "Restored";
  }

  return entry.action === "create" ? "Created" : "Updated";
}

export function GitPullRequestPanel({
  worktree,
  documents,
  document,
  history,
  loading,
  saving,
  availableStatuses,
  selectedDocumentId,
  branchOptions,
  defaultBaseBranch,
  comparisonWorkspace,
  aiReviewJob,
  onSelectDocument,
  onCreatePullRequest,
  onUpdatePullRequest,
  onAddComment,
  onReviewByAi,
}: GitPullRequestPanelProps) {
  const [titleDraft, setTitleDraft] = useState("");
  const [summaryDraft, setSummaryDraft] = useState("");
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [assigneeDraft, setAssigneeDraft] = useState("");
  const [baseBranchDraft, setBaseBranchDraft] = useState<string | null>(defaultBaseBranch);
  const [compareBranchDraft, setCompareBranchDraft] = useState("");
  const [draftMode, setDraftMode] = useState(false);
  const [stateDraft, setStateDraft] = useState<ProjectManagementPullRequestState>("open");
  const [commentDraft, setCommentDraft] = useState("");

  const [newTitle, setNewTitle] = useState("");
  const [newSummary, setNewSummary] = useState("");
  const [newMarkdown, setNewMarkdown] = useState("");
  const [newStatus, setNewStatus] = useState(availableStatuses[0] ?? "backlog");
  const [newAssignee, setNewAssignee] = useState("");
  const [newBaseBranch, setNewBaseBranch] = useState<string | null>(defaultBaseBranch);
  const [newCompareBranch, setNewCompareBranch] = useState(worktree?.branch ?? "");
  const [newDraftMode, setNewDraftMode] = useState(false);

  useEffect(() => {
    setNewBaseBranch(defaultBaseBranch);
  }, [defaultBaseBranch]);

  useEffect(() => {
    if (worktree?.branch) {
      setNewCompareBranch((current) => current || worktree.branch);
    }
  }, [worktree?.branch]);

  useEffect(() => {
    if (!document?.pullRequest) {
      setCommentDraft("");
      return;
    }

    setTitleDraft(document.title);
    setSummaryDraft(document.summary ?? "");
    setMarkdownDraft(document.markdown);
    setStatusDraft(document.status ?? "");
    setAssigneeDraft(document.assignee ?? "");
    setBaseBranchDraft(document.pullRequest.baseBranch);
    setCompareBranchDraft(document.pullRequest.compareBranch);
    setDraftMode(document.pullRequest.draft);
    setStateDraft(document.pullRequest.state);
    setCommentDraft("");
  }, [document]);

  const selectedSummary = useMemo(
    () => documents.find((entry) => entry.id === selectedDocumentId) ?? null,
    [documents, selectedDocumentId],
  );

  const documentOptions = useMemo<MatrixDropdownOption[]>(
    () => documents.map((entry) => ({
      value: entry.id,
      label: `#${entry.number} ${entry.title}`,
      description: entry.pullRequest
        ? `${entry.pullRequest.compareBranch} → ${entry.pullRequest.baseBranch}`
        : entry.summary || "Pull request",
      badgeLabel: entry.pullRequest?.state === "merged"
        ? "Merged"
        : entry.pullRequest?.state === "closed"
          ? "Closed"
          : entry.pullRequest?.draft
            ? "Draft"
            : "Open",
      badgeTone: entry.pullRequest?.state === "merged" ? "active" : "idle",
    })),
    [documents],
  );

  const bodyHtml = useMemo(
    () => (document?.markdown ? marked.parse(document.markdown) : ""),
    [document?.markdown],
  );

  const canCreatePullRequest = Boolean(newTitle.trim() && newBaseBranch?.trim() && newCompareBranch.trim());
  const canSavePullRequest = Boolean(document?.id && titleDraft.trim() && baseBranchDraft?.trim() && compareBranchDraft.trim());
  const canComment = Boolean(document?.id && commentDraft.trim());
  const branchDescription = document?.pullRequest
    ? `${document.pullRequest.compareBranch} → ${document.pullRequest.baseBranch}`
    : selectedSummary?.pullRequest
      ? `${selectedSummary.pullRequest.compareBranch} → ${selectedSummary.pullRequest.baseBranch}`
      : null;

  return (
    <div className="mt-4 space-y-4">
      <div className="theme-inline-panel p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0 flex-1">
            <p className="matrix-kicker">Pull request</p>
            <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">
              {document?.title ?? "Review-ready branch handoff"}
            </h2>
            <p className="mt-2 text-sm theme-text-muted">
              Track branch intent, reviewer context, and discussion in the same durable document history used for project management.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(18rem,1fr)_auto] xl:min-w-[34rem]">
            <MatrixDropdown
              label="Pull request"
              value={selectedDocumentId}
              options={documentOptions}
              placeholder="Choose pull request"
              disabled={!documentOptions.length}
              emptyLabel="No pull requests yet"
              onChange={(value) => {
                if (!value) {
                  return;
                }

                void onSelectDocument(value, { silent: true });
              }}
            />
            <div className="flex items-end">
              {document?.pullRequest ? (
                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex flex-wrap gap-2">
                    <MatrixBadge tone={getPullRequestTone(document.pullRequest.state)}>
                      {document.pullRequest.state}
                    </MatrixBadge>
                    {document.pullRequest.draft ? <MatrixBadge tone="warning">draft</MatrixBadge> : null}
                  </div>
                  {onReviewByAi ? (
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      disabled={!worktree?.branch || saving || aiReviewJob?.status === "running"}
                      onClick={() => {
                        if (!document.id || !document.pullRequest) {
                          return;
                        }

                        void onReviewByAi({
                          documentId: document.id,
                          baseBranch: document.pullRequest.baseBranch,
                          compareBranch: document.pullRequest.compareBranch,
                        });
                      }}
                    >
                      {aiReviewJob?.status === "running" ? "AI review running..." : "Review by AI"}
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="text-sm theme-text-muted">Create a PR document to start review discussion.</div>
              )}
            </div>
          </div>
        </div>

        {branchDescription ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <MatrixBadge tone="neutral">{branchDescription}</MatrixBadge>
            {document?.status ? <MatrixBadge tone="neutral">lane: {document.status}</MatrixBadge> : null}
            {document?.assignee ? <MatrixBadge tone="neutral">owner: {document.assignee}</MatrixBadge> : null}
          </div>
        ) : null}
      </div>

      {comparisonWorkspace ? comparisonWorkspace : null}

      {!document?.pullRequest ? (
        <div className="theme-inline-panel p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1">
              <p className="matrix-kicker">Create pull request</p>
              <h3 className="mt-2 text-xl font-semibold theme-text-strong">Open a review document for this branch</h3>
              <p className="mt-2 text-sm theme-text-muted">
                This creates a durable pull request document that stays out of the normal Project management workspace.
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
            <div className="space-y-3">
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Title</span>
                <input
                  value={newTitle}
                  onChange={(event) => setNewTitle(event.target.value)}
                  placeholder="Summarize what this pull request changes"
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Summary</span>
                <input
                  value={newSummary}
                  onChange={(event) => setNewSummary(event.target.value)}
                  placeholder="One-line context for the PR list"
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>

              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Description</span>
                <textarea
                  value={newMarkdown}
                  onChange={(event) => setNewMarkdown(event.target.value)}
                  rows={12}
                  placeholder="Describe the change, testing notes, and anything reviewers should focus on."
                  className="matrix-input min-h-[16rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                />
              </label>
            </div>

            <div className="space-y-3">
              <MatrixDropdown
                label="Base branch"
                value={newBaseBranch}
                options={branchOptions}
                placeholder="Choose base branch"
                disabled={!branchOptions.length}
                emptyLabel="No branches available"
                onChange={setNewBaseBranch}
              />
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Compare branch</span>
                <input
                  value={newCompareBranch}
                  onChange={(event) => setNewCompareBranch(event.target.value)}
                  placeholder="feature/my-branch"
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <MatrixDropdown
                label="Lane"
                value={newStatus}
                options={availableStatuses.map((status) => ({ value: status, label: status }))}
                placeholder="Choose lane"
                disabled={!availableStatuses.length}
                emptyLabel="No statuses available"
                onChange={(value) => setNewStatus(value ?? availableStatuses[0] ?? "backlog")}
              />
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Assignee</span>
                <input
                  value={newAssignee}
                  onChange={(event) => setNewAssignee(event.target.value)}
                  placeholder="Reviewer or owner"
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <label className="flex items-center gap-3 border theme-border-subtle px-3 py-3 text-sm theme-text">
                <input type="checkbox" checked={newDraftMode} onChange={(event) => setNewDraftMode(event.target.checked)} />
                Start as draft
              </label>
              <button
                type="button"
                className="matrix-button w-full rounded-none px-3 py-2 text-sm font-semibold"
                disabled={!canCreatePullRequest || saving}
                onClick={async () => {
                  const nextDocument = await onCreatePullRequest({
                    title: newTitle.trim(),
                    summary: newSummary.trim() || undefined,
                    markdown: newMarkdown,
                    status: newStatus || undefined,
                    assignee: newAssignee.trim() || undefined,
                    baseBranch: newBaseBranch?.trim() ?? "",
                    compareBranch: newCompareBranch.trim(),
                    draft: newDraftMode,
                  });

                  if (!nextDocument) {
                    return;
                  }

                  setNewTitle("");
                  setNewSummary("");
                  setNewMarkdown("");
                  setNewAssignee("");
                  setNewDraftMode(false);
                }}
              >
                Create pull request
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,0.55fr)]">
          <div className="space-y-4">
            <div className="theme-inline-panel p-4">
              <div className="flex flex-wrap items-center gap-2">
                <MatrixBadge tone={getPullRequestTone(document.pullRequest.state)}>
                  {document.pullRequest.state}
                </MatrixBadge>
                {document.pullRequest.draft ? <MatrixBadge tone="warning">draft</MatrixBadge> : null}
                <MatrixBadge tone="neutral">#{document.number}</MatrixBadge>
              </div>
              {document.summary ? (
                <p className="mt-3 text-sm theme-text-muted">{document.summary}</p>
              ) : null}
            </div>

            <div className="theme-inline-panel p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="matrix-kicker">Description</p>
                  <p className="mt-2 text-sm theme-text-muted">Rendered from the pull request markdown document.</p>
                </div>
              </div>
              <div
                className="prose prose-invert mt-4 max-w-none text-sm"
                dangerouslySetInnerHTML={{ __html: bodyHtml || "<p>No description yet.</p>" }}
              />
            </div>

            <div className="theme-inline-panel p-4">
              <div>
                <p className="matrix-kicker">Comments</p>
                <p className="mt-2 text-sm theme-text-muted">Discuss review notes, blockers, and merge decisions here.</p>
              </div>

              <div className="mt-4 space-y-3">
                {document.comments.length ? document.comments.map((comment) => (
                  <div key={comment.id} className="border theme-border-subtle px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs theme-text-soft">
                      <span className="font-semibold theme-text-strong">{comment.authorName || comment.authorEmail || "Unknown author"}</span>
                      {comment.authorEmail ? <span>{comment.authorEmail}</span> : null}
                      <span>{new Date(comment.createdAt).toLocaleString()}</span>
                    </div>
                    <p className="mt-3 whitespace-pre-wrap text-sm theme-text">{comment.body}</p>
                  </div>
                )) : (
                  <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                    No comments yet. Add review context, merge notes, or follow-up decisions here.
                  </div>
                )}
              </div>

              <label className="mt-4 block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Add comment</span>
                <textarea
                  value={commentDraft}
                  onChange={(event) => setCommentDraft(event.target.value)}
                  rows={5}
                  placeholder="Share review feedback or next steps"
                  className="matrix-input min-h-[8rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                />
              </label>
              <div className="mt-3 flex items-center justify-between gap-3">
                <p className="text-xs theme-text-soft">Saved with your repo git user attribution.</p>
                <button
                  type="button"
                  className="matrix-button rounded-none px-3 py-2 text-sm"
                  disabled={!canComment || saving}
                  onClick={async () => {
                    if (!document.id) {
                      return;
                    }

                    const result = await onAddComment(document.id, { body: commentDraft.trim() });
                    if (result) {
                      setCommentDraft("");
                    }
                  }}
                >
                  Add comment
                </button>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="theme-inline-panel p-4">
              <p className="matrix-kicker">Details</p>
              <div className="mt-4 grid gap-3 text-sm">
                <MatrixDetailField label="Base" value={document.pullRequest.baseBranch} mono />
                <MatrixDetailField label="Compare" value={document.pullRequest.compareBranch} mono />
                <MatrixDetailField label="Updated" value={new Date(document.updatedAt).toLocaleString()} />
                <MatrixDetailField label="Comments" value={String(document.comments.length)} mono />
              </div>
            </div>

            <div className="theme-inline-panel p-4 space-y-3">
              <p className="matrix-kicker">Edit pull request</p>
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Title</span>
                <input
                  value={titleDraft}
                  onChange={(event) => setTitleDraft(event.target.value)}
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Summary</span>
                <input
                  value={summaryDraft}
                  onChange={(event) => setSummaryDraft(event.target.value)}
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Description</span>
                <textarea
                  value={markdownDraft}
                  onChange={(event) => setMarkdownDraft(event.target.value)}
                  rows={10}
                  className="matrix-input min-h-[12rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                />
              </label>
              <MatrixDropdown
                label="Base branch"
                value={baseBranchDraft}
                options={branchOptions}
                placeholder="Choose base branch"
                disabled={!branchOptions.length}
                emptyLabel="No branches available"
                onChange={setBaseBranchDraft}
              />
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Compare branch</span>
                <input
                  value={compareBranchDraft}
                  onChange={(event) => setCompareBranchDraft(event.target.value)}
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <MatrixDropdown
                label="Review state"
                value={stateDraft}
                options={[
                  { value: "open", label: "open" },
                  { value: "closed", label: "closed" },
                  { value: "merged", label: "merged" },
                ]}
                placeholder="Choose state"
                onChange={(value) => setStateDraft((value as ProjectManagementPullRequestState | null) ?? "open")}
              />
              <MatrixDropdown
                label="Lane"
                value={statusDraft}
                options={availableStatuses.map((status) => ({ value: status, label: status }))}
                placeholder="Choose lane"
                disabled={!availableStatuses.length}
                emptyLabel="No statuses available"
                onChange={(value) => setStatusDraft(value ?? "")}
              />
              <label className="block space-y-2">
                <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Assignee</span>
                <input
                  value={assigneeDraft}
                  onChange={(event) => setAssigneeDraft(event.target.value)}
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                />
              </label>
              <label className="flex items-center gap-3 border theme-border-subtle px-3 py-3 text-sm theme-text">
                <input type="checkbox" checked={draftMode} onChange={(event) => setDraftMode(event.target.checked)} />
                Mark as draft
              </label>
              <button
                type="button"
                className="matrix-button w-full rounded-none px-3 py-2 text-sm font-semibold"
                disabled={!canSavePullRequest || saving}
                onClick={() => void onUpdatePullRequest(document.id, {
                  title: titleDraft.trim(),
                  summary: summaryDraft.trim() || undefined,
                  markdown: markdownDraft,
                  status: statusDraft || undefined,
                  assignee: assigneeDraft.trim() || undefined,
                  baseBranch: baseBranchDraft?.trim() ?? "",
                  compareBranch: compareBranchDraft.trim(),
                  state: stateDraft,
                  draft: draftMode,
                })}
              >
                Save pull request
              </button>
            </div>

            <div className="theme-inline-panel p-4">
              <p className="matrix-kicker">Recent activity</p>
              <div className="mt-4 space-y-3">
                {history.length ? history.slice(0, 5).map((entry) => (
                  <div key={`${entry.commitSha}:${entry.changeCount}`} className="border theme-border-subtle px-3 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2 text-xs theme-text-soft">
                      <span className="font-semibold theme-text-strong">{summarizeHistoryAction(entry)}</span>
                      <span>{entry.authorName || entry.authorEmail || "Unknown author"}</span>
                      <span>{new Date(entry.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                )) : (
                  <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                    {loading ? "Loading pull request activity..." : "No saved pull request activity yet."}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
