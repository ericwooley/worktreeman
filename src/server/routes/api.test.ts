import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import express from "express";
import request from "supertest";
import { createApiRouter, resolveAiLogsDir } from "./api.js";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "../services/repository-layout-service.js";
import { initRepository } from "../services/init-service.js";
import { createWorktree } from "../services/git-service.js";
import { loadConfig, readConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { findRepoContext } from "../utils/paths.js";
import { runCommand } from "../utils/process.js";
import { RuntimeStore } from "../state/runtime-store.js";
import { ShutdownStatusService } from "../services/shutdown-status-service.js";
import { getProjectManagementDocument, getProjectManagementDocumentHistory } from "../services/project-management-service.js";
import { clearAiCommandJobs, startAiCommandJob } from "../services/ai-command-service.js";
import { stopAllAiCommandJobManagers } from "../services/ai-command-job-manager-service.js";
import { startServer } from "../app.js";
import { resolveTmuxSessionName } from "../services/terminal-service.js";
import { getTmuxSessionName } from "../../shared/tmux.js";
import type { AiCommandJob } from "../../shared/types.js";

type RouterOptions = Parameters<typeof createApiRouter>[0];
type InjectedAiProcesses = NonNullable<RouterOptions["aiProcesses"]>;
type StartAiQueueJob = (payload: {
  branch: string;
  documentId: string;
  commandId: "smart" | "simple";
  input: string;
  renderedCommand: string;
  worktreePath: string;
  env: Record<string, string>;
}, context: { notifyStarted: (job: AiCommandJob) => void }) => Promise<void>;

interface FakeAiProcessSnapshot {
  status: string | null;
  stdout?: string;
  stderr?: string;
  pid?: number;
  exitCode?: number | null;
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
      return {
        stdout: snapshot.stdout ?? "",
        stderr: snapshot.stderr ?? "",
      };
    },
    async deleteProcess(processName) {
      deletedProcesses.push(processName);
      manualStates.delete(processName);
      scriptedStates.delete(processName);
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
  worktreePath: string;
  command: string;
  request: string;
  processName?: string | null;
  pid?: number | null;
  stdout?: string;
  stderr?: string;
  completedAt?: string | null;
  exitCode?: number | null;
  error?: unknown;
}) {
  const timestamp = new Date().toISOString();
  const logsDir = resolveAiLogsDir(options.repoRoot);
  await fs.mkdir(logsDir, { recursive: true });
  const logPath = path.join(logsDir, options.fileName);
  await fs.writeFile(logPath, `${JSON.stringify({
    jobId: `job-${options.fileName}`,
    timestamp,
    startedAt: timestamp,
    completedAt: options.completedAt ?? null,
    branch: options.branch,
    commandId: options.commandId ?? "smart",
    worktreePath: options.worktreePath,
    command: options.command,
    pid: options.pid ?? null,
    exitCode: options.exitCode ?? null,
    processName: options.processName ?? null,
    request: options.request,
    response: {
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
    },
    error: options.error ?? null,
  }, null, 2)}\n`, "utf8");
  return logPath;
}

async function openSse(url: string) {
  const controller = new AbortController();
  const response = await fetch(url, {
    headers: { Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.ok(response.body);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  async function readChunk(timeoutMs: number) {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(`Timed out waiting for SSE chunk after ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
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

        const chunk = await readChunk(timeoutMs);
        if (chunk.done) {
          throw new Error("SSE stream closed before the next event arrived.");
        }

        buffer += decoder.decode(chunk.value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // ignore abort/cancel errors during cleanup
      }
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
  overrides?: Partial<Pick<RouterOptions, "aiProcesses" | "aiProcessPollIntervalMs" | "aiLogStreamPollIntervalMs">> & {
    onEnqueueProjectManagementAiJob?: StartAiQueueJob;
  },
) {
  const app = express();
  app.use(express.json());
  app.use("/api", createApiRouter({
    repoRoot: repo.repoRoot,
    configPath: repo.configPath,
    configSourceRef: repo.configSourceRef,
    configFile: repo.configFile,
    configWorktreePath: repo.configWorktreePath,
    runtimes: new RuntimeStore(),
    shutdownStatus: new ShutdownStatusService(),
    onEnqueueProjectManagementAiJob: overrides?.onEnqueueProjectManagementAiJob,
    ...(overrides ?? {}),
  }));

  let server: http.Server | null = null;
  let liveBaseUrl: string | null = null;

  const ensureLiveBaseUrl = async () => {
    if (liveBaseUrl) {
      return liveBaseUrl;
    }

    server = http.createServer(app);
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
      if (!server) {
        return;
      }

      await new Promise<void>((resolve, reject) => {
        server?.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

test.afterEach(async () => {
  clearAiCommandJobs();
  await stopAllAiCommandJobManagers();
});

test("startServer fails fast when the initial tmux session cannot be prepared", { concurrency: false }, async () => {
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
    assert.equal(
      resolveTmuxSessionName({
        repoRoot: repo.repoRoot,
        branch: "main",
        worktreePath: path.join(repo.repoRoot, "main"),
      }),
      getTmuxSessionName(repo.repoRoot, "main"),
    );
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

test("AI command logs are written under the resolved repo root .logs directory", { concurrency: false }, async () => {
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

    const logsDir = resolveAiLogsDir(repo.repoRoot);
    await waitFor(async () => {
      try {
        const entries = (await fs.readdir(logsDir)).filter((entry) => entry.endsWith(".json"));
        return entries.length > 0;
      } catch {
        return false;
      }
    });

    await waitFor(async () => {
      const entries = (await fs.readdir(logsDir)).filter((entry) => entry.endsWith(".json"));
      if (entries.length === 0) {
        return false;
      }

      const payload = JSON.parse(await fs.readFile(path.join(logsDir, entries[0]), "utf8")) as {
        response?: { stdout?: string };
        pid?: number | null;
        completedAt?: string | null;
      };
      return payload.response?.stdout === "rewrite the document" && payload.pid === 4123 && typeof payload.completedAt === "string";
    });

    const entries = (await fs.readdir(logsDir)).filter((entry) => entry.endsWith(".json"));
    assert.equal(entries.length > 0, true);

    const logPath = path.join(logsDir, entries[0]);
    const logPayload = JSON.parse(await fs.readFile(logPath, "utf8")) as {
      branch: string;
      pid: number | null;
      processName: string | null;
      request: string;
      completedAt: string | null;
      response: { stdout: string; stderr: string };
    };

    assert.equal(logPayload.branch, "feature-ai-log");
    assert.equal(logPayload.pid, 4123);
    assert.equal(typeof logPayload.processName, "string");
    assert.equal(logPayload.request, "rewrite the document");
    assert.equal(typeof logPayload.completedAt, "string");
    assert.equal(logPayload.response.stdout, "rewrite the document");
    await assert.rejects(fs.access(path.join(repo.configWorktreePath, ".logs")));
  } finally {
    await server.close();
    await waitForPathToDisappear(path.join(resolveAiLogsDir(repo.repoRoot), "cancel-job.stdout.log")).catch(() => undefined);
    await waitForPathToDisappear(path.join(resolveAiLogsDir(repo.repoRoot), "cancel-job.stderr.log")).catch(() => undefined);
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
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

    const response = await server.fetch(`/api/git/compare/feature-ai-resolve-merge/resolve-conflicts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseBranch: "main", commandId: "smart" }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      mergeIntoCompareStatus: { hasConflicts: boolean; conflicts: Array<unknown> };
      workingTreeSummary: { dirty: boolean };
    };
    assert.equal(payload.mergeIntoCompareStatus.hasConflicts, false);
    assert.equal(payload.mergeIntoCompareStatus.conflicts.length, 0);
    assert.equal(payload.workingTreeSummary.dirty, true);

    const resolved = await fs.readFile(path.join(feature.worktreePath, "shared.txt"), "utf8");
    assert.equal(resolved, "resolved by ai\n");
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

test("AI log routes list logs and expose running jobs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
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
      logs: Array<{ fileName: string; branch: string; requestPreview: string; status: string; pid?: number | null }>;
      runningJobs: Array<{ fileName: string; branch: string; status: string; pid?: number | null }>;
    };

    assert.equal(listPayload.logs.length > 0, true);
    assert.equal(listPayload.logs[0].branch, "feature-ai-log");
    assert.equal(listPayload.logs[0].requestPreview.includes("summarize the work"), true);
    assert.equal(listPayload.logs[0].status, "running");
    assert.equal(listPayload.logs[0].pid, 7331);
    assert.equal(listPayload.runningJobs.length, 1);
    assert.equal(listPayload.runningJobs[0].fileName, "running-log.json");
    assert.equal(listPayload.runningJobs[0].pid, 7331);

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(listPayload.logs[0].fileName)}`);
    assert.equal(detailResponse.status, 200);

    const detailPayload = await detailResponse.json() as {
      log: {
        fileName: string;
        branch: string;
        status: string;
        pid?: number | null;
        request: string;
        response: { stdout: string; stderr: string };
      };
    };

    assert.equal(detailPayload.log.fileName, listPayload.logs[0].fileName);
    assert.equal(detailPayload.log.branch, "feature-ai-log");
    assert.equal(detailPayload.log.status, "running");
    assert.equal(detailPayload.log.pid, 7331);
    assert.equal(detailPayload.log.request, "summarize the work");
    assert.equal(detailPayload.log.response.stdout, "live stdout\n");
    assert.equal(detailPayload.log.response.stderr, "live stderr\n");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI log detail stream emits live updates and completion for running logs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  fakeAiProcesses.setManualProcess("wtm:ai:stream-log", {
    status: "online",
    pid: 9001,
    stdout: "first line\n",
    stderr: "",
  });
  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName: "stream-log.json",
    branch: "feature-ai-log",
    worktreePath: path.join(repo.repoRoot, "feature-ai-log"),
    command: "printf %s 'stream me'",
    request: "stream me",
    processName: "wtm:ai:stream-log",
  });
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
    aiLogStreamPollIntervalMs: 20,
  });

  try {
    const sse = await openSse(`${await server.url()}/api/ai/logs/${encodeURIComponent("stream-log.json")}/stream`);

    const snapshot = await sse.nextEvent();
    const snapshotLog = snapshot.log as {
      status: string;
      pid?: number | null;
      response: { stdout: string };
    };
    assert.equal(snapshot.type, "snapshot");
    assert.equal(snapshotLog.status, "running");
    assert.equal(snapshotLog.pid, 9001);
    assert.equal(snapshotLog.response.stdout, "first line\n");

    fakeAiProcesses.updateManualProcess("wtm:ai:stream-log", {
      stdout: "first line\nsecond line\n",
      stderr: "warn\n",
    });

    const runningUpdate = await sse.nextEvent();
    const runningLog = runningUpdate.log as {
      status: string;
      response: { stdout: string; stderr: string };
    };
    assert.equal(runningUpdate.type, "update");
    assert.equal(runningLog.status, "running");
    assert.equal(runningLog.response.stdout, "first line\nsecond line\n");
    assert.equal(runningLog.response.stderr, "warn\n");

    fakeAiProcesses.updateManualProcess("wtm:ai:stream-log", {
      status: "stopped",
      exitCode: 0,
    });

    const completedUpdate = await sse.nextEvent();
    const completedLog = completedUpdate.log as {
      status: string;
      exitCode?: number | null;
      completedAt?: string;
      response: { stdout: string; stderr: string };
    };
    assert.equal(completedUpdate.type, "update");
    assert.equal(completedLog.status, "completed");
    assert.equal(completedLog.exitCode, 0);
    assert.equal(typeof completedLog.completedAt, "string");
    assert.equal(completedLog.response.stderr, "warn\n");

    await sse.close();
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("missing AI processes reconcile stale running logs to a failed terminal state", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName: "missing-process.json",
    branch: "feature-ai-log",
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
        error: { message: string } | null;
        response: { stdout: string };
      };
    };

    assert.equal(detailPayload.log.status, "failed");
    assert.equal(typeof detailPayload.log.completedAt, "string");
    assert.equal(detailPayload.log.response.stdout, "partial output");
    assert.equal(detailPayload.log.error?.message.includes("no longer available"), true);

    const listResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json() as {
      runningJobs: Array<unknown>;
      logs: Array<{ fileName: string; status: string }>;
    };

    assert.equal(listPayload.runningJobs.length, 0);
    assert.equal(listPayload.logs[0].fileName, "missing-process.json");
    assert.equal(listPayload.logs[0].status, "failed");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management AI runs update the saved document on the server", { concurrency: false }, async () => {
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
      logs: Array<{ documentId?: string | null; status: string }>;
    };
    assert.equal(logsPayload.logs[0]?.documentId, outline.id);
    assert.equal(logsPayload.logs[0]?.status, "completed");
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
      logs: Array<{ fileName: string }>;
    };

    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(logsPayload.logs[0].fileName)}`);
    assert.equal(detailResponse.status, 200);
    const detailPayload = await detailResponse.json() as {
      log: {
        response: { stdout: string; stderr: string };
      };
    };

    assert.equal(detailPayload.log.response.stdout, "# Clean Markdown\n\nOnly stdout belongs here.\n");
    assert.equal(detailPayload.log.response.stderr, "> build · gpt-4.1\n");
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
      logs: Array<{ documentId?: string | null; status: string }>;
      runningJobs: Array<unknown>;
    };

    assert.equal(logsPayload.runningJobs.length, 0);
    assert.equal(logsPayload.logs[0]?.documentId, "missing-document");
    assert.equal(logsPayload.logs[0]?.status, "failed");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management document AI creates a derived worktree and streams stdout from that worktree job", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  let capturedCommand = "";
  let capturedWorktreePath = "";
  let capturedEnv: NodeJS.ProcessEnv | null = null;
  const aiProcesses: InjectedAiProcesses = {
    ...fakeAiProcesses.aiProcesses,
    async startProcess(options) {
      capturedCommand = options.command;
      capturedWorktreePath = options.worktreePath;
      capturedEnv = options.env;
      return await fakeAiProcesses.aiProcesses.startProcess(options);
    },
  };

  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 6123, stdout: "planning...\n", stderr: "" },
    { status: "online", pid: 6123, stdout: "planning...\nimplemented\n", stderr: "" },
    { status: "stopped", pid: 6123, stdout: "planning...\nimplemented\n", stderr: "", exitCode: 0 },
  ]);

  const server = await startApiServer(repo, {
    aiProcesses,
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

    const stateResponse = await server.fetch(`/api/state`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json() as {
      worktrees: Array<{ branch: string; worktreePath: string; runtime?: { tmuxSession: string } }>;
    };
    const createdWorktree = statePayload.worktrees.find((entry) => entry.branch === payload.job.branch);
    assert.ok(createdWorktree);
    if (!capturedEnv) {
      assert.fail("Expected AI process env to be captured.");
    }
    const processEnv: NodeJS.ProcessEnv = capturedEnv;
    assert.equal(capturedWorktreePath, createdWorktree.worktreePath);
    assert.equal(createdWorktree.runtime?.tmuxSession?.length ? true : false, true);
    assert.equal(processEnv.WORKTREE_BRANCH, payload.job.branch);
    assert.equal(processEnv.WORKTREE_PATH, createdWorktree.worktreePath);
    assert.equal(processEnv.TMUX_SESSION_NAME, createdWorktree.runtime?.tmuxSession);
    assert.equal(capturedCommand.includes("You are implementing the work described by the project-management document"), true);
    assert.equal(capturedCommand.includes("in worktree"), false);
    assert.equal(capturedCommand.includes("Worktree path:"), false);
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
      assert.equal((snapshot as { job?: { branch?: string } }).job?.branch, payload.job.branch);

      await waitFor(async () => {
        const logsResponse = await server.fetch(`/api/ai/logs`);
        if (logsResponse.status !== 200) {
          return false;
        }
        const logsPayload = await logsResponse.json() as {
          logs: Array<{ branch: string; status: string }>;
        };
        return logsPayload.logs.some((entry) => entry.branch === payload.job.branch && entry.status === "completed");
      });

      let sawImplemented = false;
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
      assert.equal(sawImplemented, true);
    } finally {
      await stream.close();
    }

    const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(updated.document.title, "Project Outline");
    assert.equal(updated.document.markdown.includes("implemented"), false);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI cancel route deletes the running process and returns the settled failed job", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  await createWorktree(repo.repoRoot, config, { branch: "feature-ai-cancel" });
  const fakeAiProcesses = createFakeAiProcesses();
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
      job: { branch: string; status: string; processName?: string | null; error?: string | null; completedAt?: string | null };
    };
    assert.equal(cancelPayload.job.branch, "feature-ai-cancel");
    assert.equal(cancelPayload.job.status, "failed");
    assert.equal(cancelPayload.job.processName?.startsWith("wtm:ai:"), true);
    assert.equal(typeof cancelPayload.job.completedAt, "string");
    assert.match(cancelPayload.job.error ?? "", /Cancellation requested by the user/);
    assert.equal(fakeAiProcesses.deletedProcesses.length, 1);
    assert.equal(fakeAiProcesses.deletedProcesses[0]?.startsWith("wtm:ai:"), true);

    await waitFor(async () => {
      const logsResponse = await server.fetch(`/api/ai/logs`);
      if (logsResponse.status !== 200) {
        return false;
      }

      const logsPayload = await logsResponse.json() as {
        runningJobs: Array<{ branch: string }>;
        logs: Array<{ branch: string; status: string }>;
      };

      const runningForBranch = logsPayload.runningJobs.some((entry) => entry.branch === "feature-ai-cancel");
      const failedLog = logsPayload.logs.find((entry) => entry.branch === "feature-ai-cancel");
      return !runningForBranch && failedLog?.status === "failed";
    });

  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("AI cancel route returns 409 when the running job has no process name", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  await createWorktree(repo.repoRoot, config, { branch: "feature-ai-no-process" });
  await startAiCommandJob({
    branch: "feature-ai-no-process",
    commandId: "smart",
    input: "wait",
    command: "printf %s 'wait'",
    repoRoot: repo.repoRoot,
    worktreePath: path.join(repo.repoRoot, "feature-ai-no-process"),
    execute: async () => await new Promise<{ stdout: string; stderr: string }>(() => {}),
    writeLog: async () => null,
  });
  const server = await startApiServer(repo, {
  });

  try {
    const cancelResponse = await server.fetch(`/api/worktrees/feature-ai-no-process/ai-command/cancel`, {
      method: "POST",
    });
    assert.equal(cancelResponse.status, 409);

    const payload = await cancelResponse.json() as { message: string };
    assert.equal(payload.message, "Running AI command for feature-ai-no-process cannot be cancelled yet.");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});
