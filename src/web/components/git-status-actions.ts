export function getResolvableConflictCount(options: {
  workingTreeConflicts: number;
  mergeIntoWorktreeConflicts: number;
}) {
  return options.workingTreeConflicts > 0
    ? options.workingTreeConflicts
    : options.mergeIntoWorktreeConflicts;
}

export function getAiResolveButtonState(options: {
  hasWorktreeBranch: boolean;
  gitComparisonLoading: boolean;
  mergeConflictAiRunning: boolean;
  resolvableConflicts: number;
}) {
  if (!options.hasWorktreeBranch) {
    return {
      disabled: true,
      title: "Open a worktree branch to resolve git conflicts with AI.",
      label: options.mergeConflictAiRunning ? "Resolving conflicts..." : "AI resolve conflicts",
    };
  }

  if (options.gitComparisonLoading) {
    return {
      disabled: true,
      title: "Git comparison is updating.",
      label: options.mergeConflictAiRunning ? "Resolving conflicts..." : "AI resolve conflicts",
    };
  }

  if (options.mergeConflictAiRunning) {
    return {
      disabled: true,
      title: "Smart AI is resolving the current git conflicts.",
      label: "Resolving conflicts...",
    };
  }

  if (options.resolvableConflicts === 0) {
    return {
      disabled: true,
      title: "No git conflicts are available to resolve.",
      label: "AI resolve conflicts",
    };
  }

  return {
    disabled: false,
    title: "Ask Smart AI to resolve the current git conflicts in this worktree.",
    label: "AI resolve conflicts",
  };
}
