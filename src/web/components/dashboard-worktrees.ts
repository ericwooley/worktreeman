import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "@shared/constants";
import type { WorktreeRecord } from "@shared/types";

export function getVisibleWorktrees(worktrees: WorktreeRecord[] | null | undefined): WorktreeRecord[] {
  return (worktrees ?? []).filter((entry) => entry.branch !== DEFAULT_WORKTREEMAN_SETTINGS_BRANCH);
}
