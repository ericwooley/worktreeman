import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectManagementPanel } from "./project-management-panel";

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
