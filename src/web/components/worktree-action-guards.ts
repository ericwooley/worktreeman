import type { AiCommandJob } from "@shared/types";

function getRunningAiBranches(runningAiJobs: AiCommandJob[]) {
  return new Set(
    runningAiJobs
      .filter((job) => job.status === "running")
      .map((job) => job.branch),
  );
}

function getFirstMatchingRunningAiBranch(runningAiJobs: AiCommandJob[], branches: Array<string | null | undefined>) {
  const runningBranches = getRunningAiBranches(runningAiJobs);
  for (const branch of branches) {
    if (branch && runningBranches.has(branch)) {
      return branch;
    }
  }

  return null;
}

export function getWorktreeDeleteAiDisabledReason(runningAiJobs: AiCommandJob[], worktreeBranch: string | null | undefined) {
  const runningBranch = getFirstMatchingRunningAiBranch(runningAiJobs, [worktreeBranch]);
  if (!runningBranch) {
    return null;
  }

  return `Cancel the running AI job on ${runningBranch} before deleting this worktree.`;
}

export function getWorktreeMergeAiDisabledReason(runningAiJobs: AiCommandJob[], branches: Array<string | null | undefined>) {
  const runningBranch = getFirstMatchingRunningAiBranch(runningAiJobs, branches);
  if (!runningBranch) {
    return null;
  }

  return `Cancel the running AI job on ${runningBranch} before merging these branches.`;
}
