import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectManagementAiLogTab } from "./project-management-ai-log-tab";

function renderAiLogTab() {
  return renderToStaticMarkup(
    <ProjectManagementAiLogTab
      logs={[
        {
          jobId: "job-1",
          fileName: "job-1.log",
          timestamp: "2026-03-27T18:00:00.000Z",
          branch: "feature/readability",
          commandId: "smart",
          worktreePath: "/repo/.worktrees/feature-readability",
          command: "runner --prompt $WTM_AI_INPUT",
          requestPreview: "Improve AI work comment readability",
          status: "completed",
        },
      ]}
      logDetail={{
        jobId: "job-1",
        fileName: "job-1.log",
        timestamp: "2026-03-27T18:00:00.000Z",
        branch: "feature/readability",
        commandId: "smart",
        worktreePath: "/repo/.worktrees/feature-readability",
        command: "runner --prompt $WTM_AI_INPUT",
        request: "Summarize the change",
        response: {
          stdout: "# Stdout heading\n\n- first item\n- second item",
          stderr: "## Stderr heading\n\n**Needs review**",
        },
        status: "completed",
        pid: 1234,
        exitCode: 0,
        completedAt: "2026-03-27T18:01:00.000Z",
        processName: "runner",
        error: null,
        origin: {
          kind: "project-management-document-run",
          label: "Document run",
          description: "Started from the project-management document run flow.",
          location: {
            tab: "project-management",
            branch: "feature/readability",
            projectManagementSubTab: "document",
            documentId: "doc-1",
            projectManagementDocumentViewMode: "document",
          },
        },
      }}
      loading={false}
      runningJobs={[]}
      onSelectLog={async () => null}
      onCancelJob={async () => null}
      onOpenOrigin={() => undefined}
    />, 
  );
}

test("AI log tab renders stdout and stderr as markdown accordions with expected defaults", () => {
  const markup = renderAiLogTab();

  assert.match(markup, /Response stdout/);
  assert.match(markup, /Response stderr/);
  assert.equal((markup.match(/<details class="matrix-accordion" open=""/g) ?? []).length, 2);
  assert.match(markup, /<details class="matrix-accordion"><summary class="matrix-accordion-summary"><span class="min-w-0 flex-1"><div><p class="text-sm font-semibold theme-text-strong">Response stderr<\/p>/);
  assert.match(markup, /max-h-\[24rem\] overflow-auto border theme-border-subtle p-3/);
  assert.match(markup, /<h1>Stdout heading<\/h1>/);
  assert.match(markup, /<li>first item<\/li>/);
  assert.match(markup, /pm-markdown text-sm theme-text/);
  assert.doesNotMatch(markup, /pm-markdown text-sm theme-text-danger/);
});
