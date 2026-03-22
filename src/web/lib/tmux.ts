function sanitizeBranchName(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function getTmuxSessionName(branch: string): string {
  return `wt-${sanitizeBranchName(branch)}`;
}
