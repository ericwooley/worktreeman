import assert from "node:assert/strict";
import test from "node:test";
import { getAiResolveButtonState, getResolvableConflictCount } from "./git-status-actions";

test("resolvable conflict count falls back to merge-preview conflicts", () => {
  assert.equal(getResolvableConflictCount({
    workingTreeConflicts: 0,
    mergeIntoWorktreeConflicts: 2,
  }), 2);
});

test("resolvable conflict count prefers active worktree conflicts", () => {
  assert.equal(getResolvableConflictCount({
    workingTreeConflicts: 1,
    mergeIntoWorktreeConflicts: 3,
  }), 1);
});

test("AI resolve button stays disabled when no conflicts exist", () => {
  const state = getAiResolveButtonState({
    hasWorktreeBranch: true,
    gitComparisonLoading: false,
    mergeConflictAiRunning: false,
    resolvableConflicts: 0,
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
    resolvableConflicts: 2,
  });

  assert.equal(state.disabled, false);
  assert.equal(state.label, "AI resolve conflicts");
  assert.match(state.title, /resolve the current git conflicts/i);
});

test("AI resolve button enables when merge preview exposes conflicts", () => {
  const state = getAiResolveButtonState({
    hasWorktreeBranch: true,
    gitComparisonLoading: false,
    mergeConflictAiRunning: false,
    resolvableConflicts: 1,
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
    resolvableConflicts: 1,
  });

  assert.equal(state.disabled, true);
  assert.equal(state.label, "Resolving conflicts...");
  assert.match(state.title, /resolving the current git conflicts/i);
});
