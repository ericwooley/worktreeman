import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary } from "@shared/types";
import { ProjectManagementDependencyPickerModal } from "./project-management-dependency-picker-modal";
import { ProjectManagementPanel } from "./project-management-panel";

const sampleDocuments: ProjectManagementDocumentSummary[] = [
  {
    id: "doc-1",
    number: 1,
    title: "Dependencies",
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
    tags: ["reference"],
    dependencies: [],
    status: "reference",
    assignee: "",
    archived: false,
    createdAt: "2026-03-18T10:00:00.000Z",
    updatedAt: "2026-03-23T10:00:00.000Z",
    historyCount: 1,
  },
] ;

const sampleDocument: ProjectManagementDocument = {
  ...sampleDocuments[0],
  markdown: "# Dependencies\n",
};

test("create form renders without seeded defaults", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[]}
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
      aiLogs={[]}
      aiLogDetail={null}
      aiLogsLoading={false}
      runningAiJobs={[]}
      selectedWorktreeBranch={null}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onRefresh={async () => null}
      onLoadAiLogs={async () => null}
      onLoadAiLog={async () => null}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
      onRunAiCommand={async () => null}
      onRunDocumentAi={async () => null}
      onCancelDocumentAiCommand={async () => null}
      onCancelAiCommand={async () => null}
    />,
  );

  assert.match(markup, /placeholder="Document title"/);
  assert.match(markup, /placeholder="bug, feature, plan"/);
  assert.match(markup, /Select lane/);
  assert.match(markup, /placeholder="Assignee"/);
  assert.match(markup, /<textarea[^>]*><\/textarea>/);
  assert.doesNotMatch(markup, /value="Project Outline"/);
  assert.doesNotMatch(markup, /value="plan"/);
  assert.doesNotMatch(markup, /# Project Outline/);
});

test("document view shows dependency summary and modal entrypoint", () => {
  const markup = renderToStaticMarkup(
    <ProjectManagementPanel
      documents={[...sampleDocuments]}
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
      aiLogs={[]}
      aiLogDetail={null}
      aiLogsLoading={false}
      runningAiJobs={[]}
      selectedWorktreeBranch={null}
      onSubTabChange={() => undefined}
      onDocumentViewModeChange={() => undefined}
      onRefresh={async () => null}
      onLoadAiLogs={async () => null}
      onLoadAiLog={async () => null}
      onSelectDocument={async () => null}
      onCreateDocument={async () => null}
      onUpdateDocument={async () => null}
      onUpdateDependencies={async () => null}
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
