import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AiCommandJob,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementUsersResponse,
  WorktreeRecord,
} from "@shared/types";
import { ProjectManagementBoardTab } from "./project-management-board-tab";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
import { ProjectManagementDocumentForm } from "./project-management-document-form";
import { getAiOutputEvents, getCompletedAiDocumentRefreshTarget, ProjectManagementPanel } from "./project-management-panel";

const sampleDocuments: ProjectManagementDocumentSummary[] = [
  {
    id: "doc-1",
    number: 1,
    title: "Dependencies",
    summary: "Track prerequisite document work.",
    kind: "document",
    pullRequest: null,
    tags: ["feature", "ux"],
    dependencies: ["doc-2"],
    status: "todo",
    assignee: "Eric",
    archived: false,
    createdAt: "2026-03-20T10:00:00.000Z",
    updatedAt: "2026-03-25T10:00:00.000Z",
    historyCount: 2,
  },
  {
    id: "doc-2",
    number: 2,
    title: "Shared document list",
    summary: "Normalize the shared document browser.",
    kind: "document",
    pullRequest: null,
    tags: ["plan"],
    dependencies: [],
    status: "in-progress",
    assignee: "Avery",
    archived: false,
    createdAt: "2026-03-19T10:00:00.000Z",
    updatedAt: "2026-03-24T10:00:00.000Z",
    historyCount: 4,
  },
  {
    id: "doc-3",
    number: 3,
    title: "Graph fallback",
    summary: "Reference behavior when the graph view is unavailable.",
    kind: "document",
    pullRequest: null,
    tags: ["reference"],
    dependencies: [],
    status: "reference",
    assignee: "",
    archived: false,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-23T10:00:00.000Z",
    historyCount: 1,
  },
];

const sampleDocument: ProjectManagementDocument = {
  ...sampleDocuments[0],
  markdown: "# Dependencies\n",
  comments: [],
};

const sampleWorktrees: WorktreeRecord[] = [
  {
    branch: "feature/doc-1-primary",
    worktreePath: "/repo/.worktrees/feature-doc-1-primary",
    isBare: false,
    isDetached: false,
    locked: false,
    prunable: false,
    linkedDocument: {
      id: "doc-1",
      number: 1,
      title: "Dependencies",
      summary: "Track prerequisite document work.",
      kind: "document",
      pullRequest: null,
      status: "todo",
      archived: false,
    },
  },
  {
    branch: "feature/doc-1-runtime",
    worktreePath: "/repo/.worktrees/feature-doc-1-runtime",
    isBare: false,
    isDetached: false,
    locked: false,
    prunable: false,
    linkedDocument: {
      id: "doc-1",
      number: 1,
      title: "Dependencies",
      summary: "Track prerequisite document work.",
      kind: "document",
      pullRequest: null,
      status: "todo",
      archived: false,
    },
    runtime: {
      branch: "feature/doc-1-runtime",
      worktreePath: "/repo/.worktrees/feature-doc-1-runtime",
      env: {},
      quickLinks: [],
      allocatedPorts: {},
      tmuxSession: "wtm-feature-doc-1-runtime",
    },
  },
];

const sampleHistory = [
  {
    commitSha: "abcdef1234567890",
    batchId: "batch-1",
    createdAt: "2026-03-25T11:00:00.000Z",
    actorId: "actor-1",
    authorName: "Casey Reviewer",
    authorEmail: "casey@example.com",
    documentId: "doc-1",
    number: 1,
    title: "Dependencies",
    tags: ["feature", "ux"],
    status: "todo",
    assignee: "Eric",
    archived: false,
    changeCount: 1,
    action: "comment" as const,
    diff: "@@\n+Need a final QA pass",
  },
];

const sampleUsers: ProjectManagementUsersResponse = {
  branch: "feature/doc-1-primary",
  config: {
    customUsers: [{ name: "Jordan Example", email: "jordan@example.com" }],
    archivedUserIds: ["user-2"],
  },
  users: [
    {
      id: "user-1",
      name: "Eric Woolley",
      email: "eric@example.com",
      source: "git",
      archived: false,
      avatarUrl: "https://www.gravatar.com/avatar/abc123?d=identicon&s=80",
      commitCount: 12,
      lastCommitAt: "2026-03-27T10:00:00.000Z",
    },
    {
      id: "user-2",
      name: "Archived Person",
      email: "archived@example.com",
      source: "git",
      archived: true,
      avatarUrl: "https://www.gravatar.com/avatar/def456?d=identicon&s=80",
      commitCount: 2,
      lastCommitAt: "2026-03-20T10:00:00.000Z",
    },
    {
      id: "user-3",
      name: "Jordan Example",
      email: "jordan@example.com",
      source: "config",
      archived: false,
      avatarUrl: "https://www.gravatar.com/avatar/ghi789?d=identicon&s=80",
      commitCount: 0,
      lastCommitAt: null,
    },
  ],
};

function renderProjectManagementPanel(overrides: Partial<Parameters<typeof ProjectManagementPanel>[0]> = {}) {
  const props: Parameters<typeof ProjectManagementPanel>[0] = {
    documents: [...sampleDocuments],
    worktrees: sampleWorktrees,
    availableTags: ["feature", "ux", "plan", "reference"],
    availableStatuses: ["backlog", "todo", "in-progress", "blocked", "done", "reference"],
    projectManagementUsers: sampleUsers,
    activeSubTab: "document",
    selectedDocumentId: "doc-1",
    documentViewMode: "document",
    document: sampleDocument,
    history: sampleHistory,
    loading: false,
    saving: false,
    aiCommands: {
      smart: "runner --prompt $WTM_AI_INPUT",
      simple: "runner --fast $WTM_AI_INPUT",
    },
    aiJob: null,
    documentRunJob: null,
    runningAiJobs: [],
    selectedWorktreeBranch: null,
    onSelectWorktree: () => undefined,
    onSubTabChange: () => undefined,
    onDocumentViewModeChange: () => undefined,
    onSelectDocument: async () => null,
    onCreateDocument: async () => null,
    onUpdateDocument: async () => null,
    onUpdateDependencies: async () => null,
    onUpdateStatus: async () => null,
    onUpdateUsers: async () => null,
    onBatchUpdateDocuments: async () => true,
    onAddComment: async () => null,
    onRunAiCommand: async () => null,
    onRunDocumentAi: async () => null,
    onCancelDocumentAiCommand: async () => null,
    onCancelAiCommand: async () => null,
    ...overrides,
  };

  return renderToStaticMarkup(<ProjectManagementPanel {...props} />);
}

function createAiJob(overrides: Partial<AiCommandJob> = {}): AiCommandJob {
  return {
    jobId: "job-1",
    fileName: "job-1.log",
    branch: "pm-doc-1-dependencies",
    documentId: "doc-1",
    commandId: "smart",
    command: "runner --prompt $WTM_AI_INPUT",
    input: "Implement the document",
    status: "running",
    startedAt: "2026-03-26T10:00:00.000Z",
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

test("create form renders without seeded defaults", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[]}
      worktrees={[]}
      availableTags={[]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="create"
      selectedDocumentId={null}
      documentViewMode="document"
      document={null}
      history={[]}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onAddComment={async () => null}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
    />,
  );

  assert.match(markup, /placeholder="Document title"/);
  assert.match(markup, /placeholder="Short summary shown in the document list"/);
  assert.match(markup, /placeholder="bug, feature, plan"/);
  assert.match(markup, /Select lane/);
  assert.match(markup, /placeholder="Assignee"/);
  assert.match(markup, />Write</);
  assert.match(markup, />Preview</);
  assert.match(markup, /Loading editor\.\.\./);
  assert.equal(markup.includes("No short summary yet."), false);
  assert.doesNotMatch(markup, /value="Project Outline"/);
  assert.doesNotMatch(markup, /value="plan"/);
  assert.doesNotMatch(markup, /# Project Outline/);
  assert.doesNotMatch(markup, />WYSIWYG</);
  assert.doesNotMatch(markup, />Monaco</);
  assert.doesNotMatch(markup, />Markdown</);
});

test("edit form uses write and preview tabs instead of multiple editor modes", () => {
  const markup = renderProjectManagementPanel({
    documentViewMode: "edit",
  });

  assert.match(markup, />Write</);
  assert.match(markup, />Preview</);
  assert.match(markup, /Loading editor\.\.\./);
  assert.doesNotMatch(markup, />WYSIWYG</);
  assert.doesNotMatch(markup, />Monaco</);
  assert.doesNotMatch(markup, />Markdown</);
});

test("document form preview renders parsed markdown from the Monaco-backed draft", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementDocumentForm
      mode="edit"
      title="Dependencies"
      summary="Track prerequisite document work."
      tags="feature, ux"
      markdown={"# Dependencies\n\n- First item"}
      status="todo"
      assignee="Eric"
      statuses={["todo", "in-progress", "done"]}
      saving={false}
      viewMode="preview"
      onViewModeChange={() => undefined}
      onTitleChange={() => undefined}
      onSummaryChange={() => undefined}
      onTagsChange={() => undefined}
      onMarkdownChange={() => undefined}
      onStatusChange={() => undefined}
      onAssigneeChange={() => undefined}
      onSubmit={async () => undefined}
    />,
  );

  assert.match(markup, /pm-markdown text-sm theme-text/);
  assert.match(markup, /<h1>Dependencies<\/h1>/);
  assert.match(markup, /<li>First item<\/li>/);
  assert.doesNotMatch(markup, /Loading editor\.\.\./);
});

test("document view shows dependency summary and modal entrypoint", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
      worktrees={sampleWorktrees}
      availableTags={["feature", "ux", "plan", "reference"]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="document"
      selectedDocumentId="doc-1"
      documentViewMode="document"
      document={sampleDocument}
      history={[]}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onAddComment={async () => null}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
    />,
  );

  assert.match(markup, /Manage dependencies/);
  assert.match(markup, /Open graph/);
  assert.match(markup, /Shared document list/);
  assert.match(markup, /1 dependency/);
  assert.match(markup, /Remove/);
  assert.match(markup, /Linked worktrees/);
  assert.match(markup, /feature\/doc-1-primary/);
  assert.match(markup, /feature\/doc-1-runtime/);
  assert.match(markup, /Make active/);
  assert.match(markup, /runtime active/);
  assert.match(markup, /Archive document/);
  assert.match(markup, /Save assignee/);
  assert.match(markup, /Update the lane, assignee, or archive state here without leaving the document view\./);
});

test("document view renders summary, comments, and comment attribution", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
      worktrees={sampleWorktrees}
      availableTags={["feature", "ux", "plan", "reference"]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="document"
      selectedDocumentId="doc-1"
      documentViewMode="document"
      document={{
        ...sampleDocument,
        summary: "Track prerequisite document work.",
        comments: [{
          id: "comment-1",
          body: "Need a final QA pass",
          createdAt: "2026-03-25T11:30:00.000Z",
          authorName: "Casey Reviewer",
          authorEmail: "casey@example.com",
        }],
      }}
      history={sampleHistory}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      selectedWorktreeBranch="feature/doc-1-primary"
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onAddComment={async () => null}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
    />,
  );

  assert.match(markup, />Summary</);
  assert.match(markup, /Active worktree/);
  assert.match(markup, /active worktree/);
  assert.match(markup, /Track prerequisite document work\./);
  assert.match(markup, /1 comment/);
  assert.match(markup, /Casey Reviewer/);
  assert.match(markup, /casey@example.com/);
  assert.match(markup, /Need a final QA pass/);
  assert.match(markup, /Saved with your repo git/);
});

test("dependency picker modal renders current dependencies and searchable document browser", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementDependencyPickerModal
      document={sampleDocument}
      documents={[...sampleDocuments]}
      availableTags={["feature", "ux", "plan", "reference"]}
      statuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
      dependencyIds={["doc-2"]}
      onClose={() => undefined}
      onOpenGraph={() => undefined}
      onToggleDependency={() => undefined}
    />,
  );

  assert.match(markup, /Manage prerequisites for/);
  assert.match(markup, /Current dependencies/);
  assert.match(markup, /Search documents/);
  assert.match(markup, /All tags/);
  assert.match(markup, /all assignees/i);
  assert.match(markup, /Shared document list/);
  assert.match(markup, /Graph fallback/);
  assert.match(markup, /selected/);
  assert.match(markup, /type="checkbox"/);
  assert.match(markup, /matrix-card matrix-card-selected/);
});

test("document worktree run in another branch does not lock this worktree UI", () => {
  const markup = renderProjectManagementPanel({
    documentRunJob: createAiJob(),
    selectedWorktreeBranch: "feature/current-worktree",
  });

  assert.match(markup, />Start Worktree AI</);
  assert.doesNotMatch(markup, /Start Worktree AI \(running\)/);
  assert.doesNotMatch(markup, /Document worktree AI run in progress/);
  assert.doesNotMatch(markup, /Streaming live output from pm-doc-1-dependencies while the worktree run is active\./);
});

test("document worktree run in the selected branch shows running state and controls", () => {
  const markup = renderProjectManagementPanel({
    documentRunJob: createAiJob({ jobId: "job-2", startedAt: "2026-03-26T10:05:00.000Z" }),
    selectedWorktreeBranch: "pm-doc-1-dependencies",
  });

  assert.match(markup, /Start Worktree AI \(running\)/);
  assert.match(markup, /Document worktree AI run in progress/);
  assert.match(markup, /Cancel worktree AI/);
  assert.match(markup, /Streaming mixed stdout and stderr from pm-doc-1-dependencies while the worktree run is active\./);
});

test("running document edit view shows ordered mixed AI output in the editor area", () => {
  const markup = renderProjectManagementPanel({
    documentViewMode: "edit",
    aiJob: createAiJob({
      outputEvents: [
        {
          id: "event-1",
          source: "stdout",
          text: "Planning edits",
          timestamp: "2026-03-26T10:05:01.000Z",
        },
        {
          id: "event-2",
          source: "stderr",
          text: "Warning: lint still running",
          timestamp: "2026-03-26T10:05:02.000Z",
        },
      ],
    }),
  });

  assert.match(markup, /Document editing locked while AI updates the saved document/);
  assert.match(markup, /Document AI is working/);
  assert.match(markup, /Streaming mixed stdout and stderr while the saved document updates in pm-doc-1-dependencies\./);
  assert.match(markup, />stdout</);
  assert.match(markup, />stderr</);
  assert.match(markup, /Planning edits/);
  assert.match(markup, /Warning: lint still running/);
  assert.match(markup, /Cancel AI/);
});

test("getAiOutputEvents preserves ordered output events and falls back to stdout stderr blocks", () => {
  const orderedEvents = getAiOutputEvents(createAiJob({
    outputEvents: [
      {
        id: "event-1",
        source: "stdout",
        text: "First",
        timestamp: "2026-03-26T10:00:01.000Z",
      },
      {
        id: "event-2",
        source: "stderr",
        text: "Second",
        timestamp: "2026-03-26T10:00:02.000Z",
      },
    ],
  }));
  assert.deepEqual(orderedEvents.map((event) => event.text), ["First", "Second"]);

  const fallbackEvents = getAiOutputEvents(createAiJob({
    outputEvents: undefined,
    stdout: "Only stdout",
    stderr: "Only stderr",
    completedAt: "2026-03-26T10:00:03.000Z",
  }));
  assert.deepEqual(fallbackEvents, [
    {
      id: "job-1.log:stdout",
      source: "stdout",
      text: "Only stdout",
      timestamp: "2026-03-26T10:00:00.000Z",
    },
    {
      id: "job-1.log:stderr",
      source: "stderr",
      text: "Only stderr",
      timestamp: "2026-03-26T10:00:03.000Z",
    },
  ]);
});

test("getCompletedAiDocumentRefreshTarget prefers workspace refresh when available", () => {
  assert.equal(getCompletedAiDocumentRefreshTarget({
    aiJob: createAiJob({ status: "completed" }),
    documentId: "doc-1",
    hasWorkspaceRefresh: true,
  }), "workspace");

  assert.equal(getCompletedAiDocumentRefreshTarget({
    aiJob: createAiJob({ status: "completed" }),
    documentId: "doc-1",
    hasWorkspaceRefresh: false,
  }), "document");

  assert.equal(getCompletedAiDocumentRefreshTarget({
    aiJob: createAiJob({ status: "completed", documentId: "doc-2" }),
    documentId: "doc-1",
    hasWorkspaceRefresh: true,
  }), null);
});

test("workspace headers show passive sync status and retry only on error", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-28T15:37:31.000Z");

  try {
    const updatedMarkup = renderProjectManagementPanel({
      lastUpdatedAt: "2026-03-28T15:37:30.000Z",
    });

    assert.match(updatedMarkup, /Updated just now|Updated \d+s ago/);
    assert.doesNotMatch(updatedMarkup, />Refresh</);
    assert.doesNotMatch(updatedMarkup, />Retry</);
  } finally {
    Date.now = originalNow;
  }

  const errorMarkup = renderProjectManagementPanel({
    refreshError: "Project documents are temporarily unavailable.",
    onRetryRefresh: () => undefined,
  });

  assert.match(errorMarkup, /Sync issue/);
  assert.match(errorMarkup, /Project documents are temporarily unavailable\./);
  assert.match(errorMarkup, />Retry</);
  assert.doesNotMatch(errorMarkup, />Refresh</);
});

test("board view renders multi-select controls and AI quick actions", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementBoardTab
      swimlaneDocuments={[
        { status: "todo", documents: [sampleDocuments[0]] },
        { status: "in-progress", documents: [sampleDocuments[1]] },
      ]}
      document={sampleDocument}
      documentRunJob={null}
      runningAiJobs={[]}
      showBacklogLane={true}
      saving={false}
      smartAiReady={true}
      onToggleBacklogLane={() => undefined}
      onSelectDocument={async () => null}
      onMoveDocument={async () => undefined}
      onBatchUpdateDocuments={async () => true}
      onRunDocumentAi={async () => null}
    />,
  );

  assert.match(markup, /Status board/);
  assert.match(markup, /board quick actions/);
  assert.match(markup, /Select all visible/);
  assert.match(markup, /Board selection/);
  assert.match(markup, /Select one or more cards to move or archive them together\./);
  assert.match(markup, /Move selected/);
  assert.match(markup, /Archive selected/);
  assert.match(markup, /Start AI/);
  assert.match(markup, /aria-label="Select Dependencies"/);
  assert.match(markup, /aria-label="Select Shared document list"/);
  assert.match(markup, /matrix-card matrix-card-interactive/);
  assert.match(markup, /matrix-card-header/);
  assert.match(markup, /AI running|Start AI/);
});

test("users tab renders discovered users, archived users, and custom user controls", () => {
  const markup = renderProjectManagementPanel({
    activeSubTab: "users",
    selectedDocumentId: null,
    document: null,
    history: [],
  });

  assert.match(markup, />Users</);
  assert.match(markup, /Manage users/);
  assert.match(markup, /Git commit authors appear here automatically/);
  assert.match(markup, /Add custom user/);
  assert.match(markup, /Save custom user/);
  assert.match(markup, /Active users/);
  assert.match(markup, /Archived users/);
  assert.match(markup, /Eric Woolley/);
  assert.match(markup, /Jordan Example/);
  assert.match(markup, /Archived Person/);
  assert.match(markup, /Archive user/);
  assert.match(markup, /Unarchive user/);
  assert.match(markup, /Remove custom entry/);
});

test("board view marks AI running for documents even when the active worktree differs", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementBoardTab
      swimlaneDocuments={[
        { status: "todo", documents: [sampleDocuments[0]] },
        { status: "in-progress", documents: [sampleDocuments[1]] },
      ]}
      document={sampleDocument}
      documentRunJob={null}
      runningAiJobs={[
        {
          jobId: "job-3",
          fileName: "job-3.log",
          branch: "feature/doc-1-runtime",
          documentId: "doc-1",
          commandId: "smart",
          command: "runner --prompt $WTM_AI_INPUT",
          input: "Implement the document",
          status: "running",
          startedAt: "2026-03-26T10:10:00.000Z",
          stdout: "",
          stderr: "",
          origin: {
            kind: "project-management-document-run",
            label: "Project management board run",
            description: "#1 Dependencies",
            location: {
              tab: "project-management",
              projectManagementSubTab: "board",
              documentId: "doc-1",
              projectManagementDocumentViewMode: "document",
            },
          },
        },
      ]}
      showBacklogLane={true}
      saving={false}
      smartAiReady={true}
      onToggleBacklogLane={() => undefined}
      onSelectDocument={async () => null}
      onMoveDocument={async () => undefined}
      onBatchUpdateDocuments={async () => true}
      onRunDocumentAi={async () => null}
    />,
  );

  assert.match(markup, /AI running/);
  assert.match(markup, /title="AI is already running in feature\/doc-1-runtime"/);
});
