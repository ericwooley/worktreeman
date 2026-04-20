import { randomUUID } from "node:crypto";
import type {
  AddProjectManagementReviewEntryRequest,
  ProjectManagementDocumentReview,
  ProjectManagementDocumentReviewResponse,
  ProjectManagementReviewEntry,
  ProjectManagementReviewsResponse,
} from "../../shared/types.js";
import type { ManagedDatabaseClient } from "./database-client-service.js";
import { getManagedDatabaseClient } from "./database-client-service.js";
import { listProjectManagementDocuments } from "./project-management-service.js";
import { runCommand } from "../utils/process.js";

const PROJECT_MANAGEMENT_REVIEW_NAMESPACE = "project-management-review";
const PROJECT_MANAGEMENT_REVIEWS_TABLE = "project_management_review_entries";

interface PersistedProjectManagementReviewRow {
  id: string;
  document_id: string;
  kind: ProjectManagementReviewEntry["kind"];
  source: ProjectManagementReviewEntry["source"];
  event_type: ProjectManagementReviewEntry["eventType"];
  body: string;
  created_at: string;
  updated_at: string;
  author_name: string;
  author_email: string;
}

const projectManagementReviewDbState = new Map<string, { db: ManagedDatabaseClient; ready: Promise<void> }>();

interface ProjectManagementAuthor {
  name: string;
  email: string;
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

function normalizeReviewBody(value: string): string {
  return value.trim();
}

function toReviewEntry(row: PersistedProjectManagementReviewRow): ProjectManagementReviewEntry {
  return {
    id: row.id,
    documentId: row.document_id,
    kind: row.kind,
    source: row.source,
    eventType: row.event_type,
    body: row.body,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    authorName: row.author_name,
    authorEmail: row.author_email,
  };
}

async function getProjectManagementReviewDb(repoRoot: string) {
  const db = await getManagedDatabaseClient(repoRoot, PROJECT_MANAGEMENT_REVIEW_NAMESPACE);
  const existing = projectManagementReviewDbState.get(repoRoot);
  if (!existing || existing.db !== db) {
    const ready = db.exec(`
      create table if not exists ${PROJECT_MANAGEMENT_REVIEWS_TABLE} (
        id text primary key,
        document_id text not null,
        kind text not null,
        source text not null,
        event_type text not null,
        body text not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        author_name text not null,
        author_email text not null
      );

      create index if not exists project_management_review_entries_document_idx
        on ${PROJECT_MANAGEMENT_REVIEWS_TABLE} (document_id, created_at, id);
    `);
    projectManagementReviewDbState.set(repoRoot, { db, ready });
  }

  const initialized = projectManagementReviewDbState.get(repoRoot);
  if (!initialized) {
    throw new Error("Project management review database initialization state was not recorded.");
  }

  await initialized.ready;
  return db;
}

async function assertKnownProjectManagementDocument(repoRoot: string, documentId: string): Promise<void> {
  const documents = await listProjectManagementDocuments(repoRoot);
  if (!documents.documents.some((document) => document.id === documentId)) {
    throw new Error(`Unknown project management document ${documentId}.`);
  }
}

function buildDocumentReview(documentId: string, entries: ProjectManagementReviewEntry[]): ProjectManagementDocumentReview {
  return {
    documentId,
    entries,
  };
}

export async function listProjectManagementReviews(repoRoot: string): Promise<ProjectManagementReviewsResponse> {
  const documents = await listProjectManagementDocuments(repoRoot);
  const db = await getProjectManagementReviewDb(repoRoot);
  const result = await db.query<PersistedProjectManagementReviewRow>(`
    select
      id,
      document_id,
      kind,
      source,
      event_type,
      body,
      created_at::text,
      updated_at::text,
      author_name,
      author_email
    from ${PROJECT_MANAGEMENT_REVIEWS_TABLE}
    order by document_id asc, created_at asc, id asc
  `);

  const entriesByDocumentId = new Map<string, ProjectManagementReviewEntry[]>();
  for (const row of result.rows) {
    const entries = entriesByDocumentId.get(row.document_id) ?? [];
    entries.push(toReviewEntry(row));
    entriesByDocumentId.set(row.document_id, entries);
  }

  return {
    branch: documents.branch,
    headSha: documents.headSha,
    reviews: documents.documents.map((document) => buildDocumentReview(document.id, entriesByDocumentId.get(document.id) ?? [])),
  };
}

export async function getProjectManagementDocumentReview(
  repoRoot: string,
  documentId: string,
): Promise<ProjectManagementDocumentReviewResponse> {
  await assertKnownProjectManagementDocument(repoRoot, documentId);
  const reviews = await listProjectManagementReviews(repoRoot);
  const review = reviews.reviews.find((entry) => entry.documentId === documentId) ?? buildDocumentReview(documentId, []);
  return {
    branch: reviews.branch,
    headSha: reviews.headSha,
    review,
  };
}

export async function addProjectManagementReviewEntry(
  repoRoot: string,
  documentId: string,
  request: AddProjectManagementReviewEntryRequest,
): Promise<ProjectManagementDocumentReviewResponse> {
  const body = normalizeReviewBody(request.body);
  if (!body) {
    throw new Error("Review body is required.");
  }

  await assertKnownProjectManagementDocument(repoRoot, documentId);
  const author = await resolveProjectManagementAuthor(repoRoot);
  const db = await getProjectManagementReviewDb(repoRoot);
  const now = new Date().toISOString();

  await db.query(
    `
      insert into ${PROJECT_MANAGEMENT_REVIEWS_TABLE} (
        id,
        document_id,
        kind,
        source,
        event_type,
        body,
        created_at,
        updated_at,
        author_name,
        author_email
      ) values (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
      )
    `,
    [
      randomUUID(),
      documentId,
      request.kind ?? "comment",
      request.source ?? "user",
      request.eventType ?? "comment",
      body,
      now,
      now,
      author.name,
      author.email,
    ],
  );

  return getProjectManagementDocumentReview(repoRoot, documentId);
}
