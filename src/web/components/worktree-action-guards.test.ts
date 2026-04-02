import assert from "node:assert/strict";
import test from "node:test";
import type { AiCommandJob } from "@shared/types";
import { getWorktreeDeleteAiDisabledReason, getWorktreeMergeAiDisabledReason } from "./worktree-action-guards";

const WORKTREE_ID = "77777777777777777777777777777777" as AiCommandJob["worktreeId"];

function createAiJob(overrides: Partial<AiCommandJob> = {}): AiCommandJob {
  return {
    jobId: "job-1",
    fileName: "job-1.json",
    worktreeId: WORKTREE_ID,
    branch: "feature-ai",
    commandId: "smart",
    command: "echo test",
    input: "test",
    status: "running",
    startedAt: "2026-03-31T00:00:00.000Z",
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

test("getWorktreeDeleteAiDisabledReason returns a targeted message for running AI", () => {
  const reason = getWorktreeDeleteAiDisabledReason([createAiJob()], "feature-ai");

  assert.equal(reason, "Cancel the running AI job on feature-ai before deleting this worktree.");
});

test("getWorktreeDeleteAiDisabledReason ignores completed AI jobs", () => {
  const reason = getWorktreeDeleteAiDisabledReason([
    createAiJob({ status: "completed" }),
  ], "feature-ai");

  assert.equal(reason, null);
});

test("getWorktreeMergeAiDisabledReason blocks merges when the selected worktree branch is running AI", () => {
  const reason = getWorktreeMergeAiDisabledReason([createAiJob()], ["feature-ai", "main"]);

  assert.equal(reason, "Cancel the running AI job on feature-ai before merging these branches.");
});

test("getWorktreeMergeAiDisabledReason also blocks merges when the target worktree branch is running AI", () => {
  const reason = getWorktreeMergeAiDisabledReason([
    createAiJob({ branch: "main" }),
  ], ["feature-ai", "main"]);

  assert.equal(reason, "Cancel the running AI job on main before merging these branches.");
});
