import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary, WorktreeRecord } from "@shared/types";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
import { ProjectManagementPanel } from "./project-management-panel";

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

test("create form renders without seeded defaults", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[]}
      worktrees={[]}
      availableTags={[]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
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
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
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
  assert.match(markup, /<textarea[^>]*><\/textarea>/);
  assert.equal(markup.includes("No short summary yet."), false);
  assert.doesNotMatch(markup, /value="Project Outline"/);
  assert.doesNotMatch(markup, /value="plan"/);
  assert.doesNotMatch(markup, /# Project Outline/);
});

test("document view shows dependency summary and modal entrypoint", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
      worktrees={sampleWorktrees}
      availableTags={["feature", "ux", "plan", "reference"]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
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
      selectedWorktreeBranch={null}
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
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
});

test("document view renders summary, comments, and comment attribution", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
      worktrees={sampleWorktrees}
      availableTags={["feature", "ux", "plan", "reference"]}
      availableStatuses={["backlog", "todo", "in-progress", "blocked", "done", "reference"]}
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
      selectedWorktreeBranch="feature/doc-1-primary"
      onSelectWorktree={() => undefined}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onUpdateStatus={async () => null}
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
});
