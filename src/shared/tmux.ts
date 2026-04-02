import type { WorktreeId } from "./worktree-id.js";
import { sanitizeSlug } from "./slug-utils.js";

function sanitizeTmuxSegment(value: string, fallback: string): string {
  const sanitized = sanitizeSlug(value);
  return sanitized || fallback;
}

function normalizeRepoPath(repoRoot: string): string {
  return repoRoot.trim().replace(/\\/g, "/").replace(/\/+$/, "").replace(/^[a-zA-Z]:/, "");
}

export function getTmuxRepoName(repoRoot: string): string {
  const normalized = normalizeRepoPath(repoRoot);
  const pathParts = normalized.split("/").filter(Boolean);
  const relevantParts = pathParts[0] === "home" || pathParts[0] === "Users"
    ? pathParts.slice(2)
    : pathParts;
  const repoParts = (relevantParts.length > 0 ? relevantParts : pathParts).slice(-2);
  const sanitizedParts = repoParts
    .map((part) => sanitizeTmuxSegment(part, "repo"))
    .filter(Boolean);

  return sanitizedParts.join("_") || "repo";
}

export function getTmuxSessionName(repoRoot: string, id: WorktreeId): string {
  return `wt-${getTmuxRepoName(repoRoot)}-${sanitizeTmuxSegment(id, "worktree")}`;
}
