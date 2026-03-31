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
  branch: string;
  jobId: string;
  type: "run" | "output";
}

interface AiCommandLogRow {
  job_id: string;
  file_name: string;
  timestamp: string;
  branch: string;
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

interface AiCommandOutputRow {
  job_id: string;
  event_id: string;
  entry_number: number;
  source: "stdout" | "stderr";
  text: string;
  timestamp: string;
}

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

function cloneAiCommandJob(job: AiCommandJob | null): AiCommandJob | null {
  if (!job) {
    return null;
  }

  return {
    ...job,
    completedAt: job.completedAt,
    worktreePath: job.worktreePath,
    error: job.error,
    outputEvents: job.outputEvents?.map((event) => ({ ...event })) ?? [],
    origin: job.origin
      ? {
          ...job.origin,
          location: { ...job.origin.location },
        }
      : job.origin ?? null,
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

function parseAiCommandOrigin(value: unknown): AiCommandOrigin | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const origin = value as AiCommandOrigin;
  if (typeof origin.kind !== "string" || typeof origin.label !== "string" || !origin.location || typeof origin.location !== "object") {
    return null;
  }

  return cloneAiCommandOrigin(origin) ?? null;
}

function parseAiCommandLogError(value: unknown): AiCommandLogError | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    return { message: value };
  }

  if (typeof value !== "object") {
    return { message: String(value) };
  }

  const error = value as { name?: unknown; message?: unknown; stack?: unknown };
  return {
    name: typeof error.name === "string" ? error.name : undefined,
    message: typeof error.message === "string" ? error.message : String(value),
    stack: typeof error.stack === "string" ? error.stack : undefined,
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
  return {
    jobId: row.job_id,
    fileName: row.file_name,
    timestamp: row.timestamp,
    branch: row.branch,
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
    error: row.error_json ? parseAiCommandLogError(JSON.parse(row.error_json)) : null,
  };
}

async function notifyAiCommandLogUpdate(repoRoot: string, payload: AiCommandLogNotification): Promise<void> {
  const managed = await ensureManagedStore(repoRoot);
  await managed.db.query(`select pg_notify($1, $2)`, ["ai_command_log_updates", JSON.stringify(payload)]);
}

async function readAiCommandOutputEvents(repoRoot: string, jobId: string): Promise<AiCommandOutputEvent[]> {
  const managed = await ensureManagedStore(repoRoot);
  const result = await managed.db.query<AiCommandOutputRow>(
    `
      select job_id, event_id, entry_number, source, text, timestamp
      from ai_run_output_entries
      where job_id = $1
      order by entry_number asc
    `,
    [jobId],
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
      create table if not exists runtime_state (
        branch text primary key,
        snapshot_json text not null,
        updated_at timestamptz not null default now()
      );

      create table if not exists ai_job_state (
        branch text primary key,
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

      create table if not exists ai_run_logs (
        job_id text primary key,
        file_name text not null unique,
        timestamp text not null,
        branch text not null,
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

      create index if not exists ai_run_logs_branch_updated_idx
        on ai_run_logs (branch, updated_at desc);

      create table if not exists ai_run_output_entries (
        job_id text not null,
        file_name text not null,
        branch text not null,
        entry_number integer not null,
        event_id text not null,
        source text not null,
        text text not null,
        timestamp text not null,
        created_at timestamptz not null default now(),
        primary key (job_id, entry_number),
        foreign key (job_id) references ai_run_logs (job_id) on delete cascade
      );

      create index if not exists ai_run_output_entries_file_name_entry_idx
        on ai_run_output_entries (file_name, entry_number asc);
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
    return await querySnapshot(
      this.repoRoot,
      `select snapshot_json from runtime_state where branch = $1`,
      [branch],
      parseRuntime,
    );
  }

  async setRuntime(runtime: WorktreeRuntime): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into runtime_state (branch, snapshot_json, updated_at)
        values ($1, $2, now())
        on conflict (branch) do update
        set snapshot_json = excluded.snapshot_json,
            updated_at = now()
      `,
      [runtime.branch, JSON.stringify(cloneRuntime(runtime))],
    );
  }

  async deleteRuntime(branch: string): Promise<WorktreeRuntime | null> {
    const existing = await this.getRuntime(branch);
    if (!existing) {
      return null;
    }

    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(`delete from runtime_state where branch = $1`, [branch]);
    return existing;
  }

  async listRuntimes(): Promise<WorktreeRuntime[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<{ snapshot_json: string }>(
      `select snapshot_json from runtime_state order by updated_at asc`,
    );
    return result.rows
      .map((row) => parseRuntime(JSON.parse(row.snapshot_json)))
      .filter((runtime): runtime is WorktreeRuntime => runtime !== null);
  }

  async mergeInto<T extends { branch: string }>(worktrees: T[]): Promise<Array<T & { runtime?: WorktreeRuntime }>> {
    const runtimeEntries = await this.listRuntimes();
    const runtimeByBranch = new Map(runtimeEntries.map((runtime) => [runtime.branch, runtime]));
    return worktrees.map((worktree) => ({
      ...worktree,
      runtime: runtimeByBranch.get(worktree.branch),
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
    return await querySnapshot(
      this.repoRoot,
      `select snapshot_json from ai_job_state where branch = $1`,
      [branch],
      parseAiCommandJob,
    );
  }

  async listAiCommandJobs(): Promise<AiCommandJob[]> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query<{ snapshot_json: string }>(
      `select snapshot_json from ai_job_state order by updated_at desc`,
    );
    return result.rows
      .map((row) => parseAiCommandJob(JSON.parse(row.snapshot_json)))
      .filter((job): job is AiCommandJob => job !== null);
  }

  async claimRunningAiCommandJob(job: AiCommandJob): Promise<boolean> {
    const managed = await ensureManagedStore(this.repoRoot);
    const result = await managed.db.query(
      `
        insert into ai_job_state (branch, job_id, status, snapshot_json, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (branch) do update
        set job_id = excluded.job_id,
            status = excluded.status,
            snapshot_json = excluded.snapshot_json,
            updated_at = now()
        where ai_job_state.status <> 'running'
        returning branch
      `,
      [job.branch, job.jobId, job.status, JSON.stringify(cloneAiCommandJob(job))],
    );
    return result.rows.length > 0;
  }

  async setAiCommandJob(job: AiCommandJob): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    await managed.db.query(
      `
        insert into ai_job_state (branch, job_id, status, snapshot_json, updated_at)
        values ($1, $2, $3, $4, now())
        on conflict (branch) do update
        set job_id = excluded.job_id,
            status = excluded.status,
            snapshot_json = excluded.snapshot_json,
            updated_at = now()
      `,
      [job.branch, job.jobId, job.status, JSON.stringify(cloneAiCommandJob(job))],
    );
  }

  async clearAiCommandJobs(branch?: string): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    if (branch) {
      await managed.db.query(`delete from ai_job_state where branch = $1`, [branch]);
      return;
    }

    await managed.db.query(`delete from ai_job_state`);
  }

  async upsertAiCommandLogEntry(entry: AiCommandLogEntry): Promise<void> {
    const managed = await ensureManagedStore(this.repoRoot);
    const nextEntry = cloneAiCommandLogEntry(entry);
    if (!nextEntry) {
      return;
    }

    await managed.db.query(
      `
        insert into ai_run_logs (
          job_id,
          file_name,
          timestamp,
          branch,
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
          $11, $12, $13, $14, $15, $16, $17, $18, now()
        )
        on conflict (job_id) do update
        set file_name = excluded.file_name,
            timestamp = excluded.timestamp,
            branch = excluded.branch,
            document_id = excluded.document_id,
            command_id = excluded.command_id,
            origin_json = excluded.origin_json,
            worktree_path = excluded.worktree_path,
            command_text = excluded.command_text,
            request_text = excluded.request_text,
            status = excluded.status,
            stdout_text = excluded.stdout_text,
            stderr_text = excluded.stderr_text,
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
        nextEntry.branch,
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
      ],
    );

    await notifyAiCommandLogUpdate(this.repoRoot, {
      fileName: nextEntry.fileName,
      branch: nextEntry.branch,
      jobId: nextEntry.jobId,
      type: "run",
    });
  }

  async syncAiCommandOutputEvents(jobId: string, fileName: string, branch: string, events: AiCommandOutputEvent[] | undefined): Promise<void> {
    if (!events || events.length === 0) {
      return;
    }

    const managed = await ensureManagedStore(this.repoRoot);
    const maxResult = await managed.db.query<{ max_entry: number | null }>(
      `select max(entry_number) as max_entry from ai_run_output_entries where job_id = $1`,
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
          insert into ai_run_output_entries (
            job_id,
            file_name,
            branch,
            entry_number,
            event_id,
            source,
            text,
            timestamp
          )
          values ($1, $2, $3, $4, $5, $6, $7, $8)
        `,
        [
          jobId,
          fileName,
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
          branch,
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
        from ai_run_logs
        where job_id = $1
      `,
      [jobId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    const events = await readAiCommandOutputEvents(this.repoRoot, row.job_id);
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
          branch,
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
        from ai_run_logs
        order by updated_at desc, file_name desc
      `,
    );

    return await Promise.all(result.rows.map(async (row) => {
      const events = await readAiCommandOutputEvents(this.repoRoot, row.job_id);
      return toAiCommandLogEntry(row, events);
    }));
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

        if (typeof parsed.fileName !== "string" || typeof parsed.branch !== "string" || typeof parsed.jobId !== "string") {
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
}

export async function createOperationalStateStore(repoRoot: string): Promise<OperationalStateStore> {
  await ensureManagedStore(repoRoot);
  return new OperationalStateStore(repoRoot);
}

export async function clearAllOperationalAiJobs(branch?: string): Promise<void> {
  await Promise.all(Array.from(managedStores.keys()).map(async (repoRoot) => {
    const store = await createOperationalStateStore(repoRoot);
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
