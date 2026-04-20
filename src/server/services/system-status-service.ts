import os from "node:os";
import type { AiCommandId, SystemJobPayloadSummary, SystemJobRecord, SystemJobsSnapshot, SystemPerformanceSnapshot, SystemStatusResponse } from "../../shared/types.js";
import { listWorktrees } from "./git-service.js";
import { getManagedDatabaseClient } from "./database-client-service.js";
import { logServerEvent } from "../utils/server-logger.js";

const MAX_SYSTEM_JOBS = 50;

interface PgBossJobRow {
  id: string | number;
  name: string;
  state: string;
  priority: number | string | null;
  retry_limit: number | string | null;
  retry_count: number | string | null;
  retry_delay: number | string | null;
  retry_delay_max: number | string | null;
  retry_backoff: boolean | number | string | null;
  expire_seconds: number | string | null;
  deletion_seconds: number | string | null;
  policy: string | null;
  singleton_key: string | null;
  singleton_on: string | Date | null;
  dead_letter: string | null;
  start_after: string | Date | null;
  created_on: string | Date;
  started_on: string | Date | null;
  completed_on: string | Date | null;
  keep_until: string | Date | null;
  heartbeat_on: string | Date | null;
  heartbeat_seconds: number | string | null;
  data: unknown;
  output: unknown;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

function toNullableNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function toBoolean(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return value === "true" || value === "1";
  }

  return false;
}

function toIsoString(value: unknown): string | null {
  if (value == null) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }

    return value;
  }

  return null;
}

function previewText(value: unknown, maxLength = 160): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isAiCommandId(value: unknown): value is AiCommandId {
  return value === "smart" || value === "simple";
}

function toPayloadSummary(value: unknown): SystemJobPayloadSummary {
  const payload = asRecord(parseJsonValue(value));
  const origin = asRecord(payload?.origin);

  return {
    branch: typeof payload?.branch === "string" ? payload.branch : null,
    documentId: typeof payload?.documentId === "string" ? payload.documentId : null,
    commandId: isAiCommandId(payload?.commandId) ? payload.commandId : null,
    worktreePath: typeof payload?.worktreePath === "string" ? payload.worktreePath : null,
    originKind: typeof origin?.kind === "string" ? origin.kind : null,
    originLabel: typeof origin?.label === "string" ? origin.label : null,
    renderedCommandPreview: previewText(payload?.renderedCommand),
    inputPreview: previewText(payload?.input),
    applyDocumentUpdateToDocumentId:
      typeof payload?.applyDocumentUpdateToDocumentId === "string"
        ? payload.applyDocumentUpdateToDocumentId
        : null,
    reviewDocumentId: typeof payload?.reviewDocumentId === "string" ? payload.reviewDocumentId : null,
    reviewRequestSummaryPreview: previewText(payload?.reviewRequestSummary),
    autoCommitDirtyWorktree: payload?.autoCommitDirtyWorktree === true,
  };
}

function toRuntimeSeconds(startedAt: string | null, completedAt: string | null, capturedAt: Date): number | null {
  if (!startedAt) {
    return null;
  }

  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) {
    return null;
  }

  const endMs = completedAt ? Date.parse(completedAt) : capturedAt.getTime();
  if (Number.isNaN(endMs)) {
    return null;
  }

  return Math.max(0, Math.round((endMs - startedMs) / 1000));
}

function isPgBossUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("pgboss.job")
    && (
      message.includes("does not exist")
      || message.includes("no such table")
      || message.includes("relation")
    )
  );
}

async function loadJobsSnapshot(repoRoot: string, capturedAt: Date): Promise<SystemJobsSnapshot> {
  const database = await getManagedDatabaseClient(repoRoot, "jobs");

  try {
    const rows = await database.query<PgBossJobRow>(
      `
        select
          id,
          name,
          state,
          priority,
          retry_limit,
          retry_count,
          retry_delay,
          retry_delay_max,
          retry_backoff,
          expire_seconds,
          deletion_seconds,
          policy,
          singleton_key,
          singleton_on,
          dead_letter,
          start_after,
          created_on,
          started_on,
          completed_on,
          keep_until,
          heartbeat_on,
          heartbeat_seconds,
          data,
          output
        from pgboss.job
        order by created_on desc
        limit $1
      `,
      [MAX_SYSTEM_JOBS],
    );

    const items: SystemJobRecord[] = rows.rows.map((row) => {
      const createdAt = toIsoString(row.created_on) ?? capturedAt.toISOString();
      const startedAt = toIsoString(row.started_on);
      const completedAt = toIsoString(row.completed_on);
      return {
        id: String(row.id),
        queue: row.name,
        state: row.state,
        priority: toNumber(row.priority),
        retryLimit: toNumber(row.retry_limit),
        retryCount: toNumber(row.retry_count),
        retryDelay: toNullableNumber(row.retry_delay),
        retryDelayMax: toNullableNumber(row.retry_delay_max),
        retryBackoff: toBoolean(row.retry_backoff),
        expireSeconds: toNullableNumber(row.expire_seconds),
        deletionSeconds: toNullableNumber(row.deletion_seconds),
        policy: row.policy ?? null,
        singletonKey: row.singleton_key ?? null,
        singletonOn: toIsoString(row.singleton_on),
        deadLetter: row.dead_letter ?? null,
        startAfter: toIsoString(row.start_after),
        createdAt,
        startedAt,
        completedAt,
        keepUntil: toIsoString(row.keep_until),
        heartbeatAt: toIsoString(row.heartbeat_on),
        heartbeatSeconds: toNullableNumber(row.heartbeat_seconds),
        runtimeSeconds: toRuntimeSeconds(startedAt, completedAt, capturedAt),
        hasOutput: parseJsonValue(row.output) != null,
        payloadSummary: toPayloadSummary(row.data),
      };
    });

    const countsByState = items.reduce<Record<string, number>>((counts, item) => {
      counts[item.state] = (counts[item.state] ?? 0) + 1;
      return counts;
    }, {});

    return {
      available: true,
      unavailableReason: null,
      total: items.length,
      countsByState,
      items,
    };
  } catch (error) {
    if (isPgBossUnavailableError(error)) {
      return {
        available: false,
        unavailableReason: "The pg-boss job table is not initialized yet.",
        total: 0,
        countsByState: {},
        items: [],
      };
    }

    logServerEvent("system-status", "pgboss-query-failed", {
      error: error instanceof Error ? error.message : String(error),
    }, "error");

    return {
      available: false,
      unavailableReason: error instanceof Error ? error.message : "Failed to load pg-boss jobs.",
      total: 0,
      countsByState: {},
      items: [],
    };
  }
}

function buildPerformanceSnapshot(
  worktreeCount: number,
  runtimeCount: number,
  linkedDocumentCount: number,
): SystemPerformanceSnapshot {
  const cpus = os.cpus();
  const coreCount = Math.max(1, cpus.length || 1);
  const loadAverage = os.loadavg() as [number, number, number];
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    nodeVersion: process.version,
    uptimeSeconds: Math.max(0, Math.round(os.uptime())),
    cpu: {
      coreCount,
      model: cpus[0]?.model ?? "Unknown CPU",
      speedMhz: cpus[0]?.speed ?? null,
      loadAverage,
      loadAveragePerCore: loadAverage.map((value) => Number((value / coreCount).toFixed(2))) as [number, number, number],
    },
    memory: {
      totalBytes,
      freeBytes,
      usedBytes,
      usageRatio: totalBytes > 0 ? usedBytes / totalBytes : 0,
    },
    worktrees: {
      total: worktreeCount,
      runtimeCount,
      linkedDocumentCount,
    },
  };
}

export async function getSystemStatus(repoRoot: string): Promise<SystemStatusResponse> {
  const capturedAt = new Date();
  const worktrees = await listWorktrees(repoRoot);
  const runtimeCount = worktrees.filter((worktree) => Boolean(worktree.runtime)).length;
  const linkedDocumentCount = worktrees.filter((worktree) => Boolean(worktree.linkedDocument)).length;
  const [jobs] = await Promise.all([
    loadJobsSnapshot(repoRoot, capturedAt),
  ]);

  return {
    capturedAt: capturedAt.toISOString(),
    performance: buildPerformanceSnapshot(worktrees.length, runtimeCount, linkedDocumentCount),
    jobs,
  };
}
