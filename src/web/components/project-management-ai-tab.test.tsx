import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";
import { ProjectManagementAiTab } from "./project-management-ai-tab";

const WORKTREE_ID = "55555555555555555555555555555555" as AiCommandJob["worktreeId"];

const sampleOrigin: AiCommandOrigin = {
  kind: "project-management-document-run",
  label: "Project document #12",
  description: "Started from the selected project document.",
  location: {
    tab: "project-management",
    branch: "feature/active-run",
    projectManagementSubTab: "document",
    documentId: "doc-12",
    projectManagementDocumentViewMode: "document",
  },
};

const sampleRunningJob: AiCommandJob = {
  jobId: "job-running-1",
  fileName: "job-running-1.log",
  worktreeId: WORKTREE_ID,
  branch: "feature/active-run",
  documentId: "doc-12",
  commandId: "smart",
  command: "runner --prompt $WTM_AI_INPUT",
  input: "Implement the active worktree view",
  status: "running",
  startedAt: "2026-03-27T10:00:00.000Z",
  stdout: "streamed stdout",
  stderr: "",
  pid: 4242,
  origin: sampleOrigin,
};

const sampleLogSummary: AiCommandLogSummary = {
  jobId: "job-log-1",
  fileName: "job-log-1.log",
  timestamp: "2026-03-27T09:45:00.000Z",
  worktreeId: WORKTREE_ID,
  branch: "feature/ai-log",
  documentId: "doc-8",
  commandId: "simple",
  worktreePath: "/repo/.worktrees/feature-ai-log",
  requestPreview: "Summarize the implementation plan.",
  status: "completed",
  pid: 3131,
  origin: sampleOrigin,
};

const sampleLogDetail: AiCommandLogEntry = {
  jobId: "job-log-1",
  fileName: "job-log-1.log",
  timestamp: "2026-03-27T09:45:00.000Z",
  worktreeId: WORKTREE_ID,
  branch: "feature/ai-log",
  documentId: "doc-8",
  commandId: "simple",
  worktreePath: "/repo/.worktrees/feature-ai-log",
  command: "runner --fast $WTM_AI_INPUT",
  request: "Summarize the implementation plan.",
  response: {
    stdout: "Done.",
    stderr: "",
  },
  status: "completed",
  pid: 3131,
  exitCode: 0,
  processName: "runner",
  completedAt: "2026-03-27T09:46:00.000Z",
  error: null,
  origin: sampleOrigin,
};

function renderAiTab(overrides: Partial<Parameters<typeof ProjectManagementAiTab>[0]> = {}) {
  return renderToStaticMarkup(
    <ProjectManagementAiTab
      activeSubTab="log"
      logs={[sampleLogSummary]}
      logDetail={sampleLogDetail}
      loading={false}
      runningJobs={[sampleRunningJob]}
      onSubTabChange={() => undefined}
      onSelectLog={async () => null}
      onCancelJob={async () => null}
      onOpenOrigin={() => undefined}
      {...overrides}
    />,
  );
}

test("AI log sub tab renders saved log detail and origin actions", () => {
  const markup = renderAiTab();

  assert.match(markup, />AI log</);
  assert.match(markup, />Active AI Worktrees</);
  assert.match(markup, /role="tablist"/);
  assert.match(markup, /id="project-management-ai-activity-log-tab"/);
  assert.match(markup, /id="project-management-ai-activity-log-panel"/);
  assert.match(markup, /aria-labelledby="project-management-ai-activity-log-tab"/);
  assert.match(markup, /Saved logs/);
  assert.match(markup, /feature\/ai-log/);
  assert.match(markup, /Worktree AI output/);
  assert.match(markup, /Initial prompt/);
  assert.match(markup, /Review the markdown prompt that Simple AI received before it started running\./);
  assert.doesNotMatch(markup, /Summarize the implementation plan\./);
  assert.match(markup, /Project document #12/);
  assert.match(markup, />Open origin</);
});

test("AI log sub tab passes passive sync status through to the log header", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-28T15:37:31.000Z");

  try {
    const markup = renderAiTab({
      lastUpdatedAt: "2026-03-28T15:37:30.000Z",
    });

    assert.match(markup, /Updated just now|Updated \d+s ago/);
    assert.doesNotMatch(markup, />Refresh logs</);
  } finally {
    Date.now = originalNow;
  }
});

test("active AI worktrees sub tab renders live output and runtime details", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-27T10:05:30.000Z");

  try {
    const markup = renderAiTab({
      activeSubTab: "active-worktrees",
      logs: [],
      logDetail: null,
    });

    assert.match(markup, /Running jobs/);
    assert.match(markup, /Active worktrees/);
    assert.match(markup, /Running for 5m 30s/);
    assert.match(markup, /AI has been running in feature\/active-run for 5m 30s\./);
    assert.match(markup, /Streaming the combined AI log from feature\/active-run while the worktree run is active\./);
    assert.match(markup, /PID/);
    assert.match(markup, /runner --prompt \$WTM_AI_INPUT/);
  } finally {
    Date.now = originalNow;
  }
});

test("active AI worktrees sub tab shows an empty state when nothing is running", () => {
  const markup = renderAiTab({
    activeSubTab: "active-worktrees",
    logs: [],
    logDetail: null,
    runningJobs: [],
  });

  assert.match(markup, /No worktrees are actively running AI right now\./);
  assert.match(markup, /Select an active AI worktree to inspect its live output\./);
});
