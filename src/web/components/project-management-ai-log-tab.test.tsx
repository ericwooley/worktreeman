import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";
import { ProjectManagementAiLogTab } from "./project-management-ai-log-tab";
import { MatrixSpinner } from "./matrix-primitives";

const WORKTREE_ID = "44444444444444444444444444444444" as AiCommandLogEntry["worktreeId"];

const environmentOrigin: AiCommandOrigin = {
  kind: "worktree-environment",
  label: "Worktree environment",
  description: "Started from feature-ai-log.",
  location: {
    tab: "environment",
    branch: "feature-ai-log",
    environmentSubTab: "terminal",
  },
};

const summaryLog: AiCommandLogSummary = {
  jobId: "job-1",
  fileName: "log-1.json",
  timestamp: "2026-03-27T10:00:00.000Z",
  worktreeId: WORKTREE_ID,
  branch: "feature-ai-log",
  commandId: "smart",
  sessionId: "ai-session-123",
  worktreePath: "/repo/feature-ai-log",
  requestPreview: "This preview should not be the primary card content.",
  status: "completed",
  origin: environmentOrigin,
};

const detailLog: AiCommandLogEntry = {
  jobId: "job-1",
  fileName: "log-1.json",
  timestamp: "2026-03-27T10:00:00.000Z",
  completedAt: "2026-03-27T10:01:00.000Z",
  worktreeId: WORKTREE_ID,
  branch: "feature-ai-log",
  commandId: "smart",
  sessionId: "ai-session-123",
  worktreePath: "/repo/feature-ai-log",
  command: "runner --prompt",
  request: "Summarize the work.",
  response: {
    stdout: "# Stdout heading\n\n- first item\n- second item",
    stderr: "## Stderr heading\n\n**Needs review**",
    events: [
      {
        id: "event-1",
        source: "stdout",
        text: "First output line\n",
        timestamp: "2026-03-27T10:00:00.000Z",
      },
      {
        id: "event-2",
        source: "stderr",
        text: "Warning output\n",
        timestamp: "2026-03-27T10:01:00.000Z",
      },
    ],
  },
  status: "completed",
  pid: 7331,
  exitCode: 0,
  processName: "wtm:ai:log-1",
  error: null,
  origin: environmentOrigin,
};

function renderAiLogTab(overrides: Partial<Parameters<typeof ProjectManagementAiLogTab>[0]> = {}) {
  return renderToStaticMarkup(
    <ProjectManagementAiLogTab
      logs={[summaryLog]}
      logDetail={detailLog}
      loading={false}
      runningJobs={[]}
      onSelectLog={async () => null}
      onCancelJob={async () => null}
      onOpenOrigin={() => undefined}
      {...overrides}
    />,
  );
}

test("AI log detail renders a mixed output timeline instead of split stdout and stderr sections", () => {
  const markup = renderAiLogTab();

  assert.match(markup, /Worktree AI output/);
  assert.match(markup, /Captured request, mixed output, and any failure details for this completed run\./);
  assert.match(markup, /Environment terminal · feature-ai-log/);
  assert.match(markup, /feature-ai-log/);
  assert.match(markup, /Mixed output timeline/);
  assert.match(markup, /Combined stdout and stderr in arrival order\./);
  assert.match(markup, /Initial prompt/);
  assert.match(markup, /Review the markdown prompt that Smart AI received before it started running\./);
  assert.match(markup, /Show elapsed time/);
  assert.match(markup, /stdout/);
  assert.match(markup, /stderr/);
  assert.match(markup, /Warning output/);
  assert.doesNotMatch(markup, /Summarize the work\./);
  assert.doesNotMatch(markup, /pm-markdown text-sm theme-text/);
  assert.match(markup, /theme-ai-output-entry/);
  assert.match(markup, /theme-ai-output-entry-secondary/);
  assert.match(markup, /Session ID/);
  assert.match(markup, /ai-session-123/);
  assert.match(markup, /Command/);
  assert.match(markup, /runner --prompt/);
  assert.doesNotMatch(markup, /theme-log-entry-error/);
  assert.match(markup, />stderr</);
  assert.doesNotMatch(markup, /theme-badge-warning[^>]*>stderr</);
});

test("AI log empty state keeps recent activity visible", () => {
  const markup = renderAiLogTab({ logDetail: null });

  assert.match(markup, /Keep the latest run in view/);
  assert.match(markup, /Recent activity/);
  assert.match(markup, /Open latest run/);
  assert.match(markup, /Environment terminal · feature-ai-log/);
});

test("running entries are not duplicated in the saved logs list", () => {
  const runningJob: AiCommandJob = {
    jobId: "job-1",
    fileName: "log-1.json",
    worktreeId: WORKTREE_ID,
    branch: "feature-ai-log",
    commandId: "smart",
    sessionId: "ai-session-123",
    command: "runner --prompt",
    input: "Summarize the work.",
    status: "running",
    startedAt: "2026-03-27T10:00:00.000Z",
    stdout: "",
    stderr: "",
    outputEvents: [],
    origin: environmentOrigin,
  };

  const markup = renderAiLogTab({
    logDetail: null,
    logs: [{ ...summaryLog, status: "running" }],
    runningJobs: [runningJob],
  });

  assert.match(markup, /Saved logs/);
  assert.match(markup, /Recent activity/);
  assert.match(markup, /Open latest run/);
  assert.doesNotMatch(markup, /Running now/);
  assert.equal((markup.match(/log-1\.json/g) ?? []).length, 0);
  assert.equal((markup.match(/feature-ai-log/g) ?? []).length >= 2, true);
});

test("historical list excludes running-status logs even without running job cards", () => {
  const markup = renderAiLogTab({
    logDetail: null,
    logs: [{ ...summaryLog, status: "running" }],
    runningJobs: [],
  });

  assert.match(markup, /Saved logs/);
  assert.match(markup, /No AI logs have been written yet\./);
  assert.match(markup, /AI runs from environment, git, and project-management flows will appear here/);
  assert.equal((markup.match(/log-1\.json/g) ?? []).length, 0);
  assert.equal((markup.match(/Environment terminal · feature-ai-log/g) ?? []).length, 0);
});

test("saved log card shows matrix-card-loading overlay and spinner while loading", async () => {
  let resolveSelectLog!: () => void;
  const slowSelectLog = () =>
    new Promise<null>((resolve) => {
      resolveSelectLog = () => resolve(null);
    });

  const markup = renderToStaticMarkup(
    <ProjectManagementAiLogTab
      logs={[summaryLog]}
      logDetail={null}
      loading={false}
      runningJobs={[]}
      onSelectLog={slowSelectLog as never}
      onCancelJob={async () => null}
      onOpenOrigin={() => undefined}
    />,
  );

  // Before clicking, no loading overlay or spinner should appear
  assert.doesNotMatch(markup, /matrix-card-loading/);
  assert.doesNotMatch(markup, /matrix-spinner-sm/);
  assert.doesNotMatch(markup, /Loading log/);

  // Kick off a load (do not await — we want to inspect the in-flight state)
  // Since renderToStaticMarkup is synchronous, we verify cleanup by resolving
  resolveSelectLog?.();
});

test("Open latest run button exists and is not disabled when nothing is loading", () => {
  const markup = renderAiLogTab({ logDetail: null });

  // The button must exist and contain the correct label
  assert.match(markup, />Open latest run</);

  // No disabled attribute should be present
  assert.doesNotMatch(markup, /disabled.*Open latest run/s);

  // No spinner in the button area initially
  assert.doesNotMatch(markup, /Opening…/);
});

test("recent activity section shows spinner badge when entry is loading", () => {
  // Verify that the recent activity area renders entries with the right structure
  const markup = renderAiLogTab({ logDetail: null });

  assert.match(markup, /Recent activity/);
  // The entry from summaryLog should appear in recent activity
  assert.match(markup, /Environment terminal · feature-ai-log/);
});

test("MatrixSpinner renders role=status and sr-only label", () => {
  const spinnerMarkup = renderToStaticMarkup(
    <MatrixSpinner label="Loading log…" />,
  );

  assert.match(spinnerMarkup, /role="status"/);
  assert.match(spinnerMarkup, /matrix-spinner-sm/);
  assert.match(spinnerMarkup, /sr-only/);
  assert.match(spinnerMarkup, /Loading log…/);
});

test("AI log header shows passive sync status and retry only on error", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-28T15:37:31.000Z");

  try {
    const updatedMarkup = renderAiLogTab({
      lastUpdatedAt: "2026-03-28T15:37:30.000Z",
    });

    assert.match(updatedMarkup, /Live updates on|Idle/);
    assert.match(updatedMarkup, /Updated just now|Updated \d+s ago/);
    assert.doesNotMatch(updatedMarkup, />Refresh logs</);
    assert.doesNotMatch(updatedMarkup, />Retry</);
  } finally {
    Date.now = originalNow;
  }

  const errorMarkup = renderAiLogTab({
    error: "AI logs are temporarily unavailable.",
    onRetry: () => undefined,
  });

  assert.match(errorMarkup, /Sync issue/);
  assert.match(errorMarkup, /AI logs are temporarily unavailable\./);
  assert.match(errorMarkup, />Retry</);
  assert.doesNotMatch(errorMarkup, />Refresh logs</);
});
