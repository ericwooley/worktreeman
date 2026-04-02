import type { ProjectManagementDocumentSummary, WorktreeLinkedDocumentSummary, WorktreeRecord } from "../../shared/types.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import { createOperationalStateStore, type WorktreeDocumentLinkRecord } from "./operational-state-service.js";

export async function getWorktreeDocumentLinks(repoRoot: string): Promise<Map<WorktreeId, WorktreeDocumentLinkRecord>> {
  const store = await createOperationalStateStore(repoRoot);
  const links = await store.listWorktreeDocumentLinks();
  return new Map(links.map((entry) => [entry.worktreeId, entry]));
}

export async function getWorktreeDocumentLink(repoRoot: string, worktreeId: WorktreeId): Promise<WorktreeDocumentLinkRecord | null> {
  const store = await createOperationalStateStore(repoRoot);
  return await store.getWorktreeDocumentLinkById(worktreeId);
}

export async function setWorktreeDocumentLink(repoRoot: string, details: {
  worktreeId: WorktreeId;
  branch: string;
  worktreePath: string;
  documentId: string;
}): Promise<void> {
  const store = await createOperationalStateStore(repoRoot);
  await store.setWorktreeDocumentLink(details);
}

export async function clearWorktreeDocumentLink(repoRoot: string, worktreeId: WorktreeId): Promise<void> {
  const store = await createOperationalStateStore(repoRoot);
  await store.clearWorktreeDocumentLinkById(worktreeId);
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
  links: Map<WorktreeId, WorktreeDocumentLinkRecord>,
  documents: ProjectManagementDocumentSummary[],
): WorktreeRecord[] {
  const documentsById = new Map(documents.map((document) => [document.id, document]));

  return worktrees.map((worktree) => {
    const link = links.get(worktree.id);
    const linkedDocument = link ? documentsById.get(link.documentId) : null;

    return {
      ...worktree,
      linkedDocument: linkedDocument ? toLinkedDocumentSummary(linkedDocument) : null,
    };
  });
}
