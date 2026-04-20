import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
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
  ProjectManagementDocumentSummaryResponse,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  ProjectManagementUser,
  ProjectManagementUsersConfig,
  ProjectManagementUsersResponse,
  UpdateProjectManagementDocumentRequest,
} from "../../shared/types.js";
import { loadConfig } from "./config-service.js";
import { getManagedDatabaseClient, type ManagedDatabaseClient } from "./database-client-service.js";
import { runCommand } from "../utils/process.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";

const PROJECT_MANAGEMENT_MAX_APPEND_RETRIES = 5;
const PROJECT_MANAGEMENT_MAX_HISTORY_DIFF_CHARS = 20_000;
const PROJECT_MANAGEMENT_CACHE_NAMESPACE = "project-management-cache";

type ProjectManagementDocumentAction = "create" | "update" | "archive" | "restore";

interface ProjectManagementAuthor {
  name: string;
  email: string;
}

interface GitDiscoveredProjectManagementUser {
  id: string;
  name: string;
  email: string;
  commitCount: number;
  lastCommitAt: string | null;
}

interface ProjectManagementAutomergeDocument {
  id: string;
  number: number;
  title: string;
  summary: string;
  markdown: string;
  tags: string[];
  dependencies: string[];
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
  authorName: string;
  authorEmail: string;
  title: string;
  summary: string;
  tags: string[];
  dependencies: string[];
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

interface ProjectManagementStoreState {
  branch: string;
  headSha: string;
  updatedAt: string;
}

interface PersistedProjectManagementDocumentRecord {
  documentOrder: number;
  document: ProjectManagementDocument;
  automergeDoc: Automerge.Doc<ProjectManagementAutomergeDocument>;
}

interface PersistedProjectManagementDocumentSummaryRow {
  document_id: string;
  number: number;
  title: string;
  summary: string;
  kind: string;
  pull_request_json: string;
  tags_json: string;
  dependencies_json: string;
  status: string;
  assignee: string;
  archived: boolean;
  created_at: string;
  updated_at: string;
  history_count: number;
}

interface PersistedProjectManagementDocumentRow extends PersistedProjectManagementDocumentSummaryRow {
  document_order: number;
  markdown: string;
  automerge_binary: string;
}

interface PersistedProjectManagementHistoryRow {
  entry_json: string;
}

interface ProjectManagementDependencyDocument {
  dependencies: string[];
}

const PROJECT_MANAGEMENT_STATE_TABLE = "project_management_state_cache";
const PROJECT_MANAGEMENT_DOCUMENTS_TABLE = "project_management_documents";
const PROJECT_MANAGEMENT_HISTORY_TABLE = "project_management_history";

const projectManagementCache = new Map<string, ProjectManagementStoreState>();
const projectManagementDbState = new Map<string, { db: ManagedDatabaseClient; ready: Promise<void> }>();

function getNextDocumentNumber(documents: Iterable<ProjectManagementDocumentSummary>): number {
  let maxNumber = 0;
  for (const document of documents) {
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

function normalizeDependencyIds(values: string[] | undefined, documentId?: string): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const value of values ?? []) {
    const nextValue = value.trim();
    if (!nextValue || nextValue === documentId || seen.has(nextValue)) {
      continue;
    }

    seen.add(nextValue);
    normalized.push(nextValue);
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

function normalizeSummary(value: string | undefined): string {
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

async function readGitConfigValue(repoRoot: string, key: string): Promise<string> {
  try {
    const { stdout } = await runCommand("git", ["config", "--get", key], {
      cwd: repoRoot,
      allowExitCodes: [1],
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

async function resolveProjectManagementAuthor(repoRoot: string): Promise<ProjectManagementAuthor> {
  const configuredName = await readGitConfigValue(repoRoot, "user.name");
  const configuredEmail = await readGitConfigValue(repoRoot, "user.email");

  return {
    name: configuredName || process.env.GIT_AUTHOR_NAME || process.env.GIT_COMMITTER_NAME || "worktreeman",
    email: configuredEmail || process.env.GIT_AUTHOR_EMAIL || process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
  };
}

function buildProjectManagementCommitEnv(author: ProjectManagementAuthor): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
  };
}

function createProjectManagementUserId(email: string): string {
  const normalizedEmail = email.trim().toLowerCase();
  return createHash("sha1").update(normalizedEmail).digest("hex");
}

function createGravatarUrl(email: string): string {
  const hash = createHash("md5").update(email.trim().toLowerCase()).digest("hex");
  return `https://www.gravatar.com/avatar/${hash}?d=identicon&s=80`;
}

async function listGitDiscoveredProjectManagementUsers(repoRoot: string): Promise<GitDiscoveredProjectManagementUser[]> {
  const { stdout } = await runCommand(
    "git",
    ["log", "--format=%aN%x1f%aE%x1f%aI"],
    { cwd: repoRoot, allowExitCodes: [0, 128] },
  );

  const users = new Map<string, GitDiscoveredProjectManagementUser>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    const [rawName = "", rawEmail = "", rawDate = ""] = trimmed.split("\u001f");
    const email = rawEmail.trim().toLowerCase();
    const name = rawName.trim();
    if (!email) {
      continue;
    }

    const id = createProjectManagementUserId(email);
    const existing = users.get(id);
    if (!existing) {
      users.set(id, {
        id,
        name,
        email,
        commitCount: 1,
        lastCommitAt: rawDate || null,
      });
      continue;
    }

    existing.commitCount += 1;
    if (!existing.name && name) {
      existing.name = name;
    }
    if (!existing.lastCommitAt || (rawDate && rawDate > existing.lastCommitAt)) {
      existing.lastCommitAt = rawDate || existing.lastCommitAt;
    }
  }

  return [...users.values()].sort((left, right) => {
    if (right.commitCount !== left.commitCount) {
      return right.commitCount - left.commitCount;
    }
    return left.name.localeCompare(right.name);
  });
}

export async function listProjectManagementUsers(
  repoRoot: string,
  configUsersOverride?: ProjectManagementUsersConfig,
): Promise<ProjectManagementUsersResponse> {
  const [documents, discoveredUsers, loadedConfig] = await Promise.all([
    listProjectManagementDocuments(repoRoot),
    listGitDiscoveredProjectManagementUsers(repoRoot),
    configUsersOverride
      ? Promise.resolve(null)
      : loadConfig(path.resolve(repoRoot, "worktree.yml")).catch(() => loadConfig(path.resolve(repoRoot, "worktreeman.yml"))),
  ]);
  const configUsers = configUsersOverride ?? loadedConfig?.projectManagement.users ?? {
    customUsers: [],
    archivedUserIds: [],
  };
  const users = new Map<string, ProjectManagementUser>();

  for (const entry of discoveredUsers) {
    users.set(entry.id, {
      id: entry.id,
      name: entry.name || entry.email,
      email: entry.email,
      source: "git",
      archived: configUsers.archivedUserIds.includes(entry.id),
      avatarUrl: createGravatarUrl(entry.email),
      commitCount: entry.commitCount,
      lastCommitAt: entry.lastCommitAt,
    });
  }

  for (const entry of configUsers.customUsers) {
    const id = createProjectManagementUserId(entry.email);
    const existing = users.get(id);
    if (existing) {
      existing.name = existing.name || entry.name || entry.email;
      existing.archived = configUsers.archivedUserIds.includes(id);
      continue;
    }

    users.set(id, {
      id,
      name: entry.name || entry.email,
      email: entry.email,
      source: "config",
      archived: configUsers.archivedUserIds.includes(id),
      avatarUrl: createGravatarUrl(entry.email),
      commitCount: 0,
      lastCommitAt: null,
    });
  }

  return {
    branch: documents.branch,
    users: [...users.values()].sort((left, right) => {
      if (left.archived !== right.archived) {
        return Number(left.archived) - Number(right.archived);
      }
      if (right.commitCount !== left.commitCount) {
        return right.commitCount - left.commitCount;
      }
      return left.name.localeCompare(right.name);
    }),
    config: configUsers,
  };
}

function encodeChange(change: Uint8Array): string {
  return Buffer.from(change).toString("base64");
}

function decodeChange(change: string): Uint8Array {
  return Uint8Array.from(Buffer.from(change, "base64"));
}

function parseStringArray(value: string): string[] {
  if (!value) {
    return [];
  }

  const parsed = JSON.parse(value) as unknown[];
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function toSummaryFromRow(row: PersistedProjectManagementDocumentSummaryRow): ProjectManagementDocumentSummary {
  return {
    id: row.document_id,
    number: row.number,
    title: row.title,
    summary: row.summary,
    tags: parseStringArray(row.tags_json),
    dependencies: parseStringArray(row.dependencies_json),
    status: row.status,
    assignee: row.assignee,
    archived: Boolean(row.archived),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    historyCount: row.history_count,
  };
}

function toDocumentFromRow(row: PersistedProjectManagementDocumentRow): PersistedProjectManagementDocumentRecord {
  const summary = toSummaryFromRow(row);
  return {
    documentOrder: row.document_order,
    document: {
      ...summary,
      markdown: row.markdown,
    },
    automergeDoc: Automerge.load<ProjectManagementAutomergeDocument>(
      Uint8Array.from(Buffer.from(row.automerge_binary, "base64")),
    ),
  };
}

async function getProjectManagementDb(repoRoot: string) {
  const db = await getManagedDatabaseClient(repoRoot, PROJECT_MANAGEMENT_CACHE_NAMESPACE);
  const existing = projectManagementDbState.get(repoRoot);
  if (!existing || existing.db !== db) {
    const ready = (async () => {
      await db.exec(`
        create table if not exists ${PROJECT_MANAGEMENT_STATE_TABLE} (
          singleton boolean primary key default true,
          head_sha text not null,
          updated_at timestamptz not null default now()
        );

        create table if not exists ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE} (
          document_id text primary key,
          document_order integer not null,
          number integer not null,
          title text not null,
          summary text not null,
          kind text not null,
          pull_request_json text not null,
          tags_json text not null,
          dependencies_json text not null,
          status text not null,
          assignee text not null,
          archived boolean not null,
          created_at timestamptz not null,
          updated_at timestamptz not null,
          history_count integer not null,
          markdown text not null,
          automerge_binary text not null
        );

        create table if not exists ${PROJECT_MANAGEMENT_HISTORY_TABLE} (
          document_id text not null,
          history_order integer not null,
          created_at timestamptz not null,
          entry_json text not null,
          primary key (document_id, history_order)
        );

        create index if not exists project_management_documents_order_idx
          on ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE} (document_order);
        create index if not exists project_management_history_lookup_idx
          on ${PROJECT_MANAGEMENT_HISTORY_TABLE} (document_id, history_order);
      `);
      await db.exec(`
        alter table ${PROJECT_MANAGEMENT_STATE_TABLE}
          add column if not exists snapshot_json text;
      `);
    })();
    projectManagementDbState.set(repoRoot, { db, ready });
  }

  const initialized = projectManagementDbState.get(repoRoot);
  if (!initialized) {
    throw new Error("Project management database initialization state was not recorded.");
  }

  try {
    await initialized.ready;
  } catch (error) {
    if (projectManagementDbState.get(repoRoot)?.db === db) {
      projectManagementDbState.delete(repoRoot);
    }
    throw error;
  }

  return db;
}

async function getProjectManagementDbExecutor(
  repoRoot: string,
  db?: ManagedDatabaseClient,
): Promise<ManagedDatabaseClient> {
  return db ?? getProjectManagementDb(repoRoot);
}

async function readPersistedProjectManagementState(repoRoot: string, db?: ManagedDatabaseClient): Promise<ProjectManagementStoreState | null> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  const result = await executor.query<{ head_sha: string | null; updated_at: string | null; snapshot_json: string | null }>(
    `select head_sha, updated_at::text, snapshot_json from ${PROJECT_MANAGEMENT_STATE_TABLE} where singleton = true`,
  );
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  if (row.snapshot_json) {
    const snapshot = JSON.parse(row.snapshot_json) as Partial<ProjectManagementStoreState>;
    if (typeof snapshot.headSha === "string" && typeof snapshot.updatedAt === "string") {
      return {
        branch: typeof snapshot.branch === "string" ? snapshot.branch : DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        headSha: snapshot.headSha,
        updatedAt: snapshot.updatedAt,
      };
    }
  }

  if (!row.head_sha || !row.updated_at) {
    return null;
  }

  return {
    branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
    headSha: row.head_sha,
    updatedAt: row.updated_at,
  };
}

async function persistProjectManagementStoreState(
  repoRoot: string,
  state: ProjectManagementStoreState,
  db?: ManagedDatabaseClient,
): Promise<void> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  const snapshot = JSON.stringify(state);
  await executor.query(
    `
      insert into ${PROJECT_MANAGEMENT_STATE_TABLE} (singleton, head_sha, updated_at, snapshot_json)
      values (true, $1, $2, $3)
      on conflict (singleton) do update
      set head_sha = excluded.head_sha,
          updated_at = excluded.updated_at,
          snapshot_json = excluded.snapshot_json
    `,
    [state.headSha, state.updatedAt, snapshot],
  );
}

async function clearPersistedProjectManagementStore(repoRoot: string, db?: ManagedDatabaseClient): Promise<void> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  await executor.exec(`
    delete from ${PROJECT_MANAGEMENT_HISTORY_TABLE};
    delete from ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE};
    delete from ${PROJECT_MANAGEMENT_STATE_TABLE};
  `);
}

async function listPersistedDocumentSummaries(repoRoot: string): Promise<ProjectManagementDocumentSummary[]> {
  const db = await getProjectManagementDb(repoRoot);
  const result = await db.query<PersistedProjectManagementDocumentSummaryRow>(
    `
      select
        document_id,
        number,
        title,
        summary,
        kind,
        pull_request_json,
        tags_json,
        dependencies_json,
        status,
        assignee,
        archived,
        created_at::text,
        updated_at::text,
        history_count
      from ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE}
      order by document_order asc
    `,
  );
  return result.rows.map(toSummaryFromRow);
}

async function loadPersistedDocumentRecord(
  repoRoot: string,
  documentId: string,
  db?: ManagedDatabaseClient,
): Promise<PersistedProjectManagementDocumentRecord | null> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  const result = await executor.query<PersistedProjectManagementDocumentRow>(
    `
      select
        document_id,
        document_order,
        number,
        title,
        summary,
        kind,
        pull_request_json,
        tags_json,
        dependencies_json,
        status,
        assignee,
        archived,
        created_at::text,
        updated_at::text,
        history_count,
        markdown,
        automerge_binary
      from ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE}
      where document_id = $1
    `,
    [documentId],
  );
  const row = result.rows[0];
  return row ? toDocumentFromRow(row) : null;
}

async function loadPersistedDocumentHistory(repoRoot: string, documentId: string): Promise<ProjectManagementHistoryEntry[]> {
  const db = await getProjectManagementDb(repoRoot);
  const result = await db.query<PersistedProjectManagementHistoryRow>(
    `
      select entry_json
      from ${PROJECT_MANAGEMENT_HISTORY_TABLE}
      where document_id = $1
      order by history_order asc
    `,
    [documentId],
  );
  return result.rows.map((row) => {
    const entry = JSON.parse(row.entry_json) as ProjectManagementHistoryEntry;
    return {
      ...entry,
      tags: [...entry.tags],
      diff: ensureProjectManagementDiff(entry),
    };
  });
}

async function getNextDocumentOrder(repoRoot: string, db?: ManagedDatabaseClient): Promise<number> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  const result = await executor.query<{ max_order: number | null }>(
    `select max(document_order) as max_order from ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE}`,
  );
  return (result.rows[0]?.max_order ?? 0) + 1;
}

async function upsertPersistedDocumentRecord(
  repoRoot: string,
  record: PersistedProjectManagementDocumentRecord,
  db?: ManagedDatabaseClient,
): Promise<void> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  await executor.query(
    `
      insert into ${PROJECT_MANAGEMENT_DOCUMENTS_TABLE} (
        document_id,
        document_order,
        number,
        title,
        summary,
        kind,
        pull_request_json,
        tags_json,
        dependencies_json,
        status,
        assignee,
        archived,
        created_at,
        updated_at,
        history_count,
        markdown,
        automerge_binary
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17
      )
      on conflict (document_id) do update
      set document_order = excluded.document_order,
          number = excluded.number,
          title = excluded.title,
          summary = excluded.summary,
          kind = excluded.kind,
          pull_request_json = excluded.pull_request_json,
          tags_json = excluded.tags_json,
          dependencies_json = excluded.dependencies_json,
          status = excluded.status,
          assignee = excluded.assignee,
          archived = excluded.archived,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          history_count = excluded.history_count,
          markdown = excluded.markdown,
          automerge_binary = excluded.automerge_binary
    `,
    [
      record.document.id,
      record.documentOrder,
      record.document.number,
      record.document.title,
      record.document.summary,
      "document",
      JSON.stringify(null),
      JSON.stringify(record.document.tags),
      JSON.stringify(record.document.dependencies),
      record.document.status,
      record.document.assignee,
      record.document.archived,
      record.document.createdAt,
      record.document.updatedAt,
      record.document.historyCount,
      record.document.markdown,
      Buffer.from(Automerge.save(record.automergeDoc)).toString("base64"),
    ],
  );
}

async function appendPersistedHistoryEntry(
  repoRoot: string,
  documentId: string,
  historyOrder: number,
  entry: ProjectManagementHistoryEntry,
  db?: ManagedDatabaseClient,
): Promise<void> {
  const executor = await getProjectManagementDbExecutor(repoRoot, db);
  await executor.query(
    `
      insert into ${PROJECT_MANAGEMENT_HISTORY_TABLE} (document_id, history_order, created_at, entry_json)
      values ($1, $2, $3, $4)
      on conflict (document_id, history_order) do update
      set created_at = excluded.created_at,
          entry_json = excluded.entry_json
    `,
    [documentId, historyOrder, entry.createdAt, JSON.stringify(entry)],
  );
}

async function applyBatchToStore(repoRoot: string, batch: StoredProjectManagementBatch, commitSha: string): Promise<void> {
  const db = await getProjectManagementDb(repoRoot);
  await db.transaction(async (tx) => {
    let nextDocumentOrder = await getNextDocumentOrder(repoRoot, tx);

    for (const entry of batch.entries) {
      const previous = await loadPersistedDocumentRecord(repoRoot, entry.documentId, tx);
      const previousDocument = previous?.document ?? null;
      const currentDoc = previous?.automergeDoc ?? Automerge.init<ProjectManagementAutomergeDocument>({ actor: entry.actorId });
      const [nextDoc] = Automerge.applyChanges(
        currentDoc,
        entry.changes.map((change) => decodeChange(change)),
      );
      const materialized = materializeDocument(nextDoc as Automerge.Doc<ProjectManagementAutomergeDocument>);
      const historyCount = (previous?.document.historyCount ?? 0) + 1;
      const record: PersistedProjectManagementDocumentRecord = {
        documentOrder: previous?.documentOrder ?? nextDocumentOrder,
        document: {
          ...materialized,
          historyCount,
        },
        automergeDoc: nextDoc as Automerge.Doc<ProjectManagementAutomergeDocument>,
      };

      if (!previous) {
        nextDocumentOrder += 1;
      }

      const historyEntry: ProjectManagementHistoryEntry = {
        commitSha,
        batchId: batch.batchId,
        createdAt: batch.createdAt,
        actorId: entry.actorId,
        authorName: entry.authorName,
        authorEmail: entry.authorEmail,
        documentId: entry.documentId,
        number: record.document.number,
        title: record.document.title,
        tags: [...record.document.tags],
        status: record.document.status,
        assignee: record.document.assignee,
        archived: record.document.archived,
        changeCount: entry.changes.length,
        action: entry.action,
        diff: clampProjectManagementDiff(ensureProjectManagementDiff({
          action: entry.action,
          diff: buildProjectManagementDiff(previousDocument, record.document),
        })),
      };

      await upsertPersistedDocumentRecord(repoRoot, record, tx);
      await appendPersistedHistoryEntry(repoRoot, entry.documentId, historyCount, historyEntry, tx);
    }
  });
}

async function rebuildProjectManagementStore(repoRoot: string, headSha: string): Promise<ProjectManagementStoreState> {
  const commits = await listCommits(repoRoot, headSha);
  let updatedAt = "";
  const db = await getProjectManagementDb(repoRoot);

  await db.transaction(async (tx) => {
    await clearPersistedProjectManagementStore(repoRoot, tx);

    for (const commitSha of commits) {
      const batch = await readBatchAtCommit(repoRoot, commitSha);
      let nextDocumentOrder = await getNextDocumentOrder(repoRoot, tx);

      for (const entry of batch.entries) {
        const previous = await loadPersistedDocumentRecord(repoRoot, entry.documentId, tx);
        const previousDocument = previous?.document ?? null;
        const currentDoc = previous?.automergeDoc ?? Automerge.init<ProjectManagementAutomergeDocument>({ actor: entry.actorId });
        const [nextDoc] = Automerge.applyChanges(
          currentDoc,
          entry.changes.map((change) => decodeChange(change)),
        );
        const materialized = materializeDocument(nextDoc as Automerge.Doc<ProjectManagementAutomergeDocument>);
        const historyCount = (previous?.document.historyCount ?? 0) + 1;
        const record: PersistedProjectManagementDocumentRecord = {
          documentOrder: previous?.documentOrder ?? nextDocumentOrder,
          document: {
            ...materialized,
            historyCount,
          },
          automergeDoc: nextDoc as Automerge.Doc<ProjectManagementAutomergeDocument>,
        };

        if (!previous) {
          nextDocumentOrder += 1;
        }

        const historyEntry: ProjectManagementHistoryEntry = {
          commitSha,
          batchId: batch.batchId,
          createdAt: batch.createdAt,
          actorId: entry.actorId,
          authorName: entry.authorName,
          authorEmail: entry.authorEmail,
          documentId: entry.documentId,
          number: record.document.number,
          title: record.document.title,
          tags: [...record.document.tags],
          status: record.document.status,
          assignee: record.document.assignee,
          archived: record.document.archived,
          changeCount: entry.changes.length,
          action: entry.action,
          diff: clampProjectManagementDiff(ensureProjectManagementDiff({
            action: entry.action,
            diff: buildProjectManagementDiff(previousDocument, record.document),
          })),
        };

        await upsertPersistedDocumentRecord(repoRoot, record, tx);
        await appendPersistedHistoryEntry(repoRoot, entry.documentId, historyCount, historyEntry, tx);
      }

      updatedAt = batch.createdAt;
    }

    const state: ProjectManagementStoreState = {
      branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
      headSha,
      updatedAt,
    };
    await persistProjectManagementStoreState(repoRoot, state, tx);
  });

  const state: ProjectManagementStoreState = {
    branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
    headSha,
    updatedAt,
  };
  projectManagementCache.set(repoRoot, state);
  return state;
}

async function syncProjectManagementStore(repoRoot: string): Promise<ProjectManagementStoreState> {
  const ensuredHead = await ensureProjectManagementInitialized(repoRoot);
  const cached = projectManagementCache.get(repoRoot);
  if (cached?.headSha === ensuredHead) {
    return cached;
  }

  const persisted = await readPersistedProjectManagementState(repoRoot);
  if (persisted?.headSha === ensuredHead) {
    projectManagementCache.set(repoRoot, persisted);
    return persisted;
  }

  if (persisted?.headSha && await isAncestor(repoRoot, persisted.headSha, ensuredHead)) {
    const commits = await listCommits(repoRoot, ensuredHead, persisted.headSha);
    let updatedAt = persisted.updatedAt;
    for (const commitSha of commits) {
      const batch = await readBatchAtCommit(repoRoot, commitSha);
      await applyBatchToStore(repoRoot, batch, commitSha);
      updatedAt = batch.createdAt;
    }

    const nextState: ProjectManagementStoreState = {
      branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
      headSha: ensuredHead,
      updatedAt,
    };
    await persistProjectManagementStoreState(repoRoot, nextState);
    projectManagementCache.set(repoRoot, nextState);
    return nextState;
  }

  return rebuildProjectManagementStore(repoRoot, ensuredHead);
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

function toDiffLines(value: string): string[] {
  const normalized = value.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}

function buildUnifiedDiff(before: string, after: string, beforeLabel: string, afterLabel: string): string {
  const beforeLines = toDiffLines(before);
  const afterLines = toDiffLines(after);
  const lengths = Array.from({ length: beforeLines.length + 1 }, () => Array<number>(afterLines.length + 1).fill(0));

  for (let leftIndex = beforeLines.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = afterLines.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex][rightIndex] = beforeLines[leftIndex] === afterLines[rightIndex]
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }

  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`, "@@"];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < beforeLines.length && rightIndex < afterLines.length) {
    if (beforeLines[leftIndex] === afterLines[rightIndex]) {
      lines.push(` ${beforeLines[leftIndex]}`);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (lengths[leftIndex + 1][rightIndex] >= lengths[leftIndex][rightIndex + 1]) {
      lines.push(`-${beforeLines[leftIndex]}`);
      leftIndex += 1;
      continue;
    }

    lines.push(`+${afterLines[rightIndex]}`);
    rightIndex += 1;
  }

  while (leftIndex < beforeLines.length) {
    lines.push(`-${beforeLines[leftIndex]}`);
    leftIndex += 1;
  }

  while (rightIndex < afterLines.length) {
    lines.push(`+${afterLines[rightIndex]}`);
    rightIndex += 1;
  }

  return lines.join("\n");
}

function serializeDocumentMetadata(document: ProjectManagementDocument | null): string {
  return [
    `title: ${document?.title ?? ""}`,
    `number: ${document?.number ?? ""}`,
    `summary: ${document?.summary ?? ""}`,
    `status: ${document?.status ?? DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS}`,
    `assignee: ${document?.assignee ?? ""}`,
    `archived: ${document?.archived ? "true" : "false"}`,
    `tags: ${(document?.tags ?? []).join(", ")}`,
    `dependencies: ${(document?.dependencies ?? []).join(", ")}`,
  ].join("\n");
}

function buildProjectManagementDiff(previous: ProjectManagementDocument | null, next: ProjectManagementDocument): string {
  const sections: string[] = [];
  const previousMetadata = serializeDocumentMetadata(previous);
  const nextMetadata = serializeDocumentMetadata(next);

  if (previousMetadata !== nextMetadata) {
    sections.push(buildUnifiedDiff(previousMetadata, nextMetadata, "metadata:before", "metadata:after"));
  }

  const previousMarkdown = previous?.markdown ?? "";
  if (previousMarkdown !== next.markdown) {
    sections.push(buildUnifiedDiff(previousMarkdown, next.markdown, "markdown:before", "markdown:after"));
  }

  return sections.join("\n\n");
}

function ensureProjectManagementDiff(entry: Pick<ProjectManagementHistoryEntry, "diff" | "action">): string {
  const diff = entry.diff?.trim();
  if (diff) {
    return diff;
  }

  return entry.action === "create"
    ? "@@\n+Initial document state"
    : "@@\n No diff available for this history entry.";
}

function clampProjectManagementDiff(diff: string): string {
  if (diff.length <= PROJECT_MANAGEMENT_MAX_HISTORY_DIFF_CHARS) {
    return diff;
  }

  return `${diff.slice(0, PROJECT_MANAGEMENT_MAX_HISTORY_DIFF_CHARS)}\n\n@@\n Diff truncated because it exceeded the in-memory history limit.`;
}

function materializeDocument(doc: Automerge.Doc<ProjectManagementAutomergeDocument>): ProjectManagementDocument {
  return {
    id: doc.id,
    number: doc.number,
    title: doc.title,
    summary: doc.summary || "",
    markdown: doc.markdown,
    tags: Array.from(doc.tags ?? []),
    dependencies: Array.from(doc.dependencies ?? []),
    status: doc.status || DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_STATUS,
    assignee: doc.assignee || "",
    archived: Boolean(doc.archived),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    historyCount: 0,
  };
}

async function loadStoreDocuments(repoRoot: string): Promise<ProjectManagementDocumentSummary[]> {
  return listPersistedDocumentSummaries(repoRoot);
}

async function loadStoreDocument(repoRoot: string, documentId: string): Promise<ProjectManagementDocument> {
  const record = await loadPersistedDocumentRecord(repoRoot, documentId);
  if (!record) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }

  return {
    ...record.document,
    tags: [...record.document.tags],
    dependencies: [...record.document.dependencies],
  };
}

async function loadStoreHistory(repoRoot: string, documentId: string): Promise<ProjectManagementHistoryEntry[]> {
  const document = await loadPersistedDocumentRecord(repoRoot, documentId);
  if (!document) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }

  return loadPersistedDocumentHistory(repoRoot, documentId);
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

async function writeCommit(
  repoRoot: string,
  treeSha: string,
  parentSha: string | null,
  message: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const args = ["commit-tree", treeSha, "-m", message];
  if (parentSha) {
    args.push("-p", parentSha);
  }

  const { stdout } = await runCommand("git", args, {
    cwd: repoRoot,
    env,
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
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const blobSha = await writeBlob(repoRoot, JSON.stringify(batch));
  const treeSha = await writeTree(repoRoot, blobSha);
  const message = `pm: ${batch.entries.length === 1 ? batch.entries[0].action : "batch"} ${batch.documentIds.length} document${batch.documentIds.length === 1 ? "" : "s"}`;
  const commitSha = await writeCommit(repoRoot, treeSha, parentSha, message, env);
  await updateRef(repoRoot, commitSha, parentSha);
  return commitSha;
}

function createSeedBatch(now: string, author: ProjectManagementAuthor): StoredProjectManagementBatch {
  const actorId = createActorId();
  let doc = Automerge.init<ProjectManagementAutomergeDocument>({ actor: actorId });
  doc = Automerge.change(doc, "Create Project Outline", (draft) => {
    draft.id = DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_ID;
    draft.number = 1;
    draft.title = DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE;
    draft.summary = "";
    draft.markdown = buildSeedMarkdown();
    draft.tags = [DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG];
    draft.dependencies = [];
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
      authorName: author.name,
      authorEmail: author.email,
      title: DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE,
      summary: "",
      tags: [DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TAG],
      dependencies: [],
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

  const author = await resolveProjectManagementAuthor(repoRoot);
  const batch = createSeedBatch(new Date().toISOString(), author);
  try {
    const commitSha = await appendBatchCommit(repoRoot, null, batch, buildProjectManagementCommitEnv(author));
    await rebuildProjectManagementStore(repoRoot, commitSha);
    return commitSha;
  } catch {
    const headSha = await resolveBranchHead(repoRoot);
    if (headSha) {
      return headSha;
    }
    throw new Error("Failed to initialize the project management branch.");
  }
}

async function getReducedProjectManagementState(repoRoot: string): Promise<ProjectManagementStoreState> {
  return syncProjectManagementStore(repoRoot);
}

function applyDocumentChange(
  documentId: string,
  doc: Automerge.Doc<ProjectManagementAutomergeDocument> | undefined,
    input: {
      number: number;
      title: string;
      summary?: string;
      markdown: string;
      tags: string[];
      dependencies?: string[];
      status?: string;
    assignee?: string;
    archived?: boolean;
    now: string;
    actorId: string;
  },
): { nextDoc: Automerge.Doc<ProjectManagementAutomergeDocument>; action: ProjectManagementDocumentAction; change: Uint8Array } {
  const tags = normalizeTags(input.tags);
  const dependencies = normalizeDependencyIds(input.dependencies, documentId);
  const status = normalizeStatus(input.status);
  const assignee = normalizeAssignee(input.assignee);
  const summary = input.summary === undefined ? doc?.summary ?? "" : normalizeSummary(input.summary);
  const writableDoc = doc
    ? Automerge.clone(doc, { actor: input.actorId })
    : Automerge.init<ProjectManagementAutomergeDocument>({ actor: input.actorId });

  const nextDoc = Automerge.change(writableDoc, doc ? "Update project management document" : "Create project management document", (draft) => {
    draft.id = documentId;
    draft.number = draft.number || input.number;
    draft.title = input.title.trim() || DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE;
    if (typeof draft.summary !== "string") {
      draft.summary = "";
    }
    Automerge.updateText(draft as Automerge.Doc<unknown>, ["summary"], summary);
    if (typeof draft.markdown !== "string") {
      draft.markdown = "";
    }
    Automerge.updateText(draft as Automerge.Doc<unknown>, ["markdown"], input.markdown);
    draft.tags = tags;
    draft.dependencies = dependencies;
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
    title?: string;
    summary?: string;
    markdown?: string;
    tags?: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
     archived?: boolean;
   }>,
): Promise<ProjectManagementBatchResponse> {
  for (let attempt = 1; attempt <= PROJECT_MANAGEMENT_MAX_APPEND_RETRIES; attempt += 1) {
    const operationStartedAt = Date.now();
      logServerEvent("project-management-update-timing", "append-entries-started", {
        attempt,
        documentIds: entries.map((entry) => entry.documentId?.trim()).filter(Boolean),
        entryCount: entries.length,
      });
    const stateStartedAt = Date.now();
    logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "state" });
    const state = await getReducedProjectManagementState(repoRoot);
    const stateDurationMs = Date.now() - stateStartedAt;
    const summariesStartedAt = Date.now();
    logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "summaries" });
    const summaries = await loadStoreDocuments(repoRoot);
    const summariesDurationMs = Date.now() - summariesStartedAt;
    const summariesById = new Map(summaries.map((document) => [document.id, document]));
    const orderStartedAt = Date.now();
    logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "next-order" });
    let nextDocumentOrder = await getNextDocumentOrder(repoRoot);
    const orderDurationMs = Date.now() - orderStartedAt;
    const now = new Date().toISOString();
    const authorStartedAt = Date.now();
    logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "author" });
    const author = await resolveProjectManagementAuthor(repoRoot);
    const authorDurationMs = Date.now() - authorStartedAt;
    const commitEnv = buildProjectManagementCommitEnv(author);
    const batchEntries: StoredProjectManagementBatchEntry[] = [];
    const documentIds: string[] = [];
    const predictedDependencies = new Map<string, string[]>(
      summaries.map((document) => [document.id, [...document.dependencies]]),
    );
    const loadedDocs = new Map<string, PersistedProjectManagementDocumentRecord | null>();

    for (const entry of entries) {
      const actorId = createActorId();
      const providedDocumentId = entry.documentId?.trim();
      const providedTitle = entry.title?.trim();
      if (!providedDocumentId && !providedTitle) {
        throw new Error("Document title is required.");
      }
      const documentId = providedDocumentId || createDocumentId(providedTitle!);
      const existingRecord = loadedDocs.has(documentId)
        ? loadedDocs.get(documentId) ?? null
        : await loadPersistedDocumentRecord(repoRoot, documentId);
      loadedDocs.set(documentId, existingRecord);
      const existingDoc = existingRecord?.automergeDoc;
      if (entry.documentId && !existingDoc) {
        throw new Error(`Unknown project management document ${documentId}.`);
      }
      const title = providedTitle || existingDoc?.title || "";
      if (!title) {
        throw new Error("Document title is required.");
      }
      const markdown = entry.markdown ?? existingDoc?.markdown ?? "";
      const tags = entry.tags ?? existingDoc?.tags ?? [];
      const dependencies = normalizeDependencyIds(entry.dependencies ?? existingDoc?.dependencies ?? [], documentId);
      assertValidDependencies(predictedDependencies, summariesById, documentId, dependencies);

      let nextDoc: Automerge.Doc<ProjectManagementAutomergeDocument>;
      let action: ProjectManagementDocumentAction;
      let change: Uint8Array;

      ({ nextDoc, action, change } = applyDocumentChange(documentId, existingDoc, {
        number: existingDoc?.number ?? getNextDocumentNumber(summariesById.values()),
        title,
        summary: entry.summary ?? existingDoc?.summary,
        markdown,
        tags,
        dependencies,
        status: entry.status,
        assignee: entry.assignee ?? existingDoc?.assignee,
        archived: entry.archived ?? existingDoc?.archived,
        now,
        actorId,
      }));

      batchEntries.push({
        documentId,
        action,
        actorId,
        authorName: author.name,
        authorEmail: author.email,
        title: nextDoc.title,
        summary: nextDoc.summary || "",
        tags: Array.from(nextDoc.tags ?? []),
        dependencies: Array.from(nextDoc.dependencies ?? []),
        status: nextDoc.status,
        assignee: nextDoc.assignee,
        archived: nextDoc.archived,
        changes: [encodeChange(change)],
      });
      documentIds.push(documentId);
      predictedDependencies.set(documentId, [...dependencies]);
      summariesById.set(documentId, {
        id: documentId,
        number: nextDoc.number,
        title: nextDoc.title,
        summary: nextDoc.summary || "",
        tags: Array.from(nextDoc.tags ?? []),
        dependencies: [...dependencies],
        status: nextDoc.status,
        assignee: nextDoc.assignee,
        archived: nextDoc.archived,
        createdAt: nextDoc.createdAt,
        updatedAt: nextDoc.updatedAt,
        historyCount: (existingRecord?.document.historyCount ?? 0) + 1,
      });
      loadedDocs.set(documentId, {
        documentOrder: existingRecord?.documentOrder ?? nextDocumentOrder++,
        document: {
          ...materializeDocument(nextDoc),
          historyCount: (existingRecord?.document.historyCount ?? 0) + 1,
        },
        automergeDoc: nextDoc,
      });
    }

    const batch: StoredProjectManagementBatch = {
      schemaVersion: PROJECT_MANAGEMENT_SCHEMA_VERSION,
      batchId: randomUUID(),
      createdAt: now,
      documentIds,
      entries: batchEntries,
    };

    try {
      const appendCommitStartedAt = Date.now();
      logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "append-commit" });
      const commitSha = await appendBatchCommit(repoRoot, state.headSha, batch, commitEnv);
      const appendCommitDurationMs = Date.now() - appendCommitStartedAt;
      const applyStoreStartedAt = Date.now();
      logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "apply-store" });
      await applyBatchToStore(repoRoot, batch, commitSha);
      const applyStoreDurationMs = Date.now() - applyStoreStartedAt;
      const nextState: ProjectManagementStoreState = {
        branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        headSha: commitSha,
        updatedAt: now,
      };
      const persistStateStartedAt = Date.now();
      logServerEvent("project-management-update-timing", "phase-start", { attempt, phase: "persist-state" });
      await persistProjectManagementStoreState(repoRoot, nextState);
      const persistStateDurationMs = Date.now() - persistStateStartedAt;
      projectManagementCache.set(repoRoot, nextState);
      logServerEvent("project-management-update-timing", "append-entries-completed", {
        attempt,
        documentIds,
        state: formatDurationMs(stateDurationMs),
        summaries: formatDurationMs(summariesDurationMs),
        nextOrder: formatDurationMs(orderDurationMs),
        author: formatDurationMs(authorDurationMs),
        appendCommit: formatDurationMs(appendCommitDurationMs),
        applyStore: formatDurationMs(applyStoreDurationMs),
        persistState: formatDurationMs(persistStateDurationMs),
        total: formatDurationMs(Date.now() - operationStartedAt),
      });
      return {
        branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        headSha: commitSha,
        documentIds,
      };
    } catch (error) {
      logServerEvent("project-management-update-timing", "append-entries-retry", {
        attempt,
        documentIds,
        duration: formatDurationMs(Date.now() - operationStartedAt),
        error: error instanceof Error ? error.message : String(error),
      }, attempt === PROJECT_MANAGEMENT_MAX_APPEND_RETRIES ? "error" : "warn");
      if (attempt === PROJECT_MANAGEMENT_MAX_APPEND_RETRIES) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }

  throw new Error("Failed to append project management updates.");
}

function buildDependencyGraph(state: Map<string, string[]>): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  for (const [documentId, dependencies] of state.entries()) {
    graph.set(documentId, [...dependencies]);
  }
  return graph;
}

function hasDependencyPath(graph: Map<string, string[]>, startId: string, targetId: string): boolean {
  const stack = [startId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const currentId = stack.pop()!;
    if (currentId === targetId) {
      return true;
    }
    if (visited.has(currentId)) {
      continue;
    }
    visited.add(currentId);
    for (const dependencyId of graph.get(currentId) ?? []) {
      if (!visited.has(dependencyId)) {
        stack.push(dependencyId);
      }
    }
  }

  return false;
}

function assertValidDependencies(
  dependencyState: Map<string, string[]>,
  documentsById: Map<string, ProjectManagementDependencyDocument>,
  documentId: string,
  dependencyIds: string[],
): void {
  const graph = buildDependencyGraph(dependencyState);
  for (const dependencyId of dependencyIds) {
    if (!documentsById.has(dependencyId)) {
      throw new Error(`Unknown dependency document ${dependencyId}.`);
    }
  }

  graph.set(documentId, [...dependencyIds]);
  for (const dependencyId of dependencyIds) {
    if (hasDependencyPath(graph, dependencyId, documentId)) {
      throw new Error("Dependency cycles are not allowed.");
    }
  }
}

export async function listProjectManagementDocuments(repoRoot: string): Promise<ProjectManagementListResponse> {
  const state = await getReducedProjectManagementState(repoRoot);
  const documents = await loadStoreDocuments(repoRoot);
  const availableTags = [...new Set(documents.flatMap((document) => document.tags))].sort((left, right) => left.localeCompare(right));
  return {
    branch: state.branch,
    headSha: state.headSha,
    documents,
    availableTags,
    availableStatuses: [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES],
  };
}

export async function rebuildProjectManagementStateForStartup(repoRoot: string): Promise<ProjectManagementListResponse> {
  const headSha = await ensureProjectManagementInitialized(repoRoot);
  const state = await rebuildProjectManagementStore(repoRoot, headSha);
  const documents = await loadStoreDocuments(repoRoot);
  const availableTags = [...new Set(documents.flatMap((document) => document.tags))].sort((left, right) => left.localeCompare(right));
  return {
    branch: state.branch,
    headSha: state.headSha,
    documents,
    availableTags,
    availableStatuses: [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES],
  };
}

export async function getProjectManagementDocument(repoRoot: string, documentId: string): Promise<ProjectManagementDocumentResponse> {
  const state = await getReducedProjectManagementState(repoRoot);
  return {
    branch: state.branch,
    headSha: state.headSha,
    document: await loadStoreDocument(repoRoot, documentId),
  };
}

export async function getProjectManagementDocumentHistory(repoRoot: string, documentId: string): Promise<ProjectManagementHistoryResponse> {
  const state = await getReducedProjectManagementState(repoRoot);
  return {
    branch: state.branch,
    headSha: state.headSha,
    history: await loadStoreHistory(repoRoot, documentId),
  };
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
    summary: request.summary,
    markdown: request.markdown,
    tags: request.tags,
    dependencies: request.dependencies,
    status: request.status,
    assignee: request.assignee,
  }]);

  return getProjectManagementDocument(repoRoot, result.documentIds[0]);
}

export async function updateProjectManagementDocument(
  repoRoot: string,
  documentId: string,
  request: UpdateProjectManagementDocumentRequest,
): Promise<ProjectManagementDocumentSummaryResponse> {
  const result = await appendEntries(repoRoot, [{
    documentId,
    title: request.title,
    summary: request.summary,
    markdown: request.markdown,
    tags: request.tags,
    dependencies: request.dependencies,
    status: request.status,
    assignee: request.assignee,
    archived: request.archived,
  }]);

  return getProjectManagementDocumentSummary(repoRoot, documentId, result.headSha);
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

export async function updateProjectManagementDependencies(
  repoRoot: string,
  documentId: string,
  dependencyIds: string[],
): Promise<ProjectManagementDocumentSummaryResponse> {
  await getReducedProjectManagementState(repoRoot);
  const currentDocument = await loadStoreDocument(repoRoot, documentId);
  const summaries = await loadStoreDocuments(repoRoot);
  const dependenciesById = new Map(summaries.map((document) => [document.id, [...document.dependencies]]));
  const documentsById = new Map(summaries.map((document) => [document.id, document]));

  const normalizedDependencies = normalizeDependencyIds(dependencyIds, documentId);
  assertValidDependencies(dependenciesById, documentsById, documentId, normalizedDependencies);

  const result = await appendEntries(repoRoot, [{
    documentId,
    title: currentDocument.title,
    summary: currentDocument.summary,
    markdown: currentDocument.markdown,
    tags: currentDocument.tags,
    dependencies: normalizedDependencies,
    status: currentDocument.status,
    assignee: currentDocument.assignee,
    archived: currentDocument.archived,
  }]);

  return getProjectManagementDocumentSummary(repoRoot, documentId, result.headSha);
}

export async function updateProjectManagementStatus(
  repoRoot: string,
  documentId: string,
  status: string,
): Promise<ProjectManagementDocumentSummaryResponse> {
  const result = await appendEntries(repoRoot, [{
    documentId,
    status,
  }]);

  return getProjectManagementDocumentSummary(repoRoot, documentId, result.headSha);
}

export async function moveProjectManagementDocumentTowardInProgress(
  repoRoot: string,
  documentId: string,
): Promise<ProjectManagementDocumentSummaryResponse> {
  const currentDocument = await getProjectManagementDocument(repoRoot, documentId);
  if (currentDocument.document.status !== "backlog" && currentDocument.document.status !== "todo") {
    return {
      branch: currentDocument.branch,
      headSha: currentDocument.headSha,
      document: currentDocument.document,
    };
  }

  return updateProjectManagementStatus(repoRoot, documentId, "in-progress");
}

async function getProjectManagementDocumentSummary(
  repoRoot: string,
  documentId: string,
  headSha?: string,
): Promise<ProjectManagementDocumentSummaryResponse> {
  const startedAt = Date.now();
  logServerEvent("project-management-update-timing", "load-document-summary-started", {
    documentId,
  });
  const state = await getReducedProjectManagementState(repoRoot);
  const documents = await loadStoreDocuments(repoRoot);
  const document = documents.find((entry) => entry.id === documentId) ?? null;
  if (!document) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }

  logServerEvent("project-management-update-timing", "load-document-summary", {
    documentId,
    duration: formatDurationMs(Date.now() - startedAt),
  });

  return {
    branch: state.branch,
    headSha: headSha ?? state.headSha,
    document,
  };
}

export function clearProjectManagementCache(repoRoot?: string): void {
  if (repoRoot) {
    projectManagementCache.delete(repoRoot);
    projectManagementDbState.delete(repoRoot);
    return;
  }

  projectManagementCache.clear();
  projectManagementDbState.clear();
}
