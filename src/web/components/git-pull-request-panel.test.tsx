import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary, ProjectManagementHistoryEntry, WorktreeRecord } from "@shared/types";
import { GitPullRequestPanel } from "./git-pull-request-panel";

const WORKTREE_ID = "33333333333333333333333333333333" as WorktreeRecord["id"];

const pullRequestSummary: ProjectManagementDocumentSummary = {
  id: "pr-1",
  number: 14,
  title: "Add pull request workspace",
  summary: "Ship the GitHub-style review tab.",
  kind: "pull-request",
  pullRequest: {
    baseBranch: "main",
    compareBranch: "feature/pull-request-workspace",
    state: "open",
    draft: true,
  },
  tags: ["pull-request", "feature"],
  dependencies: [],
  status: "in-progress",
  assignee: "Riley",
  archived: false,
  createdAt: "2026-03-26T10:00:00.000Z",
  updatedAt: "2026-03-27T11:00:00.000Z",
  historyCount: 3,
};

const pullRequestDocument: ProjectManagementDocument = {
  ...pullRequestSummary,
  markdown: "# Summary\n\n- Add PR tab\n- Hide PR docs from PM workspace\n",
  comments: [
    {
      id: "comment-1",
      body: "## Review note\n\nLooks good. Please verify the **final copy**.",
      createdAt: "2026-03-27T11:30:00.000Z",
      authorName: "Casey Reviewer",
      authorEmail: "casey@example.com",
    },
  ],
};

const pullRequestHistory: ProjectManagementHistoryEntry[] = [
  {
    commitSha: "abc123",
    batchId: "batch-1",
    createdAt: "2026-03-27T12:00:00.000Z",
    actorId: "actor-1",
    authorName: "Casey Reviewer",
    authorEmail: "casey@example.com",
    documentId: "pr-1",
    number: 14,
    title: "Add pull request workspace",
    tags: ["pull-request", "feature"],
    status: "in-progress",
    assignee: "Riley",
    archived: false,
    changeCount: 1,
    action: "comment",
    diff: "@@\n+Looks good",
  },
];

const sampleWorktree: WorktreeRecord = {
  id: WORKTREE_ID,
  branch: "feature/pull-request-workspace",
  worktreePath: "/repo/.worktrees/feature-pull-request-workspace",
  isBare: false,
  isDetached: false,
  locked: false,
  prunable: false,
};

function renderPanel(overrides: Partial<Parameters<typeof GitPullRequestPanel>[0]> = {}) {
  const props: Parameters<typeof GitPullRequestPanel>[0] = {
    worktree: sampleWorktree,
    documents: [pullRequestSummary],
    document: pullRequestDocument,
    history: pullRequestHistory,
    loading: false,
    saving: false,
    availableStatuses: ["backlog", "todo", "in-progress", "blocked", "done", "reference"],
    selectedDocumentId: pullRequestSummary.id,
    branchOptions: [
      { value: "main", label: "main" },
      { value: "release", label: "release" },
    ],
    defaultBaseBranch: "main",
    onSelectDocument: async () => null,
    onCreatePullRequest: async () => null,
    onUpdatePullRequest: async () => null,
    onAddComment: async () => null,
    ...overrides,
  };

  return renderToStaticMarkup(<GitPullRequestPanel {...props} />);
}

test("pull request panel renders PR details, comments, and activity", () => {
  const markup = renderPanel({
    comparisonWorkspace: <div>Branch comparison workspace</div>,
  });

  assert.match(markup, /Pull request/);
  assert.match(markup, /Add pull request workspace/);
  assert.match(markup, /Branch comparison workspace/);
  assert.match(markup, /feature\/pull-request-workspace → main/);
  assert.match(markup, /Ship the GitHub-style review tab\./);
  assert.match(markup, /Rendered from the pull request markdown document\./);
  assert.match(markup, /<h2>Review note<\/h2>/);
  assert.match(markup, /Looks good\. Please verify the <strong>final copy<\/strong>\./);
  assert.match(markup, /Saved with your repo git user attribution\./);
  assert.match(markup, /Recent activity/);
  assert.match(markup, /Comment added/);
  assert.match(markup, /Edit pull request/);
  assert.match(markup, /Save pull request/);
});

test("pull request panel renders AI review action state", () => {
  const markup = renderPanel({
    onReviewByAi: async () => null,
    aiReviewJob: {
      jobId: "job-ai-review",
      fileName: "job-ai-review.json",
      worktreeId: sampleWorktree.id,
      branch: sampleWorktree.branch,
      documentId: pullRequestDocument.id,
      commandId: "smart",
      command: "runner --prompt",
      input: "Review the pull request.",
      status: "running",
      startedAt: "2026-03-27T12:30:00.000Z",
      stdout: "",
      stderr: "",
      origin: {
        kind: "git-pull-request-review",
        label: "Git pull request review",
        location: {
          tab: "git",
          branch: sampleWorktree.branch,
          gitBaseBranch: "main",
          documentId: pullRequestDocument.id,
        },
      },
    },
  });

  assert.match(markup, /AI review running\.\.\./);
});

test("pull request panel renders create state when no PR is selected", () => {
  const markup = renderPanel({
    documents: [],
    document: null,
    history: [],
    selectedDocumentId: null,
  });

  assert.match(markup, /Review-ready branch handoff/);
  assert.match(markup, /Create pull request/);
  assert.match(markup, /Open a review document for this branch/);
  assert.match(markup, /This creates a durable pull request document that stays out of the normal Project management workspace\./);
  assert.match(markup, /placeholder="Summarize what this pull request changes"/);
  assert.match(markup, /placeholder="feature\/my-branch"/);
  assert.match(markup, /Create pull request/);
});
