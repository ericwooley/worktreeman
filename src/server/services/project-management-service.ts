import { randomUUID } from "node:crypto";
import * as Automerge from "@automerge/automerge";
import {
  DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS,
  DEFAULT_PROJECT_MANAGEMENT_BRANCH,
  DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID,
  DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG,
  DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE,
  PROJECT_MANAGEMENT_DOCUMENT_STATUSES,
  PROJECT_MANAGEMENT_BATCH_FILE,
  PROJECT_MANAGEMENT_REF,
  PROJECT_MANAGEMENT_SCHEMA_VERSION,
} from "../../shared/constants.js";
import type {
  AppendProjectManagementBatchRequest,
  CreateProjectManagementDocumentRequest,
  ProjectManagementBatchResponse,
  ProjectManagementDocument,
  ProjectManagementDocumentResponse,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  UpdateProjectManagementDocumentRequest,
} from "../../shared/types.js";
import { runCommand } from "../utils/process.js";

const PROJECT_MANAGEMENT_MAX_APPEND_RETRIES = 5;
const PROJECT_MANAGEMENT_COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "worktreeman",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "worktreeman@example.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "worktreeman",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
};

type ProjectManagementDocumentAction = "create" | "update" | "archive" | "restore";

interface ProjectManagementAutomergeDocument {
  id: string;
  number: number;
  title: string;
  markdown: string;
  tags: string[];
  status: string;
  assignee: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

interface StoredProjectManagementBatchEntry {
  documentId: string;
  action: ProjectManagementDocumentAction;
  actorId: string;
  title: string;
  tags: string[];
  status: string;
  assignee: string;
  archived: boolean;
  changes: string[];
}

interface StoredProjectManagementBatch {
  schemaVersion: number;
  batchId: string;
  createdAt: string;
  documentIds: string[];
  entries: StoredProjectManagementBatchEntry[];
}

interface ReducedProjectManagementState {
  branch: string;
  headSha: string;
  documentsById: Map<string, ProjectManagementDocument>;
  documentOrder: string[];
  tagIndex: Map<string, Set<string>>;
  historyByDocumentId: Map<string, ProjectManagementHistoryEntry[]>;
  updatedAt: string;
}

interface ProjectManagementCacheEntry extends ReducedProjectManagementState {
  automergeDocsById: Map<string, Automerge.Doc<ProjectManagementAutomergeDocument>>;
}

const projectManagementCache = new Map<string, ProjectManagementCacheEntry>();

function createEmptyReducedState(headSha = ""): ProjectManagementCacheEntry {
  return {
    branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
    headSha,
    documentsById: new Map(),
    documentOrder: [],
    tagIndex: new Map(),
    historyByDocumentId: new Map(),
    updatedAt: "",
    automergeDocsById: new Map(),
  };
}

function getNextDocumentNumber(cache: ProjectManagementCacheEntry): number {
  let maxNumber = 0;
  for (const document of cache.documentsById.values()) {
    if (document.number > maxNumber) {
      maxNumber = document.number;
    }
  }

  return maxNumber + 1;
}

function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeTags(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values) {
    const tag = normalizeTag(value);
    if (!tag || seen.has(tag)) {
      continue;
    }

    seen.add(tag);
    normalized.push(tag);
  }

  return normalized;
}

function normalizeStatus(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  if (PROJECT_MANAGEMENT_DOCUMENT_STATUSES.includes(normalized as (typeof PROJECT_MANAGEMENT_DOCUMENT_STATUSES)[number])) {
    return normalized;
  }

  return DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS;
}

function normalizeAssignee(value: string | undefined): string {
  return value?.trim() ?? "";
}

function slugifyDocumentId(value: string): string {
  const base = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return base || "document";
}

function createDocumentId(title: string): string {
  return `${slugifyDocumentId(title)}-${randomUUID().slice(0, 8)}`;
}

function createActorId(): string {
  return randomUUID().replace(/-/g, "");
}

function encodeChange(change: Uint8Array): string {
  return Buffer.from(change).toString("base64");
}

function decodeChange(change: string): Uint8Array {
  return Uint8Array.from(Buffer.from(change, "base64"));
}

function cloneCacheEntry(cache: ProjectManagementCacheEntry): ProjectManagementCacheEntry {
  return {
    branch: cache.branch,
    headSha: cache.headSha,
    documentsById: new Map(
      Array.from(cache.documentsById.entries(), ([documentId, document]) => [documentId, { ...document, tags: [...document.tags] }]),
    ),
    documentOrder: [...cache.documentOrder],
    tagIndex: new Map(Array.from(cache.tagIndex.entries(), ([tag, documentIds]) => [tag, new Set(documentIds)])),
    historyByDocumentId: new Map(
      Array.from(cache.historyByDocumentId.entries(), ([documentId, history]) => [
        documentId,
        history.map((entry) => ({ ...entry, tags: [...entry.tags] })),
      ]),
    ),
    updatedAt: cache.updatedAt,
    automergeDocsById: new Map(
      Array.from(cache.automergeDocsById.entries(), ([documentId, doc]) => [documentId, Automerge.clone(doc)]),
    ),
  };
}

function buildSeedMarkdown(): string {
  return [
    "# Project Outline",
    "",
    "## Goals",
    "",
    "- Define the scope",
    "- Track major workstreams",
    "- Capture decisions and risks",
    "",
    "## Open Questions",
    "",
    "- What ships first?",
    "- What is blocked?",
    "- What needs design?",
    "",
  ].join("\n");
}

function materializeDocument(doc: Automerge.Doc<ProjectManagementAutomergeDocument>): ProjectManagementDocument {
  return {
    id: doc.id,
    number: doc.number,
    title: doc.title,
    markdown: doc.markdown,
    tags: Array.from(doc.tags ?? []),
    status: doc.status || DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS,
    assignee: doc.assignee || "",
    archived: Boolean(doc.archived),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    historyCount: 0,
  };
}

function setDocumentTagsInIndex(cache: ProjectManagementCacheEntry, documentId: string, previousTags: string[], nextTags: string[]) {
  for (const tag of previousTags) {
    const entry = cache.tagIndex.get(tag);
    if (!entry) {
      continue;
    }

    entry.delete(documentId);
    if (entry.size === 0) {
      cache.tagIndex.delete(tag);
    }
  }

  for (const tag of nextTags) {
    const entry = cache.tagIndex.get(tag) ?? new Set<string>();
    entry.add(documentId);
    cache.tagIndex.set(tag, entry);
  }
}

function reduceBatchIntoCache(
  cache: ProjectManagementCacheEntry,
  batch: StoredProjectManagementBatch,
  commitSha: string,
) {
  for (const entry of batch.entries) {
    let doc = cache.automergeDocsById.get(entry.documentId);
    if (!doc) {
      doc = Automerge.init<ProjectManagementAutomergeDocument>({ actor: entry.actorId });
    }

    const [nextDoc] = Automerge.applyChanges(
      doc,
      entry.changes.map((change) => decodeChange(change)),
    );

    const previousTags = cache.documentsById.get(entry.documentId)?.tags ?? [];
    const materialized = materializeDocument(nextDoc);
    const history = cache.historyByDocumentId.get(entry.documentId) ?? [];

    cache.automergeDocsById.set(entry.documentId, nextDoc);
    cache.documentsById.set(entry.documentId, {
      ...materialized,
      historyCount: history.length + 1,
    });

    if (!cache.documentOrder.includes(entry.documentId)) {
      cache.documentOrder.push(entry.documentId);
    }

    setDocumentTagsInIndex(cache, entry.documentId, previousTags, materialized.tags);

    const historyEntry: ProjectManagementHistoryEntry = {
      commitSha,
      batchId: batch.batchId,
      createdAt: batch.createdAt,
      actorId: entry.actorId,
      documentId: entry.documentId,
      number: materialized.number,
      title: materialized.title,
      tags: [...materialized.tags],
      status: materialized.status,
      assignee: materialized.assignee,
      archived: materialized.archived,
      changeCount: entry.changes.length,
      action: entry.action,
    };
    history.push(historyEntry);
    cache.historyByDocumentId.set(entry.documentId, history);
    cache.documentsById.set(entry.documentId, {
      ...cache.documentsById.get(entry.documentId)!,
      historyCount: history.length,
    });
    cache.updatedAt = batch.createdAt;
  }
}

function toListResponse(cache: ReducedProjectManagementState): ProjectManagementListResponse {
  const documents = cache.documentOrder
    .map((documentId) => cache.documentsById.get(documentId))
    .filter((document): document is ProjectManagementDocument => Boolean(document))
    .map<ProjectManagementDocumentSummary>((document) => ({
      id: document.id,
      number: document.number,
      title: document.title,
      tags: [...document.tags],
      status: document.status,
      assignee: document.assignee,
      archived: document.archived,
      createdAt: document.createdAt,
      updatedAt: document.updatedAt,
      historyCount: document.historyCount,
    }));

  return {
    branch: cache.branch,
    headSha: cache.headSha,
    documents,
    availableTags: Array.from(cache.tagIndex.keys()).sort((left, right) => left.localeCompare(right)),
    availableStatuses: [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES],
  };
}

function toDocumentResponse(cache: ReducedProjectManagementState, documentId: string): ProjectManagementDocumentResponse {
  const document = cache.documentsById.get(documentId);
  if (!document) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }

  return {
    branch: cache.branch,
    headSha: cache.headSha,
    document: { ...document, tags: [...document.tags] },
  };
}

function toHistoryResponse(cache: ReducedProjectManagementState, documentId: string): ProjectManagementHistoryResponse {
  return {
    branch: cache.branch,
    headSha: cache.headSha,
    history: (cache.historyByDocumentId.get(documentId) ?? []).map((entry) => ({ ...entry, tags: [...entry.tags] })),
  };
}

async function resolveBranchHead(repoRoot: string): Promise<string | null> {
  try {
    const { stdout } = await runCommand("git", ["rev-parse", "--verify", PROJECT_MANAGEMENT_REF], { cwd: repoRoot });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function readBatchAtCommit(repoRoot: string, commitSha: string): Promise<StoredProjectManagementBatch> {
  const { stdout } = await runCommand("git", ["cat-file", "-p", `${commitSha}:${PROJECT_MANAGEMENT_BATCH_FILE}`], { cwd: repoRoot });
  return JSON.parse(stdout) as StoredProjectManagementBatch;
}

async function listCommits(repoRoot: string, headSha: string, sinceHeadSha?: string): Promise<string[]> {
  const range = sinceHeadSha ? `${sinceHeadSha}..${headSha}` : headSha;
  const { stdout } = await runCommand("git", ["rev-list", "--reverse", range], { cwd: repoRoot });
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function isAncestor(repoRoot: string, ancestorSha: string, descendantSha: string): Promise<boolean> {
  if (ancestorSha === descendantSha) {
    return true;
  }

  const { stdout } = await runCommand("git", ["merge-base", ancestorSha, descendantSha], { cwd: repoRoot });
  return stdout.trim() === ancestorSha;
}

async function writeBlob(repoRoot: string, contents: string): Promise<string> {
  const { stdout } = await runCommand("git", ["hash-object", "-w", "--stdin"], {
    cwd: repoRoot,
    stdin: contents,
  });
  return stdout.trim();
}

async function writeTree(repoRoot: string, blobSha: string): Promise<string> {
  const { stdout } = await runCommand("git", ["mktree"], {
    cwd: repoRoot,
    stdin: `100644 blob ${blobSha}\t${PROJECT_MANAGEMENT_BATCH_FILE}\n`,
  });
  return stdout.trim();
}

async function writeCommit(repoRoot: string, treeSha: string, parentSha: string | null, message: string): Promise<string> {
  const args = ["commit-tree", treeSha, "-m", message];
  if (parentSha) {
    args.push("-p", parentSha);
  }

  const { stdout } = await runCommand("git", args, {
    cwd: repoRoot,
    env: PROJECT_MANAGEMENT_COMMIT_ENV,
  });
  return stdout.trim();
}

async function updateRef(repoRoot: string, newSha: string, previousSha: string | null): Promise<void> {
  await runCommand("git", [
    "update-ref",
    PROJECT_MANAGEMENT_REF,
    newSha,
    previousSha ?? "0000000000000000000000000000000000000000",
  ], { cwd: repoRoot });
}

async function appendBatchCommit(
  repoRoot: string,
  parentSha: string | null,
  batch: StoredProjectManagementBatch,
): Promise<string> {
  const blobSha = await writeBlob(repoRoot, JSON.stringify(batch));
  const treeSha = await writeTree(repoRoot, blobSha);
  const message = `pm: ${batch.entries.length === 1 ? batch.entries[0].action : "batch"} ${batch.documentIds.length} document${batch.documentIds.length === 1 ? "" : "s"}`;
  const commitSha = await writeCommit(repoRoot, treeSha, parentSha, message);
  await updateRef(repoRoot, commitSha, parentSha);
  return commitSha;
}

function createSeedBatch(now: string): StoredProjectManagementBatch {
  const actorId = createActorId();
  let doc = Automerge.init<ProjectManagementAutomergeDocument>({ actor: actorId });
  doc = Automerge.change(doc, "Create Project Outline", (draft) => {
    draft.id = DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID;
    draft.number = 1;
    draft.title = DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE;
    draft.markdown = buildSeedMarkdown();
    draft.tags = [DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG];
    draft.status = DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS;
    draft.assignee = "";
    draft.archived = false;
    draft.createdAt = now;
    draft.updatedAt = now;
  });

  const change = Automerge.getLastLocalChange(doc);
  if (!change) {
    throw new Error("Failed to create the initial project management document.");
  }

  return {
    schemaVersion: PROJECT_MANAGEMENT_SCHEMA_VERSION,
    batchId: randomUUID(),
    createdAt: now,
    documentIds: [DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID],
    entries: [{
      documentId: DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID,
      action: "create",
      actorId,
      title: DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE,
      tags: [DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG],
      status: DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS,
      assignee: "",
      archived: false,
      changes: [encodeChange(change)],
    }],
  };
}

async function ensureProjectManagementInitialized(repoRoot: string): Promise<string> {
  const existingHead = await resolveBranchHead(repoRoot);
  if (existingHead) {
    return existingHead;
  }

  const batch = createSeedBatch(new Date().toISOString());
  try {
    const commitSha = await appendBatchCommit(repoRoot, null, batch);
    const cache = createEmptyReducedState(commitSha);
    reduceBatchIntoCache(cache, batch, commitSha);
    projectManagementCache.set(repoRoot, cache);
    return commitSha;
  } catch {
    const headSha = await resolveBranchHead(repoRoot);
    if (headSha) {
      return headSha;
    }
    throw new Error("Failed to initialize the project management branch.");
  }
}

async function getReducedProjectManagementState(repoRoot: string): Promise<ProjectManagementCacheEntry> {
  const ensuredHead = await ensureProjectManagementInitialized(repoRoot);
  const cached = projectManagementCache.get(repoRoot);

  if (cached?.headSha === ensuredHead) {
    return cached;
  }

  if (cached?.headSha && await isAncestor(repoRoot, cached.headSha, ensuredHead)) {
    const nextCache = cloneCacheEntry(cached);
    const commits = await listCommits(repoRoot, ensuredHead, cached.headSha);

    for (const commitSha of commits) {
      reduceBatchIntoCache(nextCache, await readBatchAtCommit(repoRoot, commitSha), commitSha);
    }

    nextCache.headSha = ensuredHead;
    projectManagementCache.set(repoRoot, nextCache);
    return nextCache;
  }

  const nextCache = createEmptyReducedState(ensuredHead);
  const commits = await listCommits(repoRoot, ensuredHead);
  for (const commitSha of commits) {
    reduceBatchIntoCache(nextCache, await readBatchAtCommit(repoRoot, commitSha), commitSha);
  }

  nextCache.headSha = ensuredHead;
  projectManagementCache.set(repoRoot, nextCache);
  return nextCache;
}

function applyDocumentChange(
  documentId: string,
  doc: Automerge.Doc<ProjectManagementAutomergeDocument> | undefined,
  input: {
    number: number;
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
    now: string;
    actorId: string;
  },
): { nextDoc: Automerge.Doc<ProjectManagementAutomergeDocument>; action: ProjectManagementDocumentAction; change: Uint8Array } {
  const tags = normalizeTags(input.tags);
  const status = normalizeStatus(input.status);
  const assignee = normalizeAssignee(input.assignee);
  const writableDoc = doc
    ? Automerge.clone(doc, { actor: input.actorId })
    : Automerge.init<ProjectManagementAutomergeDocument>({ actor: input.actorId });

  const nextDoc = Automerge.change(writableDoc, doc ? "Update project management document" : "Create project management document", (draft) => {
    draft.id = documentId;
    draft.number = draft.number || input.number;
    draft.title = input.title.trim() || DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE;
    if (typeof draft.markdown !== "string") {
      draft.markdown = "";
    }
    Automerge.updateText(draft as Automerge.Doc<unknown>, ["markdown"], input.markdown);
    draft.tags = tags;
    draft.status = status;
    draft.assignee = assignee;
    draft.archived = input.archived ?? draft.archived ?? false;
    draft.createdAt = draft.createdAt || input.now;
    draft.updatedAt = input.now;
  });

  const change = Automerge.getLastLocalChange(nextDoc);
  if (!change) {
    throw new Error(`Failed to create a CRDT change for document ${documentId}.`);
  }

  return {
    nextDoc,
    action: doc
      ? (input.archived ?? false)
          ? "archive"
          : doc.archived && input.archived === false
            ? "restore"
            : "update"
      : "create",
    change,
  };
}

async function appendEntries(
  repoRoot: string,
  entries: Array<{
    documentId?: string;
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }>,
): Promise<ProjectManagementBatchResponse> {
  for (let attempt = 1; attempt <= PROJECT_MANAGEMENT_MAX_APPEND_RETRIES; attempt += 1) {
    const state = await getReducedProjectManagementState(repoRoot);
    const workingState = cloneCacheEntry(state);
    const now = new Date().toISOString();
    const batchEntries: StoredProjectManagementBatchEntry[] = [];
    const documentIds: string[] = [];

    for (const entry of entries) {
      const actorId = createActorId();
      const documentId = entry.documentId?.trim() || createDocumentId(entry.title);
      const existingDoc = workingState.automergeDocsById.get(documentId);
      if (entry.documentId && !existingDoc) {
        throw new Error(`Unknown project management document ${documentId}.`);
      }

      const { nextDoc, action, change } = applyDocumentChange(documentId, existingDoc, {
        number: existingDoc?.number ?? getNextDocumentNumber(workingState),
        title: entry.title,
        markdown: entry.markdown,
        tags: entry.tags,
        status: entry.status,
        assignee: entry.assignee,
        archived: entry.archived,
        now,
        actorId,
      });

      batchEntries.push({
        documentId,
        action,
        actorId,
        title: nextDoc.title,
        tags: Array.from(nextDoc.tags ?? []),
        status: nextDoc.status,
        assignee: nextDoc.assignee,
        archived: nextDoc.archived,
        changes: [encodeChange(change)],
      });
      documentIds.push(documentId);

      const predictedBatch: StoredProjectManagementBatch = {
        schemaVersion: PROJECT_MANAGEMENT_SCHEMA_VERSION,
        batchId: "prediction",
        createdAt: now,
        documentIds: [documentId],
        entries: [batchEntries[batchEntries.length - 1]],
      };
      reduceBatchIntoCache(workingState, predictedBatch, state.headSha);
    }

    const batch: StoredProjectManagementBatch = {
      schemaVersion: PROJECT_MANAGEMENT_SCHEMA_VERSION,
      batchId: randomUUID(),
      createdAt: now,
      documentIds,
      entries: batchEntries,
    };

    try {
      const commitSha = await appendBatchCommit(repoRoot, state.headSha, batch);
      const nextCache = cloneCacheEntry(state);
      reduceBatchIntoCache(nextCache, batch, commitSha);
      nextCache.headSha = commitSha;
      projectManagementCache.set(repoRoot, nextCache);
      return {
        branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        headSha: commitSha,
        documentIds,
      };
    } catch (error) {
      if (attempt === PROJECT_MANAGEMENT_MAX_APPEND_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }

  throw new Error("Failed to append project management updates.");
}

export async function listProjectManagementDocuments(repoRoot: string): Promise<ProjectManagementListResponse> {
  return toListResponse(await getReducedProjectManagementState(repoRoot));
}

export async function getProjectManagementDocument(repoRoot: string, documentId: string): Promise<ProjectManagementDocumentResponse> {
  return toDocumentResponse(await getReducedProjectManagementState(repoRoot), documentId);
}

export async function getProjectManagementDocumentHistory(repoRoot: string, documentId: string): Promise<ProjectManagementHistoryResponse> {
  const state = await getReducedProjectManagementState(repoRoot);
  if (!state.documentsById.has(documentId)) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }
  return toHistoryResponse(state, documentId);
}

export async function createProjectManagementDocument(
  repoRoot: string,
  request: CreateProjectManagementDocumentRequest,
): Promise<ProjectManagementDocumentResponse> {
  const title = request.title.trim();
  if (!title) {
    throw new Error("Document title is required.");
  }

  const result = await appendEntries(repoRoot, [{
    title,
    markdown: request.markdown,
    tags: request.tags,
    status: request.status,
    assignee: request.assignee,
  }]);

  return getProjectManagementDocument(repoRoot, result.documentIds[0]);
}

export async function updateProjectManagementDocument(
  repoRoot: string,
  documentId: string,
  request: UpdateProjectManagementDocumentRequest,
): Promise<ProjectManagementDocumentResponse> {
  const title = request.title.trim();
  if (!title) {
    throw new Error("Document title is required.");
  }

  await appendEntries(repoRoot, [{
    documentId,
    title,
    markdown: request.markdown,
    tags: request.tags,
    status: request.status,
    assignee: request.assignee,
    archived: request.archived,
  }]);

  return getProjectManagementDocument(repoRoot, documentId);
}

export async function appendProjectManagementBatch(
  repoRoot: string,
  request: AppendProjectManagementBatchRequest,
): Promise<ProjectManagementBatchResponse> {
  if (!request.entries.length) {
    throw new Error("At least one batch entry is required.");
  }

  return appendEntries(repoRoot, request.entries);
}

export function clearProjectManagementCache(repoRoot?: string): void {
  if (repoRoot) {
    projectManagementCache.delete(repoRoot);
    return;
  }

  projectManagementCache.clear();
}
