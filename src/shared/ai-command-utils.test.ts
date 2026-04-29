import assert from "node:assert/strict";
import test from "#test-runtime";
import type { AiCommandJob } from "./types.js";
import { AI_COMMAND_PROCESS_UNAVAILABLE_MESSAGE, isAiCommandNonActionableCleanupFailure } from "./ai-command-utils.js";

const WORKTREE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as AiCommandJob["worktreeId"];

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

test("isAiCommandNonActionableCleanupFailure identifies unavailable process cleanup jobs", () => {
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ failureReason: "startup-reconcile" })), true);
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ failureReason: "process-unavailable" })), true);
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ error: AI_COMMAND_PROCESS_UNAVAILABLE_MESSAGE })), true);
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ stderr: AI_COMMAND_PROCESS_UNAVAILABLE_MESSAGE })), true);
});

test("isAiCommandNonActionableCleanupFailure keeps real command failures actionable", () => {
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ failureReason: "process-exited", error: "Tests failed." })), false);
  assert.equal(isAiCommandNonActionableCleanupFailure(createAiJob({ status: "running", failureReason: "process-unavailable" })), false);
});
