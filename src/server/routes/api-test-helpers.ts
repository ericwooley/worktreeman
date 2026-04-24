import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "#test-runtime";
import express from "express";
import request from "supertest";
import { createApiRouter } from "./api.js";
import { stopManagedApiRouterContexts } from "./api-router-context.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "../services/repository-layout-service.js";
import { initRepository } from "../services/init-service.js";
import { createWorktree } from "../services/git-service.js";
import { loadConfig, readConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { findRepoContext } from "../utils/paths.js";
import { createOperationalStateStore, stopOperationalStateStore } from "../services/operational-state-service.js";
import { getAiCommandJob, waitForActiveAiCommandJobs } from "../services/ai-command-service.js";
import { startProjectManagementAiWorker, stopAiCommandJobManager } from "../services/ai-command-job-manager-service.js";
import { deleteAiCommandProcess } from "../services/ai-command-process-service.js";
import { stopDatabaseSocketServer } from "../services/database-socket-service.js";
import { worktreeId } from "../../shared/worktree-id.js";
import type { AiCommandOrigin, AiCommandOutputEvent, AiCommandLogEntry } from "../../shared/types.js";

type RouterOptions = Parameters<typeof createApiRouter>[0];
export type InjectedAiProcesses = NonNullable<RouterOptions["aiProcesses"]>;
export type ApiTestRepo = Awaited<ReturnType<typeof findRepoContext>>;
export type ApiTestServer = Awaited<ReturnType<typeof startApiServer>>;

export interface FakeAiProcessSnapshot {
  status: string | null;
  stdout?: string;
  stderr?: string;
  pid?: number;
  exitCode?: number | null;
}

const testContextRepoRoots = new Set<string>();

async function repoRootExists(repoRoot: string) {
  try {
    await fs.access(repoRoot);
    return true;
  } catch {
    return false;
  }
}

async function stopRunningAiJobsForRepo(
  repoRoot: string,
  deleteProcess: (processName: string) => Promise<void>,
  waitForProcess?: (processName: string) => Promise<unknown>,
) {
  const operationalState = await createOperationalStateStore(repoRoot);
  const jobs = await operationalState.listAiCommandJobs().catch(() => []);
  const runningProcessNames = jobs
    .filter((job) => job.status === "running" && typeof job.processName === "string" && job.processName.length > 0)
    .map((job) => job.processName as string);

  await Promise.all(runningProcessNames.map(async (processName) => {
    await deleteProcess(processName).catch(() => undefined);
    if (waitForProcess) {
      await waitForProcess(processName).catch(() => undefined);
    }
  }));
}

export function createFakeAiProcesses() {
  const queuedScripts: FakeAiProcessSnapshot[][] = [];
  const scriptedStates = new Map<string, {
    snapshots: FakeAiProcessSnapshot[];
    cursor: number;
    current: number;
    completion: Promise<FakeAiProcessSnapshot | null>;
    settled: boolean;
    settleCompletion: {
      resolve: (snapshot: FakeAiProcessSnapshot | null) => void;
      reject: (error: unknown) => void;
    };
  }>();
  const manualStates = new Map<string, FakeAiProcessSnapshot>();
  const manualCompletions = new Map<string, {
    promise: Promise<FakeAiProcessSnapshot | null>;
    settled: boolean;
    resolve: (snapshot: FakeAiProcessSnapshot | null) => void;
    reject: (error: unknown) => void;
  }>();
  const deletedProcesses: string[] = [];
  const isActiveStatus = (status: string | null | undefined) => status === "online" || status === "launching";

  const normalizeSnapshot = (snapshot?: FakeAiProcessSnapshot): FakeAiProcessSnapshot => ({
    status: snapshot?.status ?? null,
    stdout: snapshot?.stdout ?? "",
    stderr: snapshot?.stderr ?? "",
    pid: snapshot?.pid,
    exitCode: snapshot?.exitCode ?? null,
  });

  const toProcessDescription = (processName: string, snapshot: FakeAiProcessSnapshot | undefined) => {
    if (!snapshot?.status) {
      return null;
    }

    return {
      name: processName,
      pid: snapshot.pid,
      status: snapshot.status,
      exitCode: snapshot.exitCode ?? null,
    };
  };

  const settleScriptedCompletion = (
    processName: string,
    settle: (entry: {
      snapshots: FakeAiProcessSnapshot[];
      cursor: number;
      current: number;
      completion: Promise<FakeAiProcessSnapshot | null>;
      settled: boolean;
      settleCompletion: {
        resolve: (snapshot: FakeAiProcessSnapshot | null) => void;
        reject: (error: unknown) => void;
      };
    }) => void,
  ) => {
    const state = scriptedStates.get(processName);
    if (!state || state.settled) {
      return;
    }

    state.settled = true;
    settle(state);
  };

  const settleManualCompletion = (
    processName: string,
    settle: (entry: {
      promise: Promise<FakeAiProcessSnapshot | null>;
      settled: boolean;
      resolve: (snapshot: FakeAiProcessSnapshot | null) => void;
      reject: (error: unknown) => void;
    }) => void,
  ) => {
    const state = manualCompletions.get(processName);
    if (!state || state.settled) {
      return;
    }

    state.settled = true;
    settle(state);
  };

  const aiProcesses: InjectedAiProcesses = {
    async startProcess({ processName, hooks }) {
      const snapshots = queuedScripts.shift()?.map(normalizeSnapshot) ?? [
        normalizeSnapshot({ status: "online" }),
        normalizeSnapshot({ status: "stopped", exitCode: 0 }),
      ];
      let resolveCompletion!: (snapshot: FakeAiProcessSnapshot | null) => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<FakeAiProcessSnapshot | null>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      void completion.catch(() => null);
      scriptedStates.set(processName, {
        snapshots,
        cursor: 0,
        current: 0,
        completion,
        settled: false,
        settleCompletion: {
          resolve: resolveCompletion,
          reject: rejectCompletion,
        },
      });

      void Promise.resolve().then(async () => {
        let previous = normalizeSnapshot();
        for (const snapshot of snapshots) {
          const normalized = normalizeSnapshot(snapshot);
          const stdout = normalized.stdout ?? "";
          const previousStdout = previous.stdout ?? "";
          const stderr = normalized.stderr ?? "";
          const previousStderr = previous.stderr ?? "";

          if (hooks?.onStdout) {
            const chunk = stdout.startsWith(previousStdout) ? stdout.slice(previousStdout.length) : stdout;
            if (chunk) {
              await hooks.onStdout(chunk);
            }
          }

          if (hooks?.onStderr) {
            const chunk = stderr.startsWith(previousStderr) ? stderr.slice(previousStderr.length) : stderr;
            if (chunk) {
              await hooks.onStderr(chunk);
            }
          }

          previous = normalized;
        }

        if (!isActiveStatus(previous.status)) {
          settleScriptedCompletion(processName, (state) => {
            state.settleCompletion.resolve(previous);
          });
        }
      }).catch((error) => {
        settleScriptedCompletion(processName, (state) => {
          state.settleCompletion.reject(error);
        });
      });

      return toProcessDescription(processName, snapshots[0]) ?? {
        name: processName,
        status: "stopped",
        exitCode: snapshots[0]?.exitCode ?? null,
      };
    },
    async getProcess(processName) {
      const manual = manualStates.get(processName);
      if (manual) {
        return toProcessDescription(processName, manual);
      }

      const state = scriptedStates.get(processName);
      if (!state) {
        return null;
      }

      const index = Math.min(state.cursor, state.snapshots.length - 1);
      state.current = index;
      if (state.cursor < state.snapshots.length - 1) {
        state.cursor += 1;
      }
      return toProcessDescription(processName, state.snapshots[index]);
    },
    async waitForProcess(processName) {
      const manualCompletion = manualCompletions.get(processName);
      if (manualCompletion) {
        const snapshot = await manualCompletion.promise;
        return toProcessDescription(processName, snapshot ?? undefined);
      }

      const state = scriptedStates.get(processName);
      if (!state) {
        return null;
      }

      const snapshot = await state.completion;
      return toProcessDescription(processName, snapshot ?? undefined);
    },
    async deleteProcess(processName) {
      deletedProcesses.push(processName);
      const manual = manualStates.get(processName);
      if (manual) {
        const nextManual = {
          ...manual,
          status: "stopped",
          exitCode: manual.exitCode ?? null,
        };
        manualStates.set(processName, nextManual);
        settleManualCompletion(processName, (state) => {
          state.resolve(nextManual);
        });
        return;
      }

      const state = scriptedStates.get(processName);
      if (state) {
        const current = state.snapshots[state.current] ?? normalizeSnapshot();
        state.snapshots = [{
          ...current,
          status: "stopped",
          exitCode: current.exitCode ?? null,
        }];
        state.cursor = 0;
        state.current = 0;
        settleScriptedCompletion(processName, (entry) => {
          entry.settleCompletion.resolve(entry.snapshots[0] ?? null);
        });
      }
    },
    isProcessActive(status) {
      return isActiveStatus(status);
    },
  };

  return {
    aiProcesses,
    deletedProcesses,
    queueStartScript(script: FakeAiProcessSnapshot[]) {
      queuedScripts.push(script.map(normalizeSnapshot));
    },
    setManualProcess(processName: string, snapshot: FakeAiProcessSnapshot) {
      manualStates.set(processName, normalizeSnapshot(snapshot));
      if (!manualCompletions.has(processName)) {
        let resolve!: (snapshot: FakeAiProcessSnapshot | null) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<FakeAiProcessSnapshot | null>((nextResolve, nextReject) => {
          resolve = nextResolve;
          reject = nextReject;
        });
        void promise.catch(() => null);
        manualCompletions.set(processName, { promise, settled: false, resolve, reject });
      }
    },
    updateManualProcess(processName: string, updates: Partial<FakeAiProcessSnapshot>) {
      const current = manualStates.get(processName) ?? normalizeSnapshot();
      const nextSnapshot = normalizeSnapshot({
        ...current,
        ...updates,
      });
      manualStates.set(processName, nextSnapshot);
      if (nextSnapshot.status && nextSnapshot.status !== "online" && nextSnapshot.status !== "launching") {
        settleManualCompletion(processName, (state) => {
          state.resolve(nextSnapshot);
        });
      }
    },
  };
}

export async function writeAiLogFixture(options: {
  repoRoot: string;
  fileName: string;
  branch: string;
  commandId?: "smart" | "simple";
  sessionId?: string | null;
  origin?: AiCommandOrigin | null;
  worktreePath: string;
  command: string;
  request: string;
  processName?: string | null;
  pid?: number | null;
  stdout?: string;
  stderr?: string;
  events?: AiCommandOutputEvent[];
  completedAt?: string | null;
  exitCode?: number | null;
  error?: unknown;
}) {
  const store = await createOperationalStateStore(options.repoRoot);
  const timestamp = new Date().toISOString();
  const jobId = `job-${worktreeId(options.worktreePath)}-${options.fileName}`;
  const status = options.completedAt
    ? (options.error ? "failed" : "completed")
    : "running";
  const events: AiCommandOutputEvent[] = options.events?.map((event, index) => ({
    ...event,
    runId: event.runId ?? jobId,
    entry: event.entry ?? index + 1,
  })) ?? (() => {
      const nextEvents: AiCommandOutputEvent[] = [];
      if (options.stdout) {
        nextEvents.push({
          id: `${jobId}:1`,
          runId: jobId,
          entry: 1,
          source: "stdout",
          text: options.stdout,
          timestamp,
        });
      }
      if (options.stderr) {
        nextEvents.push({
          id: `${jobId}:${nextEvents.length + 1}`,
          runId: jobId,
          entry: nextEvents.length + 1,
          source: "stderr",
          text: options.stderr,
          timestamp,
        });
      }
      return nextEvents;
    })();

  const entry: AiCommandLogEntry = {
    jobId,
    fileName: options.fileName,
    timestamp,
    worktreeId: worktreeId(options.worktreePath),
    branch: options.branch,
    documentId: null,
    commandId: options.commandId ?? "smart",
    sessionId: options.sessionId ?? null,
    origin: options.origin ?? null,
    worktreePath: options.worktreePath,
    command: options.command,
    request: options.request,
    response: {
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
      events,
    },
    status,
    pid: options.pid ?? null,
    exitCode: options.exitCode ?? null,
    processName: options.processName ?? null,
    completedAt: options.completedAt ?? undefined,
    error: options.error
      ? { message: options.error instanceof Error ? options.error.message : String(options.error) }
      : null,
  };

  await store.upsertAiCommandLogEntry(entry);
  await store.syncAiCommandOutputEvents(entry.jobId, entry.fileName, entry.worktreeId, entry.branch, entry.response.events);

  if (status === "running") {
    await store.setAiCommandJob({
      jobId,
      fileName: options.fileName,
      worktreeId: entry.worktreeId,
      branch: options.branch,
      documentId: null,
      commandId: options.commandId ?? "smart",
      sessionId: options.sessionId ?? null,
      command: options.command,
      input: options.request,
      status: "running",
      startedAt: timestamp,
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
      outputEvents: events,
      pid: options.pid ?? null,
      exitCode: options.exitCode ?? null,
      processName: options.processName ?? null,
      worktreePath: options.worktreePath,
      error: null,
      origin: options.origin ?? null,
    });
  }

  return entry.fileName;
}

export async function openSse(url: string) {
  const target = new URL(url);
  const { request: streamRequest, response } = await new Promise<{
    request: http.ClientRequest;
    response: http.IncomingMessage;
  }>((resolve, reject) => {
    const nextRequest = http.get(target, {
      headers: { Accept: "text/event-stream" },
    });
    nextRequest.once("response", (incoming) => resolve({ request: nextRequest, response: incoming }));
    nextRequest.once("error", reject);
  });
  assert.equal(response.statusCode, 200);
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
  let closed = false;
  let streamError: unknown = null;
  let waiter: (() => void) | null = null;

  const wake = () => {
    const pending = waiter;
    waiter = null;
    pending?.();
  };

  response.on("data", (chunk) => {
    if (closed) {
      return;
    }
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    wake();
  });
  response.on("end", () => {
    ended = true;
    buffer += decoder.decode();
    wake();
  });
  response.on("error", (error) => {
    if (closed) {
      return;
    }
    streamError = error;
    wake();
  });
  response.on("close", () => {
    ended = true;
    wake();
  });
  streamRequest.on("error", (error: unknown) => {
    if (closed) {
      return;
    }
    streamError = error;
    wake();
  });

  async function waitForChunk(timeoutMs: number) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (waiter === onWake) {
          waiter = null;
        }
        reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms.`));
      }, timeoutMs);

      const onWake = () => {
        if (waiter === onWake) {
          waiter = null;
        }
        clearTimeout(timeout);
        resolve();
      };

      waiter = onWake;
    });
  }

  return {
    async nextEvent(timeoutMs = 3000) {
      while (true) {
        const separator = buffer.indexOf("\n\n");
        if (separator >= 0) {
          const rawEvent = buffer.slice(0, separator);
          buffer = buffer.slice(separator + 2);
          const payload = rawEvent
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!payload) {
            continue;
          }

          return JSON.parse(payload) as { type: string; log: unknown };
        }

        if (streamError) {
          throw streamError;
        }

        if (ended) {
          throw new Error("SSE stream closed before the next event arrived.");
        }

        await waitForChunk(timeoutMs);
      }
    },
    async close() {
      if (closed) {
        return;
      }

      closed = true;
      ended = true;
      streamError = null;
      const ignoreClosedStreamError = () => undefined;
      streamRequest.on("error", ignoreClosedStreamError);
      response.on("error", ignoreClosedStreamError);
      const closePromise = response.destroyed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            response.once("close", () => resolve());
            setTimeout(resolve, 100);
          });
      response.resume();
      streamRequest.destroy();
      wake();
      await closePromise;
    },
  };
}

export async function createApiTestRepo(): Promise<ApiTestRepo> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-api-"));
  await createBareRepoLayout({ rootDir });
  await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
  await initRepository(rootDir, { baseDir: ".", runtimePorts: [], force: false });

  const repo = await findRepoContext(rootDir);
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });

  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "printf %s $WTM_AI_INPUT",
    simple:
      "node -e \"const text = process.argv[1] || ''; const isCommitPrompt = text.includes('single-line git commit message') || text.includes('concise git commit message') || text.includes('git commit message'); console.log(isCommitPrompt ? 'commit me' : text);\" $WTM_AI_INPUT",
    autoStartRuntime: false,
  });
  await fs.writeFile(repo.configPath, nextContents, "utf8");

  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });

  await createWorktree(repo.repoRoot, config, { branch: "feature-ai-log" });
  return repo;
}

export async function startApiServer(
  repo: ApiTestRepo,
  overrides?: Partial<Pick<RouterOptions, "aiProcesses" | "aiProcessPollIntervalMs" | "aiLogStreamPollIntervalMs" | "stateStreamFullRefreshIntervalMs" | "gitWatchDebounceMs" | "autoSyncIntervalMs">>,
) {
  const worker = await startProjectManagementAiWorker({ repoRoot: repo.repoRoot });
  const app = express();
  app.use(express.json());
  const operationalState = await createOperationalStateStore(repo.repoRoot);
  testContextRepoRoots.add(repo.repoRoot);
  const deleteProcess = overrides?.aiProcesses?.deleteProcess ?? deleteAiCommandProcess;
  const waitForProcess = overrides?.aiProcesses?.waitForProcess;
  const apiRouter = createApiRouter({
    repoRoot: repo.repoRoot,
    configPath: repo.configPath,
    configSourceRef: repo.configSourceRef,
    configFile: repo.configFile,
    configWorktreePath: repo.configWorktreePath,
    operationalState,
    ...(overrides ?? {}),
  });
  app.use("/api", apiRouter);

  let server: http.Server | null = null;
  let liveBaseUrl: string | null = null;
  const liveSockets = new Set<net.Socket>();

  const ensureLiveBaseUrl = async () => {
    if (liveBaseUrl) {
      return liveBaseUrl;
    }

    server = http.createServer(app);
    server.on("connection", (socket) => {
      liveSockets.add(socket);
      socket.on("close", () => {
        liveSockets.delete(socket);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Failed to resolve test server address.");
    }

    liveBaseUrl = `http://127.0.0.1:${address.port}`;
    return liveBaseUrl;
  };

  const agent = request(app);

  const apiFetch = async (
    input: string,
    init: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    } = {},
  ) => {
    const url = new URL(input, "http://127.0.0.1");
    const target = `${url.pathname}${url.search}`;
    const method = (init.method ?? "GET").toUpperCase();

    let req: ReturnType<typeof agent.get>;
    switch (method) {
      case "GET":
        req = agent.get(target);
        break;
      case "POST":
        req = agent.post(target);
        break;
      case "PUT":
        req = agent.put(target);
        break;
      case "DELETE":
        req = agent.delete(target);
        break;
      default:
        throw new Error(`Unsupported test request method: ${method}`);
    }

    for (const [key, value] of Object.entries(init.headers ?? {})) {
      req = req.set(key, value);
    }

    if (typeof init.body === "string") {
      req = req.send(init.body);
    }

    const response = await req;
    return {
      status: response.status,
      async json() {
        return response.body;
      },
      async text() {
        return response.text;
      },
    };
  };

  return {
    baseUrl: "http://127.0.0.1",
    fetch: apiFetch,
    url: ensureLiveBaseUrl,
    close: async (options?: { shutdownRuntimes?: boolean }) => {
      try {
        if (server) {
          server.closeIdleConnections?.();
          for (const socket of liveSockets) {
            socket.destroy();
          }

          await new Promise<void>((resolve, reject) => {
            server?.close((error) => error ? reject(error) : resolve());
          });
        }
      } finally {
        if (options?.shutdownRuntimes ?? true) {
          await apiRouter.shutdownRuntimes().catch(() => undefined);
        }
        await stopRunningAiJobsForRepo(repo.repoRoot, deleteProcess, waitForProcess).catch(() => undefined);
        await waitForActiveAiCommandJobs(repo.repoRoot, { timeoutMs: 1000 }).catch(() => undefined);
        await apiRouter.dispose().catch(() => undefined);
        await worker.close();
        await stopAiCommandJobManager(repo.repoRoot);
        await stopOperationalStateStore(repo.repoRoot);
        await stopDatabaseSocketServer(repo.repoRoot).catch(() => undefined);
      }
    },
  };
}

export async function readStateSnapshot<TState>(server: ApiTestServer, timeoutMs = 3000): Promise<TState> {
  const stream = await openSse(`${await server.url()}/api/state/stream`);

  try {
    const snapshot = await stream.nextEvent(timeoutMs) as unknown as { type: string; state: TState };
    assert.equal(snapshot.type, "snapshot");
    return snapshot.state;
  } finally {
    await stream.close();
  }
}

export async function startRunningAiJob(
  server: ApiTestServer,
  fakeAiProcesses: ReturnType<typeof createFakeAiProcesses>,
  branch: string,
) {
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 4123, stdout: "running", stderr: "" },
  ]);

  const response = await server.fetch(`/api/worktrees/${encodeURIComponent(branch)}/ai-command/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: `run ai for ${branch}` }),
  });

  assert.equal(response.status, 200);
  const payload = await response.json() as { job: { branch: string; status: string } };
  assert.equal(payload.job.branch, branch);
  assert.equal(payload.job.status, "running");
}

export async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

export async function waitForPathToDisappear(targetPath: string, timeoutMs = 5000) {
  await waitFor(async () => {
    try {
      await fs.access(targetPath);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

export async function removePathWithRetry(targetPath: string, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || (error.code !== "ENOTEMPTY" && error.code !== "EBUSY")) {
        throw error;
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  await fs.rm(targetPath, { recursive: true, force: true });
}

export async function allocateTestPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a test port.")));
        return;
      }

      const { port } = address;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

test.afterEach(async () => {
  const repos = Array.from(testContextRepoRoots);
  const staleRepos = await Promise.all(repos.map(async (repoRoot) => {
    return await repoRootExists(repoRoot) ? null : repoRoot;
  }));
  const repoRootsToCleanup = staleRepos.filter((repoRoot): repoRoot is string => Boolean(repoRoot));

  await Promise.all(repoRootsToCleanup.map(async (repoRoot) => {
    testContextRepoRoots.delete(repoRoot);
    await stopManagedApiRouterContexts(repoRoot, { shutdownRuntimes: true }).catch(() => undefined);
    await stopAiCommandJobManager(repoRoot);
    await stopOperationalStateStore(repoRoot);
    await stopDatabaseSocketServer(repoRoot).catch(() => undefined);
  }));
}, { timeout: 15000 });

test.after(async () => {
  const repos = Array.from(testContextRepoRoots);
  testContextRepoRoots.clear();
  await Promise.all(repos.map((repoRoot) => stopManagedApiRouterContexts(repoRoot, { shutdownRuntimes: true }).catch(() => undefined)));
  await Promise.all(repos.map(async (repoRoot) => {
    await stopRunningAiJobsForRepo(repoRoot, deleteAiCommandProcess).catch(() => undefined);
  }));
  await Promise.all(repos.map(async (repoRoot) => {
    await waitForActiveAiCommandJobs(repoRoot, { timeoutMs: 500 }).catch(() => undefined);
  }));
  await Promise.all(repos.map((repoRoot) => stopAiCommandJobManager(repoRoot)));
  await Promise.all(repos.map((repoRoot) => stopOperationalStateStore(repoRoot)));
  await Promise.all(repos.map((repoRoot) => stopDatabaseSocketServer(repoRoot).catch(() => undefined)));
  await Promise.all(repos.map(async (repoRoot) => {
    await fs.rm(repoRoot, { recursive: true, force: true }).catch(() => undefined);
  }));
}, { timeout: 30000 });

export async function getRunningJob(repoRoot: string, branch: string) {
  return await getAiCommandJob(repoRoot, worktreeId(path.join(repoRoot, branch)), { reconcile: false });
}
