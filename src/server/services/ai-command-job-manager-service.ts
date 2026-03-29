import fs from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PgBoss } from "pg-boss";
import type { AiCommandId, AiCommandJob, AiCommandOrigin } from "../../shared/types.js";

const PROJECT_MANAGEMENT_AI_QUEUE = "project-management-ai-update";
const JOB_START_TIMEOUT_MS = 10000;
const JOB_POLL_INTERVAL_SECONDS = 0.5;

export interface ProjectManagementAiQueuePayload {
  branch: string;
  commandId: AiCommandId;
  worktreePath: string;
  input: string;
  renderedCommand: string;
  env: Record<string, string>;
  documentId: string;
  origin?: AiCommandOrigin | null;
}

interface AiCommandJobManagerOptions {
  repoRoot: string;
  onProcessProjectManagementAiJob: (payload: ProjectManagementAiQueuePayload, context: {
    queueJobId: string;
    notifyStarted: (job: AiCommandJob) => void;
    started: (job: AiCommandJob) => Promise<AiCommandJob>;
  }) => Promise<void>;
}

interface StartWaiter {
  resolve: (job: AiCommandJob) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ManagedAiCommandJobQueue {
  boss: PgBoss;
  db: PGlite;
  readyPromise: Promise<void>;
  startWaiters: Map<string, StartWaiter>;
  startedJobs: Map<string, AiCommandJob>;
}

const managedQueues = new Map<string, ManagedAiCommandJobQueue>();

function resolveAiJobDbPath(repoRoot: string) {
  return path.join(repoRoot, ".logs", "jobs", "pgdata");
}

function toSerializableEnv(env: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(env).filter(([, value]) => typeof value === "string"),
  );
}

async function ensureJobManager(options: AiCommandJobManagerOptions): Promise<ManagedAiCommandJobQueue> {
  const existing = managedQueues.get(options.repoRoot);
  if (existing) {
    await existing.readyPromise;
    return existing;
  }

  const dbPath = resolveAiJobDbPath(options.repoRoot);
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  const db = await PGlite.create(dbPath);

  const boss = new PgBoss({
    db: {
      executeSql: async (text, values) => {
        if (values && values.length > 0) {
          const result = await db.query(text, values);
          return { rows: result.rows ?? [] };
        }

        const results = await db.exec(text);
        const last = results.at(-1) ?? { rows: [] };
        return { rows: last.rows ?? [] };
      },
    },
    schema: "pgboss",
    createSchema: true,
    migrate: true,
  });

  const startWaiters = new Map<string, StartWaiter>();
  const startedJobs = new Map<string, AiCommandJob>();
  const readyPromise = (async () => {
    boss.on("error", (error) => {
      console.error("[ai-jobs] pg-boss error", error);
    });
    await boss.start();
    await boss.createQueue(PROJECT_MANAGEMENT_AI_QUEUE);
    await boss.work<ProjectManagementAiQueuePayload>(
      PROJECT_MANAGEMENT_AI_QUEUE,
      { pollingIntervalSeconds: JOB_POLL_INTERVAL_SECONDS },
      async (jobs) => {
        for (const job of jobs) {
          try {
            const notifyStarted = (startedJob: AiCommandJob) => {
              const waiter = startWaiters.get(job.id);
              if (!waiter) {
                startedJobs.set(job.id, startedJob);
                return;
              }

              clearTimeout(waiter.timer);
              startWaiters.delete(job.id);
              waiter.resolve(startedJob);
            };
            await options.onProcessProjectManagementAiJob(job.data, {
              queueJobId: job.id,
              notifyStarted,
              started(startedJob) {
                notifyStarted(startedJob);
                return Promise.resolve(startedJob);
              },
            });
          } catch (error) {
            const waiter = startWaiters.get(job.id);
            if (waiter) {
              clearTimeout(waiter.timer);
              startWaiters.delete(job.id);
              waiter.reject(error instanceof Error ? error : new Error(String(error)));
            }
            throw error;
          }
        }
      },
    );
  })();

  const managed: ManagedAiCommandJobQueue = { boss, db, readyPromise, startWaiters, startedJobs };
  managedQueues.set(options.repoRoot, managed);

  try {
    await readyPromise;
    return managed;
  } catch (error) {
    managedQueues.delete(options.repoRoot);
    await Promise.allSettled([boss.stop(), db.close()]);
    throw error;
  }
}

export async function enqueueProjectManagementAiJob(options: AiCommandJobManagerOptions & {
  payload: ProjectManagementAiQueuePayload;
  timeoutMs?: number;
}): Promise<AiCommandJob> {
  const manager = await ensureJobManager(options);
  const payload: ProjectManagementAiQueuePayload = {
    ...options.payload,
    env: toSerializableEnv(options.payload.env),
  };
  const queueJobId = await manager.boss.send(PROJECT_MANAGEMENT_AI_QUEUE, payload, {
    retryLimit: 0,
  });

  if (!queueJobId) {
    throw new Error("Failed to enqueue the project management AI job.");
  }

  const alreadyStarted = manager.startedJobs.get(queueJobId);
  if (alreadyStarted) {
    manager.startedJobs.delete(queueJobId);
    return alreadyStarted;
  }

  return await new Promise<AiCommandJob>((resolve, reject) => {
    let settled = false;
    const resolveStartedJob = (job: AiCommandJob) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      manager.startWaiters.delete(queueJobId);
      manager.startedJobs.delete(queueJobId);
      resolve(job);
    };

    const timer = setTimeout(() => {
      settled = true;
      manager.startWaiters.delete(queueJobId);
      reject(new Error(`Timed out waiting for AI job ${queueJobId} to start.`));
    }, options.timeoutMs ?? JOB_START_TIMEOUT_MS);

    manager.startWaiters.set(queueJobId, {
      resolve: resolveStartedJob,
      reject: (error) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timer);
        manager.startWaiters.delete(queueJobId);
        manager.startedJobs.delete(queueJobId);
        reject(error);
      },
      timer,
    });

    const startedAfterWaiterRegistered = manager.startedJobs.get(queueJobId);
    if (startedAfterWaiterRegistered) {
      resolveStartedJob(startedAfterWaiterRegistered);
    }
  });
}

export async function stopAllAiCommandJobManagers() {
  const entries = Array.from(managedQueues.entries());
  managedQueues.clear();

  await Promise.all(entries.map(async ([, manager]) => {
    for (const waiter of manager.startWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("AI job manager stopped before the job started."));
    }
    manager.startWaiters.clear();
    manager.startedJobs.clear();
    await Promise.allSettled([manager.boss.stop(), manager.db.close()]);
  }));
}

export async function stopAiCommandJobManager(repoRoot: string) {
  const manager = managedQueues.get(repoRoot);
  if (!manager) {
    return;
  }

  managedQueues.delete(repoRoot);

  await Promise.all([
    (async () => {
    for (const waiter of manager.startWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("AI job manager stopped before the job started."));
    }
    manager.startWaiters.clear();
    manager.startedJobs.clear();
    })(),
    Promise.allSettled([manager.boss.stop(), manager.db.close()]),
  ]);
}
