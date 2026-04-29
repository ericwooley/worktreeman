import assert from "node:assert/strict";
import test from "#test-runtime";
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
import { ProjectManagementDocumentDetail } from "./project-management-document-detail";
import { ProjectManagementDocumentForm } from "./project-management-document-form";
import { sortProjectManagementDocuments } from "./project-management-document-browser";
import { readProjectManagementDocumentPath } from "./project-management-document-route";
import {
  getCompletedAiDocumentRefreshTarget,
  getProjectManagementDocumentRunDefaults,
} from "./project-management-document-utils";
import {
  moveBoardDocument,
  ProjectManagementPanel,
} from "./project-management-panel";
import {
  formatAiOutputAge,
  getAiOutputEvents,
  getNextAiOutputScrollTop,
  shouldStickAiOutputToBottom,
} from "./project-management-ai-output-viewer";
import { ProjectManagementAiStreamViewer } from "./project-management-ai-stream-viewer";

const PRIMARY_WORKTREE_ID = "66666666666666666666666666666661" as WorktreeRecord["id"];
const RUNTIME_WORKTREE_ID = "66666666666666666666666666666662" as WorktreeRecord["id"];

const sampleDocuments: ProjectManagementDocumentSummary[] = [
  {
    id: "doc-1",
    number: 1,
    title: "Dependencies",
    summary: "Track prerequisite document work.",
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
};

const sampleWorktrees: WorktreeRecord[] = [
  {
    id: PRIMARY_WORKTREE_ID,
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
      status: "todo",
      archived: false,
    },
  },
  {
    id: RUNTIME_WORKTREE_ID,
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
      status: "todo",
      archived: false,
    },
    runtime: {
      id: RUNTIME_WORKTREE_ID,
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
    action: "update" as const,
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
    availableStatuses: ["backlog", "todo", "in-progress", "review_passed", "done", "reference"],
    projectManagementUsers: sampleUsers,
    activeSubTab: "document",
    selectedDocumentId: "doc-1",
    documentViewMode: "document",
    editFormTab: "write",
    createFormTab: "write",
    document: sampleDocument,
    history: sampleHistory,
    loading: false,
    saving: false,
    aiCommands: {
      smart: "runner --prompt $WTM_AI_INPUT",
      simple: "runner --fast $WTM_AI_INPUT",
      autoStartRuntime: false,
    },
    aiJob: null,
    documentRunJob: null,
    runningAiJobs: [],
    documentPresentation: "modal",
    selectedWorktreeBranch: null,
    onSelectWorktree: () => undefined,
    onSubTabChange: () => undefined,
    onDocumentViewModeChange: () => undefined,
    onEditFormTabChange: () => undefined,
    onCreateFormTabChange: () => undefined,
    onSelectDocument: async () => null,
    onCreateDocument: async () => null,
    onUpdateDocument: async () => null,
    onUpdateDependencies: async () => null,
    onUpdateStatus: async () => null,
    onUpdateUsers: async () => null,
    onBatchUpdateDocuments: async () => true,
    onRunAiCommand: async () => null,
    onRunDocumentAi: async () => null,
    onCancelDocumentAiCommand: async () => null,
    onCancelAiCommand: async () => null,
    onOpenDocumentPage: () => undefined,
    onCloseDocument: () => undefined,
    ...overrides,
  };

  return renderToStaticMarkup(<ProjectManagementPanel {...props} />);
}

function renderDocumentWorktreeModal() {
  return renderToStaticMarkup(
    <ProjectManagementDocumentDetail
      presentation="page"
      document={sampleDocument}
      documents={sampleDocuments}
      availableTags={["feature", "ux", "plan", "reference"]}
      statuses={["backlog", "todo", "in-progress", "review_passed", "done", "reference"]}
      saving={false}
      aiCommands={{ smart: "runner --prompt $WTM_AI_INPUT", simple: "runner --fast $WTM_AI_INPUT", autoStartRuntime: false }}
      aiJob={null}
      documentRunJob={null}
      selectedWorktreeBranch={null}
      documentViewMode="document"
      editFormTab="write"
      editTitle={sampleDocument.title}
      editSummary={sampleDocument.summary}
      editMarkdown={sampleDocument.markdown}
      editTags={sampleDocument.tags.join(", ")}
      editStatus={sampleDocument.status}
      editAssignee={sampleDocument.assignee}
      dependencySelection={sampleDocument.dependencies}
      currentDependencyDocuments={[]}
      aiRunSummary={null}
      documentRunSummary={null}
      aiFailureToast={null}
      documentRunFailureToast={null}
      aiRequestModalOpen={false}
      aiOutputModalOpen={false}
      dependencyModalOpen={false}
      documentWorktreeModalOpen={true}
      selectedAiCommandId="smart"
      aiCommandOptions={[]}
      linkedWorktrees={sampleWorktrees}
      currentLinkedWorktree={null}
      canContinueCurrent={false}
      generatedWorktreeName="pm-doc-1-dependencies"
      documentWorktreeInstructions=""
      documentWorktreeStrategy="new"
      documentWorktreeName="pm-doc-1-dependencies"
      documentWorktreeAutoReviewLoop={true}
      compactDocumentSummary={["#1", "todo", "Eric", "Active", "2 tags"]}
      metadataControlsDisabled={false}
      assigneeActionDisabled={false}
      selectedDocumentAiOutput={null}
      inlineSelectedAiOutput={null}
      onClose={() => undefined}
      onOpenPage={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onEditFormTabChange={() => undefined}
      onEditTitleChange={() => undefined}
      onEditSummaryChange={() => undefined}
      onEditMarkdownChange={() => undefined}
      onEditTagsChange={() => undefined}
      onEditStatusChange={() => undefined}
      onEditAssigneeChange={() => undefined}
      onSetEditingState={() => undefined}
      onSaveDocument={async () => undefined}
      onQuickDocumentUpdate={async () => undefined}
      onSaveAssignee={async () => undefined}
      onToggleArchive={async () => undefined}
      onSelectWorktree={() => undefined}
      onOpenDependencyGraph={() => undefined}
      onOpenDependencyModal={() => undefined}
      onCloseDependencyModal={() => undefined}
      onToggleDependencySelection={async () => undefined}
      onOpenAiRequest={() => undefined}
      onCloseAiRequest={() => undefined}
      onAiChangeRequestChange={() => undefined}
      aiChangeRequest=""
      onSelectedAiCommandIdChange={() => undefined}
      onRunUiMagic={async () => false}
      onCancelAiCommand={async () => null}
      onDismissAiFailureToast={() => undefined}
      onDismissDocumentRunFailureToast={() => undefined}
      onOpenDocumentWorktreeModal={() => undefined}
      onCloseDocumentWorktreeModal={() => undefined}
      onDocumentWorktreeInstructionsChange={() => undefined}
      onDocumentWorktreeStrategyChange={() => undefined}
      onDocumentWorktreeNameChange={() => undefined}
      onDocumentWorktreeAutoReviewLoopChange={() => undefined}
      onRunDocumentWork={async () => false}
      onCancelDocumentAiCommand={async () => null}
      onOpenAiOutputModal={() => undefined}
      onCloseAiOutputModal={() => undefined}
      onCancelSelectedDocumentAiOutput={async () => undefined}
    />,
  );
}

function createAiJob(overrides: Partial<AiCommandJob> = {}): AiCommandJob {
  return {
    jobId: "job-1",
    fileName: "job-1.log",
    worktreeId: RUNTIME_WORKTREE_ID,
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
      availableStatuses={["backlog", "todo", "in-progress", "review_passed", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="create"
      selectedDocumentId={null}
      documentViewMode="document"
      editFormTab="write"
      createFormTab="write"
      document={null}
      history={[]}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      documentPresentation="modal"
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onEditFormTabChange={() => undefined}
      onCreateFormTabChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
      onOpenDocumentPage={() => undefined}
      onCloseDocument={() => undefined}
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

test("worktree AI modal enables auto loop by default", () => {
  const markup = renderDocumentWorktreeModal();

  assert.match(markup, /Enable auto loop/);
  assert.match(markup, /Smart AI reviews the branch and loops on fixes until review passes/);
  assert.match(markup, /name="pm-document-worktree-auto-loop"[^>]*checked=""/);
});

test("document detail does not render worktree AI output inline", () => {
  const markup = renderProjectManagementPanel({
    documentRunJob: createAiJob({ jobId: "job-worktree", startedAt: "2026-03-26T10:05:00.000Z" }),
    selectedWorktreeBranch: "pm-doc-1-dependencies",
  });

  assert.match(markup, /Document worktree AI run in progress/);
  assert.doesNotMatch(markup, /AI output/);
  assert.doesNotMatch(markup, /Document AI is working/);
  assert.doesNotMatch(markup, /worktree run is active\./);
  assert.doesNotMatch(markup, /Live worktree output/);
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
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /id="project-management-document-view-edit-tab"/);
  assert.match(markup, /id="project-management-edit-form-write-tab"/);
  assert.match(markup, /aria-controls="project-management-document-view-edit-panel"/);
});

test("document form preview renders parsed markdown from the Monaco-backed draft", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementDocumentForm
      tabsId="project-management-edit-form"
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
      availableStatuses={["backlog", "todo", "in-progress", "review_passed", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="document"
      selectedDocumentId="doc-1"
      documentViewMode="document"
      editFormTab="write"
      createFormTab="write"
      document={sampleDocument}
      history={[]}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      documentPresentation="modal"
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onEditFormTabChange={() => undefined}
      onCreateFormTabChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
      onOpenDocumentPage={() => undefined}
      onCloseDocument={() => undefined}
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
  assert.match(markup, /Open full page/);
  assert.match(markup, /Update the lane, assignee, or archive state here without leaving the document view\./);
  assert.match(markup, /id="project-management-workspace-document-tab"/);
  assert.match(markup, /id="project-management-workspace-document-panel"/);
  assert.match(markup, /aria-labelledby="project-management-workspace-document-tab"/);
});

test("document page presentation renders page-specific controls and tab ids", () => {
  const markup = renderProjectManagementPanel({
    documentPresentation: "page",
  });

  assert.match(markup, /Back to documents/);
  assert.match(markup, /id="project-management-document-page-view-document-tab"/);
  assert.doesNotMatch(markup, /Open full page/);
});

test("document view renders summary without inline review timeline", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
      worktrees={sampleWorktrees}
      availableTags={["feature", "ux", "plan", "reference"]}
      availableStatuses={["backlog", "todo", "in-progress", "review_passed", "done", "reference"]}
      projectManagementUsers={sampleUsers}
      activeSubTab="document"
      selectedDocumentId="doc-1"
      documentViewMode="document"
      editFormTab="write"
      createFormTab="write"
      document={{
        ...sampleDocument,
        summary: "Track prerequisite document work.",
      }}
      history={sampleHistory}
      loading={false}
      saving={false}
      aiCommands={null}
      aiJob={null}
      documentRunJob={null}
      runningAiJobs={[]}
      documentPresentation="modal"
      selectedWorktreeBranch="feature/doc-1-primary"
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onEditFormTabChange={() => undefined}
      onCreateFormTabChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
      onUpdateUsers={async () => null}
      onBatchUpdateDocuments={async () => true}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
      onOpenDocumentPage={() => undefined}
      onCloseDocument={() => undefined}
    />,
  );

  assert.match(markup, />Summary</);
  assert.match(markup, /Active worktree/);
  assert.match(markup, /active worktree/);
  assert.match(markup, /Track prerequisite document work\./);
  assert.doesNotMatch(markup, />Comments</);
  assert.doesNotMatch(markup, /Add comment/);
});

test("dependency picker modal renders current dependencies and searchable document browser", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementDependencyPickerModal
      document={sampleDocument}
      documents={[...sampleDocuments]}
      availableTags={["feature", "ux", "plan", "reference"]}
      statuses={["backlog", "todo", "in-progress", "review_passed", "done", "reference"]}
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

test("selected document stays pinned during poll-driven document reordering", () => {
  const polledDocuments = [
    {
      ...sampleDocuments[0],
      updatedAt: "2026-03-26T10:00:00.000Z",
    },
    {
      ...sampleDocuments[1],
      updatedAt: "2026-03-30T12:00:00.000Z",
    },
    {
      ...sampleDocuments[2],
      updatedAt: "2026-03-29T12:00:00.000Z",
    },
  ];

  const orderedIds = sortProjectManagementDocuments(polledDocuments, "doc-1").map((entry) => entry.id);

  assert.deepEqual(orderedIds, ["doc-1", "doc-2", "doc-3"]);
});

test("document rail keeps the selected card first even when another document was updated more recently", () => {
  const markup = renderProjectManagementPanel({
    selectedDocumentId: "doc-1",
    document: {
      ...sampleDocument,
      updatedAt: "2026-03-26T10:00:00.000Z",
    },
    documents: [
      {
        ...sampleDocuments[0],
        updatedAt: "2026-03-26T10:00:00.000Z",
      },
      {
        ...sampleDocuments[1],
        updatedAt: "2026-03-30T12:00:00.000Z",
      },
      {
        ...sampleDocuments[2],
        updatedAt: "2026-03-29T12:00:00.000Z",
      },
    ],
  });

  const selectedIndex = markup.indexOf("matrix-card matrix-card-selected");
  const newerDocumentIndex = markup.indexOf("Shared document list");

  assert.notEqual(selectedIndex, -1);
  assert.notEqual(newerDocumentIndex, -1);
  assert.ok(selectedIndex < newerDocumentIndex);
});

test("document route parser recognizes dedicated page urls", () => {
  assert.deepEqual(readProjectManagementDocumentPath("/project-management/documents/doc-7"), {
    documentId: "doc-7",
    presentation: "page",
  });
  assert.deepEqual(readProjectManagementDocumentPath("/"), {
    documentId: null,
    presentation: "modal",
  });
});

test("moveBoardDocument updates the lane without forcing a document reselect", async () => {
  const calls: Array<{ documentId: string; status: string }> = [];
  const result = await moveBoardDocument({
    documents: [...sampleDocuments],
    documentId: "doc-1",
    nextStatus: "done",
    onUpdateStatus: async (documentId: string, status: string) => {
      calls.push({ documentId, status });
      return {
        branch: "refs/heads/main",
        headSha: "abc123",
        document: { ...sampleDocument, status },
      };
    },
  });

  assert.deepEqual(calls, [{ documentId: "doc-1", status: "done" }]);
  assert.equal(result?.document.status, "done");
});

test("moveBoardDocument skips redundant lane moves", async () => {
  let called = false;
  const result = await moveBoardDocument({
    documents: [...sampleDocuments],
    documentId: "doc-1",
    nextStatus: "todo",
    onUpdateStatus: async (_documentId: string, _status: string) => {
      called = true;
      return {
        branch: "refs/heads/main",
        headSha: "abc123",
        document: sampleDocument,
      };
    },
  });

  assert.equal(called, false);
  assert.equal(result, null);
});

test("document worktree run in another branch does not lock this worktree UI", () => {
  const markup = renderProjectManagementPanel({
    documentRunJob: createAiJob(),
    selectedWorktreeBranch: "feature/current-worktree",
  });

  assert.match(markup, />Start Worktree AI</);
  assert.doesNotMatch(markup, /Start Worktree AI \(running\)/);
  assert.doesNotMatch(markup, /Document worktree AI run in progress/);
  assert.doesNotMatch(markup, /worktree run is active\./);
});

test("document worktree run in the selected branch shows running state and controls", () => {
  const markup = renderProjectManagementPanel({
    documentRunJob: createAiJob({ jobId: "job-2", startedAt: "2026-03-26T10:05:00.000Z" }),
    selectedWorktreeBranch: "pm-doc-1-dependencies",
  });

  assert.match(markup, /Start Worktree AI \(running\)/);
  assert.match(markup, /Document worktree AI run in progress/);
  assert.match(markup, /Cancel worktree AI/);
  assert.doesNotMatch(markup, /worktree run is active\./);
});

test("getProjectManagementDocumentRunDefaults prefers continuing the selected linked worktree", () => {
  const defaults = getProjectManagementDocumentRunDefaults({
    document: sampleDocument,
    linkedWorktrees: sampleWorktrees,
    selectedWorktreeBranch: "feature/doc-1-runtime",
  });

  assert.equal(defaults.currentLinkedWorktree?.branch, "feature/doc-1-runtime");
  assert.equal(defaults.canContinueCurrent, true);
  assert.equal(defaults.defaultStrategy, "continue-current");
  assert.equal(defaults.generatedWorktreeName, "pm-doc-1-dependencies");
});

test("getProjectManagementDocumentRunDefaults falls back to a new worktree when the selected branch is unrelated", () => {
  const defaults = getProjectManagementDocumentRunDefaults({
    document: sampleDocument,
    linkedWorktrees: sampleWorktrees,
    selectedWorktreeBranch: "feature/unrelated",
  });

  assert.equal(defaults.currentLinkedWorktree, null);
  assert.equal(defaults.canContinueCurrent, false);
  assert.equal(defaults.defaultStrategy, "new");
  assert.equal(defaults.generatedWorktreeName, "pm-doc-1-dependencies");
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
  assert.match(markup, /Streaming the combined AI log while the saved document updates in pm-doc-1-dependencies\./);
  assert.match(markup, />stdout</);
  assert.match(markup, />stderr</);
  assert.match(markup, /Planning edits/);
  assert.match(markup, /Warning: lint still running/);
  assert.match(markup, /Cancel AI/);
});

test("document viewer hides unavailable AI cleanup failures", () => {
  const markup = renderProjectManagementPanel({
    aiJob: createAiJob({
      status: "failed",
      stderr: "AI process was no longer available. The server may have restarted or the process may have crashed.",
      error: "AI process was no longer available. The server may have restarted or the process may have crashed.",
      failureReason: "process-unavailable",
    }),
  });

  assert.doesNotMatch(markup, /Document AI output/);
  assert.doesNotMatch(markup, /AI process was no longer available/);
});

test("AI stream viewer prefers persisted log output over an empty fallback job", () => {
  const fallbackJob = createAiJob({
    status: "failed",
    stdout: "",
    stderr: "",
    outputEvents: [],
  });
  const markup = renderToStaticMarkup(
    <ProjectManagementAiStreamViewer
      source="worktree"
      jobId={fallbackJob.jobId}
      summary="Captured output from pm-doc-1-dependencies."
      fallbackJob={fallbackJob}
      initialLogDetail={{
        jobId: fallbackJob.jobId,
        fileName: fallbackJob.fileName,
        timestamp: fallbackJob.startedAt,
        completedAt: "2026-03-26T10:05:10.000Z",
        worktreeId: fallbackJob.worktreeId,
        branch: fallbackJob.branch,
        documentId: fallbackJob.documentId ?? null,
        commandId: fallbackJob.commandId,
        worktreePath: "/repo/.worktrees/pm-doc-1-dependencies",
        command: fallbackJob.command,
        request: fallbackJob.input,
        response: {
          stdout: "",
          stderr: "AI process exited with code 1.",
          events: [
            {
              id: "event-1",
              source: "stderr",
              text: "AI process exited with code 1.",
              timestamp: "2026-03-26T10:05:10.000Z",
            },
          ],
        },
        status: "failed",
        pid: 7331,
        exitCode: 1,
        processName: "wtm:ai:job-1",
        error: { message: "AI process exited with code 1." },
        origin: null,
      }}
      onCancel={() => undefined}
    />,
  );

  assert.match(markup, /Worktree AI output/);
  assert.match(markup, /Initial prompt/);
  assert.match(markup, /Review the markdown prompt that Smart AI received before it started running\./);
  assert.match(markup, /AI process exited with code 1\./);
  assert.match(markup, />stderr</);
  assert.doesNotMatch(markup, /Summarize the work\./);
  assert.doesNotMatch(markup, /Waiting for live output\.\.\./);
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
      id: "job-1:stdout",
      source: "stdout",
      text: "Only stdout",
      timestamp: "2026-03-26T10:00:00.000Z",
    },
    {
      id: "job-1:stderr",
      source: "stderr",
      text: "Only stderr",
      timestamp: "2026-03-26T10:00:03.000Z",
    },
  ]);
});

test("shouldStickAiOutputToBottom only follows when the viewport is near the bottom", () => {
  assert.equal(shouldStickAiOutputToBottom({
    scrollHeight: 500,
    scrollTop: 300,
    clientHeight: 200,
  }), true);

  assert.equal(shouldStickAiOutputToBottom({
    scrollHeight: 500,
    scrollTop: 260,
    clientHeight: 200,
  }), false);
});

test("getNextAiOutputScrollTop snaps to the bottom when auto-follow is enabled", () => {
  assert.equal(getNextAiOutputScrollTop({
    shouldStickToBottom: true,
    previousScrollHeight: 400,
    nextScrollHeight: 520,
    currentScrollTop: 180,
  }), 520);
});

test("getNextAiOutputScrollTop preserves relative position when auto-follow is disabled", () => {
  assert.equal(getNextAiOutputScrollTop({
    shouldStickToBottom: false,
    previousScrollHeight: 400,
    nextScrollHeight: 520,
    currentScrollTop: 180,
  }), 300);

  assert.equal(getNextAiOutputScrollTop({
    shouldStickToBottom: false,
    previousScrollHeight: 0,
    nextScrollHeight: 520,
    currentScrollTop: 180,
  }), 180);
});

test("formatAiOutputAge renders compact time-ago labels for the latest output", () => {
  const now = Date.parse("2026-03-31T18:10:00.000Z");

  assert.equal(formatAiOutputAge("2026-03-31T18:09:51.000Z", now), "9s ago");
  assert.equal(formatAiOutputAge("2026-03-31T18:09:00.000Z", now), "1m ago");
  assert.equal(formatAiOutputAge("2026-03-31T17:10:00.000Z", now), "1h ago");
  assert.equal(formatAiOutputAge("2026-03-30T18:10:00.000Z", now), "1d ago");
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
          worktreeId: RUNTIME_WORKTREE_ID,
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
