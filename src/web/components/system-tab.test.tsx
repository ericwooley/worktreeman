import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { SystemStatusResponse } from "@shared/types";
import { SystemTab } from "./system-tab";

const sampleStatus: SystemStatusResponse = {
  capturedAt: "2026-03-31T12:00:00.000Z",
  performance: {
    hostname: "builder-01",
    platform: "linux",
    arch: "x64",
    nodeVersion: "v22.2.0",
    uptimeSeconds: 93784,
    cpu: {
      coreCount: 12,
      model: "Example CPU",
      speedMhz: 3200,
      loadAverage: [1.42, 1.11, 0.88],
      loadAveragePerCore: [0.12, 0.09, 0.07],
    },
    memory: {
      totalBytes: 32 * 1024 * 1024 * 1024,
      freeBytes: 10 * 1024 * 1024 * 1024,
      usedBytes: 22 * 1024 * 1024 * 1024,
      usageRatio: 0.6875,
    },
    worktrees: {
      total: 4,
      runtimeCount: 2,
      linkedDocumentCount: 3,
    },
  },
  jobs: {
    available: true,
    unavailableReason: null,
    total: 2,
    countsByState: {
      active: 1,
      completed: 1,
    },
    items: [
      {
        id: "job-active-1",
        queue: "project-management-ai-update",
        state: "active",
        priority: 5,
        retryLimit: 0,
        retryCount: 0,
        retryDelay: null,
        retryDelayMax: null,
        retryBackoff: false,
        expireSeconds: 900,
        deletionSeconds: 3600,
        policy: "standard",
        singletonKey: null,
        singletonOn: null,
        deadLetter: null,
        startAfter: "2026-03-31T11:58:00.000Z",
        createdAt: "2026-03-31T11:58:00.000Z",
        startedAt: "2026-03-31T11:58:10.000Z",
        completedAt: null,
        keepUntil: "2026-04-01T11:58:00.000Z",
        heartbeatAt: "2026-03-31T11:59:00.000Z",
        heartbeatSeconds: 30,
        runtimeSeconds: 110,
        hasOutput: false,
        payloadSummary: {
          branch: "feature/system-tab",
          documentId: "doc-12",
          commandId: "smart",
          worktreePath: "/repo/.worktrees/feature-system-tab",
          originKind: "project-management-document-run",
          originLabel: "Project document #12",
          renderedCommandPreview: "runner --prompt \"Add the System tab\"",
          inputPreview: "Add the System tab and summarize queue activity.",
          applyDocumentUpdateToDocumentId: "doc-12",
          reviewDocumentId: null,
          reviewRequestSummaryPreview: null,
          autoCommitDirtyWorktree: true,
        },
      },
      {
        id: "job-complete-1",
        queue: "project-management-ai-update",
        state: "completed",
        priority: 1,
        retryLimit: 0,
        retryCount: 0,
        retryDelay: null,
        retryDelayMax: null,
        retryBackoff: false,
        expireSeconds: 900,
        deletionSeconds: 3600,
        policy: "standard",
        singletonKey: null,
        singletonOn: null,
        deadLetter: null,
        startAfter: null,
        createdAt: "2026-03-31T10:00:00.000Z",
        startedAt: "2026-03-31T10:00:05.000Z",
        completedAt: "2026-03-31T10:02:05.000Z",
        keepUntil: "2026-04-01T10:00:00.000Z",
        heartbeatAt: null,
        heartbeatSeconds: null,
        runtimeSeconds: 120,
        hasOutput: true,
        payloadSummary: {
          branch: "feature/queue-cleanup",
          documentId: null,
          commandId: "simple",
          worktreePath: "/repo/.worktrees/feature-queue-cleanup",
          originKind: "worktree-environment",
          originLabel: "Environment terminal",
          renderedCommandPreview: "runner --fast \"Check queue state\"",
          inputPreview: "Check queue state",
          applyDocumentUpdateToDocumentId: null,
          reviewDocumentId: null,
          reviewRequestSummaryPreview: "Summarize the queue cleanup status.",
          autoCommitDirtyWorktree: false,
        },
      },
    ],
  },
};

function renderSystemTab(overrides: Partial<Parameters<typeof SystemTab>[0]> = {}) {
  return renderToStaticMarkup(
    <SystemTab
      activeSubTab="performance"
      status={sampleStatus}
      loading={false}
      onSubTabChange={() => undefined}
      {...overrides}
    />,
  );
}

test("System performance tab renders metrics and passive sync status", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-31T12:00:01.000Z");

  try {
    const markup = renderSystemTab({
      activeSubTab: "performance",
      lastUpdatedAt: "2026-03-31T12:00:00.000Z",
    });

    assert.match(markup, />Performance</);
    assert.match(markup, />Jobs</);
    assert.match(markup, /id="system-tab-performance-tab"/);
    assert.match(markup, /id="system-tab-performance-panel"/);
    assert.match(markup, /aria-labelledby="system-tab-performance-tab"/);
    assert.match(markup, /Host performance and queue activity/);
    assert.match(markup, /CPU cores/);
    assert.match(markup, /Load avg \(1m\)/);
    assert.match(markup, /Memory used/);
    assert.match(markup, /builder-01/);
    assert.match(markup, /Example CPU/);
    assert.match(markup, /Updated just now|Updated \d+s ago/);
    assert.doesNotMatch(markup, />Refresh</);
  } finally {
    Date.now = originalNow;
  }
});

test("System jobs tab renders pg-boss job detail and payload summary", () => {
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-03-31T12:00:01.000Z");

  try {
    const markup = renderSystemTab({
      activeSubTab: "jobs",
      lastUpdatedAt: "2026-03-31T12:00:00.000Z",
    });

    assert.match(markup, /id="system-tab-jobs-tab"/);
    assert.match(markup, /id="system-tab-jobs-panel"/);
    assert.match(markup, /Recent pg-boss jobs/);
    assert.match(markup, /Live updates on/);
    assert.match(markup, /Project document #12/);
    assert.match(markup, /project-management-ai-update/);
    assert.match(markup, /Payload summary/);
    assert.match(markup, /feature\/system-tab/);
    assert.match(markup, /Rendered command/);
    assert.match(markup, /runner --prompt/);
    assert.match(markup, /Input preview/);
    assert.doesNotMatch(markup, />Refresh</);
  } finally {
    Date.now = originalNow;
  }
});

test("System jobs tab shows unavailable state and inline retry when sync fails", () => {
  const markup = renderSystemTab({
    activeSubTab: "jobs",
    error: "System polling paused.",
    onRetry: () => undefined,
    status: {
      ...sampleStatus,
      jobs: {
        available: false,
        unavailableReason: "The pg-boss job table is not initialized yet.",
        total: 0,
        countsByState: {},
        items: [],
      },
    },
  });

  assert.match(markup, /Sync issue/);
  assert.match(markup, />Retry</);
  assert.match(markup, /The pg-boss job table is not initialized yet\./);
});
