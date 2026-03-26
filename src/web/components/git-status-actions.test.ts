import assert from "node:assert/strict";
import test from "node:test";
import { getAiResolveButtonState } from "./git-status-actions";

test("AI resolve button stays disabled when no conflicts exist", () => {
  const state = getAiResolveButtonState({
    hasWorktreeBranch: true,
    gitComparisonLoading: false,
    mergeConflictAiRunning: false,
    workingTreeConflicts: 0,
  });

  assert.equal(state.disabled, true);
  assert.equal(state.label, "AI resolve conflicts");
  assert.match(state.title, /no git conflicts/i);
});

test("AI resolve button enables when worktree has conflicts", () => {
  const state = getAiResolveButtonState({
    hasWorktreeBranch: true,
    gitComparisonLoading: false,
    mergeConflictAiRunning: false,
    workingTreeConflicts: 2,
  });

  assert.equal(state.disabled, false);
  assert.equal(state.label, "AI resolve conflicts");
  assert.match(state.title, /resolve the current git conflicts/i);
});

test("AI resolve button shows running state while AI is active", () => {
  const state = getAiResolveButtonState({
    hasWorktreeBranch: true,
    gitComparisonLoading: false,
    mergeConflictAiRunning: true,
    workingTreeConflicts: 1,
  });

  assert.equal(state.disabled, true);
  assert.equal(state.label, "Resolving conflicts...");
  assert.match(state.title, /resolving the current git conflicts/i);
});
