import type { DeleteWorktreeRequest, WorktreeRecord } from "@shared/types";

export interface DeleteConfirmationState {
  worktree: WorktreeRecord;
  deleteBranch: boolean;
  confirmWorktreeName: string;
}

export function buildDeleteWorktreePayload(deleteConfirmation: DeleteConfirmationState): DeleteWorktreeRequest {
  return {
    deleteBranch: deleteConfirmation.deleteBranch,
    confirmWorktreeName: deleteConfirmation.worktree.deletion?.requiresConfirmation
      ? deleteConfirmation.confirmWorktreeName
      : undefined,
  };
}

export async function confirmWorktreeDeletion(
  deleteConfirmation: DeleteConfirmationState,
  remove: (branch: string, payload: DeleteWorktreeRequest) => Promise<void>,
): Promise<{ success: true } | { success: false; message: string }> {
  try {
    await remove(deleteConfirmation.worktree.branch, buildDeleteWorktreePayload(deleteConfirmation));
    return { success: true };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Failed to delete worktree.",
    };
  }
}
