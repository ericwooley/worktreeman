import assert from "node:assert/strict";
import test from "#test-runtime";
import {
  appendDashboardNotification,
  dismissDashboardNotification,
  shouldNotifyAiCommandJobFailure,
  type DashboardNotification,
} from "./use-dashboard-state";
import type { AiCommandJob } from "@shared/types";

const WORKTREE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as AiCommandJob["worktreeId"];

function createNotification(id: string, tone: DashboardNotification["tone"], title: string, message: string): DashboardNotification {
  return {
    id,
    tone,
    title,
    message,
    createdAt: `2026-04-24T12:00:0${id}.000Z`,
  };
}

function createAiJob(overrides: Partial<AiCommandJob> = {}): AiCommandJob {
  return {
    jobId: "job-1",
    fileName: "job-1.json",
    worktreeId: WORKTREE_ID,
    branch: "feature/zombie-ai",
    commandId: "smart",
    command: "runner --prompt $WTM_AI_INPUT",
    input: "Run the task",
    status: "failed",
    startedAt: "2026-04-29T12:00:00.000Z",
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

test("appendDashboardNotification keeps the newest notifications within the stack limit", () => {
  const notifications = [
    createNotification("1", "info", "Started", "First request started."),
    createNotification("2", "success", "Saved", "Second request finished."),
  ];

  const next = appendDashboardNotification(
    notifications,
    createNotification("3", "danger", "Request failed", "Third request failed."),
    2,
  );

  assert.deepEqual(next.map((notification) => notification.id), ["2", "3"]);
});

test("dismissDashboardNotification removes only the targeted notification", () => {
  const notifications = [
    createNotification("1", "info", "Started", "First request started."),
    createNotification("2", "warning", "Check this request", "Background sync needs attention."),
    createNotification("3", "danger", "Request failed", "Third request failed."),
  ];

  const next = dismissDashboardNotification(notifications, "2");

  assert.deepEqual(next.map((notification) => notification.id), ["1", "3"]);
});

test("shouldNotifyAiCommandJobFailure ignores non-actionable zombie cleanup failures", () => {
  assert.equal(
    shouldNotifyAiCommandJobFailure(null, createAiJob({ failureReason: "process-unavailable" })),
    false,
  );
  assert.equal(
    shouldNotifyAiCommandJobFailure(null, createAiJob({ failureReason: "startup-reconcile" })),
    false,
  );
  assert.equal(
    shouldNotifyAiCommandJobFailure("running", createAiJob({ failureReason: "process-exited", error: "Tests failed." })),
    true,
  );
  assert.equal(
    shouldNotifyAiCommandJobFailure("failed", createAiJob({ failureReason: "process-exited", error: "Tests failed." })),
    false,
  );
});
