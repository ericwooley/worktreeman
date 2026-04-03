import assert from "node:assert/strict";
import test from "#test-runtime";
import type { WorktreeRecord } from "@shared/types";
import { buildDeleteWorktreePayload, confirmWorktreeDeletion, type DeleteConfirmationState } from "./dashboard-delete";

const WORKTREE_ID = "11111111111111111111111111111111" as WorktreeRecord["id"];

function createDeleteConfirmationState(overrides?: Partial<DeleteConfirmationState>): DeleteConfirmationState {
  const worktree: WorktreeRecord = {
    id: WORKTREE_ID,
    branch: "feature-delete",
    worktreePath: "/tmp/feature-delete",
    isBare: false,
    isDetached: false,
    locked: false,
    prunable: false,
    deletion: {
      canDelete: true,
      reason: null,
      requiresConfirmation: false,
      hasLocalChanges: false,
      hasUnmergedCommits: false,
      deleteBranchByDefault: true,
      isDefaultBranch: false,
      isDefaultWorktree: false,
      isSettingsWorktree: false,
    },
  };

  return {
    worktree,
    deleteBranch: true,
    confirmWorktreeName: "",
    ...overrides,
  };
}

test("buildDeleteWorktreePayload omits confirmation text when not required", () => {
  const payload = buildDeleteWorktreePayload(createDeleteConfirmationState());

  assert.deepEqual(payload, {
    deleteBranch: true,
    confirmWorktreeName: undefined,
  });
});

test("buildDeleteWorktreePayload includes confirmation text when required", () => {
  const baseState = createDeleteConfirmationState();
  const payload = buildDeleteWorktreePayload({
    ...baseState,
    confirmWorktreeName: "feature-delete",
    worktree: {
      ...baseState.worktree,
      deletion: {
        ...baseState.worktree.deletion!,
        requiresConfirmation: true,
      },
    },
  });

  assert.deepEqual(payload, {
    deleteBranch: true,
    confirmWorktreeName: "feature-delete",
  });
});

test("confirmWorktreeDeletion reports success after delete completes", async () => {
  const deleteConfirmation = createDeleteConfirmationState();
  let receivedBranch: string | null = null;

  const result = await confirmWorktreeDeletion(deleteConfirmation, async (branch, payload) => {
    receivedBranch = branch;
    assert.deepEqual(payload, {
      deleteBranch: true,
      confirmWorktreeName: undefined,
    });
  });

  assert.deepEqual(result, { success: true });
  assert.equal(receivedBranch, "feature-delete");
});

test("confirmWorktreeDeletion keeps the modal open on delete failure", async () => {
  const result = await confirmWorktreeDeletion(
    createDeleteConfirmationState(),
    async () => {
      throw new Error("Delete failed.");
    },
  );

  assert.deepEqual(result, {
    success: false,
    message: "Delete failed.",
  });
});
