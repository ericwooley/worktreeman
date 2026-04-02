import assert from "node:assert/strict";
import test from "node:test";
import { getVisibleWorktrees } from "./dashboard-worktrees";
import type { WorktreeRecord } from "@shared/types";

const WORKTREE_ID_PREFIX = "222222222222222222222222222222";

function createWorktree(branch: string): WorktreeRecord {
  return {
    id: `${WORKTREE_ID_PREFIX}${branch === "main" ? "01" : branch === "wtm-settings" ? "02" : "03"}` as WorktreeRecord["id"],
    branch,
    worktreePath: `/tmp/${branch}`,
    isBare: false,
    isDetached: false,
    locked: false,
    prunable: false,
  };
}

test("getVisibleWorktrees excludes the settings worktree and preserves order", () => {
  const worktrees = [
    createWorktree("main"),
    createWorktree("wtm-settings"),
    createWorktree("feature-delete"),
  ];

  assert.deepEqual(
    getVisibleWorktrees(worktrees).map((entry) => entry.branch),
    ["main", "feature-delete"],
  );
});
