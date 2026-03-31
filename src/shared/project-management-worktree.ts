export interface ProjectManagementDocumentWorktreeIdentity {
  id: string;
  title: string;
}

export function sanitizeProjectManagementWorktreeBranch(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
}

export function normalizeProjectManagementDocumentWorktreeName(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = sanitizeProjectManagementWorktreeBranch(value).slice(0, 72).replace(/-+$/g, "");
  return normalized || null;
}

export function createProjectManagementDocumentWorktreeBranch(document: ProjectManagementDocumentWorktreeIdentity): string {
  const branch = normalizeProjectManagementDocumentWorktreeName(`pm-${document.id}-${document.title}`);
  return branch || `pm-${normalizeProjectManagementDocumentWorktreeName(document.id) || "document"}`;
}

export function createProjectManagementDocumentWorktreeBranchCandidate(baseBranch: string, runNumber: number): string {
  if (runNumber <= 1) {
    return baseBranch;
  }

  const suffix = `-${runNumber}`;
  const truncatedBase = baseBranch
    .slice(0, Math.max(1, 72 - suffix.length))
    .replace(/-+$/g, "");
  return `${truncatedBase || "pm-document"}${suffix}`;
}
