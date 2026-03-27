import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import type { AiCommandJob, ShutdownLogEntry, ShutdownStatus, WorktreeRuntime } from "../../shared/types.js";

const DEFAULT_SHUTDOWN_STATUS: ShutdownStatus = {
  active: false,
  completed: false,
  failed: false,
  logs: [],
};

interface ManagedOperationalStateStore {
  db: PGlite;
  readyPromise: Promise<void>;
}

const managedStores = new Map<string, ManagedOperationalStateStore>();

function resolveOperationalStateDbPath(repoRoot: string) {
  return path.join(repoRoot, ".logs", "operations", "pgdata");
}

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
    logPath: job.logPath,
    error: job.error,
    origin: job.origin
      ? {
          ...job.origin,
          location: { ...job.origin.location },
        }
      : job.origin ?? null,
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

  const dbPath = resolveOperationalStateDbPath(repoRoot);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = await PGlite.create(dbPath);
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
    await db.close().catch(() => undefined);
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
  await managed.db.close().catch(() => undefined);
}

export async function stopAllOperationalStateStores() {
  const entries = Array.from(managedStores.entries());
  managedStores.clear();
  await Promise.all(entries.map(async ([, managed]) => {
    await managed.readyPromise.catch(() => undefined);
    await managed.db.close().catch(() => undefined);
  }));
}
