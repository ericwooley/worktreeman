import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "#test-runtime";
import express from "express";
import request from "supertest";
import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { createApiRouter } from "./api.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "../services/repository-layout-service.js";
import { initRepository } from "../services/init-service.js";
import { createWorktree } from "../services/git-service.js";
import { loadConfig, parseConfigContents, readConfigContents, serializeConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { findRepoContext, findWorktreePathForRef } from "../utils/paths.js";
import { runCommand } from "../utils/process.js";
import { createOperationalStateStore, stopOperationalStateStore } from "../services/operational-state-service.js";
import { closeManagedDatabaseClient, getManagedDatabaseClient } from "../services/database-client-service.js";
import { getProjectManagementDocument, getProjectManagementDocumentHistory } from "../services/project-management-service.js";
import { getAiCommandJob, startAiCommandJob, waitForActiveAiCommandJobs, waitForAiCommandJob } from "../services/ai-command-service.js";
import { startProjectManagementAiWorker, stopAiCommandJobManager } from "../services/ai-command-job-manager-service.js";
import { stopAllBackgroundCommands } from "../services/background-command-service.js";
import { deleteAiCommandProcess } from "../services/ai-command-process-service.js";
import { stopDatabaseSocketServer } from "../services/database-socket-service.js";
import { startServer } from "../app.js";
import { resolveTmuxSessionName } from "../services/terminal-service.js";
import { getWorktreeDocumentLink, setWorktreeDocumentLink } from "../services/worktree-link-service.js";
import { getTmuxSessionName } from "../../shared/tmux.js";
import { worktreeId } from "../../shared/worktree-id.js";
import type { AiCommandJob, AiCommandLogEntry, AiCommandOrigin, AiCommandOutputEvent, SystemStatusResponse } from "../../shared/types.js";

type RouterOptions = Parameters<typeof createApiRouter>[0];
type InjectedAiProcesses = NonNullable<RouterOptions["aiProcesses"]>;

interface FakeAiProcessSnapshot {
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
) {
  const operationalState = await createOperationalStateStore(repoRoot);
  const jobs = await operationalState.listAiCommandJobs().catch(() => []);
  const runningProcessNames = jobs
    .filter((job) => job.status === "running" && typeof job.processName === "string" && job.processName.length > 0)
    .map((job) => job.processName as string);

  await Promise.all(runningProcessNames.map((processName) => deleteProcess(processName).catch(() => undefined)));
}

function createFakeAiProcesses() {
  const queuedScripts: FakeAiProcessSnapshot[][] = [];
  const scriptedStates = new Map<string, {
    snapshots: FakeAiProcessSnapshot[];
    cursor: number;
    current: number;
  }>();
  const manualStates = new Map<string, FakeAiProcessSnapshot>();
  const deletedProcesses: string[] = [];

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

  const aiProcesses: InjectedAiProcesses = {
    async startProcess({ processName }) {
      const snapshots = queuedScripts.shift()?.map(normalizeSnapshot) ?? [
        normalizeSnapshot({ status: "online" }),
        normalizeSnapshot({ status: "stopped", exitCode: 0 }),
      ];
      scriptedStates.set(processName, { snapshots, cursor: 0, current: 0 });
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
    async readProcessLogs(processInfo) {
      if (!processInfo) {
        return { stdout: "", stderr: "" };
      }

      const manual = manualStates.get(processInfo.name);
      if (manual) {
        return {
          stdout: manual.stdout ?? "",
          stderr: manual.stderr ?? "",
        };
      }

      const state = scriptedStates.get(processInfo.name);
      if (!state) {
        return { stdout: "", stderr: "" };
      }

      const snapshot = state.snapshots[state.current] ?? normalizeSnapshot();
      if (state.current < state.snapshots.length - 1) {
        state.current += 1;
      }
      return {
        stdout: snapshot.stdout ?? "",
        stderr: snapshot.stderr ?? "",
      };
    },
    async deleteProcess(processName) {
      deletedProcesses.push(processName);
      const manual = manualStates.get(processName);
      if (manual) {
        manualStates.set(processName, {
          ...manual,
          status: "stopped",
          exitCode: manual.exitCode ?? null,
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
      }
    },
    isProcessActive(status) {
      return status === "online" || status === "launching";
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
    },
    updateManualProcess(processName: string, updates: Partial<FakeAiProcessSnapshot>) {
      const current = manualStates.get(processName) ?? normalizeSnapshot();
      manualStates.set(processName, normalizeSnapshot({
        ...current,
        ...updates,
      }));
    },
  };
}

async function writeAiLogFixture(options: {
  repoRoot: string;
  fileName: string;
  branch: string;
  commandId?: "smart" | "simple";
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
  const jobId = `job-${options.fileName}`;
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

async function openSse(url: string) {
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
      closed = true;
      ended = true;
      streamError = null;
      const closePromise = response.destroyed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            response.once("close", () => resolve());
            setTimeout(resolve, 100);
          });
      streamRequest.destroy();
      response.destroy();
      wake();
      await closePromise;
    },
  };
}

async function createApiTestRepo(): Promise<Awaited<ReturnType<typeof findRepoContext>>> {
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
    simple: "node -e \"const text = process.argv[1] || ''; console.log(text.includes('git commit message') ? 'commit me' : text);\" $WTM_AI_INPUT",
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

async function startApiServer(
  repo: Awaited<ReturnType<typeof findRepoContext>>,
  overrides?: Partial<Pick<RouterOptions, "aiProcesses" | "aiProcessPollIntervalMs" | "aiLogStreamPollIntervalMs" | "stateStreamFullRefreshIntervalMs">>,
) {
  const worker = await startProjectManagementAiWorker({ repoRoot: repo.repoRoot });
  const app = express();
  app.use(express.json());
  const operationalState = await createOperationalStateStore(repo.repoRoot);
  testContextRepoRoots.add(repo.repoRoot);
  const deleteProcess = overrides?.aiProcesses?.deleteProcess ?? deleteAiCommandProcess;
  app.use("/api", createApiRouter({
    repoRoot: repo.repoRoot,
    configPath: repo.configPath,
    configSourceRef: repo.configSourceRef,
    configFile: repo.configFile,
    configWorktreePath: repo.configWorktreePath,
    operationalState,
    ...(overrides ?? {}),
  }));

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
    close: async () => {
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
        await stopRunningAiJobsForRepo(repo.repoRoot, deleteProcess).catch(() => undefined);
        await waitForActiveAiCommandJobs(repo.repoRoot, { timeoutMs: 500 });
        await worker.close();
        await stopAiCommandJobManager(repo.repoRoot);
        await stopOperationalStateStore(repo.repoRoot);
        await stopDatabaseSocketServer(repo.repoRoot).catch(() => undefined);
      }
    },
  };
}

async function readStateSnapshot<TState>(server: Awaited<ReturnType<typeof startApiServer>>, timeoutMs = 3000): Promise<TState> {
  const stream = await openSse(`${await server.url()}/api/state/stream`);

  try {
    const snapshot = await stream.nextEvent(timeoutMs) as unknown as { type: string; state: TState };
    assert.equal(snapshot.type, "snapshot");
    return snapshot.state;
  } finally {
    await stream.close();
  }
}

async function startRunningAiJob(
  server: Awaited<ReturnType<typeof startApiServer>>,
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

test.afterEach(async () => {
  const repos = Array.from(testContextRepoRoots);
  const staleRepos = await Promise.all(repos.map(async (repoRoot) => {
    return await repoRootExists(repoRoot) ? null : repoRoot;
  }));
  const repoRootsToCleanup = staleRepos.filter((repoRoot): repoRoot is string => Boolean(repoRoot));

  await Promise.all(repoRootsToCleanup.map(async (repoRoot) => {
    testContextRepoRoots.delete(repoRoot);
    await stopAiCommandJobManager(repoRoot);
    await stopOperationalStateStore(repoRoot);
    await stopDatabaseSocketServer(repoRoot).catch(() => undefined);
  }));
}, { timeout: 15000 });

test.after(async () => {
  const repos = Array.from(testContextRepoRoots);
  testContextRepoRoots.clear();
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

test("GET /api/state returns favicon and preferred port config", async () => {
  const repo = await createApiTestRepo();
  const configContents = await fs.readFile(repo.configPath, "utf8");

  try {
    await fs.writeFile(
      repo.configPath,
      configContents.replace("favicon: ''", "favicon: assets/favicon.png").replace("preferredPort: 4312", "preferredPort: 4900"),
      "utf8",
    );

    const server = await startApiServer(repo);
    const stream = await openSse(`${await server.url()}/api/state/stream`);

    try {
      const snapshot = await stream.nextEvent() as unknown as {
        type: string;
        state: { config: { favicon: string; preferredPort?: number } };
      };

      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.state.config.favicon, "assets/favicon.png");
      assert.equal(snapshot.state.config.preferredPort, 4900);
    } finally {
      await stream.close();
    }

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/state/stream emits runtime updates after the runtime starts", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo, { stateStreamFullRefreshIntervalMs: 50 });
    const stream = await openSse(`${await server.url()}/api/state/stream`);

    try {
      const snapshot = await stream.nextEvent() as unknown as { type: string; state: { worktrees: Array<{ branch: string; runtime?: { branch: string } }> } };
      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.state.worktrees.find((entry: { branch: string }) => entry.branch === "feature-ai-log")?.runtime, undefined);

      const startResponse = await server.fetch(`/api/worktrees/${encodeURIComponent("feature-ai-log")}/runtime/start`, {
        method: "POST",
      });
      assert.equal(startResponse.status, 200);

      const update = await stream.nextEvent() as unknown as { type: string; state: { worktrees: Array<{ branch: string; runtime?: { branch: string } }> } };
      assert.equal(update.type, "update");
      const runtime = update.state.worktrees.find((entry: { branch: string }) => entry.branch === "feature-ai-log")?.runtime;
      assert.ok(runtime);
      assert.equal(runtime.branch, "feature-ai-log");
    } finally {
      await stream.close();
      await server.close();
    }
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/state/stream replays persisted runtime state after a server restart", async () => {
  const repo = await createApiTestRepo();
  const featureAiLogId = worktreeId(path.join(repo.repoRoot, "feature-ai-log"));

  try {
    const firstServer = await startApiServer(repo, { stateStreamFullRefreshIntervalMs: 50 });
    const startResponse = await firstServer.fetch(`/api/worktrees/${encodeURIComponent("feature-ai-log")}/runtime/start`, {
      method: "POST",
    });
    assert.equal(startResponse.status, 200);
    await firstServer.close();

    await stopOperationalStateStore(repo.repoRoot);

    const secondServer = await startApiServer(repo, { stateStreamFullRefreshIntervalMs: 50 });
    const stream = await openSse(`${await secondServer.url()}/api/state/stream`);

    try {
      const snapshot = await stream.nextEvent() as unknown as {
        type: string;
        state: { worktrees: Array<{ branch: string; runtime?: { branch: string; tmuxSession: string } }> };
      };
      assert.equal(snapshot.type, "snapshot");
      const runtime = snapshot.state.worktrees.find((entry) => entry.branch === "feature-ai-log")?.runtime;
      assert.ok(runtime);
      assert.equal(runtime.branch, "feature-ai-log");
      assert.equal(runtime.tmuxSession, getTmuxSessionName(repo.repoRoot, featureAiLogId));
    } finally {
      await stream.close();
      await secondServer.close();
    }
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/state/stream rebuilds state on the fallback interval for out-of-band runtime changes", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo, { stateStreamFullRefreshIntervalMs: 50 });
    const stream = await openSse(`${await server.url()}/api/state/stream`);

    try {
      const snapshot = await stream.nextEvent() as unknown as {
        type: string;
        state: { worktrees: Array<{ branch: string; runtime?: { branch: string } }> };
      };
      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshot.state.worktrees.find((entry) => entry.branch === "feature-ai-log")?.runtime, undefined);

      const operationalState = await createOperationalStateStore(repo.repoRoot);
      const featureAiLogPath = path.join(repo.repoRoot, "feature-ai-log");
      const featureAiLogId = worktreeId(featureAiLogPath);
      await operationalState.setRuntime({
        id: featureAiLogId,
        branch: "feature-ai-log",
        worktreePath: featureAiLogPath,
        env: {},
        quickLinks: [],
        allocatedPorts: {},
        tmuxSession: getTmuxSessionName(repo.repoRoot, featureAiLogId),
        runtimeStartedAt: new Date().toISOString(),
      });

      const update = await stream.nextEvent() as unknown as {
        type: string;
        state: { worktrees: Array<{ branch: string; runtime?: { branch: string; tmuxSession: string } }> };
      };
      assert.equal(update.type, "update");
      const runtime = update.state.worktrees.find((entry) => entry.branch === "feature-ai-log")?.runtime;
      assert.ok(runtime);
      assert.equal(runtime.branch, "feature-ai-log");
      assert.equal(runtime.tmuxSession, getTmuxSessionName(repo.repoRoot, featureAiLogId));
    } finally {
      await stream.close();
      await server.close();
    }
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("startServer fails fast when the initial tmux session cannot be prepared", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const port = await allocateTestPort();

  await assert.rejects(
    () => startServer({
      repo,
      port,
      openBrowser: false,
      prepareInitialTerminalSession: async () => {
        throw new Error("Unable to determine tmux session for main.");
      },
    }),
    /Failed to prepare tmux session for startup worktree main: Unable to determine tmux session for main\./,
  );

  await fs.rm(repo.repoRoot, { recursive: true, force: true });
});

test("terminal tmux session resolution uses repoRoot when runtime is missing", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();

  try {
    const mainWorktreeId = worktreeId(path.join(repo.repoRoot, "main"));
    assert.equal(
      resolveTmuxSessionName({
        repoRoot: repo.repoRoot,
        id: mainWorktreeId,
        branch: "main",
        worktreePath: path.join(repo.repoRoot, "main"),
      }),
      getTmuxSessionName(repo.repoRoot, mainWorktreeId),
    );
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/state includes deletion metadata for protected worktrees", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const stream = await openSse(`${await server.url()}/api/state/stream`);

    try {
      const snapshot = await stream.nextEvent() as unknown as {
        type: string;
        state: {
          worktrees: Array<{
            branch: string;
            deletion?: {
              canDelete: boolean;
              reason: string | null;
              deleteBranchByDefault: boolean;
              isDefaultBranch: boolean;
              isDefaultWorktree: boolean;
              isSettingsWorktree: boolean;
            };
          }>;
        };
      };

      assert.equal(snapshot.type, "snapshot");

      const main = snapshot.state.worktrees.find((entry) => entry.branch === "main");
      const settings = snapshot.state.worktrees.find((entry) => entry.branch === DEFAULT_WORKTREEMAN_SETTINGS_BRANCH);
      const feature = snapshot.state.worktrees.find((entry) => entry.branch === "feature-ai-log");

      assert.ok(main?.deletion);
      assert.equal(main.deletion.canDelete, false);
      assert.equal(main.deletion.isDefaultBranch, true);
      assert.equal(main.deletion.isDefaultWorktree, true);
      assert.match(main.deletion.reason ?? "", /default branch worktree/i);

      assert.ok(settings?.deletion);
      assert.equal(settings.deletion.canDelete, false);
      assert.equal(settings.deletion.isSettingsWorktree, true);
      assert.equal(settings.deletion.deleteBranchByDefault, false);

      assert.ok(feature?.deletion);
      assert.equal(feature.deletion.canDelete, true);
      assert.equal(feature.deletion.deleteBranchByDefault, true);
    } finally {
      await stream.close();
    }

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/system returns host metrics and recent pg-boss jobs", async () => {
  const repo = await createApiTestRepo();
  const app = express();
  app.use(express.json());

  const operationalState = await createOperationalStateStore(repo.repoRoot);
  testContextRepoRoots.add(repo.repoRoot);
  app.use("/api", createApiRouter({
    repoRoot: repo.repoRoot,
    configPath: repo.configPath,
    configSourceRef: repo.configSourceRef,
    configFile: repo.configFile,
    configWorktreePath: repo.configWorktreePath,
    operationalState,
  }));

  const database = await getManagedDatabaseClient(repo.repoRoot, "jobs");

  try {
    await database.exec(`
      create schema if not exists pgboss;
      create table if not exists pgboss.job (
        id text primary key,
        name text not null,
        state text not null,
        priority integer,
        retry_limit integer,
        retry_count integer,
        retry_delay integer,
        retry_delay_max integer,
        retry_backoff boolean,
        expire_seconds integer,
        deletion_seconds integer,
        policy text,
        singleton_key text,
        singleton_on text,
        dead_letter text,
        start_after text,
        created_on text not null,
        started_on text,
        completed_on text,
        keep_until text,
        heartbeat_on text,
        heartbeat_seconds integer,
        data text,
        output text
      );
    `);

    await database.query(
      `
        insert into pgboss.job (
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
        ) values (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
          $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24
        )
      `,
      [
        "job-system-active",
        "project-management-ai-update",
        "active",
        3,
        1,
        0,
        30,
        120,
        true,
        600,
        3600,
        "standard",
        null,
        null,
        null,
        "2026-03-31T11:59:00.000Z",
        "2026-03-31T11:59:00.000Z",
        "2026-03-31T11:59:10.000Z",
        null,
        "2026-04-01T11:59:00.000Z",
        "2026-03-31T11:59:30.000Z",
        30,
        JSON.stringify({
          branch: "feature/system-tab",
          documentId: "doc-12",
          commandId: "smart",
          worktreePath: "/repo/.worktrees/feature-system-tab",
          renderedCommand: "runner --prompt \"Add the System tab\"",
          input: "Add the System tab and summarize queue activity.",
          autoCommitDirtyWorktree: true,
          origin: {
            kind: "project-management-document-run",
            label: "Project document #12",
          },
        }),
        JSON.stringify({ ok: true }),
      ],
    );

    const response = await request(app).get("/api/system");
    assert.equal(response.status, 200);

    const payload = response.body as SystemStatusResponse;
    assert.equal(typeof payload.capturedAt, "string");
    assert.equal(payload.performance.worktrees.total >= 2, true);
    assert.equal(payload.performance.worktrees.runtimeCount, 0);
    assert.equal(payload.jobs.available, true);
    assert.equal(payload.jobs.total, 1);
    assert.equal(payload.jobs.countsByState.active, 1);
    assert.equal(payload.jobs.items[0]?.id, "job-system-active");
    assert.equal(payload.jobs.items[0]?.queue, "project-management-ai-update");
    assert.equal(payload.jobs.items[0]?.state, "active");
    assert.equal(payload.jobs.items[0]?.hasOutput, true);
    assert.equal(payload.jobs.items[0]?.payloadSummary.branch, "feature/system-tab");
    assert.equal(payload.jobs.items[0]?.payloadSummary.documentId, "doc-12");
    assert.equal(payload.jobs.items[0]?.payloadSummary.commandId, "smart");
    assert.equal(payload.jobs.items[0]?.payloadSummary.originLabel, "Project document #12");
  } finally {
    await closeManagedDatabaseClient(repo.repoRoot, "jobs").catch(() => undefined);
    await stopOperationalStateStore(repo.repoRoot).catch(() => undefined);
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch rejects deleting the default branch worktree", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const response = await server.fetch("/api/worktrees/main", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      message: "The default branch worktree cannot be deleted from the UI.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch rejects deleting the settings worktree", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const response = await server.fetch(`/api/worktrees/${DEFAULT_WORKTREEMAN_SETTINGS_BRANCH}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      message: "The settings worktree is managed by worktreeman and cannot be deleted from the UI.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch requires typing the worktree name when local changes exist", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const stream = await openSse(`${await server.url()}/api/state/stream`);
    const snapshot = await stream.nextEvent() as unknown as {
      type: string;
      state: {
        worktrees: Array<{ branch: string; worktreePath: string }>;
      };
    };
    await stream.close();

    const featureWorktree = snapshot.state.worktrees.find((entry) => entry.branch === "feature-ai-log");

    assert.ok(featureWorktree);
    await fs.writeFile(path.join(featureWorktree.worktreePath, "dirty.txt"), "local change\n", "utf8");

    const rejectedResponse = await server.fetch("/api/worktrees/feature-ai-log", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deleteBranch: false }),
    });

    assert.equal(rejectedResponse.status, 400);
    assert.deepEqual(await rejectedResponse.json(), {
      message: "Type feature-ai-log to confirm deleting this worktree.",
    });

    const confirmedResponse = await server.fetch("/api/worktrees/feature-ai-log", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        deleteBranch: false,
        confirmWorktreeName: "feature-ai-log",
      }),
    });

    assert.equal(confirmedResponse.status, 204);
    await waitForPathToDisappear(featureWorktree.worktreePath);

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch rejects deleting a worktree with a running AI job", async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();

  try {
    const server = await startApiServer(repo, {
      aiProcesses: fakeAiProcesses.aiProcesses,
      aiProcessPollIntervalMs: 10,
    });

    await startRunningAiJob(server, fakeAiProcesses, "feature-ai-log");

    const response = await server.fetch("/api/worktrees/feature-ai-log", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      message: "Cancel the running AI job on feature-ai-log before deleting this worktree.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch deletes the branch by default", async () => {
  const repo = await createApiTestRepo();

  try {
    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const worktree = await createWorktree(repo.repoRoot, config, { branch: "feature-delete-default" });
    const server = await startApiServer(repo);

    const response = await server.fetch("/api/worktrees/feature-delete-default", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 204);
    await waitForPathToDisappear(worktree.worktreePath);

    const branchList = await runCommand("git", ["branch", "--list", "feature-delete-default"], {
      cwd: repo.repoRoot,
    });
    assert.equal(branchList.stdout.trim(), "");

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("DELETE /api/worktrees/:branch removes leftover files when git worktree remove leaves the directory behind", async () => {
  const repo = await createApiTestRepo();

  try {
    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const worktree = await createWorktree(repo.repoRoot, config, { branch: "feature-delete-leftovers" });
    await fs.mkdir(path.join(worktree.worktreePath, ".nested-cache"), { recursive: true });
    await fs.writeFile(path.join(worktree.worktreePath, ".nested-cache", "keepalive.sock"), "busy\n", "utf8");

    const server = await startApiServer(repo);

    const response = await server.fetch("/api/worktrees/feature-delete-leftovers", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmWorktreeName: "feature-delete-leftovers",
      }),
    });

    assert.equal(response.status, 204);
    await waitForPathToDisappear(worktree.worktreePath);

    const branchList = await runCommand("git", ["branch", "--list", "feature-delete-leftovers"], {
      cwd: repo.repoRoot,
    });
    assert.equal(branchList.stdout.trim(), "");

    const worktreeList = await runCommand("git", ["worktree", "list", "--porcelain"], {
      cwd: repo.repoRoot,
    });
    assert.doesNotMatch(worktreeList.stdout, /feature-delete-leftovers/);

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/git/compare ignores broken worktree directories left in git metadata", async () => {
  const repo = await createApiTestRepo();

  try {
    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const brokenWorktree = await createWorktree(repo.repoRoot, config, { branch: "feature-broken-compare" });
    await fs.rm(brokenWorktree.worktreePath, { recursive: true, force: true });

    const server = await startApiServer(repo);
    const response = await server.fetch("/api/git/compare?compareBranch=feature-ai-log&baseBranch=main");

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      compareBranch: string;
      workingTreeSummary: { dirty: boolean; conflicted: boolean; changedFiles: number };
      workingTreeDiff: string;
      branches: Array<{ name: string }>;
    };

    assert.equal(payload.compareBranch, "feature-ai-log");
    assert.equal(payload.workingTreeSummary.dirty, false);
    assert.equal(payload.workingTreeSummary.conflicted, false);
    assert.equal(payload.workingTreeSummary.changedFiles, 0);
    assert.equal(payload.workingTreeDiff, "");

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/worktrees persists an optional linked project-management document", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string; number: number }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const createResponse = await server.fetch(`/api/worktrees`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch: "feature-linked-doc",
        documentId: outline.id,
      }),
    });
    assert.equal(createResponse.status, 201);

    const statePayload = await readStateSnapshot<{
      worktrees: Array<{
        branch: string;
        linkedDocument?: {
          id: string;
          number: number;
          title: string;
          archived: boolean;
        } | null;
      }>;
    }>(server);
    const linkedWorktree = statePayload.worktrees.find((entry) => entry.branch === "feature-linked-doc");
    assert.ok(linkedWorktree);
    assert.equal(linkedWorktree.linkedDocument?.id, outline.id);
    assert.equal(linkedWorktree.linkedDocument?.number, outline.number);
    assert.equal(linkedWorktree.linkedDocument?.title, outline.title);
    assert.equal(linkedWorktree.linkedDocument?.archived, false);

    const storedLink = await getWorktreeDocumentLink(repo.repoRoot, worktreeId(path.join(repo.repoRoot, "feature-linked-doc")));
    assert.ok(storedLink);
    assert.equal(storedLink.documentId, outline.id);
    assert.match(storedLink.worktreePath, /feature-linked-doc$/);

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

async function waitFor(condition: () => Promise<boolean>, timeoutMs = 5000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (await condition()) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Condition not met within ${timeoutMs}ms.`);
}

async function waitForPathToDisappear(targetPath: string, timeoutMs = 5000) {
  await waitFor(async () => {
    try {
      await fs.access(targetPath);
      return false;
    } catch {
      return true;
    }
  }, timeoutMs);
}

async function removePathWithRetry(targetPath: string, timeoutMs = 5000) {
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

async function allocateTestPort(): Promise<number> {
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

test("AI command runs persist durable log entries without config-worktree file logs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 4123, stdout: "rewrite the document", stderr: "" },
    { status: "stopped", pid: 4123, stdout: "rewrite the document", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const response = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "rewrite the document" }),
    });

    assert.equal(response.status, 200);

    const payload = await response.json() as { job: { branch: string; status: string } };
    assert.equal(payload.job.branch, "feature-ai-log");
    assert.equal(payload.job.status, "running");

    await waitFor(async () => {
      try {
        const store = await createOperationalStateStore(repo.repoRoot);
        const entries = await store.listAiCommandLogEntries();
        return entries.length > 0;
      } catch {
        return false;
      }
    });

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ jobId: string; fileName: string; branch: string }>;
    };
    assert.equal(logsPayload.logs.length > 0, true);

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(logsPayload.logs[0].jobId)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        branch: string;
        pid: number | null;
        processName: string | null;
        request: string;
        completedAt?: string;
        response: { stdout: string; stderr: string };
      };
    };

    assert.equal(detailPayload.log.branch, "feature-ai-log");
    assert.equal(detailPayload.log.pid, 4123);
    assert.equal(typeof detailPayload.log.processName, "string");
    assert.equal(detailPayload.log.request.includes("Environment wrapper:"), true);
    assert.equal(detailPayload.log.request.includes("Operator request:\nrewrite the document"), true);
    assert.equal(typeof detailPayload.log.completedAt, "string");
    assert.equal(detailPayload.log.response.stdout, "rewrite the document");
    await assert.rejects(fs.access(path.join(repo.configWorktreePath, ".logs")));
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI run auto-commits leftover dirty files when it completes", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-auto-commit" });
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 5111, stdout: "working\n", stderr: "" },
    { status: "stopped", pid: 5111, stdout: "working\ndone\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    await runCommand("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: feature.worktreePath });
    await fs.writeFile(path.join(feature.worktreePath, "leftover.txt"), "left behind\n", "utf8");

    const response = await server.fetch(`/api/worktrees/feature-ai-auto-commit/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "finish the task" }),
    });

    assert.equal(response.status, 200);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.some((entry) => entry.branch === "feature-ai-auto-commit" && entry.status === "completed");
    });

    const latestSubject = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: feature.worktreePath });
    assert.equal(latestSubject.stdout.trim(), "commit me");

    const status = await runCommand("git", ["status", "--short"], { cwd: feature.worktreePath });
    assert.equal(status.stdout.trim(), "");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI run does not create an extra commit when the worktree stays clean", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-auto-commit-clean" });
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 5222, stdout: "working\n", stderr: "" },
    { status: "stopped", pid: 5222, stdout: "working\ndone\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    await runCommand("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: feature.worktreePath });
    const beforeHead = await runCommand("git", ["rev-parse", "HEAD"], { cwd: feature.worktreePath });

    const response = await server.fetch(`/api/worktrees/feature-ai-auto-commit-clean/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "finish the clean task" }),
    });

    assert.equal(response.status, 200);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.some((entry) => entry.branch === "feature-ai-auto-commit-clean" && entry.status === "completed");
    });

    const afterHead = await runCommand("git", ["rev-parse", "HEAD"], { cwd: feature.worktreePath });
    assert.equal(afterHead.stdout.trim(), beforeHead.stdout.trim());

    const status = await runCommand("git", ["status", "--short"], { cwd: feature.worktreePath });
    assert.equal(status.stdout.trim(), "");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI auto-commits dirty files after a successful run", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 4124, stdout: "implemented\n", stderr: "" },
    { status: "stopped", pid: 4124, stdout: "implemented\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
    await runCommand("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: worktreePath });
    await fs.writeFile(path.join(worktreePath, "auto-commit.txt"), "created by ai run\n", "utf8");

    const response = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "finish this task" }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { jobId: string; branch: string; fileName: string; status: string };
    };
    assert.equal(payload.job.branch, "feature-ai-log");
    assert.equal(payload.job.status, "running");

    const completedJob = await waitForAiCommandJob(repo.repoRoot, worktreeId(worktreePath), payload.job.jobId);
    assert.equal(completedJob.status, "completed");

    const { stdout: subject } = await runCommand("git", ["log", "-1", "--pretty=%s", "feature-ai-log"], { cwd: repo.repoRoot });
    assert.equal(subject.trim(), "commit me");

    const { stdout: status } = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
    assert.equal(status.trim(), "");
  } finally {
    await server.close();
    await removePathWithRetry(repo.repoRoot);
  }
});

test("worktree AI skips auto-commit when the worktree stays clean", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 4125, stdout: "no file edits\n", stderr: "" },
    { status: "stopped", pid: 4125, stdout: "no file edits\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
    await runCommand("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: worktreePath });
    const { stdout: beforeHead } = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });

    const response = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "inspect but change nothing" }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { jobId: string; fileName: string; status: string };
    };
    assert.equal(payload.job.status, "running");

    const completedJob = await waitForAiCommandJob(repo.repoRoot, worktreeId(worktreePath), payload.job.jobId);
    assert.equal(completedJob.status, "completed");

    const { stdout: afterHead } = await runCommand("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    assert.equal(afterHead.trim(), beforeHead.trim());

    const { stdout: status } = await runCommand("git", ["status", "--short"], { cwd: worktreePath });
    assert.equal(status.trim(), "");
  } finally {
    await server.close();
    await removePathWithRetry(repo.repoRoot);
  }
});

test("AI command settings save writes both schema hints and aiCommands", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const response = await server.fetch(`/api/settings/ai-command`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiCommands: {
          smart: "opencode run $WTM_AI_INPUT --mode smart",
          simple: "opencode run $WTM_AI_INPUT --mode simple",
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      aiCommands: { smart: string; simple: string };
      filePath: string;
    };
    assert.equal(payload.aiCommands.smart, "opencode run $WTM_AI_INPUT --mode smart");
    assert.equal(payload.aiCommands.simple, "opencode run $WTM_AI_INPUT --mode simple");

    const savedContents = await fs.readFile(repo.configPath, "utf8");
    assert.match(savedContents, /^# yaml-language-server: \$schema=/);
    assert.match(savedContents, /^\$schema: https:\/\//m);
    assert.match(savedContents, /aiCommands:\n  smart: opencode run \$WTM_AI_INPUT --mode smart\n  simple: opencode run \$WTM_AI_INPUT --mode simple/);
  } finally {
    await server.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge merges a feature branch into main", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    const createDocumentResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Merge tracking doc",
        markdown: "# Merge tracking\n",
        tags: ["merge"],
      }),
    });
    assert.equal(createDocumentResponse.status, 201);
    const createDocumentPayload = await createDocumentResponse.json() as { document: { id: string } };
    await setWorktreeDocumentLink(repo.repoRoot, {
      worktreeId: feature.id,
      branch: feature.branch,
      worktreePath: feature.worktreePath,
      documentId: createDocumentPayload.document.id,
    });

    await fs.writeFile(path.join(feature.worktreePath, "merge.txt"), "hello merge\n", "utf8");
    await runCommand("git", ["add", "merge.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "add merge file"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const response = await server.fetch(`/api/git/compare/feature-merge/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { baseBranch: string; compareBranch: string; behind: number };
    assert.equal(payload.baseBranch, "main");
    assert.equal(payload.compareBranch, "feature-merge");
    assert.equal(payload.behind, 0);

    await fs.access(path.join(mainPath, "merge.txt"));
    const { stdout } = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: mainPath });
    assert.match(stdout.trim(), /Merge branch 'feature-merge'|add merge file/);

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, createDocumentPayload.document.id);
    const latestComment = updatedDocument.document.comments.at(-1);
    assert.ok(latestComment);
    assert.match(latestComment.body, /## Worktree merged/);
    assert.match(latestComment.body, /Merged `feature-merge` into `main`\./);
    assert.match(latestComment.body, /### Merged commits \(1\)/);
    assert.match(latestComment.body, /- `.+` add merge file — test \(\d{4}-\d{2}-\d{2}\)/);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge can merge the selected base branch into a worktree branch", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-merge-target" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(mainPath, "base-only.txt"), "from main\n", "utf8");
    await runCommand("git", ["add", "base-only.txt"], { cwd: mainPath });
    await runCommand("git", ["commit", "-m", "add base branch file"], {
      cwd: mainPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const response = await server.fetch(`/api/git/compare/main/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "feature-merge-target" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      baseBranch: string;
      compareBranch: string;
      mergeIntoCompareStatus: { canMerge: boolean; hasConflicts: boolean };
    };
    assert.equal(payload.baseBranch, "feature-merge-target");
    assert.equal(payload.compareBranch, "main");
    assert.equal(payload.mergeIntoCompareStatus.canMerge, true);
    assert.equal(payload.mergeIntoCompareStatus.hasConflicts, false);

    const mergedFile = await fs.readFile(path.join(feature.worktreePath, "base-only.txt"), "utf8");
    assert.equal(mergedFile, "from main\n");
    const { stdout } = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: feature.worktreePath });
    assert.match(stdout.trim(), /Merge branch 'main'|add base branch file/);

    const comparisonResponse = await server.fetch(`/api/git/compare?compareBranch=feature-merge-target&baseBranch=main`);
    assert.equal(comparisonResponse.status, 200);
    const comparisonPayload = await comparisonResponse.json() as {
      mergeIntoCompareStatus: { canMerge: boolean; hasConflicts: boolean };
      behind: number;
    };
    assert.equal(comparisonPayload.behind, 0);
    assert.equal(comparisonPayload.mergeIntoCompareStatus.canMerge, true);
    assert.equal(comparisonPayload.mergeIntoCompareStatus.hasConflicts, false);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge rejects when the compare worktree branch has a running AI job", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  await createWorktree(repo.repoRoot, config, { branch: "feature-merge-ai-lock" });

  try {
    const server = await startApiServer(repo, {
      aiProcesses: fakeAiProcesses.aiProcesses,
      aiProcessPollIntervalMs: 10,
    });

    await startRunningAiJob(server, fakeAiProcesses, "feature-merge-ai-lock");

    const response = await server.fetch(`/api/git/compare/feature-merge-ai-lock/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      message: "Cancel the running AI job on feature-merge-ai-lock before merging these branches.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge rejects when the target worktree branch has a running AI job", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  await createWorktree(repo.repoRoot, config, { branch: "feature-merge-target-ai-lock" });

  try {
    const server = await startApiServer(repo, {
      aiProcesses: fakeAiProcesses.aiProcesses,
      aiProcessPollIntervalMs: 10,
    });

    await startRunningAiJob(server, fakeAiProcesses, "feature-merge-target-ai-lock");

    const response = await server.fetch(`/api/git/compare/main/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "feature-merge-target-ai-lock" }),
    });

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      message: "Cancel the running AI job on feature-merge-target-ai-lock before merging these branches.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare reports mergeable branches even when the feature branch is behind", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-behind-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "feature.txt"), "feature change\n", "utf8");
    await runCommand("git", ["add", "feature.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "feature change"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await fs.writeFile(path.join(mainPath, "main.txt"), "main change\n", "utf8");
    await runCommand("git", ["add", "main.txt"], { cwd: mainPath });
    await runCommand("git", ["commit", "-m", "main change"], {
      cwd: mainPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const response = await server.fetch(`/api/git/compare?compareBranch=feature-behind-merge&baseBranch=main`);

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      ahead: number;
      behind: number;
      mergeStatus: { canMerge: boolean; hasConflicts: boolean; reason: string | null };
      mergeIntoCompareStatus: { canMerge: boolean; hasConflicts: boolean; reason: string | null };
    };
    assert.equal(payload.ahead, 1);
    assert.equal(payload.behind, 1);
    assert.equal(payload.mergeStatus.canMerge, true);
    assert.equal(payload.mergeStatus.hasConflicts, false);
    assert.equal(payload.mergeStatus.reason, null);
    assert.equal(payload.mergeIntoCompareStatus.canMerge, true);
    assert.equal(payload.mergeIntoCompareStatus.hasConflicts, false);
    assert.equal(payload.mergeIntoCompareStatus.reason, null);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare reports why merge is disabled when branches conflict", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-conflict-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "shared.txt"), "feature version\n", "utf8");
    await runCommand("git", ["add", "shared.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "feature shared"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await fs.writeFile(path.join(mainPath, "shared.txt"), "main version\n", "utf8");
    await runCommand("git", ["add", "shared.txt"], { cwd: mainPath });
    await runCommand("git", ["commit", "-m", "main shared"], {
      cwd: mainPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const compareResponse = await server.fetch(`/api/git/compare?compareBranch=feature-conflict-merge&baseBranch=main`);

    assert.equal(compareResponse.status, 200);
    const comparePayload = await compareResponse.json() as {
      mergeStatus: { canMerge: boolean; hasConflicts: boolean; reason: string | null; conflicts: Array<{ path: string; preview: string | null }> };
      mergeIntoCompareStatus: { canMerge: boolean; hasConflicts: boolean; reason: string | null; conflicts: Array<{ path: string; preview: string | null }> };
      workingTreeSummary: { conflicted: boolean; conflictedFiles: number };
      workingTreeConflicts: Array<{ path: string; preview: string | null }>;
    };
    assert.equal(comparePayload.mergeStatus.canMerge, false);
    assert.equal(comparePayload.mergeStatus.hasConflicts, true);
    assert.match(comparePayload.mergeStatus.reason ?? "", /resolve conflicts/i);
    assert.equal(comparePayload.mergeStatus.conflicts.length, 1);
    assert.equal(comparePayload.mergeStatus.conflicts[0]?.path, "shared.txt");
    assert.match(comparePayload.mergeStatus.conflicts[0]?.preview ?? "", /<<<<<<< main/);
    assert.equal(comparePayload.mergeIntoCompareStatus.canMerge, false);
    assert.equal(comparePayload.mergeIntoCompareStatus.hasConflicts, true);
    assert.match(comparePayload.mergeIntoCompareStatus.reason ?? "", /resolve conflicts/i);
    assert.equal(comparePayload.mergeIntoCompareStatus.conflicts.length, 1);
    assert.equal(comparePayload.mergeIntoCompareStatus.conflicts[0]?.path, "shared.txt");
    assert.equal(comparePayload.workingTreeSummary.conflicted, false);
    assert.equal(comparePayload.workingTreeSummary.conflictedFiles, 0);
    assert.equal(comparePayload.workingTreeConflicts.length, 0);

    const mergeResponse = await server.fetch(`/api/git/compare/feature-conflict-merge/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(mergeResponse.status, 500);
    const mergePayload = await mergeResponse.text();
    assert.match(mergePayload, /resolve conflicts/i);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare resolve-conflicts uses AI output to rewrite conflict files", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-resolve-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    const currentContents = await readConfigContents({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const nextContents = updateAiCommandInConfigContents(currentContents, {
      smart: "node -e \"console.log('resolved by ai')\" $WTM_AI_INPUT",
      simple: "node -e \"console.log('resolved by ai')\" $WTM_AI_INPUT",
      autoStartRuntime: false,
    });
    await fs.writeFile(repo.configPath, nextContents, "utf8");

    await fs.writeFile(path.join(feature.worktreePath, "shared.txt"), "feature version\n", "utf8");
    await runCommand("git", ["add", "shared.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "feature shared"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await fs.writeFile(path.join(mainPath, "shared.txt"), "main version\n", "utf8");
    await runCommand("git", ["add", "shared.txt"], { cwd: mainPath });
    await runCommand("git", ["commit", "-m", "main shared"], {
      cwd: mainPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await runCommand("git", ["merge", "main", "--allow-unrelated-histories"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
      allowExitCodes: [1],
    });

    const conflictedCompareResponse = await server.fetch(`/api/git/compare?compareBranch=feature-ai-resolve-merge&baseBranch=main`);
    assert.equal(conflictedCompareResponse.status, 200);
    const conflictedComparePayload = await conflictedCompareResponse.json() as {
      workingTreeSummary: { conflicted: boolean; conflictedFiles: number };
      workingTreeConflicts: Array<{ path: string; preview: string | null }>;
    };
    assert.equal(conflictedComparePayload.workingTreeSummary.conflicted, true);
    assert.equal(conflictedComparePayload.workingTreeSummary.conflictedFiles, 1);
    assert.equal(conflictedComparePayload.workingTreeConflicts.length, 1);
    assert.equal(conflictedComparePayload.workingTreeConflicts[0]?.path, "shared.txt");
    assert.match(conflictedComparePayload.workingTreeConflicts[0]?.preview ?? "", /<<<<<<< HEAD|<<<<<<< /);

    const response = await server.fetch(`/api/git/compare/feature-ai-resolve-merge/resolve-conflicts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main", commandId: "smart" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      mergeIntoCompareStatus: { hasConflicts: boolean; conflicts: Array<unknown> };
      workingTreeSummary: { dirty: boolean; conflicted: boolean; conflictedFiles: number };
      workingTreeConflicts: Array<unknown>;
    };
    assert.equal(payload.mergeIntoCompareStatus.hasConflicts, false);
    assert.equal(payload.mergeIntoCompareStatus.conflicts.length, 0);
    assert.equal(payload.workingTreeSummary.dirty, true);
    assert.equal(payload.workingTreeSummary.conflicted, false);
    assert.equal(payload.workingTreeSummary.conflictedFiles, 0);
    assert.equal(payload.workingTreeConflicts.length, 0);

    const resolved = await fs.readFile(path.join(feature.worktreePath, "shared.txt"), "utf8");
    assert.equal(resolved, "resolved by ai\n");

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{
        jobId: string;
        fileName: string;
        branch: string;
        status: string;
        requestPreview: string;
        origin?: AiCommandOrigin | null;
      }>;
      runningJobs: Array<unknown>;
    };
    assert.equal(logsPayload.runningJobs.length, 0);
    const conflictLog = logsPayload.logs.find((entry) => entry.branch === "feature-ai-resolve-merge");
    assert.ok(conflictLog);
    assert.equal(conflictLog.status, "completed");
    assert.equal(conflictLog.requestPreview.includes("Resolve merge conflicts while merging main into branch feature-ai-resolve-merge."), true);
    assert.equal(conflictLog.origin?.kind, "git-conflict-resolution");
    assert.equal(conflictLog.origin?.label, "Git conflict resolution");
    assert.equal(conflictLog.origin?.location.tab, "git");
    assert.equal(conflictLog.origin?.location.branch, "feature-ai-resolve-merge");
    assert.equal(conflictLog.origin?.location.gitBaseBranch, "main");

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(conflictLog.jobId)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        branch: string;
        origin?: AiCommandOrigin | null;
        request: string;
        response: { stdout: string; stderr: string };
      };
    };
    assert.equal(detailPayload.log.branch, "feature-ai-resolve-merge");
    assert.equal(detailPayload.log.request.includes("Resolve merge conflicts while merging main into branch feature-ai-resolve-merge."), true);
    assert.equal(detailPayload.log.response.stdout, "resolved by ai\n");
    assert.equal(detailPayload.log.origin?.kind, "git-conflict-resolution");
    assert.equal(detailPayload.log.origin?.location.tab, "git");
    assert.equal(detailPayload.log.origin?.location.branch, "feature-ai-resolve-merge");
    assert.equal(detailPayload.log.origin?.location.gitBaseBranch, "main");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge rejects when the base branch has local changes", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-dirty-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "merge.txt"), "merge me\n", "utf8");
    await runCommand("git", ["add", "merge.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "add merge source"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await fs.writeFile(path.join(mainPath, "dirty.txt"), "dirty\n", "utf8");

    const response = await server.fetch(`/api/git/compare/feature-dirty-merge/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 500);
    const payload = await response.text();
    assert.match(payload, /commit or stash local changes on main before merging\./i);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare merge allows worktree-into-base when the compare branch has local changes", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-dirty-compare-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "mergeable.txt"), "committed change\n", "utf8");
    await runCommand("git", ["add", "mergeable.txt"], { cwd: feature.worktreePath });
    await runCommand("git", ["commit", "-m", "add mergeable change"], {
      cwd: feature.worktreePath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    await fs.writeFile(path.join(feature.worktreePath, "dirty.txt"), "uncommitted change\n", "utf8");

    const comparisonResponse = await server.fetch(`/api/git/compare?compareBranch=feature-dirty-compare-merge&baseBranch=main`);
    assert.equal(comparisonResponse.status, 200);
    const comparisonPayload = await comparisonResponse.json() as {
      mergeStatus: { canMerge: boolean; reason: string | null };
      mergeIntoCompareStatus: { canMerge: boolean; reason: string | null };
      workingTreeSummary: { dirty: boolean };
    };
    assert.equal(comparisonPayload.workingTreeSummary.dirty, true);
    assert.equal(comparisonPayload.mergeStatus.canMerge, true);
    assert.equal(comparisonPayload.mergeStatus.reason, null);
    assert.equal(comparisonPayload.mergeIntoCompareStatus.canMerge, false);
    assert.match(comparisonPayload.mergeIntoCompareStatus.reason ?? "", /commit or stash local changes on feature-dirty-compare-merge before merging\./i);

    const response = await server.fetch(`/api/git/compare/feature-dirty-compare-merge/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 200);
    await fs.access(path.join(mainPath, "mergeable.txt"));
    await assert.rejects(() => fs.access(path.join(mainPath, "dirty.txt")));
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare commit creates a commit using the simple AI command by default", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-commit" });
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "commit.txt"), "commit me\n", "utf8");

    const response = await server.fetch(`/api/git/compare/feature-ai-commit/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      branch: string;
      commandId: string;
      message: string;
      commitSha: string;
      comparison: { compareBranch: string; workingTreeSummary: { dirty: boolean } };
    };
    assert.equal(payload.branch, "feature-ai-commit");
    assert.equal(payload.commandId, "simple");
    assert.equal(payload.message, "commit me");
    assert.ok(payload.commitSha.length > 0);
    assert.equal(payload.comparison.compareBranch, "feature-ai-commit");
    assert.equal(payload.comparison.workingTreeSummary.dirty, false);

    const { stdout } = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: feature.worktreePath });
    assert.equal(stdout.trim(), "commit me");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare commit-message previews a simple AI message without committing", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-preview" });
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "preview.txt"), "preview me\n", "utf8");

    const response = await server.fetch(`/api/git/compare/feature-ai-preview/commit-message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      branch: string;
      commandId: string;
      message: string;
    };
    assert.equal(payload.branch, "feature-ai-preview");
    assert.equal(payload.commandId, "simple");
    assert.equal(payload.message, "commit me");

    const { stdout } = await runCommand("git", ["status", "--short"], { cwd: feature.worktreePath });
    assert.match(stdout, /preview.txt/);
    await assert.rejects(
      () => runCommand("git", ["rev-parse", "--verify", "HEAD"], { cwd: feature.worktreePath }),
      /code 128/i,
    );
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare commit accepts an edited message", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-edit" });
  const server = await startApiServer(repo);

  try {
    await fs.writeFile(path.join(feature.worktreePath, "edited.txt"), "edited\n", "utf8");

    const response = await server.fetch(`/api/git/compare/feature-ai-edit/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main", message: "edited commit message" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as { message: string };
    assert.equal(payload.message, "edited commit message");

    const { stdout } = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: feature.worktreePath });
    assert.equal(stdout.trim(), "edited commit message");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("config document save commits the edited config file", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const nextContents = [
      "# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json",
      "",
      "$schema: https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json",
      "env:",
      "  NODE_ENV: development",
      "worktrees:",
      "  baseDir: .",
      "aiCommands:",
      "  smart: printf %s $WTM_AI_INPUT",
      "  simple: printf %s $WTM_AI_INPUT",
      "runtimePorts:",
      "  - PORT",
      "",
    ].join("\n");

    const response = await server.fetch(`/api/config/document`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: nextContents }),
    });

    assert.equal(response.status, 200);

    const logMessage = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: repo.configWorktreePath });
    assert.equal(logMessage.stdout.trim(), "config: update worktree config");

    const status = await runCommand("git", ["status", "--short", "--", repo.configFile], { cwd: repo.configWorktreePath });
    assert.equal(status.stdout.trim(), "");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI command settings save commits the config file", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const response = await server.fetch(`/api/settings/ai-command`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        aiCommands: {
          smart: "opencode run $WTM_AI_INPUT --mode smart",
          simple: "opencode run $WTM_AI_INPUT --mode simple",
        },
      }),
    });

    assert.equal(response.status, 200);

    const logMessage = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: repo.configWorktreePath });
    assert.equal(logMessage.stdout.trim(), "config: update ai commands");

    const status = await runCommand("git", ["status", "--short", "--", repo.configFile], { cwd: repo.configWorktreePath });
    assert.equal(status.stdout.trim(), "");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project management users lists discovered git authors", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const defaultBranchResult = await runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo.repoRoot });
    const defaultWorktreePath = await findWorktreePathForRef(repo.repoRoot, defaultBranchResult.stdout.trim());
    assert.ok(defaultWorktreePath);

    await fs.writeFile(path.join(defaultWorktreePath, "alex.txt"), "alex\n", "utf8");
    await runCommand("git", ["add", "alex.txt"], { cwd: defaultWorktreePath });
    await runCommand(
      "git",
      ["-c", "user.name=Alex Example", "-c", "user.email=alex@example.com", "commit", "-m", "Add Alex commit"],
      { cwd: defaultWorktreePath },
    );

    await fs.writeFile(path.join(defaultWorktreePath, "bailey.txt"), "bailey\n", "utf8");
    await runCommand("git", ["add", "bailey.txt"], { cwd: defaultWorktreePath });
    await runCommand(
      "git",
      ["-c", "user.name=Bailey Example", "-c", "user.email=bailey@example.com", "commit", "-m", "Add Bailey commit"],
      { cwd: defaultWorktreePath },
    );

    const response = await server.fetch("/api/project-management/users");
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      branch: string;
      config: {
        customUsers: Array<{ name: string; email: string }>;
        archivedUserIds: string[];
      };
      users: Array<{
        id: string;
        name: string;
        email: string;
        source: string;
        archived: boolean;
        avatarUrl: string;
        commitCount: number;
        lastCommitAt: string | null;
      }>;
    };

    assert.ok(payload.branch);
    assert.deepEqual(payload.config, {
      customUsers: [],
      archivedUserIds: [],
    });

    const alex = payload.users.find((entry) => entry.email === "alex@example.com");
    const bailey = payload.users.find((entry) => entry.email === "bailey@example.com");

    assert.ok(alex);
    assert.ok(bailey);
    assert.equal(alex?.name, "Alex Example");
    assert.equal(bailey?.name, "Bailey Example");
    assert.equal(alex?.source, "git");
    assert.equal(bailey?.source, "git");
    assert.equal(alex?.archived, false);
    assert.equal(bailey?.archived, false);
    assert.equal(alex?.commitCount, 1);
    assert.equal(bailey?.commitCount, 1);
    assert.match(alex?.avatarUrl ?? "", /^https:\/\/www\.gravatar\.com\/avatar\//);
    assert.match(bailey?.avatarUrl ?? "", /^https:\/\/www\.gravatar\.com\/avatar\//);
    assert.ok(alex?.lastCommitAt);
    assert.ok(bailey?.lastCommitAt);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project management users save commits the config overlay", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const defaultBranchResult = await runCommand("git", ["symbolic-ref", "--short", "HEAD"], { cwd: repo.repoRoot });
    const defaultWorktreePath = await findWorktreePathForRef(repo.repoRoot, defaultBranchResult.stdout.trim());
    assert.ok(defaultWorktreePath);

    await fs.writeFile(path.join(defaultWorktreePath, "casey.txt"), "casey\n", "utf8");
    await runCommand("git", ["add", "casey.txt"], { cwd: defaultWorktreePath });
    await runCommand(
      "git",
      ["-c", "user.name=Casey Example", "-c", "user.email=casey@example.com", "commit", "-m", "Add Casey commit"],
      { cwd: defaultWorktreePath },
    );

    const caseyId = createHash("sha1").update("casey@example.com").digest("hex");
    const response = await server.fetch("/api/project-management/users", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        config: {
          customUsers: [{ name: "Jordan Example", email: "JORDAN@example.com" }],
          archivedUserIds: [caseyId, caseyId],
        },
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      config: {
        customUsers: Array<{ name: string; email: string }>;
        archivedUserIds: string[];
      };
      users: Array<{
        id: string;
        name: string;
        email: string;
        source: string;
        archived: boolean;
        commitCount: number;
      }>;
    };

    assert.deepEqual(payload.config, {
      customUsers: [{ name: "Jordan Example", email: "jordan@example.com" }],
      archivedUserIds: [caseyId],
    });

    const casey = payload.users.find((entry) => entry.email === "casey@example.com");
    const jordan = payload.users.find((entry) => entry.email === "jordan@example.com");
    assert.ok(casey);
    assert.ok(jordan);
    assert.equal(casey?.archived, true);
    assert.equal(casey?.source, "git");
    assert.equal(jordan?.source, "config");
    assert.equal(jordan?.archived, false);
    assert.equal(jordan?.commitCount, 0);

    const logMessage = await runCommand("git", ["log", "-1", "--format=%s"], { cwd: repo.configWorktreePath });
    assert.equal(logMessage.stdout.trim(), "config: update project management users");

    const status = await runCommand("git", ["status", "--short", "--", repo.configFile], { cwd: repo.configWorktreePath });
    assert.equal(status.stdout.trim(), "");

    const contents = await fs.readFile(repo.configPath, "utf8");
    assert.match(contents, /projectManagement:/);
    assert.match(contents, /users:/);
    assert.match(contents, /name: Jordan Example/);
    assert.match(contents, /email: jordan@example.com/);
    assert.match(contents, new RegExp(`- ${caseyId}`));
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI log routes list logs and expose running jobs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const origin: AiCommandOrigin = {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: "Started from feature-ai-log.",
    location: {
      tab: "environment",
      branch: "feature-ai-log",
      environmentSubTab: "terminal",
    },
  };
  fakeAiProcesses.setManualProcess("wtm:ai:running-log", {
    status: "online",
    pid: 7331,
    stdout: "live stdout\n",
    stderr: "live stderr\n",
  });
  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName: "running-log.json",
    branch: "feature-ai-log",
    origin,
    worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
    command: "printf %s 'summarize the work'",
    request: "summarize the work",
    processName: "wtm:ai:running-log",
  });
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
  });

  try {
    const listResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(listResponse.status, 200);

    const listPayload = await listResponse.json() as {
      logs: Array<{
        fileName: string;
        branch: string;
        requestPreview: string;
        status: string;
        pid?: number | null;
        origin?: AiCommandOrigin | null;
      }>;
      runningJobs: Array<{
        jobId: string;
        fileName: string;
        branch: string;
        status: string;
        pid?: number | null;
        origin?: AiCommandOrigin | null;
      }>;
    };

    assert.equal(listPayload.logs.some((entry) => entry.fileName === "running-log.json"), false);
    assert.equal(listPayload.runningJobs.length, 1);
    assert.equal(listPayload.runningJobs[0].fileName, "running-log.json");
    assert.equal(listPayload.runningJobs[0].branch, "feature-ai-log");
    assert.equal(listPayload.runningJobs[0].status, "running");
    assert.equal(listPayload.runningJobs[0].pid ?? null, null);
    assert.deepEqual(listPayload.runningJobs[0].origin, origin);

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(listPayload.runningJobs[0].jobId)}`);
    assert.equal(detailResponse.status, 200);

    const detailPayload = await detailResponse.json() as {
      log: {
        jobId: string;
        fileName: string;
        branch: string;
        status: string;
        pid?: number | null;
        origin?: AiCommandOrigin | null;
        request: string;
        response: {
          stdout: string;
          stderr: string;
          events?: Array<{ source: "stdout" | "stderr"; text: string; timestamp: string }>;
        };
      };
    };

    assert.equal(detailPayload.log.jobId, listPayload.runningJobs[0].jobId);
    assert.equal(detailPayload.log.fileName, listPayload.runningJobs[0].fileName);
    assert.equal(detailPayload.log.branch, "feature-ai-log");
    assert.equal(detailPayload.log.status, "running");
    assert.equal(detailPayload.log.pid ?? null, null);
    assert.deepEqual(detailPayload.log.origin, origin);
    assert.equal(detailPayload.log.request, "summarize the work");
    assert.equal(detailPayload.log.response.stdout, "");
    assert.equal(detailPayload.log.response.stderr, "");
    assert.deepEqual(detailPayload.log.response.events ?? [], []);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI log detail stream replays persisted logs and follows durable updates", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const origin: AiCommandOrigin = {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: "Started from feature-ai-log.",
    location: {
      tab: "environment",
      branch: "feature-ai-log",
      environmentSubTab: "terminal",
    },
  };
  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName: "stream-log.json",
    branch: "feature-ai-log",
    origin,
    worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
    command: "printf %s 'stream me'",
    request: "stream me",
    processName: "wtm:ai:stream-log",
    pid: 9001,
    stdout: "first line\n",
    events: [
      {
        id: "event-1",
        source: "stdout",
        text: "first line\n",
        timestamp: "2026-03-27T10:00:00.000Z",
      },
    ],
  });
  const server = await startApiServer(repo);

  try {
    const sse = await openSse(`${await server.url()}/api/ai/logs/${encodeURIComponent("job-stream-log.json")}/stream`);

    async function waitForMatchingLogUpdate(predicate: (log: {
      status: string;
      exitCode?: number | null;
      completedAt?: string;
      origin?: AiCommandOrigin | null;
      response: {
        stdout: string;
        stderr?: string;
        events?: Array<{ source: "stdout" | "stderr"; text: string }>;
      };
    }) => boolean) {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const event = await sse.nextEvent();
        const log = event.log as {
          status: string;
          exitCode?: number | null;
          completedAt?: string;
          origin?: AiCommandOrigin | null;
          response: {
            stdout: string;
            stderr?: string;
            events?: Array<{ source: "stdout" | "stderr"; text: string }>;
          };
        };

        if (predicate(log)) {
          return { event, log };
        }
      }

      assert.fail("Did not receive the expected AI log stream update.");
    }

    const snapshot = await sse.nextEvent();
    const snapshotLog = snapshot.log as {
      status: string;
      pid?: number | null;
      origin?: AiCommandOrigin | null;
      response: {
        stdout: string;
        events?: Array<{ source: "stdout" | "stderr"; text: string }>;
      };
    };
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshotLog.status, "running");
    assert.equal(snapshotLog.pid, 9001);
    assert.deepEqual(snapshotLog.origin, origin);
    assert.equal(snapshotLog.response.stdout, "first line\n");
    assert.deepEqual(snapshotLog.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "first line\n" },
    ]);

    await writeAiLogFixture({
      repoRoot: repo.repoRoot,
      fileName: "stream-log.json",
      branch: "feature-ai-log",
      origin,
      worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
      command: "printf %s 'stream me'",
      request: "stream me",
      processName: "wtm:ai:stream-log",
      pid: 9001,
      stdout: "first line\nsecond line\n",
      stderr: "warn\n",
      events: [
        {
          id: "event-1",
          source: "stdout",
          text: "first line\n",
          timestamp: "2026-03-27T10:00:00.000Z",
        },
        {
          id: "event-2",
          source: "stdout",
          text: "second line\n",
          timestamp: "2026-03-27T10:00:05.000Z",
        },
        {
          id: "event-3",
          source: "stderr",
          text: "warn\n",
          timestamp: "2026-03-27T10:01:00.000Z",
        },
      ],
    });

    const { event: runningUpdate, log: runningLog } = await waitForMatchingLogUpdate(
      (log) => log.status === "running"
        && log.response.stdout === "first line\nsecond line\n"
        && log.response.stderr === "warn\n"
        && log.response.events?.length === 3,
    );
    assert.equal(runningUpdate.type, "update");
    assert.equal(runningLog.status, "running");
    assert.deepEqual(runningLog.origin, origin);
    assert.equal(runningLog.response.stdout, "first line\nsecond line\n");
    assert.equal(runningLog.response.stderr, "warn\n");
    assert.deepEqual(runningLog.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "first line\n" },
      { source: "stdout", text: "second line\n" },
      { source: "stderr", text: "warn\n" },
    ]);

    await writeAiLogFixture({
      repoRoot: repo.repoRoot,
      fileName: "stream-log.json",
      branch: "feature-ai-log",
      origin,
      worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
      command: "printf %s 'stream me'",
      request: "stream me",
      processName: "wtm:ai:stream-log",
      pid: 9001,
      stdout: "first line\nsecond line\n",
      stderr: "warn\n",
      exitCode: 0,
      completedAt: "2026-03-27T10:01:30.000Z",
      events: [
        {
          id: "event-1",
          source: "stdout",
          text: "first line\n",
          timestamp: "2026-03-27T10:00:00.000Z",
        },
        {
          id: "event-2",
          source: "stdout",
          text: "second line\n",
          timestamp: "2026-03-27T10:00:05.000Z",
        },
        {
          id: "event-3",
          source: "stderr",
          text: "warn\n",
          timestamp: "2026-03-27T10:01:00.000Z",
        },
      ],
    });

    const { event: completedUpdate, log: completedLog } = await waitForMatchingLogUpdate(
      (log) => log.status === "completed" && log.exitCode === 0,
    );
    assert.equal(completedUpdate.type, "update");
    assert.equal(completedLog.status, "completed");
    assert.equal(completedLog.exitCode, 0);
    assert.equal(typeof completedLog.completedAt, "string");
    assert.deepEqual(completedLog.origin, origin);
    assert.equal(completedLog.response.stderr, "warn\n");
    assert.deepEqual(completedLog.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "first line\n" },
      { source: "stdout", text: "second line\n" },
      { source: "stderr", text: "warn\n" },
    ]);

    await sse.close();
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("missing AI processes reconcile stale running logs to a failed terminal state", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const origin: AiCommandOrigin = {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: "Started from feature-ai-log.",
    location: {
      tab: "environment",
      branch: "feature-ai-log",
      environmentSubTab: "terminal",
    },
  };
  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName: "missing-process.json",
    branch: "feature-ai-log",
    origin,
    worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
    command: "printf %s 'recover me'",
    request: "recover me",
    processName: "wtm:ai:missing-process",
    stdout: "partial output",
  });
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
  });

  try {
    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent("missing-process.json")}`);
    assert.equal(detailResponse.status, 200);

    const detailPayload = await detailResponse.json() as {
      log: {
        status: string;
        completedAt?: string;
        origin?: AiCommandOrigin | null;
        error: { message: string } | null;
        response: {
          stdout: string;
          events?: Array<{ source: "stdout" | "stderr"; text: string }>;
        };
      };
    };

    assert.equal(detailPayload.log.status, "failed");
    assert.equal(typeof detailPayload.log.completedAt, "string");
    assert.deepEqual(detailPayload.log.origin, origin);
    assert.equal(detailPayload.log.response.stdout, "partial output");
    assert.deepEqual(detailPayload.log.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "partial output" },
    ]);
    assert.equal(detailPayload.log.error?.message.includes("no longer available"), true);

    const listResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as {
      runningJobs: Array<unknown>;
      logs: Array<{ fileName: string; status: string; origin?: AiCommandOrigin | null }>;
    };

    assert.equal(listPayload.runningJobs.length, 0);
    assert.equal(listPayload.logs[0].fileName, "missing-process.json");
    assert.equal(listPayload.logs[0].status, "failed");
    assert.deepEqual(listPayload.logs[0].origin, origin);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("stale persisted running AI jobs reconcile on the worktree stream and no longer block new runs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const featureAiRestart = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-restart" });
  const operationalState = await createOperationalStateStore(repo.repoRoot);
  await operationalState.setAiCommandJob({
    jobId: "stale-job",
    fileName: "stale-job.json",
    worktreeId: featureAiRestart.id,
    branch: "feature-ai-restart",
    commandId: "smart",
    command: "printf %s 'recover me'",
    input: "recover me",
    status: "running",
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    stdout: "partial output",
    stderr: "",
    outputEvents: [],
    pid: 4321,
    exitCode: null,
    processName: "wtm:ai:stale-process",
    worktreePath: featureAiRestart.worktreePath,
    origin: {
      kind: "worktree-environment",
      label: "Worktree environment",
      description: "Started from feature-ai-restart.",
      location: {
        tab: "environment",
        branch: "feature-ai-restart",
        environmentSubTab: "terminal",
      },
    },
  });

  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 7001, stdout: "fresh output\n", stderr: "" },
    { status: "stopped", pid: 7001, stdout: "fresh output\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
    aiLogStreamPollIntervalMs: 10,
  });

  try {
    const stream = await openSse(`${await server.url()}/api/worktrees/${encodeURIComponent("feature-ai-restart")}/ai-command/stream`);
    try {
      const snapshot = await stream.nextEvent();
      const snapshotJob = (snapshot as {
        type: string;
        job?: { status?: string; error?: string | null; stdout?: string; branch?: string } | null;
      }).job;

      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshotJob?.branch, "feature-ai-restart");
      assert.equal(snapshotJob?.status, "failed");
      assert.equal(snapshotJob?.stdout, "partial output");
      assert.match(snapshotJob?.error ?? "", /no longer available/);
    } finally {
      await stream.close();
    }

    const runResponse = await server.fetch(`/api/worktrees/feature-ai-restart/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "run again after restart" }),
    });
    assert.equal(runResponse.status, 200);

    const runPayload = await runResponse.json() as {
      job: { branch: string; status: string };
    };
    assert.equal(runPayload.job.branch, "feature-ai-restart");
    assert.equal(runPayload.job.status, "running");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management AI runs update the saved document on the server", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  let capturedCommand = "";
  let capturedPrompt = "";
  const aiProcesses: InjectedAiProcesses = {
    ...fakeAiProcesses.aiProcesses,
    async startProcess(options) {
      capturedCommand = options.command;
      const match = options.command.match(/^printf %s '([\s\S]*)'$/);
      capturedPrompt = match ? match[1].replace(/'\\''/g, "'") : options.command;
      return await fakeAiProcesses.aiProcesses.startProcess(options);
    },
  };
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 5012, stdout: "# Updated By AI\n\n- durable update\n", stderr: "" },
    { status: "stopped", pid: 5012, stdout: "# Updated By AI\n\n- durable update\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string; markdown?: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const runResponse = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "tighten this plan",
        documentId: outline.id,
      }),
    });
    assert.equal(runResponse.status, 200);

    const runPayload = await runResponse.json() as {
      job: {
        branch: string;
        documentId?: string | null;
        commandId: string;
        status: string;
      };
    };
    assert.equal(runPayload.job.branch, "feature-ai-log");
    assert.equal(runPayload.job.documentId, outline.id);
    assert.equal(runPayload.job.commandId, "smart");
    assert.equal(runPayload.job.status, "running");

    assert.equal(capturedCommand.includes("tighten this plan"), true);
    assert.equal(capturedPrompt.includes("You are rewriting the project-management markdown document"), true);
    assert.equal(capturedPrompt.includes("Requested change: tighten this plan"), true);
    assert.equal(capturedPrompt.includes("Output format: return only the complete updated markdown document body as plain text."), true);
    assert.equal(capturedPrompt.includes("You are not creating files, not writing a .md file"), true);
    assert.equal(capturedPrompt.includes("Document history is the rollback mechanism."), true);
    assert.equal(capturedPrompt.includes("Environment wrapper:"), true);
    assert.equal(capturedPrompt.includes(`- Repository root: ${repo.repoRoot}`), true);
    assert.equal(capturedPrompt.includes("- Running services:"), true);
    assert.equal(capturedPrompt.includes("- PM2 log access: use pm2 status, pm2 logs"), true);
    assert.equal(capturedPrompt.includes("Current markdown:"), true);

    await waitFor(async () => {
      const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
      return updated.document.markdown.includes("durable update");
    });

    const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(updated.document.title, "Project Outline");
    assert.match(updated.document.markdown, /durable update/);

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, outline.id);
    assert.equal(history.history.length >= 2, true);
    assert.equal(history.history.at(-1)?.action, "update");

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ documentId?: string | null; status: string; origin?: AiCommandOrigin | null }>;
    };
    assert.equal(logsPayload.logs[0]?.documentId, outline.id);
    assert.equal(logsPayload.logs[0]?.status, "completed");
    assert.equal(logsPayload.logs[0]?.origin?.kind, "project-management-document");
    assert.equal(logsPayload.logs[0]?.origin?.location.tab, "project-management");
    assert.equal(logsPayload.logs[0]?.origin?.location.projectManagementSubTab, "document");
    assert.equal(logsPayload.logs[0]?.origin?.location.documentId, outline.id);
    assert.equal(logsPayload.logs[0]?.origin?.location.projectManagementDocumentViewMode, "edit");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("creating a project-management document auto-generates a short summary with the simple AI command", async () => {
  const repo = await createApiTestRepo();
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "printf %s $WTM_AI_INPUT",
    simple:
      "node -e \"const fs = require('node:fs'); fs.writeFileSync('summary-prompt.txt', process.argv[1]); console.log('Generated UI summary.');\" $WTM_AI_INPUT",
    autoStartRuntime: false,
  });
  await fs.writeFile(repo.configPath, nextContents, "utf8");
  const server = await startApiServer(repo);

  try {
    const response = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Launch Checklist",
        markdown: "# Launch Checklist\n\n- verify release notes\n",
        tags: ["release", "ops"],
        status: "todo",
        assignee: "Avery",
      }),
    });
    assert.equal(response.status, 201);

    const payload = await response.json() as {
      document: {
        id: string;
        title: string;
        summary: string;
        markdown: string;
        status: string;
        assignee: string;
      };
    };

    assert.equal(payload.document.title, "Launch Checklist");
    assert.equal(payload.document.summary, "Generated UI summary.");
    assert.match(payload.document.markdown, /verify release notes/);

    const saved = await getProjectManagementDocument(repo.repoRoot, payload.document.id);
    assert.equal(saved.document.summary, "Generated UI summary.");

    const prompt = await fs.readFile(path.join(repo.repoRoot, "summary-prompt.txt"), "utf8");
    assert.equal(prompt.includes('You are writing the short summary for the project-management document "Launch Checklist"'), true);
    assert.equal(prompt.includes("Return only the final short summary as raw text."), true);
    assert.equal(prompt.includes("Write 1-2 sentences that make the document easy to scan in the UI."), true);
    assert.equal(prompt.includes("Title: Launch Checklist"), true);
    assert.equal(prompt.includes("Status: todo"), true);
    assert.equal(prompt.includes("Assignee: Avery"), true);
    assert.equal(prompt.includes("Tags: release, ops"), true);
    assert.equal(prompt.includes("Document markdown:"), true);

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, payload.document.id);
    assert.equal(history.history.length, 2);
    assert.deepEqual(history.history.map((entry) => entry.action), ["create", "update"]);
    assert.match(history.history.at(-1)?.diff ?? "", /\+summary: Generated UI summary\./);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management AI document updates ignore stderr while logs retain it", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 5013, stdout: "# Clean Markdown\n\nOnly stdout belongs here.\n", stderr: "> build · gpt-4.1\n" },
    { status: "stopped", pid: 5013, stdout: "# Clean Markdown\n\nOnly stdout belongs here.\n", stderr: "> build · gpt-4.1\n", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string; markdown?: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const runResponse = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "rewrite cleanly",
        documentId: outline.id,
      }),
    });
    assert.equal(runResponse.status, 200);

    await waitFor(async () => {
      const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
      return updated.document.markdown.includes("Only stdout belongs here.");
    });

    const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(updated.document.markdown, "# Clean Markdown\n\nOnly stdout belongs here.");
    assert.equal(updated.document.markdown.includes("> build · gpt-4.1"), false);

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ jobId: string; fileName: string }>;
    };

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(logsPayload.logs[0].jobId)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        response: {
          stdout: string;
          stderr: string;
          events?: Array<{ source: "stdout" | "stderr"; text: string }>;
        };
      };
    };

    assert.equal(detailPayload.log.response.stdout, "# Clean Markdown\n\nOnly stdout belongs here.\n");
    assert.equal(detailPayload.log.response.stderr, "> build · gpt-4.1\n");
    assert.deepEqual(detailPayload.log.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "# Clean Markdown\n\nOnly stdout belongs here.\n" },
      { source: "stderr", text: "> build · gpt-4.1\n" },
    ]);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management AI document update failures settle the job without taking down the server", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "node -e \"\" $WTM_AI_INPUT",
    simple: "node -e \"\" $WTM_AI_INPUT",
    autoStartRuntime: false,
  });
  await fs.writeFile(repo.configPath, nextContents, "utf8");
  const server = await startApiServer(repo, { aiProcessPollIntervalMs: 10 });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string; markdown?: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const original = await getProjectManagementDocument(repo.repoRoot, outline.id);

    const runResponse = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "rewrite with nothing",
        documentId: outline.id,
      }),
    });
    assert.equal(runResponse.status, 200);

    const runPayload = await runResponse.json() as {
      job: {
        jobId: string;
        fileName: string;
        status: string;
      };
    };
    assert.equal(runPayload.job.status, "running");

    await waitFor(async () => {
      const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(runPayload.job.jobId)}`);
      if (detailResponse.status !== 200) {
        return false;
      }

      const detailPayload = await detailResponse.json() as {
        log: {
          status: string;
          error: { message: string } | null;
        };
      };

      return detailPayload.log.status === "failed"
        && detailPayload.log.error?.message === "AI command finished without returning updated markdown.";
    });

    const unchanged = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(unchanged.document.markdown, original.document.markdown);

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(runPayload.job.jobId)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        status: string;
        error: { message: string } | null;
        response: {
          stdout: string;
          stderr: string;
        };
      };
    };

    assert.equal(detailPayload.log.status, "failed");
    assert.equal(detailPayload.log.response.stdout, "");
    assert.equal(detailPayload.log.response.stderr, "AI command finished without returning updated markdown.");
    assert.equal(detailPayload.log.error?.message, "AI command finished without returning updated markdown.");

    const followUpResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(followUpResponse.status, 200);
    const followUpPayload = await followUpResponse.json() as {
      documents: Array<{ id: string }>;
    };
    assert.equal(followUpPayload.documents.some((entry) => entry.id === outline.id), true);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management AI rejects unknown target documents and logs the failure", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
  });

  try {
    const response = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "rewrite this",
        documentId: "missing-document",
      }),
    });
    assert.equal(response.status, 404);

    const payload = await response.json() as { message: string };
    assert.equal(payload.message, "Unknown project management document missing-document.");

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ documentId?: string | null; status: string; origin?: AiCommandOrigin | null }>;
      runningJobs: Array<unknown>;
    };

    assert.equal(logsPayload.runningJobs.length, 0);
    assert.equal(logsPayload.logs[0]?.documentId, "missing-document");
    assert.equal(logsPayload.logs[0]?.status, "failed");
    assert.equal(logsPayload.logs[0]?.origin?.kind, "project-management-document");
    assert.equal(logsPayload.logs[0]?.origin?.location.tab, "project-management");
    assert.equal(logsPayload.logs[0]?.origin?.location.projectManagementSubTab, "document");
    assert.equal(logsPayload.logs[0]?.origin?.location.documentId, "missing-document");
    assert.equal(logsPayload.logs[0]?.origin?.location.projectManagementDocumentViewMode, "edit");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management routes preserve summary and add attributed comments", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    await runCommand("git", ["config", "user.name", "Riley Maintainer"], { cwd: repo.repoRoot });
    await runCommand("git", ["config", "user.email", "riley@example.com"], { cwd: repo.repoRoot });

    const createResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Comments rollout",
        summary: "Track the document comments launch.",
        markdown: "# Comments rollout\n",
        tags: ["feature", "ux"],
        status: "todo",
        assignee: "Riley",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as { document: { id: string; summary: string } };
    assert.equal(createPayload.document.summary, "Track the document comments launch.");

    const documentId = createPayload.document.id;

    const commentResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Need one more pass on author attribution." }),
    });
    assert.equal(commentResponse.status, 201);
    const commentPayload = await commentResponse.json() as {
      document: {
        summary: string;
        comments: Array<{ body: string; authorName: string; authorEmail: string }>;
      };
    };
    assert.equal(commentPayload.document.summary, "Track the document comments launch.");
    assert.equal(commentPayload.document.comments.length, 1);
    assert.equal(commentPayload.document.comments[0]?.body, "Need one more pass on author attribution.");
    assert.equal(commentPayload.document.comments[0]?.authorName, "Riley Maintainer");
    assert.equal(commentPayload.document.comments[0]?.authorEmail, "riley@example.com");

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, documentId);
    assert.equal(history.history.at(-1)?.action, "comment");
    assert.equal(history.history.at(-1)?.authorName, "Riley Maintainer");
    assert.equal(history.history.at(-1)?.authorEmail, "riley@example.com");

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, documentId);
    assert.equal(updatedDocument.document.summary, "Track the document comments launch.");
    assert.equal(updatedDocument.document.comments.length, 1);

    const invalidCommentResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "   " }),
    });
    assert.equal(invalidCommentResponse.status, 400);
    const invalidCommentPayload = await invalidCommentResponse.json() as { message: string };
    assert.equal(invalidCommentPayload.message, "Comment body is required.");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management routes create and update pull-request documents with preserved metadata", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    await runCommand("git", ["config", "user.name", "Riley Maintainer"], { cwd: repo.repoRoot });
    await runCommand("git", ["config", "user.email", "riley@example.com"], { cwd: repo.repoRoot });

    const createResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "PR review workspace",
        summary: "Track review notes for the PR workspace.",
        markdown: "# PR review workspace\n",
        kind: "pull-request",
        pullRequest: {
          baseBranch: "main",
          compareBranch: "feature/pr-workspace",
          state: "open",
          draft: true,
        },
        tags: ["pull-request", "feature"],
        status: "in-progress",
        assignee: "Riley",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as {
      document: {
        id: string;
        kind: string;
        pullRequest: {
          baseBranch: string;
          compareBranch: string;
          state: string;
          draft: boolean;
        } | null;
      };
    };
    assert.equal(createPayload.document.kind, "pull-request");
    assert.deepEqual(createPayload.document.pullRequest, {
      baseBranch: "main",
      compareBranch: "feature/pr-workspace",
      state: "open",
      draft: true,
    });

    const documentId = createPayload.document.id;

    const updateResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "PR review workspace",
        summary: "Ready for merge.",
        markdown: "# PR review workspace\n\nReady for merge.\n",
        kind: "pull-request",
        pullRequest: {
          baseBranch: "main",
          compareBranch: "feature/pr-workspace",
          state: "merged",
          draft: false,
        },
        tags: ["pull-request", "feature"],
        status: "done",
        assignee: "Riley",
      }),
    });
    assert.equal(updateResponse.status, 200);
    const updatePayload = await updateResponse.json() as {
      document: {
        kind: string;
        summary: string;
        status: string;
        pullRequest: {
          baseBranch: string;
          compareBranch: string;
          state: string;
          draft: boolean;
        } | null;
      };
    };
    assert.equal(updatePayload.document.kind, "pull-request");
    assert.equal(updatePayload.document.summary, "Ready for merge.");
    assert.equal(updatePayload.document.status, "done");
    assert.deepEqual(updatePayload.document.pullRequest, {
      baseBranch: "main",
      compareBranch: "feature/pr-workspace",
      state: "merged",
      draft: false,
    });

    const commentResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Merged after final review." }),
    });
    assert.equal(commentResponse.status, 201);
    const commentPayload = await commentResponse.json() as {
      document: {
        kind: string;
        pullRequest: {
          baseBranch: string;
          compareBranch: string;
          state: string;
          draft: boolean;
        } | null;
        comments: Array<{ body: string; authorName: string; authorEmail: string }>;
      };
    };
    assert.equal(commentPayload.document.kind, "pull-request");
    assert.deepEqual(commentPayload.document.pullRequest, {
      baseBranch: "main",
      compareBranch: "feature/pr-workspace",
      state: "merged",
      draft: false,
    });
    assert.equal(commentPayload.document.comments.at(-1)?.body, "Merged after final review.");
    assert.equal(commentPayload.document.comments.at(-1)?.authorName, "Riley Maintainer");
    assert.equal(commentPayload.document.comments.at(-1)?.authorEmail, "riley@example.com");

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, documentId);
    assert.equal(updatedDocument.document.kind, "pull-request");
    assert.deepEqual(updatedDocument.document.pullRequest, {
      baseBranch: "main",
      compareBranch: "feature/pr-workspace",
      state: "merged",
      draft: false,
    });
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management status route updates only the lane state", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const foundationResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Foundation",
        markdown: "# Foundation\n",
        tags: ["plan"],
      }),
    });
    assert.equal(foundationResponse.status, 201);
    const foundationPayload = await foundationResponse.json() as { document: { id: string } };

    const dependentResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Dependent Feature",
        summary: "Deliver the feature after foundation work lands.",
        markdown: "# Dependent Feature\n",
        tags: ["feature"],
        dependencies: [foundationPayload.document.id],
        status: "todo",
        assignee: "Taylor",
      }),
    });
    assert.equal(dependentResponse.status, 201);
    const dependentPayload = await dependentResponse.json() as { document: { id: string } };

    const statusResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(dependentPayload.document.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(statusResponse.status, 200);
    const statusPayload = await statusResponse.json() as {
      document: {
        status: string;
        summary: string;
        dependencies: string[];
        assignee: string;
      };
    };
    assert.equal(statusPayload.document.status, "done");
    assert.equal(statusPayload.document.summary, "Deliver the feature after foundation work lands.");
    assert.deepEqual(statusPayload.document.dependencies, [foundationPayload.document.id]);
    assert.equal(statusPayload.document.assignee, "Taylor");

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, dependentPayload.document.id);
    assert.equal(updatedDocument.document.status, "done");
    assert.equal(updatedDocument.document.summary, "Deliver the feature after foundation work lands.");
    assert.deepEqual(updatedDocument.document.dependencies, [foundationPayload.document.id]);

    const invalidStatusResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(dependentPayload.document.id)}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "   " }),
    });
    assert.equal(invalidStatusResponse.status, 400);
    const invalidStatusPayload = await invalidStatusResponse.json() as { message: string };
    assert.equal(invalidStatusPayload.message, "Document status is required.");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI creates a derived worktree and streams stdout from that worktree job", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "printf 'planning...\\nimplemented\\n'; printf '%s' \"$WTM_AI_INPUT\" > .wtm-captured-input; env > .wtm-captured-env",
    simple: "node -e \"const text = process.argv[1] || ''; console.log(text.includes('git commit message') ? 'commit me' : text);\" $WTM_AI_INPUT",
    autoStartRuntime: true,
  });
  await fs.writeFile(repo.configPath, nextContents, "utf8");

  const server = await startApiServer(repo, {
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const response = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
      }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { branch: string; documentId?: string | null; status: string; commandId: string };
      runtime?: { branch: string; worktreePath: string; tmuxSession: string; runtimeStartedAt?: string };
    };
    assert.equal(payload.job.documentId, outline.id);
    assert.equal(payload.job.status, "running");
    assert.equal(payload.job.commandId, "smart");
    assert.match(payload.job.branch, /^pm-/);
    assert.equal(payload.runtime?.branch, payload.job.branch);
    assert.equal(payload.runtime?.worktreePath?.length ? true : false, true);
    assert.equal(payload.runtime?.tmuxSession?.length ? true : false, true);
    assert.equal(typeof payload.runtime?.runtimeStartedAt, "string");

    const statePayload = await readStateSnapshot<{
      worktrees: Array<{
        branch: string;
        worktreePath: string;
        linkedDocument?: {
          id: string;
          number: number;
          title: string;
          summary: string;
          status: string;
          archived: boolean;
        } | null;
        runtime?: { tmuxSession: string };
      }>;
    }>(server);
    const createdWorktree = statePayload.worktrees.find((entry) => entry.branch === payload.job.branch);
    assert.ok(createdWorktree);
    assert.equal(createdWorktree.linkedDocument?.id, outline.id);
    assert.equal(createdWorktree.linkedDocument?.number, 1);
    assert.equal(createdWorktree.linkedDocument?.title, "Project Outline");
    assert.equal(createdWorktree.linkedDocument?.summary, "");
    assert.equal(createdWorktree.linkedDocument?.status, "in-progress");
    assert.equal(createdWorktree.linkedDocument?.archived, false);

    const storedLink = await getWorktreeDocumentLink(repo.repoRoot, worktreeId(createdWorktree.worktreePath));
    assert.ok(storedLink);
    assert.equal(storedLink.documentId, outline.id);
    assert.equal(storedLink.worktreePath, createdWorktree.worktreePath);

    assert.equal(createdWorktree.runtime?.tmuxSession?.length ? true : false, true);
    const capturedCommand = await fs.readFile(path.join(createdWorktree.worktreePath, ".wtm-captured-input"), "utf8");
    const capturedEnv = await fs.readFile(path.join(createdWorktree.worktreePath, ".wtm-captured-env"), "utf8");
    assert.equal(capturedEnv.includes(`WORKTREE_BRANCH=${payload.job.branch}`), true);
    assert.equal(capturedEnv.includes(`WORKTREE_PATH=${createdWorktree.worktreePath}`), true);
    assert.equal(capturedEnv.includes(`TMUX_SESSION_NAME=${createdWorktree.runtime?.tmuxSession}`), true);
    assert.equal(capturedCommand.includes("You are implementing the work described by the project-management document"), true);
    assert.equal(capturedCommand.includes("Environment wrapper:"), true);
    assert.equal(capturedCommand.includes(`- Repository root: ${repo.repoRoot}`), true);
    assert.equal(capturedCommand.includes(`- Branch: ${payload.job.branch}`), true);
    assert.equal(capturedCommand.includes(`- Worktree path: ${createdWorktree.worktreePath}`), true);
    assert.equal(capturedCommand.includes(`TMUX_SESSION_NAME=${createdWorktree.runtime?.tmuxSession}`), true);
    assert.equal(capturedCommand.includes("- Running services:"), true);
    assert.equal(capturedCommand.includes("- PM2 log access: use pm2 status, pm2 logs"), true);
    assert.equal(capturedCommand.includes("in worktree"), false);
    assert.equal(capturedCommand.includes("Worktree path:"), true);
    assert.equal(capturedCommand.includes("Document number:"), false);
    assert.equal(capturedCommand.includes("Status:"), false);
    assert.equal(capturedCommand.includes("Assignee:"), false);
    assert.equal(capturedCommand.includes("Tags:"), false);
    assert.equal(capturedCommand.includes("This is not an interactive user session"), true);
    assert.equal(capturedCommand.includes("Commit your work regularly as you complete meaningful milestones."), true);
    assert.equal(capturedCommand.includes("including a concise summary of what you changed and how you verified it."), true);
    assert.equal(capturedCommand.includes("Additional operator guidance:"), false);

    const stream = await openSse(`${await server.url()}/api/worktrees/${encodeURIComponent(payload.job.branch)}/ai-command/stream`);
    try {
      const snapshot = await stream.nextEvent();
      assert.equal(snapshot.type, "snapshot");
      const snapshotJob = (snapshot as { job?: { branch?: string; stdout?: string; status?: string } | null }).job;
      assert.equal(snapshotJob?.branch, payload.job.branch);

      let sawImplemented = snapshotJob?.stdout?.includes("implemented") ?? false;
      if (snapshotJob?.status !== "completed") {
        await waitFor(async () => {
          const logsResponse = await server.fetch(`/api/ai/logs`);
          if (logsResponse.status !== 200) {
            return false;
          }
          const logsPayload = await logsResponse.json() as {
            logs: Array<{ branch: string; status: string; origin?: AiCommandOrigin | null }>;
          };
          return logsPayload.logs.some((entry) => entry.branch === payload.job.branch && entry.status === "completed");
        });

        for (let index = 0; index < 5; index += 1) {
          const event = await stream.nextEvent();
          const job = (event as { job?: { stdout?: string; status?: string } | null }).job;
          if (job?.stdout?.includes("implemented")) {
            sawImplemented = true;
          }
          if (job?.status === "completed") {
            break;
          }
        }
      }
      assert.equal(sawImplemented, true);
    } finally {
      await stream.close();
    }

    const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(updated.document.title, "Project Outline");
    assert.equal(updated.document.status, "in-progress");
    assert.equal(updated.document.markdown.includes("implemented"), false);
    assert.equal(updated.document.comments.length >= 2, true);
    const startedComment = updated.document.comments.at(-2);
    const latestComment = updated.document.comments.at(-1);
    assert.ok(startedComment);
    assert.ok(latestComment);
    assert.match(startedComment.body, /## Worktree AI started/);
    assert.equal(startedComment.body.includes(`- Branch: \`${payload.job.branch}\``), true);
    assert.match(startedComment.body, /- Command: `smart`/);
    assert.match(latestComment.body, /## Worktree AI completed/);
    assert.equal(latestComment.body.includes(`- Branch: \`${payload.job.branch}\``), true);
    assert.match(latestComment.body, /- Command: `smart`/);
    assert.match(latestComment.body, /### Output/);
    assert.match(latestComment.body, /<details>/);
    assert.match(latestComment.body, /<summary>Stdout<\/summary>/);
    assert.match(latestComment.body, /> planning\.\.\.\n> implemented/);

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, outline.id);
    assert.equal(history.history.length >= 2, true);
    assert.match(history.history.at(-1)?.diff ?? "", /\+  ## Worktree AI completed/);

    const aiLogsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(aiLogsResponse.status, 200);
    const aiLogsPayload = await aiLogsResponse.json() as {
      logs: Array<{ branch: string; status: string; origin?: AiCommandOrigin | null }>;
    };
    const completedLog = aiLogsPayload.logs.find((entry) => entry.branch === payload.job.branch && entry.status === "completed");
    assert.ok(completedLog);
    assert.equal(completedLog.origin?.kind, "project-management-document-run");
    assert.equal(completedLog.origin?.location.tab, "project-management");
    assert.equal(completedLog.origin?.location.projectManagementSubTab, "document");
    assert.equal(completedLog.origin?.location.documentId, outline.id);
    assert.equal(completedLog.origin?.location.projectManagementDocumentViewMode, "document");

    await waitFor(async () => {
      const latestStatePayload = await readStateSnapshot<{
        worktrees: Array<{ branch: string; runtime?: { tmuxSession: string } }>;
      }>(server, 1000);
      return latestStatePayload.worktrees.find((entry) => entry.branch === payload.job.branch)?.runtime === undefined;
    });
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI runs startup commands for a new derived worktree without starting a runtime", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();

  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const parsedConfig = parseConfigContents(currentContents);
  parsedConfig.startupCommands = [
    "printf started > .wtm-startup-marker",
  ];
  parsedConfig.backgroundCommands = {
    web: {
      command: "printf background > .wtm-background-marker",
    },
  };
  parsedConfig.aiCommands.autoStartRuntime = false;
  parsedConfig.aiCommands.smart = "printf '%s' \"$WTM_AI_INPUT\" >/dev/null; printf 'planning...\\n'";
  parsedConfig.aiCommands.simple = "node -e \"const text = process.argv[1] || ''; console.log(text.includes('git commit message') ? 'commit me' : text);\" $WTM_AI_INPUT";
  await fs.writeFile(repo.configPath, serializeConfigContents(parsedConfig as unknown as Record<string, unknown>, { includeSchemaHeader: true }), "utf8");

  const server = await startApiServer(repo, {
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const response = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { branch: string; worktreePath?: string; status: string };
      runtime?: { branch: string };
    };
    assert.equal(payload.job.status, "running");
    assert.equal(payload.runtime, undefined);

    const statePayload = await readStateSnapshot<{
      worktrees: Array<{
        branch: string;
        worktreePath: string;
        runtime?: { tmuxSession: string };
      }>;
    }>(server);
    const createdWorktree = statePayload.worktrees.find((entry) => entry.branch === payload.job.branch);
    assert.ok(createdWorktree);
    assert.equal(createdWorktree.runtime, undefined);

    const startupMarker = await fs.readFile(path.join(createdWorktree.worktreePath, ".wtm-startup-marker"), "utf8");
    assert.equal(startupMarker, "started");

    await assert.rejects(
      fs.access(path.join(createdWorktree.worktreePath, ".wtm-background-marker")),
    );

    const operationalState = await createOperationalStateStore(repo.repoRoot);
    const runtime = await operationalState.getRuntimeById(worktreeId(createdWorktree.worktreePath));
    assert.equal(runtime, null);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI preserves board origin metadata when requested", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 9191, stdout: "Starting from board...\n", stderr: "" },
    { status: "stopped", pid: 9191, stdout: "Starting from board...\nDone.\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const response = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "start from the board",
        origin: {
          kind: "project-management-document-run",
          label: "Project management board run",
          description: "#1 Project Outline",
          location: {
            tab: "project-management",
            projectManagementSubTab: "board",
            documentId: outline.id,
            projectManagementDocumentViewMode: "document",
          },
        },
      }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { branch: string; status: string; origin?: AiCommandOrigin | null };
    };
    assert.equal(payload.job.status, "running");
    assert.equal(payload.job.origin?.kind, "project-management-document-run");
    assert.equal(payload.job.origin?.location.tab, "project-management");
    assert.equal(payload.job.origin?.location.projectManagementSubTab, "board");
    assert.equal(payload.job.origin?.location.documentId, outline.id);
    assert.equal(payload.job.origin?.location.projectManagementDocumentViewMode, "document");
    assert.equal(payload.job.origin?.location.branch, payload.job.branch);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{
          branch: string;
          status: string;
          origin?: AiCommandOrigin | null;
        }>;
      };
      const boardRunLog = logsPayload.logs.find((entry) => entry.branch === payload.job.branch);
      if (!boardRunLog) {
        return false;
      }

      assert.equal(boardRunLog.status, "completed");
      assert.equal(boardRunLog.origin?.kind, "project-management-document-run");
      assert.equal(boardRunLog.origin?.label, "Project management board run");
      assert.equal(boardRunLog.origin?.location.tab, "project-management");
      assert.equal(boardRunLog.origin?.location.projectManagementSubTab, "board");
      assert.equal(boardRunLog.origin?.location.documentId, outline.id);
      assert.equal(boardRunLog.origin?.location.projectManagementDocumentViewMode, "document");
      assert.equal(boardRunLog.origin?.location.branch, payload.job.branch);
      return true;
    });

    await waitFor(async () => {
      const latestStatePayload = await readStateSnapshot<{
        worktrees: Array<{ branch: string; runtime?: { tmuxSession: string } }>;
      }>(server, 1000);
      return latestStatePayload.worktrees.find((entry) => entry.branch === payload.job.branch)?.runtime === undefined;
    });

  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI can append pull request review comments with git origin metadata", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 9292, stdout: "Review started...\n", stderr: "" },
    { status: "stopped", pid: 9292, stdout: "Review started...\nLooks ready to merge with one missing regression test.\n", stderr: "", exitCode: 0 },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const createResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Pull request review doc",
        markdown: "# Pull request review\n\n- ready for AI feedback\n",
        kind: "pull-request",
        pullRequest: {
          baseBranch: "main",
          compareBranch: "feature-ai-log",
          state: "open",
          draft: false,
        },
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as {
      document: { id: string; kind: string; pullRequest?: { baseBranch: string; compareBranch: string } | null };
    };
    assert.equal(createPayload.document.kind, "pull-request");

    const documentId = createPayload.document.id;
    const response = await server.fetch(`/api/worktrees/feature-ai-log/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: "Review the pull request changes and leave reviewer notes.",
        commandId: "smart",
        commentDocumentId: documentId,
        origin: {
          kind: "git-pull-request-review",
          label: "Git pull request review",
          location: {
            tab: "git",
            branch: "feature-ai-log",
            gitBaseBranch: "main",
            documentId,
          },
        },
      }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { branch: string; status: string; origin?: AiCommandOrigin | null };
    };
    assert.equal(payload.job.status, "running");
    assert.equal(payload.job.origin?.kind, "git-pull-request-review");
    assert.equal(payload.job.origin?.location.tab, "git");
    assert.equal(payload.job.origin?.location.branch, "feature-ai-log");
    assert.equal(payload.job.origin?.location.gitBaseBranch, "main");
    assert.equal(payload.job.origin?.location.documentId, documentId);

    await waitFor(async () => {
      const updated = await getProjectManagementDocument(repo.repoRoot, documentId);
      const latestComment = updated.document.comments.at(-1);
      return Boolean(latestComment?.body.includes("## Worktree AI completed"));
    });

    const updated = await getProjectManagementDocument(repo.repoRoot, documentId);
    const startedComment = updated.document.comments.at(-2);
    const latestComment = updated.document.comments.at(-1);
    assert.ok(startedComment);
    assert.ok(latestComment);
    assert.match(startedComment.body, /## Worktree AI started/);
    assert.match(startedComment.body, /- Branch: `feature-ai-log`/);
    assert.match(startedComment.body, /- Command: `smart`/);
    assert.match(latestComment.body, /## Worktree AI completed/);
    assert.match(latestComment.body, /- Branch: `feature-ai-log`/);
    assert.match(latestComment.body, /- Command: `smart`/);
    assert.match(latestComment.body, /<summary>Stdout<\/summary>/);
    assert.match(latestComment.body, /Looks ready to merge with one missing regression test\./);

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ branch: string; status: string; origin?: AiCommandOrigin | null }>;
    };
    const completedLog = logsPayload.logs.find((entry) => entry.branch === "feature-ai-log" && entry.status === "completed" && entry.origin?.kind === "git-pull-request-review");
    assert.ok(completedLog);
    assert.equal(completedLog.origin?.label, "Git pull request review");
    assert.equal(completedLog.origin?.location.tab, "git");
    assert.equal(completedLog.origin?.location.branch, "feature-ai-log");
    assert.equal(completedLog.origin?.location.gitBaseBranch, "main");
    assert.equal(completedLog.origin?.location.documentId, documentId);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI continues the selected linked worktree when requested", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "stopped", pid: 8101, stdout: "existing branch run\n", stderr: "", exitCode: 0 },
    { status: "stopped", pid: 8102, stdout: "continued branch run\n", stderr: "", exitCode: 0 },
  ]);

  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const firstResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(firstResponse.status, 200);
    const firstPayload = await firstResponse.json() as {
      job: { branch: string; status: string };
    };
    assert.equal(firstPayload.job.status, "running");

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.some((entry) => entry.branch === firstPayload.job.branch && entry.status === "completed");
    });

    const secondResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktreeStrategy: "continue-current",
        targetBranch: firstPayload.job.branch,
        input: "continue the existing worktree",
      }),
    });
    assert.equal(secondResponse.status, 200);
    const secondPayload = await secondResponse.json() as {
      job: { branch: string; status: string };
    };
    assert.equal(secondPayload.job.status, "running");
    assert.equal(secondPayload.job.branch, firstPayload.job.branch);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.filter((entry) => entry.branch === firstPayload.job.branch && entry.status === "completed").length >= 2;
    });

    const link = await getWorktreeDocumentLink(repo.repoRoot, worktreeId(path.join(repo.repoRoot, firstPayload.job.branch)));
    assert.equal(link?.documentId, outline.id);

    const statePayload = await readStateSnapshot<{
      worktrees: Array<{ branch: string }>;
    }>(server);
    assert.equal(statePayload.worktrees.filter((entry) => entry.branch === firstPayload.job.branch).length, 1);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI uses a suffixed branch when explicitly starting a new worktree again", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.queueStartScript([
    { status: "stopped", pid: 7101, stdout: "first run\n", stderr: "", exitCode: 0 },
    { status: "stopped", pid: 7102, stdout: "second run\n", stderr: "", exitCode: 0 },
  ]);

  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const documentsResponse = await server.fetch(`/api/project-management/documents`);
    assert.equal(documentsResponse.status, 200);
    const documentsPayload = await documentsResponse.json() as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = documentsPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const firstResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(firstResponse.status, 200);
    const firstPayload = await firstResponse.json() as {
      job: { branch: string; status: string };
    };
    assert.equal(firstPayload.job.status, "running");

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.some((entry) => entry.branch === firstPayload.job.branch && entry.status === "completed");
    });

    const secondResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(outline.id)}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        worktreeStrategy: "new",
      }),
    });
    assert.equal(secondResponse.status, 200);
    const secondPayload = await secondResponse.json() as {
      job: { branch: string; status: string };
    };
    assert.equal(secondPayload.job.status, "running");

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        logs: Array<{ branch: string; status: string }>;
      };
      return logsPayload.logs.some((entry) => entry.branch === secondPayload.job.branch && entry.status === "completed");
    });

    assert.notEqual(firstPayload.job.branch, secondPayload.job.branch);
    assert.equal(secondPayload.job.branch, `${firstPayload.job.branch}-2`);

    const firstLink = await getWorktreeDocumentLink(repo.repoRoot, worktreeId(path.join(repo.repoRoot, firstPayload.job.branch)));
    const secondLink = await getWorktreeDocumentLink(repo.repoRoot, worktreeId(path.join(repo.repoRoot, secondPayload.job.branch)));
    assert.equal(firstLink?.documentId, outline.id);
    assert.equal(secondLink?.documentId, outline.id);

    const statePayload = await readStateSnapshot<{
      worktrees: Array<{ branch: string }>;
    }>(server);
    assert.ok(statePayload.worktrees.some((entry) => entry.branch === firstPayload.job.branch));
    assert.ok(statePayload.worktrees.some((entry) => entry.branch === secondPayload.job.branch));
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI cancel route deletes the running process and returns the settled failed job", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const cancelWorktree = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-cancel" });
  const fakeAiProcesses = createFakeAiProcesses();
  const expectedOrigin: AiCommandOrigin = {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: "Started from feature-ai-cancel.",
    location: {
      tab: "environment",
      worktreeId: cancelWorktree.id,
      branch: "feature-ai-cancel",
      environmentSubTab: "terminal",
    },
  };
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 8181, stdout: "working...\n", stderr: "" },
    { status: "online", pid: 8181, stdout: "working...\n", stderr: "" },
  ]);
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const runResponse = await server.fetch(`/api/worktrees/feature-ai-cancel/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "cancel me" }),
    });
    assert.equal(runResponse.status, 200);

    const cancelResponse = await server.fetch(`/api/worktrees/feature-ai-cancel/ai-command/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);

    const cancelPayload = await cancelResponse.json() as {
      job: {
        branch: string;
        status: string;
        processName?: string | null;
        error?: string | null;
        completedAt?: string | null;
        origin?: AiCommandOrigin | null;
      };
    };
    assert.equal(cancelPayload.job.branch, "feature-ai-cancel");
    assert.equal(cancelPayload.job.status, "failed");
    assert.equal(cancelPayload.job.processName?.startsWith("wtm:ai:"), true);
    assert.equal(typeof cancelPayload.job.completedAt, "string");
    assert.match(cancelPayload.job.error ?? "", /Cancellation requested by the user/);
    assert.deepEqual(cancelPayload.job.origin, expectedOrigin);
    assert.equal(fakeAiProcesses.deletedProcesses.length, 1);
    assert.equal(fakeAiProcesses.deletedProcesses[0]?.startsWith("wtm:ai:"), true);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        runningJobs: Array<{ branch: string }>;
        logs: Array<{ branch: string; status: string; origin?: AiCommandOrigin | null }>;
      };

      const runningForBranch = logsPayload.runningJobs.some((entry) => entry.branch === "feature-ai-cancel");
      const failedLog = logsPayload.logs.find((entry) => entry.branch === "feature-ai-cancel");
      assert.deepEqual(failedLog?.origin, expectedOrigin);
      return !runningForBranch && failedLog?.status === "failed";
    });

    const logsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(logsResponse.status, 200);
    const logsPayload = await logsResponse.json() as {
      logs: Array<{ jobId: string; fileName: string; branch: string }>;
    };
    const canceledLog = logsPayload.logs.find((entry) => entry.branch === "feature-ai-cancel");
    assert.ok(canceledLog);

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(canceledLog.jobId)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        response: {
          events?: Array<{ source: "stdout" | "stderr"; text: string }>;
        };
      };
    };
    assert.equal(
      detailPayload.log.response.events?.some((event) => event.source === "stderr" && /Cancellation requested by the user/.test(event.text)),
      true,
    );

  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI cancel route can cancel a running job before the process spawns", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const featureAiNoProcess = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-no-process" });
  await (await startAiCommandJob({
    worktreeId: featureAiNoProcess.id,
    branch: "feature-ai-no-process",
    commandId: "smart",
    input: "wait",
    command: "printf %s 'wait'",
    repoRoot: repo.repoRoot,
    worktreePath: featureAiNoProcess.worktreePath,
    execute: async () => await new Promise<{ stdout: string; stderr: string }>(() => {}),
  })).started;
  const server = await startApiServer(repo, {
  });

  try {
    const cancelResponse = await server.fetch(`/api/worktrees/feature-ai-no-process/ai-command/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 200);

    const payload = await cancelResponse.json() as {
      job: {
        status: string;
        processName?: string | null;
        pid?: number | null;
        error?: string | null;
      };
    };
    assert.equal(payload.job.status, "failed");
    assert.equal(payload.job.processName?.startsWith("wtm:ai:"), true);
    assert.equal(payload.job.pid ?? null, null);
    assert.match(payload.job.error ?? "", /Cancellation requested by the user/);

    const runningJob = await getAiCommandJob(repo.repoRoot, worktreeId(path.join(repo.repoRoot, "feature-ai-no-process")), { reconcile: false });
    assert.ok(runningJob);
    assert.equal(runningJob.processName?.startsWith("wtm:ai:"), true);
    assert.equal(runningJob.pid ?? null, null);
    assert.equal(runningJob.status, "failed");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI prompts include environment, ports, quicklinks, and pm2 guidance when runtime is active", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const parsedConfig = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = serializeConfigContents({
    ...parsedConfig,
    runtimePorts: ["PORT"],
    quickLinks: [
      { name: "App", url: "http://127.0.0.1:${PORT}" },
    ],
    backgroundCommands: {
      web: { command: "node -e \"setInterval(() => {}, 1000)\"" },
    },
  }, { includeSchemaHeader: true });
  await fs.writeFile(repo.configPath, nextContents, "utf8");

  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const featureAiEnv = await createWorktree(repo.repoRoot, config, { branch: "feature-ai-env" });

  let capturedPrompt = "";
  const aiProcesses: InjectedAiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options) {
      const match = options.command.match(/^printf %s '([\s\S]*)'$/);
      capturedPrompt = match ? match[1].replace(/'\\''/g, "'") : options.command;
      return {
        name: "wtm:ai:test-env",
        pid: 9991,
        status: "stopped",
        exitCode: 0,
      };
    },
    async getProcess() {
      return {
        name: "wtm:ai:test-env",
        pid: 9991,
        status: "stopped",
        exitCode: 0,
      };
    },
    async readProcessLogs() {
      return { stdout: "done\n", stderr: "" };
    },
    isProcessActive(status) {
      return status === "online";
    },
  };
  const server = await startApiServer(repo, {
    aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const runtimeResponse = await server.fetch(`/api/worktrees/feature-ai-env/runtime/start`, {
      method: "POST",
    });
    assert.equal(runtimeResponse.status, 200);

    const response = await server.fetch(`/api/worktrees/feature-ai-env/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "inspect the runtime" }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      runtime?: { branch: string; tmuxSession: string; runtimeStartedAt?: string };
    };
    assert.equal(payload.runtime?.branch, "feature-ai-env");
    assert.equal(payload.runtime?.tmuxSession?.length ? true : false, true);
    assert.equal(typeof payload.runtime?.runtimeStartedAt, "string");

    assert.equal(capturedPrompt.includes("Environment wrapper:"), true);
    assert.equal(capturedPrompt.includes(`- Repository root: ${repo.repoRoot}`), true);
    assert.equal(capturedPrompt.includes("- Branch: feature-ai-env"), true);
    assert.equal(capturedPrompt.includes(`- Worktree path: ${path.join(repo.repoRoot, "feature-ai-env")}`), true);
    assert.equal(capturedPrompt.includes("- Runtime: active"), true);
    assert.equal(capturedPrompt.includes("PORT="), true);
    assert.equal(capturedPrompt.includes("- Allocated ports: PORT="), true);
    assert.equal(capturedPrompt.includes("- Quicklinks: App: http://127.0.0.1:"), true);
    assert.equal(capturedPrompt.includes(`web (wtm:${featureAiEnv.id}:web, online)`), true);
    assert.equal(capturedPrompt.includes(`pm2 logs wtm:${featureAiEnv.id}:web`), true);
    assert.equal(capturedPrompt.includes("Operator request:"), true);
    assert.equal(capturedPrompt.includes("inspect the runtime"), true);

    await waitFor(async () => {
      const statePayload = await readStateSnapshot<{
        worktrees: Array<{ branch: string; runtime?: { branch: string; tmuxSession: string } }>;
      }>(server, 1000);
      const runtime = statePayload.worktrees.find((entry) => entry.branch === "feature-ai-env")?.runtime;
      return runtime?.branch === "feature-ai-env" && runtime.tmuxSession === payload.runtime?.tmuxSession;
    });
  } finally {
    await stopAllBackgroundCommands(repo.repoRoot, featureAiEnv).catch(() => undefined);
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI auto-starts a runtime and stops it after completion when the runtime was created for the AI run", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "printf %s $WTM_AI_INPUT",
    simple: "node -e \"const text = process.argv[1] || ''; console.log(text.includes('git commit message') ? 'commit me' : text);\" $WTM_AI_INPUT",
    autoStartRuntime: true,
  });
  await fs.writeFile(repo.configPath, nextContents, "utf8");

  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  await createWorktree(repo.repoRoot, config, { branch: "feature-ai-auto-stop" });

  let capturedEnv: NodeJS.ProcessEnv | null = null;
  const aiProcesses: InjectedAiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options) {
      capturedEnv = options.env;
      return {
        name: "wtm:ai:test-auto-stop",
        pid: 9992,
        status: "stopped",
        exitCode: 0,
      };
    },
    async getProcess() {
      return {
        name: "wtm:ai:test-auto-stop",
        pid: 9992,
        status: "stopped",
        exitCode: 0,
      };
    },
    async readProcessLogs() {
      return { stdout: "done\n", stderr: "" };
    },
    isProcessActive(status) {
      return status === "online";
    },
  };
  const server = await startApiServer(repo, {
    aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const response = await server.fetch(`/api/worktrees/feature-ai-auto-stop/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "finish and shut down" }),
    });
    assert.equal(response.status, 200);

    const payload = await response.json() as {
      job: { branch: string };
      runtime?: { branch: string; worktreePath: string; tmuxSession: string; runtimeStartedAt?: string };
    };
    assert.equal(payload.job.branch, "feature-ai-auto-stop");
    assert.equal(payload.runtime?.branch, "feature-ai-auto-stop");
    assert.equal(payload.runtime?.worktreePath, path.join(repo.repoRoot, "feature-ai-auto-stop"));
    assert.equal(payload.runtime?.tmuxSession?.length ? true : false, true);
    assert.equal(typeof payload.runtime?.runtimeStartedAt, "string");

    if (!capturedEnv) {
      assert.fail("Expected AI process env to be captured.");
    }

    const processEnv: NodeJS.ProcessEnv = capturedEnv;

    assert.equal(processEnv.WORKTREE_BRANCH, "feature-ai-auto-stop");
    assert.equal(processEnv.WORKTREE_PATH, path.join(repo.repoRoot, "feature-ai-auto-stop"));
    assert.equal(processEnv.TMUX_SESSION_NAME, payload.runtime?.tmuxSession);

    await waitFor(async () => {
      const statePayload = await readStateSnapshot<{
        worktrees: Array<{ branch: string; runtime?: { branch: string } }>;
      }>(server, 1000);
      return statePayload.worktrees.find((entry) => entry.branch === "feature-ai-auto-stop")?.runtime === undefined;
    }, 15000);
  } finally {
    await server.close();
    await removePathWithRetry(repo.repoRoot);
  }
});

test("runtime restart reloads config changes and reconnect ensures the tmux session", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const initialConfig = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const branch = "feature-runtime-restart";
  await createWorktree(repo.repoRoot, initialConfig, { branch });

  const initialContents = serializeConfigContents({
    ...initialConfig,
    env: {
      ...initialConfig.env,
      FEATURE_FLAG: "old-value",
    },
    runtimePorts: ["APP_PORT"],
    quickLinks: [{ name: "App", url: "http://127.0.0.1:${APP_PORT}" }],
  }, { includeSchemaHeader: true });
  await fs.writeFile(repo.configPath, initialContents, "utf8");

  let capturedEnv: NodeJS.ProcessEnv | null = null;
  let capturedPrompt = "";
  const aiProcesses: InjectedAiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options) {
      capturedEnv = options.env;
      const match = options.command.match(/^printf %s '([\s\S]*)'$/);
      capturedPrompt = match ? match[1].replace(/'\\''/g, "'") : options.command;
      return {
        name: "wtm:ai:test-runtime-restart",
        pid: 9993,
        status: "stopped",
        exitCode: 0,
      };
    },
    async getProcess() {
      return {
        name: "wtm:ai:test-runtime-restart",
        pid: 9993,
        status: "stopped",
        exitCode: 0,
      };
    },
    async readProcessLogs() {
      return { stdout: "done\n", stderr: "" };
    },
    isProcessActive(status) {
      return status === "online";
    },
  };

  const server = await startApiServer(repo, {
    aiProcesses,
    aiProcessPollIntervalMs: 10,
  });

  try {
    const startResponse = await server.fetch(`/api/worktrees/${branch}/runtime/start`, { method: "POST" });
    assert.equal(startResponse.status, 200);
    const startedRuntime = await startResponse.json() as {
      env: Record<string, string>;
      quickLinks: Array<{ name: string; url: string }>;
      tmuxSession: string;
    };
    assert.equal(startedRuntime.env.FEATURE_FLAG, "old-value");
    assert.equal(startedRuntime.quickLinks[0]?.name, "App");
    assert.match(startedRuntime.quickLinks[0]?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+$/);

    const updatedConfig = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const updatedContents = serializeConfigContents({
      ...updatedConfig,
      env: {
        ...updatedConfig.env,
        FEATURE_FLAG: "new-value",
      },
      runtimePorts: ["API_PORT"],
      quickLinks: [{ name: "API", url: "http://127.0.0.1:${API_PORT}/health" }],
    }, { includeSchemaHeader: true });
    await fs.writeFile(repo.configPath, updatedContents, "utf8");

    const restartResponse = await server.fetch(`/api/worktrees/${branch}/runtime/restart`, { method: "POST" });
    assert.equal(restartResponse.status, 200);
    const restartedRuntime = await restartResponse.json() as {
      env: Record<string, string>;
      quickLinks: Array<{ name: string; url: string }>;
      tmuxSession: string;
    };
    assert.equal(restartedRuntime.env.FEATURE_FLAG, "new-value");
    assert.equal(restartedRuntime.quickLinks[0]?.name, "API");
    assert.match(restartedRuntime.quickLinks[0]?.url ?? "", /^http:\/\/127\.0\.0\.1:\d+\/health$/);
    assert.equal(restartedRuntime.tmuxSession, startedRuntime.tmuxSession);

    const reconnectResponse = await server.fetch(`/api/worktrees/${branch}/runtime/reconnect`, { method: "POST" });
    assert.equal(reconnectResponse.status, 200);
    const reconnectPayload = await reconnectResponse.json() as {
      tmuxSession: string;
      clients: unknown[];
      runtime?: { env: Record<string, string> };
    };
    assert.equal(reconnectPayload.tmuxSession, restartedRuntime.tmuxSession);
    assert.deepEqual(reconnectPayload.clients, []);
    assert.equal(reconnectPayload.runtime?.env.FEATURE_FLAG, "new-value");

    const aiResponse = await server.fetch(`/api/worktrees/${branch}/ai-command/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: "verify restarted runtime" }),
    });
    assert.equal(aiResponse.status, 200);
    const aiPayload = await aiResponse.json() as {
      job: { jobId: string };
    };

    if (!capturedEnv) {
      assert.fail("Expected AI process env to be captured after runtime restart.");
    }

    const processEnv: NodeJS.ProcessEnv = capturedEnv;

    assert.equal(processEnv.FEATURE_FLAG, "new-value");
    assert.equal(processEnv.WORKTREE_BRANCH, branch);
    assert.match(capturedPrompt, /- Runtime env: .*FEATURE_FLAG=new-value/);
    assert.match(capturedPrompt, /- Quicklinks: API: http:\/\/127\.0\.0\.1:\d+\/health/);
    assert.match(capturedPrompt, /- Allocated ports: API_PORT=\d+/);

    await waitForAiCommandJob(repo.repoRoot, worktreeId(path.join(repo.repoRoot, branch)), aiPayload.job.jobId);
  } finally {
    await stopAllBackgroundCommands(repo.repoRoot, {
      id: worktreeId(path.join(repo.repoRoot, branch)),
      branch,
      worktreePath: path.join(repo.repoRoot, branch),
    }).catch(() => undefined);
    await server.close();
    await removePathWithRetry(repo.repoRoot);
  }
});
