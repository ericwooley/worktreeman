import fs from "node:fs/promises";
import path from "node:path";
import type { ProjectManagementDocumentSummary, WorktreeLinkedDocumentSummary, WorktreeRecord } from "../../shared/types.js";

interface StoredWorktreeLink {
  branch: string;
  worktreePath: string;
  documentId: string;
  updatedAt: string;
}

interface StoredWorktreeLinkFile {
  version: 1;
  links: StoredWorktreeLink[];
}

function resolveWorktreeLinkDir(repoRoot: string): string {
  return path.resolve(repoRoot, ".worktree-meta");
}

function resolveWorktreeLinkFile(repoRoot: string): string {
  return path.join(resolveWorktreeLinkDir(repoRoot), "links.json");
}

async function readStoredWorktreeLinks(repoRoot: string): Promise<StoredWorktreeLink[]> {
  const filePath = resolveWorktreeLinkFile(repoRoot);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredWorktreeLinkFile>;
    if (!Array.isArray(parsed.links)) {
      return [];
    }

    return parsed.links.filter((entry): entry is StoredWorktreeLink => (
      typeof entry?.branch === "string"
      && typeof entry.worktreePath === "string"
      && typeof entry.documentId === "string"
      && typeof entry.updatedAt === "string"
    ));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

async function writeStoredWorktreeLinks(repoRoot: string, links: StoredWorktreeLink[]): Promise<void> {
  const dirPath = resolveWorktreeLinkDir(repoRoot);
  const filePath = resolveWorktreeLinkFile(repoRoot);
  await fs.mkdir(dirPath, { recursive: true });

  const payload: StoredWorktreeLinkFile = {
    version: 1,
    links: links.sort((left, right) => left.branch.localeCompare(right.branch)),
  };
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

export async function getWorktreeDocumentLinks(repoRoot: string): Promise<Map<string, StoredWorktreeLink>> {
  const links = await readStoredWorktreeLinks(repoRoot);
  return new Map(links.map((entry) => [entry.branch, entry]));
}

export async function getWorktreeDocumentLink(repoRoot: string, branch: string): Promise<StoredWorktreeLink | null> {
  const links = await getWorktreeDocumentLinks(repoRoot);
  return links.get(branch) ?? null;
}

export async function setWorktreeDocumentLink(repoRoot: string, details: {
  branch: string;
  worktreePath: string;
  documentId: string;
}): Promise<void> {
  const links = await readStoredWorktreeLinks(repoRoot);
  const nextEntry: StoredWorktreeLink = {
    branch: details.branch,
    worktreePath: details.worktreePath,
    documentId: details.documentId,
    updatedAt: new Date().toISOString(),
  };
  const nextLinks = links.filter((entry) => entry.branch !== details.branch);
  nextLinks.push(nextEntry);
  await writeStoredWorktreeLinks(repoRoot, nextLinks);
}

export async function clearWorktreeDocumentLink(repoRoot: string, branch: string): Promise<void> {
  const links = await readStoredWorktreeLinks(repoRoot);
  const nextLinks = links.filter((entry) => entry.branch !== branch);
  if (nextLinks.length === links.length) {
    return;
  }

  await writeStoredWorktreeLinks(repoRoot, nextLinks);
}

function toLinkedDocumentSummary(document: ProjectManagementDocumentSummary): WorktreeLinkedDocumentSummary {
  return {
    id: document.id,
    number: document.number,
    title: document.title,
    summary: document.summary,
    kind: document.kind,
    pullRequest: document.pullRequest ? { ...document.pullRequest } : null,
    status: document.status,
    archived: document.archived,
  };
}

export function attachWorktreeDocumentLinks(
  worktrees: WorktreeRecord[],
  links: Map<string, StoredWorktreeLink>,
  documents: ProjectManagementDocumentSummary[],
): WorktreeRecord[] {
  const documentsById = new Map(documents.map((document) => [document.id, document]));

  return worktrees.map((worktree) => {
    const link = links.get(worktree.branch);
    const linkedDocument = link ? documentsById.get(link.documentId) : null;

    return {
      ...worktree,
      linkedDocument: linkedDocument ? toLinkedDocumentSummary(linkedDocument) : null,
    };
  });
}
