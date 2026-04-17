import type {
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogError,
  AiCommandOutputEvent,
  AiCommandOrigin,
  ShutdownLogEntry,
  ShutdownStatus,
  WorktreeRuntime,
} from "../../shared/types.js";
import { cloneAiCommandJob, parseAiCommandOrigin, toAiCommandLogError } from "../../shared/ai-command-utils.js";
import type { WorktreeId } from "../../shared/worktree-id.js";
import { isWorktreeId } from "../../shared/worktree-id.js";
import {
  closeAllManagedDatabaseClients,
  closeManagedDatabaseClient,
  getManagedDatabaseClient,
  type ManagedDatabaseClient,
} from "./database-client-service.js";

const DEFAULT_SHUTDOWN_STATUS: ShutdownStatus = {
  active: false,
  completed: false,
  failed: false,
  logs: [],
};

interface ManagedOperationalStateStore {
  db: ManagedDatabaseClient;
  readyPromise: Promise<void>;
}

interface AiCommandLogNotification {
  fileName: string;
  worktreeId: WorktreeId;
  branch: string;
  jobId: string;
  type: "run" | "output";
}

interface AiCommandLogRow {
  job_id: string;
  file_name: string;
  timestamp: string;
  worktree_id: string;
  branch: string;
  session_id: string | null;
  document_id: string | null;
  command_id: string;
  origin_json: string | null;
  worktree_path: string;
  command_text: string;
  request_text: string;
  status: string;
  stdout_text: string;
  stderr_text: string;
  pid: number | null;
  exit_code: number | null;
  process_name: string | null;
  completed_at: string | null;
  error_json: string | null;
}

interface AiCommandLogIndexRow {
  job_id: string;
  file_name: string;
  timestamp: string;
  worktree_id: string;
  branch: string;
  session_id: string | null;
  document_id: string | null;
  command_id: string;
  origin_json: string | null;
  worktree_path: string;
  command_text: string;
  request_text: string;
  status: string;
  pid: number | null;
  exit_code: number | null;
  process_name: string | null;
  completed_at: string | null;
  error_json: string | null;
}

export interface AiCommandLogIndexEntry {
  jobId: string;
  fileName: string;
  timestamp: string;
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
  documentId?: string | null;
  commandId: "smart" | "simple";
  origin?: AiCommandOrigin | null;
  worktreePath: string;
  command: string;
  request: string;
  status: "running" | "completed" | "failed";
  pid?: number | null;
  exitCode?: number | null;
  processName?: string | null;
  completedAt?: string;
  error: AiCommandLogError | null;
}

interface AiCommandOutputRow {
  job_id: string;
  worktree_id: string;
  event_id: string;
  entry_number: number;
  source: "stdout" | "stderr";
  text: string;
  timestamp: string;
}

export interface WorktreeDocumentLinkRecord {
  worktreeId: WorktreeId;
  branch: string;
  worktreePath: string;
  documentId: string;
  updatedAt: string;
}

interface WorktreeDocumentLinkRow {
  worktree_id: string;
  branch: string;
  worktree_path: string;
  document_id: string;
  updated_at: string;
}

export interface BackgroundCommandMetadataRecord {
  processName: string;
  worktreeId: WorktreeId;
  branch: string;
  commandName: string;
  command: string;
  worktreePath: string;
  runtimeEnv: Record<string, string>;
  updatedAt: string;
}

interface BackgroundCommandMetadataRow {
  process_name: string;
  worktree_id: string;
  branch: string;
  command_name: string;
  command_text: string;
  worktree_path: string;
  runtime_env_json: string;
  updated_at: string;
}

const RUNTIME_STATE_TABLE = "runtime_state_v2";
const AI_JOB_STATE_TABLE = "ai_job_state_v2";
const AI_RUN_LOGS_TABLE = "ai_run_logs_v2";
const AI_RUN_OUTPUT_TABLE = "ai_run_output_entries_v2";
const WORKTREE_DOCUMENT_LINKS_TABLE = "worktree_document_links";
const BACKGROUND_COMMAND_METADATA_TABLE = "background_command_metadata";

const managedStores = new Map<string, ManagedOperationalStateStore>();

function cloneRuntime(runtime: WorktreeRuntime | null): WorktreeRuntime | null {
  if (!runtime) {
    return null;
  }

  return {
    ...runtime,
    env: { ...runtime.env },
    quickLinks: runtime.quickLinks.map((link) => ({ ...link })),
    allocatedPorts: { ...runtime.allocatedPorts },
  };
}

function cloneAiCommandOutputEvent(event: AiCommandOutputEvent): AiCommandOutputEvent {
  return { ...event };
}

function cloneAiCommandLogError(error: AiCommandLogError | null): AiCommandLogError | null {
  return error ? { ...error } : null;
}

function cloneAiCommandOrigin(origin: AiCommandOrigin | null | undefined): AiCommandOrigin | null | undefined {
  return origin
    ? {
        ...origin,
        location: { ...origin.location },
      }
    : origin;
}

function cloneAiCommandLogEntry(entry: AiCommandLogEntry | null): AiCommandLogEntry | null {
  if (!entry) {
    return null;
  }

  return {
    ...entry,
    documentId: entry.documentId ?? null,
    completedAt: entry.completedAt,
    pid: entry.pid,
    exitCode: entry.exitCode,
    processName: entry.processName,
    error: cloneAiCommandLogError(entry.error),
    origin: cloneAiCommandOrigin(entry.origin) ?? null,
    response: {
      stdout: entry.response.stdout,
      stderr: entry.response.stderr,
      events: entry.response.events?.map(cloneAiCommandOutputEvent) ?? [],
    },
  };
}

function toStoredAiCommandJob(job: AiCommandJob): AiCommandJob {
  return {
    ...cloneAiCommandJob(job)!,
    stdout: "",
    stderr: job.status === "failed" ? (job.stderr || job.error || "") : "",
    outputEvents: [],
  };
}

function cloneShutdownStatus(status: ShutdownStatus): ShutdownStatus {
  return {
    ...status,
    logs: status.logs.map((entry) => ({ ...entry })),
  };
}

function parseRuntime(value: unknown): WorktreeRuntime | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return cloneRuntime(value as WorktreeRuntime);
}

function parseAiCommandJob(value: unknown): AiCommandJob | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return cloneAiCommandJob(value as AiCommandJob);
}

function parseWorktreeId(value: unknown): WorktreeId | null {
  return typeof value === "string" && isWorktreeId(value) ? value : null;
}

function parseRuntimeEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).flatMap(([key, entry]) => (
      typeof entry === "string" ? [[key, entry]] : []
    )),
  );
}

function toWorktreeDocumentLinkRecord(row: WorktreeDocumentLinkRow | null | undefined): WorktreeDocumentLinkRecord | null {
  if (!row) {
    return null;
  }

  const worktreeId = parseWorktreeId(row.worktree_id);
  if (!worktreeId) {
    return null;
  }

  return {
    worktreeId,
    branch: row.branch,
    worktreePath: row.worktree_path,
    documentId: row.document_id,
    updatedAt: row.updated_at,
  };
}

function toBackgroundCommandMetadataRecord(row: BackgroundCommandMetadataRow | null | undefined): BackgroundCommandMetadataRecord | null {
  if (!row) {
    return null;
  }

  const worktreeId = parseWorktreeId(row.worktree_id);
  if (!worktreeId) {
    return null;
  }

  return {
    processName: row.process_name,
    worktreeId,
    branch: row.branch,
    commandName: row.command_name,
    command: row.command_text,
    worktreePath: row.worktree_path,
    runtimeEnv: parseRuntimeEnv(JSON.parse(row.runtime_env_json)),
    updatedAt: row.updated_at,
  };
}

function parseAiCommandOutputEvent(value: unknown, fallbackRunId: string, fallbackEntry: number): AiCommandOutputEvent | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const event = value as {
    id?: unknown;
    runId?: unknown;
    entry?: unknown;
    source?: unknown;
    text?: unknown;
    timestamp?: unknown;
  };
  if ((event.source !== "stdout" && event.source !== "stderr") || typeof event.text !== "string") {
    return null;
  }

  return {
    id: typeof event.id === "string" && event.id ? event.id : `${fallbackRunId}:${fallbackEntry}`,
    runId: typeof event.runId === "string" && event.runId ? event.runId : fallbackRunId,
    entry: typeof event.entry === "number" && Number.isFinite(event.entry) ? event.entry : fallbackEntry,
    source: event.source,
    text: event.text,
    timestamp: typeof event.timestamp === "string" && event.timestamp ? event.timestamp : new Date().toISOString(),
  };
}

function toAiCommandLogEntry(row: AiCommandLogRow, events: AiCommandOutputEvent[]): AiCommandLogEntry {
  const worktreeId = parseWorktreeId(row.worktree_id);
  if (!worktreeId) {
    throw new Error(`AI command log ${row.job_id} is missing a valid worktree id.`);
  }

  return {
    jobId: row.job_id,
    fileName: row.file_name,
    timestamp: row.timestamp,
    worktreeId,
    branch: row.branch,
    sessionId: row.session_id,
    documentId: row.document_id,
    commandId: row.command_id === "simple" ? "simple" : "smart",
    origin: row.origin_json ? parseAiCommandOrigin(JSON.parse(row.origin_json)) : null,
    worktreePath: row.worktree_path,
    command: row.command_text,
    request: row.request_text,
    response: {
      stdout: row.stdout_text,
      stderr: row.stderr_text,
      events,
    },
    status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "running",
    pid: row.pid,
    exitCode: row.exit_code,
    processName: row.process_name,
    completedAt: row.completed_at ?? undefined,
    error: row.error_json ? toAiCommandLogError(JSON.parse(row.error_json)) : null,
  };
}

function toAiCommandLogIndexEntry(row: AiCommandLogIndexRow): AiCommandLogIndexEntry {
  const worktreeId = parseWorktreeId(row.worktree_id);
  if (!worktreeId) {
    throw new Error(`AI command log ${row.job_id} is missing a valid worktree id.`);
  }

  return {
    jobId: row.job_id,
    fileName: row.file_name,
    timestamp: row.timestamp,
    worktreeId,
    branch: row.branch,
    sessionId: row.session_id,
    documentId: row.document_id,
    commandId: row.command_id === "simple" ? "simple" : "smart",
    origin: row.origin_json ? parseAiCommandOrigin(JSON.parse(row.origin_json)) : null,
    worktreePath: row.worktree_path,
    command: row.command_text,
    request: row.request_text,
    status: row.status === "completed" ? "completed" : row.status === "failed" ? "failed" : "running",
    pid: row.pid,
    exitCode: row.exit_code,
    processName: row.process_name,
    completedAt: row.completed_at ?? undefined,
    error: row.error_json ? toAiCommandLogError(JSON.parse(row.error_json)) : null,
  };
}

async function notifyAiCommandLogUpdate(repoRoot: string, payload: AiCommandLogNotification): Promise<void> {
  const managed = await ensureManagedStore(repoRoot);
  await managed.db.query(`select pg_notify($1, $2)`, ["ai_command_log_updates", JSON.stringify(payload)]);
}

async function readAiCommandOutputEvents(
  repoRoot: string,
  options: {
    jobId: string;
    fileName?: string;
    worktreeId?: string;
    branch?: string;
  },
): Promise<AiCommandOutputEvent[]> {
  const managed = await ensureManagedStore(repoRoot);
  const conditions = ["job_id = $1"];
  const params: unknown[] = [options.jobId];

  if (typeof options.fileName === "string" && options.fileName.length > 0) {
    conditions.push(`file_name = $${params.length + 1}`);
    params.push(options.fileName);
  }

  if (typeof options.worktreeId === "string" && options.worktreeId.length > 0) {
    conditions.push(`worktree_id = $${params.length + 1}`);
    params.push(options.worktreeId);
  }

  if (typeof options.branch === "string" && options.branch.length > 0) {
    conditions.push(`branch = $${params.length + 1}`);
    params.push(options.branch);
  }

  const result = await managed.db.query<AiCommandOutputRow>(
    `
      select job_id, event_id, entry_number, source, text, timestamp
      from ${AI_RUN_OUTPUT_TABLE}
      where ${conditions.join(" and ")}
      order by entry_number asc
    `,
    params,
  );

  return result.rows.flatMap((row) => {
    const event = parseAiCommandOutputEvent({
      id: row.event_id,
      runId: row.job_id,
      entry: row.entry_number,
      source: row.source,
      text: row.text,
      timestamp: row.timestamp,
    }, row.job_id, row.entry_number);
    return event ? [event] : [];
  });
}

function parseShutdownStatus(value: unknown): ShutdownStatus {
  if (!value || typeof value !== "object") {
    return cloneShutdownStatus(DEFAULT_SHUTDOWN_STATUS);
  }

  const status = value as ShutdownStatus;
  return {
    active: Boolean(status.active),
    completed: Boolean(status.completed),
    failed: Boolean(status.failed),
    logs: Array.isArray(status.logs)
      ? status.logs.map((entry) => ({
          id: Number(entry.id),
          level: entry.level,
          message: String(entry.message),
          timestamp: String(entry.timestamp),
        }))
      : [],
  };
}

async function ensureManagedStore(repoRoot: string): Promise<ManagedOperationalStateStore> {
  const existing = managedStores.get(repoRoot);
  if (existing) {
    await existing.readyPromise;
    return existing;
  }

  const db = await getManagedDatabaseClient(repoRoot, "operations");
  const readyPromise = (async () => {
    await db.exec(`
      create table if not exists ${RUNTIME_STATE_TABLE} (
        worktree_id text primary key,
        snapshot_json text not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists ${AI_JOB_STATE_TABLE} (
        worktree_id text primary key,
        job_id text not null,
        status text not null,
        snapshot_json text not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists shutdown_state (
        singleton boolean primary key default true,
        snapshot_json text not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists ${AI_RUN_LOGS_TABLE} (
        job_id text primary key,
        file_name text not null unique,
        timestamp text not null,
        worktree_id text not null,
        branch text not null,
        session_id text,
        document_id text,
        command_id text not null,
        origin_json text,
        worktree_path text not null,
        command_text text not null,
        request_text text not null,
        status text not null,
        stdout_text text not null default '',
        stderr_text text not null default '',
        pid integer,
        exit_code integer,
        process_name text,
        completed_at text,
        error_json text,
        updated_at timestamptz not null default now()
      );

      create index if not exists ai_run_logs_worktree_updated_idx
        on ${AI_RUN_LOGS_TABLE} (worktree_id, updated_at desc);

      create index if not exists ai_run_logs_branch_updated_idx
        on ${AI_RUN_LOGS_TABLE} (branch, updated_at desc);

      create table if not exists ${AI_RUN_OUTPUT_TABLE} (
        job_id text not null,
        file_name text not null,
        worktree_id text not null,
        branch text not null,
        entry_number integer not null,
        event_id text not null,
        source text not null,
        text text not null,
        timestamp text not null,
        created_at timestamptz not null default now(),
        primary key (job_id, entry_number),
        foreign key (job_id) references ${AI_RUN_LOGS_TABLE} (job_id) on delete cascade
      );

      create index if not exists ai_run_output_entries_file_name_entry_idx
        on ${AI_RUN_OUTPUT_TABLE} (file_name, entry_number asc);

      create table if not exists ${WORKTREE_DOCUMENT_LINKS_TABLE} (
        worktree_id text primary key,
        branch text not null,
        worktree_path text not null,
        document_id text not null,
        updated_at timestamptz not null default now()
      );

      create index if not exists worktree_document_links_document_idx
        on ${WORKTREE_DOCUMENT_LINKS_TABLE} (document_id, updated_at desc);

      create table if not exists ${BACKGROUND_COMMAND_METADATA_TABLE} (
        process_name text primary key,
        worktree_id text not null,
        branch text not null,
        command_name text not null,
        command_text text not null,
        worktree_path text not null,
        runtime_env_json text not null,
        updated_at timestamptz not null default now()
      );

      create index if not exists background_command_metadata_worktree_idx
        on ${BACKGROUND_COMMAND_METADATA_TABLE} (worktree_id, updated_at desc);

      alter table ${AI_RUN_LOGS_TABLE}
        add column if not exists session_id text;
    `);

    await db.query(
      `
        insert into shutdown_state (singleton, snapshot_json, updated_at)
        values (true, $1, now())
        on conflict (singleton) do nothing
      `,
      [JSON.stringify(DEFAULT_SHUTDOWN_STATUS)],
    );
  })();

  const managed: ManagedOperationalStateStore = { db, readyPromise };
  managedStores.set(repoRoot, managed);

  try {
    await readyPromise;
    return managed;
  } catch (error) {
    managedStores.delete(repoRoot);
    await closeManagedDatabaseClient(repoRoot, "operations").catch(() => undefined);
    throw error;
  }
}

async function querySnapshot<T>(repoRoot: string, sql: string, values: unknown[], parse: (value: unknown) => T): Promise<T | null> {
  const managed = await ensureManagedStore(repoRoot);
  const result = await managed.db.query<{ snapshot_json: string }>(sql, values);
  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return parse(JSON.parse(row.snapshot_json));
}

async function updateShutdownStatus(
  repoRoot: string,
  updater: (current: ShutdownStatus) => ShutdownStatus,
): Promise<ShutdownStatus> {
  const current = await querySnapshot(
    repoRoot,
    `select snapshot_json from shutdown_state where singleton = true`,
    [],
    parseShutdownStatus,
  ) ?? cloneShutdownStatus(DEFAULT_SHUTDOWN_STATUS);
  const next = cloneShutdownStatus(updater(current));
  const managed = await ensureManagedStore(repoRoot);
  await managed.db.query(
    `
      update shutdown_state
      set snapshot_json = $1,
          updated_at = now()
      where singleton = true
    `,
    [JSON.stringify(next)],
  );
  return next;
}

function appendShutdownLog(status: ShutdownStatus, level: ShutdownLogEntry["level"], message: string): ShutdownStatus {
  const nextId = status.logs.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  return {
    ...status,
    logs: [
      ...status.logs,
      {
        id: nextId,
        level,
        message,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

export class OperationalStateStore {
  constructor(readonly repoRoot: string) {}

  async resetShutdownStatus(): Promise<ShutdownStatus> {
    const next = cloneShutdownStatus(DEFAULT_SHUTDOWN_STATUS);
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        update shutdown_state
        set snapshot_json = $1,
            updated_at = now()
        where singleton = true
      `,
      [JSON.stringify(next)],
    );
    return next;
  }

  async getRuntime(branch: string): Promise<WorktreeRuntime | null> {
    return await this.getRuntimeById(branch as WorktreeId);
  }

  async getRuntimeById(worktreeId: WorktreeId): Promise<WorktreeRuntime | null> {
    return await querySnapshot(
      this.repoRoot,
      `select snapshot_json from ${RUNTIME_STATE_TABLE} where worktree_id = $1`,
      [worktreeId],
      parseRuntime,
    );
  }

  async setRuntime(runtime: WorktreeRuntime): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into ${RUNTIME_STATE_TABLE} (worktree_id, snapshot_json, updated_at)
        values ($1, $2, now())
        on conflict (worktree_id) do update
        set snapshot_json = excluded.snapshot_json,
            updated_at = now()
      `,
      [runtime.id, JSON.stringify(cloneRuntime(runtime))],
    );
  }

  async deleteRuntime(branch: string): Promise<WorktreeRuntime | null> {
    return await this.deleteRuntimeById(branch as WorktreeId);
  }

  async deleteRuntimeById(worktreeId: WorktreeId): Promise<WorktreeRuntime | null> {
    const existing = await this.getRuntimeById(worktreeId);
    if (!existing) {
      return null;
    }

    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(`delete from ${RUNTIME_STATE_TABLE} where worktree_id = $1`, [worktreeId]);
    return existing;
  }

  async listRuntimes(): Promise<WorktreeRuntime[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<{ snapshot_json: string }>(
      `select snapshot_json from ${RUNTIME_STATE_TABLE} order by updated_at asc`,
    );
    return result.rows
      .map((row) => parseRuntime(JSON.parse(row.snapshot_json)))
      .filter((runtime): runtime is WorktreeRuntime => runtime !== null);
  }

  async mergeInto<T extends { id: WorktreeId }>(worktrees: T[]): Promise<Array<T & { runtime?: WorktreeRuntime }>> {
    const runtimeEntries = await this.listRuntimes();
    const runtimeById = new Map(runtimeEntries.map((runtime) => [runtime.id, runtime]));
    return worktrees.map((worktree) => ({
      ...worktree,
      runtime: runtimeById.get(worktree.id),
    }));
  }

  async getShutdownStatus(): Promise<ShutdownStatus> {
    const status = await querySnapshot(
      this.repoRoot,
      `select snapshot_json from shutdown_state where singleton = true`,
      [],
      parseShutdownStatus,
    );
    return status ?? cloneShutdownStatus(DEFAULT_SHUTDOWN_STATUS);
  }

  async beginShutdown(message: string): Promise<ShutdownStatus> {
    return await updateShutdownStatus(this.repoRoot, () => appendShutdownLog({
      active: true,
      completed: false,
      failed: false,
      logs: [],
    }, "info", message));
  }

  async appendShutdownInfo(message: string): Promise<ShutdownStatus> {
    return await updateShutdownStatus(this.repoRoot, (current) => appendShutdownLog(current, "info", message));
  }

  async appendShutdownError(message: string): Promise<ShutdownStatus> {
    return await updateShutdownStatus(this.repoRoot, (current) => appendShutdownLog(current, "error", message));
  }

  async completeShutdown(message: string): Promise<ShutdownStatus> {
    return await updateShutdownStatus(this.repoRoot, (current) => {
      const next = appendShutdownLog(current, "info", message);
      return {
        ...next,
        active: false,
        completed: true,
        failed: false,
      };
    });
  }

  async failShutdown(message: string): Promise<ShutdownStatus> {
    return await updateShutdownStatus(this.repoRoot, (current) => {
      const next = appendShutdownLog(current, "error", message);
      return {
        ...next,
        active: false,
        completed: false,
        failed: true,
      };
    });
  }

  async getAiCommandJob(branch: string): Promise<AiCommandJob | null> {
    return await this.getAiCommandJobById(branch as WorktreeId);
  }

  async getAiCommandJobById(worktreeId: WorktreeId): Promise<AiCommandJob | null> {
    return await querySnapshot(
      this.repoRoot,
      `select snapshot_json from ${AI_JOB_STATE_TABLE} where worktree_id = $1`,
      [worktreeId],
      parseAiCommandJob,
    );
  }

  async listAiCommandJobs(): Promise<AiCommandJob[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<{ snapshot_json: string }>(
      `select snapshot_json from ${AI_JOB_STATE_TABLE} order by updated_at desc`,
    );
    return result.rows
      .map((row) => parseAiCommandJob(JSON.parse(row.snapshot_json)))
      .filter((job): job is AiCommandJob => job !== null);
  }

  async claimRunningAiCommandJob(job: AiCommandJob): Promise<boolean> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query(
      `
        insert into ${AI_JOB_STATE_TABLE} (worktree_id, job_id, status, snapshot_json, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (worktree_id) do update
        set job_id = excluded.job_id,
            status = excluded.status,
            snapshot_json = excluded.snapshot_json,
            updated_at = now()
        where ${AI_JOB_STATE_TABLE}.status <> 'running'
        returning worktree_id
      `,
      [job.worktreeId, job.jobId, job.status, JSON.stringify(toStoredAiCommandJob(job))],
    );
    return result.rows.length > 0;
  }

  async setAiCommandJob(job: AiCommandJob): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into ${AI_JOB_STATE_TABLE} (worktree_id, job_id, status, snapshot_json, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (worktree_id) do update
        set job_id = excluded.job_id,
            status = excluded.status,
            snapshot_json = excluded.snapshot_json,
            updated_at = now()
      `,
      [job.worktreeId, job.jobId, job.status, JSON.stringify(toStoredAiCommandJob(job))],
    );
  }

  async clearAiCommandJobs(branch?: string): Promise<void> {
    if (branch) {
      await this.clearAiCommandJobsById(branch as WorktreeId);
      return;
    }

    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(`delete from ${AI_JOB_STATE_TABLE}`);
  }

  async clearAiCommandJobsById(worktreeId?: WorktreeId): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    if (worktreeId) {
      await managed.db.query(`delete from ${AI_JOB_STATE_TABLE} where worktree_id = $1`, [worktreeId]);
      return;
    }

    await managed.db.query(`delete from ${AI_JOB_STATE_TABLE}`);
  }

  async upsertAiCommandLogEntry(entry: AiCommandLogEntry, options?: { preserveOutputText?: boolean }): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    const nextEntry = cloneAiCommandLogEntry(entry);
    if (!nextEntry) {
      return;
    }

    const preserveOutputText = options?.preserveOutputText ?? false;

    await managed.db.query(
      `
        insert into ${AI_RUN_LOGS_TABLE} (
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          stdout_text,
          stderr_text,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json,
          updated_at
        )
        values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, now()
        )
        on conflict (job_id) do update
        set file_name = excluded.file_name,
            timestamp = excluded.timestamp,
            worktree_id = excluded.worktree_id,
            branch = excluded.branch,
            session_id = excluded.session_id,
            document_id = excluded.document_id,
            command_id = excluded.command_id,
            origin_json = excluded.origin_json,
            worktree_path = excluded.worktree_path,
            command_text = excluded.command_text,
            request_text = excluded.request_text,
            status = excluded.status,
            stdout_text = case when $21 then ${AI_RUN_LOGS_TABLE}.stdout_text else excluded.stdout_text end,
            stderr_text = case when $21 then ${AI_RUN_LOGS_TABLE}.stderr_text else excluded.stderr_text end,
            pid = excluded.pid,
            exit_code = excluded.exit_code,
            process_name = excluded.process_name,
            completed_at = excluded.completed_at,
            error_json = excluded.error_json,
            updated_at = now()
      `,
      [
        nextEntry.jobId,
        nextEntry.fileName,
        nextEntry.timestamp,
        nextEntry.worktreeId,
        nextEntry.branch,
        nextEntry.sessionId ?? null,
        nextEntry.documentId ?? null,
        nextEntry.commandId,
        nextEntry.origin ? JSON.stringify(nextEntry.origin) : null,
        nextEntry.worktreePath,
        nextEntry.command,
        nextEntry.request,
        nextEntry.status,
        nextEntry.response.stdout,
        nextEntry.response.stderr,
        nextEntry.pid ?? null,
        nextEntry.exitCode ?? null,
        nextEntry.processName ?? null,
        nextEntry.completedAt ?? null,
        nextEntry.error ? JSON.stringify(nextEntry.error) : null,
        preserveOutputText,
      ],
    );

    await notifyAiCommandLogUpdate(this.repoRoot, {
      fileName: nextEntry.fileName,
      worktreeId: nextEntry.worktreeId,
      branch: nextEntry.branch,
      jobId: nextEntry.jobId,
      type: "run",
    });
  }

  async appendAiCommandOutputChunk(options: {
    jobId: string;
    fileName: string;
    worktreeId: WorktreeId;
    branch: string;
    source: AiCommandOutputEvent["source"];
    text: string;
    eventId?: string;
    timestamp?: string;
  }): Promise<AiCommandOutputEvent | null> {
    if (!options.text) {
      return null;
    }

    const managed = await ensureManagedStore(this.repoRoot);
    const event = await managed.db.transaction(async (db) => {
      const entryResult = await db.query<{ next_entry: number }>(
        `select coalesce(max(entry_number), 0) + 1 as next_entry from ${AI_RUN_OUTPUT_TABLE} where job_id = $1`,
        [options.jobId],
      );
      const nextEntry = entryResult.rows[0]?.next_entry ?? 1;
      const eventId = options.eventId ?? `${options.jobId}:${nextEntry}`;
      const timestamp = options.timestamp ?? new Date().toISOString();

      await db.query(
        `
          update ${AI_RUN_LOGS_TABLE}
          set ${options.source === "stdout" ? "stdout_text" : "stderr_text"} = ${options.source === "stdout" ? "stdout_text" : "stderr_text"} || $2,
              updated_at = now()
          where job_id = $1
        `,
        [options.jobId, options.text],
      );

      await db.query(
        `
          insert into ${AI_RUN_OUTPUT_TABLE} (
            job_id,
            file_name,
            worktree_id,
            branch,
            entry_number,
            event_id,
            source,
            text,
            timestamp
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          options.jobId,
          options.fileName,
          options.worktreeId,
          options.branch,
          nextEntry,
          eventId,
          options.source,
          options.text,
          timestamp,
        ],
      );

      return {
        id: eventId,
        runId: options.jobId,
        entry: nextEntry,
        source: options.source,
        text: options.text,
        timestamp,
      } satisfies AiCommandOutputEvent;
    });

    await notifyAiCommandLogUpdate(this.repoRoot, {
      fileName: options.fileName,
      worktreeId: options.worktreeId,
      branch: options.branch,
      jobId: options.jobId,
      type: "output",
    });

    return event;
  }

  async syncAiCommandOutputEvents(
    jobId: string,
    fileName: string,
    worktreeId: WorktreeId,
    branch: string,
    events: AiCommandOutputEvent[] | undefined,
  ): Promise<void> {
    if (!events || events.length === 0) {
      return;
    }

      const managed = await ensureManagedStore(this.repoRoot);
      const maxResult = await managed.db.query<{ max_entry: number | null }>(
      `select max(entry_number) as max_entry from ${AI_RUN_OUTPUT_TABLE} where job_id = $1`,
      [jobId],
    );
    const maxEntry = maxResult.rows[0]?.max_entry ?? 0;
    const pendingEvents = events
      .map((event, index) => ({
        ...cloneAiCommandOutputEvent(event),
        runId: event.runId ?? jobId,
        entry: event.entry ?? index + 1,
      }))
      .filter((event) => (event.entry ?? 0) > maxEntry);

    for (const event of pendingEvents) {
      await managed.db.query(
        `
          insert into ${AI_RUN_OUTPUT_TABLE} (
            job_id,
            file_name,
            worktree_id,
            branch,
            entry_number,
            event_id,
            source,
            text,
            timestamp
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          jobId,
          fileName,
          worktreeId,
          branch,
          event.entry,
          event.id,
          event.source,
          event.text,
          event.timestamp,
        ],
      );

      await notifyAiCommandLogUpdate(this.repoRoot, {
        fileName,
        worktreeId,
        branch,
        jobId,
        type: "output",
      });
    }
  }

  async getAiCommandLogEntryByJobId(jobId: string): Promise<AiCommandLogEntry | null> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<AiCommandLogRow>(
      `
        select
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          stdout_text,
          stderr_text,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json
        from ${AI_RUN_LOGS_TABLE}
        where job_id = $1
      `,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const events = await readAiCommandOutputEvents(this.repoRoot, {
      jobId: row.job_id,
      fileName: row.file_name,
      worktreeId: row.worktree_id,
      branch: row.branch,
    });
    return toAiCommandLogEntry(row, events);
  }

  async getAiCommandLogIndexEntryByJobId(jobId: string): Promise<AiCommandLogIndexEntry | null> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<AiCommandLogIndexRow>(
      `
        select
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json
        from ${AI_RUN_LOGS_TABLE}
        where job_id = $1
      `,
      [jobId],
    );
    const row = result.rows[0];
    return row ? toAiCommandLogIndexEntry(row) : null;
  }

  async getAiCommandLogEntryByFileName(fileName: string): Promise<AiCommandLogEntry | null> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<AiCommandLogRow>(
      `
        select
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          stdout_text,
          stderr_text,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json
        from ${AI_RUN_LOGS_TABLE}
        where file_name = $1
      `,
      [fileName],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const events = await readAiCommandOutputEvents(this.repoRoot, {
      jobId: row.job_id,
      fileName: row.file_name,
      worktreeId: row.worktree_id,
      branch: row.branch,
    });
    return toAiCommandLogEntry(row, events);
  }

  async listAiCommandLogEntries(): Promise<AiCommandLogEntry[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<AiCommandLogRow>(
      `
        select
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          stdout_text,
          stderr_text,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json
        from ${AI_RUN_LOGS_TABLE}
        order by updated_at desc, file_name desc
      `,
    );

    return await Promise.all(result.rows.map(async (row) => {
      const events = await readAiCommandOutputEvents(this.repoRoot, {
        jobId: row.job_id,
        fileName: row.file_name,
        worktreeId: row.worktree_id,
        branch: row.branch,
      });
      return toAiCommandLogEntry(row, events);
    }));
  }

  async listAiCommandLogIndexEntries(): Promise<AiCommandLogIndexEntry[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<AiCommandLogIndexRow>(
      `
        select
          job_id,
          file_name,
          timestamp,
          worktree_id,
          branch,
          session_id,
          document_id,
          command_id,
          origin_json,
          worktree_path,
          command_text,
          request_text,
          status,
          pid,
          exit_code,
          process_name,
          completed_at,
          error_json
        from ${AI_RUN_LOGS_TABLE}
        order by updated_at desc, file_name desc
      `,
    );

    return result.rows.map(toAiCommandLogIndexEntry);
  }

  async subscribeToAiCommandLogNotifications(
    listener: (notification: AiCommandLogNotification) => void,
  ): Promise<() => Promise<void>> {
    const managed = await ensureManagedStore(this.repoRoot);
    const unlisten = await managed.db.listen("ai_command_log_updates", (payload) => {
      if (typeof payload !== "string" || !payload) {
        return;
      }

      try {
        const parsed = JSON.parse(payload) as AiCommandLogNotification;
        if (!parsed || typeof parsed !== "object") {
          return;
        }

        if (
          typeof parsed.fileName !== "string"
          || typeof parsed.branch !== "string"
          || typeof parsed.jobId !== "string"
          || !isWorktreeId(parsed.worktreeId)
        ) {
          return;
        }

        if (parsed.type !== "run" && parsed.type !== "output") {
          return;
        }

        listener(parsed);
      } catch {
        // ignore malformed notifications
      }
    });

    return async () => {
      await unlisten();
    };
  }

  async listWorktreeDocumentLinks(): Promise<WorktreeDocumentLinkRecord[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<WorktreeDocumentLinkRow>(
      `
        select worktree_id, branch, worktree_path, document_id, updated_at
        from ${WORKTREE_DOCUMENT_LINKS_TABLE}
        order by updated_at desc
      `,
    );
    return result.rows
      .map(toWorktreeDocumentLinkRecord)
      .filter((entry): entry is WorktreeDocumentLinkRecord => entry !== null);
  }

  async getWorktreeDocumentLinkById(worktreeId: WorktreeId): Promise<WorktreeDocumentLinkRecord | null> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<WorktreeDocumentLinkRow>(
      `
        select worktree_id, branch, worktree_path, document_id, updated_at
        from ${WORKTREE_DOCUMENT_LINKS_TABLE}
        where worktree_id = $1
      `,
      [worktreeId],
    );
    return toWorktreeDocumentLinkRecord(result.rows[0] ?? null);
  }

  async setWorktreeDocumentLink(details: {
    worktreeId: WorktreeId;
    branch: string;
    worktreePath: string;
    documentId: string;
  }): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into ${WORKTREE_DOCUMENT_LINKS_TABLE} (worktree_id, branch, worktree_path, document_id, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (worktree_id) do update
        set branch = excluded.branch,
            worktree_path = excluded.worktree_path,
            document_id = excluded.document_id,
            updated_at = now()
      `,
      [details.worktreeId, details.branch, details.worktreePath, details.documentId],
    );
  }

  async clearWorktreeDocumentLinkById(worktreeId: WorktreeId): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(`delete from ${WORKTREE_DOCUMENT_LINKS_TABLE} where worktree_id = $1`, [worktreeId]);
  }

  async getBackgroundCommandMetadata(processName: string): Promise<BackgroundCommandMetadataRecord | null> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<BackgroundCommandMetadataRow>(
      `
        select process_name, worktree_id, branch, command_name, command_text, worktree_path, runtime_env_json, updated_at
        from ${BACKGROUND_COMMAND_METADATA_TABLE}
        where process_name = $1
      `,
      [processName],
    );
    return toBackgroundCommandMetadataRecord(result.rows[0] ?? null);
  }

  async listBackgroundCommandMetadataByWorktreeId(worktreeId: WorktreeId): Promise<BackgroundCommandMetadataRecord[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<BackgroundCommandMetadataRow>(
      `
        select process_name, worktree_id, branch, command_name, command_text, worktree_path, runtime_env_json, updated_at
        from ${BACKGROUND_COMMAND_METADATA_TABLE}
        where worktree_id = $1
        order by updated_at desc
      `,
      [worktreeId],
    );
    return result.rows
      .map(toBackgroundCommandMetadataRecord)
      .filter((entry): entry is BackgroundCommandMetadataRecord => entry !== null);
  }

  async setBackgroundCommandMetadata(details: {
    processName: string;
    worktreeId: WorktreeId;
    branch: string;
    commandName: string;
    command: string;
    worktreePath: string;
    runtimeEnv: Record<string, string>;
  }): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into ${BACKGROUND_COMMAND_METADATA_TABLE} (
          process_name,
          worktree_id,
          branch,
          command_name,
          command_text,
          worktree_path,
          runtime_env_json,
          updated_at
        )
        values ($1, $2, $3, $4, $5, $6, $7, now())
        on conflict (process_name) do update
        set worktree_id = excluded.worktree_id,
            branch = excluded.branch,
            command_name = excluded.command_name,
            command_text = excluded.command_text,
            worktree_path = excluded.worktree_path,
            runtime_env_json = excluded.runtime_env_json,
            updated_at = now()
      `,
      [
        details.processName,
        details.worktreeId,
        details.branch,
        details.commandName,
        details.command,
        details.worktreePath,
        JSON.stringify(details.runtimeEnv),
      ],
    );
  }

  async deleteBackgroundCommandMetadata(processName: string): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(`delete from ${BACKGROUND_COMMAND_METADATA_TABLE} where process_name = $1`, [processName]);
  }
}

export async function createOperationalStateStore(repoRoot: string): Promise<OperationalStateStore> {
  await ensureManagedStore(repoRoot);
  return new OperationalStateStore(repoRoot);
}

export async function clearAllOperationalAiJobs(branch?: string): Promise<void> {
  await Promise.all(Array.from(managedStores.keys()).map(async (repoRoot) => {
    const store = await createOperationalStateStore(repoRoot);
    if (branch && isWorktreeId(branch)) {
      await store.clearAiCommandJobsById(branch);
      return;
    }
    await store.clearAiCommandJobs(branch);
  }));
}

export async function stopOperationalStateStore(repoRoot: string) {
  const managed = managedStores.get(repoRoot);
  if (!managed) {
    return;
  }

  managedStores.delete(repoRoot);
  await managed.readyPromise.catch(() => undefined);
  await closeManagedDatabaseClient(repoRoot, "operations").catch(() => undefined);
}

export async function stopAllOperationalStateStores() {
  const entries = Array.from(managedStores.entries());
  managedStores.clear();
  await Promise.all(entries.map(async ([, managed]) => {
    await managed.readyPromise.catch(() => undefined);
  }));
  await closeAllManagedDatabaseClients();
}
