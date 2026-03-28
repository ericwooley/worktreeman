import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";
import { ProjectManagementAiLogTab } from "./project-management-ai-log-tab";

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
  branch: "feature-ai-log",
  commandId: "smart",
  worktreePath: "/repo/feature-ai-log",
  command: "runner --prompt",
  requestPreview: "This preview should not be the primary card content.",
  status: "completed",
  origin: environmentOrigin,
};

const detailLog: AiCommandLogEntry = {
  jobId: "job-1",
  fileName: "log-1.json",
  timestamp: "2026-03-27T10:00:00.000Z",
  completedAt: "2026-03-27T10:01:00.000Z",
  branch: "feature-ai-log",
  commandId: "smart",
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

test("AI log detail renders derived titles, mixed timeline, and markdown response accordions", () => {
  const markup = renderAiLogTab();

  assert.match(markup, /Environment terminal · feature-ai-log/);
  assert.match(markup, /Mixed output timeline/);
  assert.match(markup, /stdout/);
  assert.match(markup, /stderr/);
  assert.match(markup, /Warning output/);
  assert.match(markup, /\+1 minute since previous output/);
  assert.match(markup, /Response stdout/);
  assert.match(markup, /Response stderr/);
  assert.match(markup, /<h1>Stdout heading<\/h1>/);
  assert.match(markup, /<li>first item<\/li>/);
  assert.match(markup, /pm-markdown text-sm theme-text/);
  assert.doesNotMatch(markup, /pm-markdown text-sm theme-text-danger/);
});

test("AI log empty state keeps recent activity visible", () => {
  const markup = renderAiLogTab({ logDetail: null });

  assert.match(markup, /Keep the latest run in view/);
  assert.match(markup, /Recent activity/);
  assert.match(markup, /Open latest run/);
  assert.match(markup, /Environment terminal · feature-ai-log/);
});

test("running cards prefer derived origin titles over prompt preview text", () => {
  const runningJob: AiCommandJob = {
    jobId: "job-2",
    fileName: "log-2.json",
    branch: "feature-ai-log",
    commandId: "simple",
    command: "runner --fast",
    input: "A very long prompt that should not be shown as the card title.",
    status: "running",
    startedAt: "2026-03-27T10:02:00.000Z",
    stdout: "",
    stderr: "",
    outputEvents: [],
    origin: environmentOrigin,
  };

  const markup = renderAiLogTab({
    logDetail: detailLog,
    runningJobs: [runningJob],
  });

  assert.match(markup, /Environment terminal · feature-ai-log/);
  assert.doesNotMatch(markup, /A very long prompt that should not be shown as the card title/);
});

test("running entries are not duplicated in the saved logs list", () => {
  const runningJob: AiCommandJob = {
    jobId: "job-1",
    fileName: "log-1.json",
    branch: "feature-ai-log",
    commandId: "smart",
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

  assert.match(markup, /Running now/);
  assert.match(markup, /Saved logs/);
  assert.match(markup, /Recent activity/);
  assert.match(markup, /Open latest run/);
  assert.match(markup, />0<\/span>/);
  assert.equal((markup.match(/log-1\.json/g) ?? []).length, 0);
  assert.equal((markup.match(/feature-ai-log/g) ?? []).length >= 2, true);
});
