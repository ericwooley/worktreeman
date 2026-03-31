import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createBareRepoLayout, ensurePrimaryWorktrees } from "./repository-layout-service.js";
import { initRepository } from "./init-service.js";
import { findRepoContext } from "../utils/paths.js";
import { enqueueProjectManagementAiJob, startProjectManagementAiWorker, stopAiCommandJobManager } from "./ai-command-job-manager-service.js";
import { configureDatabaseConnection } from "./database-connection-service.js";
import { startDatabaseSocketServer, stopDatabaseSocketServer } from "./database-socket-service.js";
import { getAiCommandJob } from "./ai-command-service.js";
import { stopOperationalStateStore } from "./operational-state-service.js";
import { getAiCommandProcessName } from "./ai-command-process-service.js";

async function waitFor<T>(callback: () => Promise<T | null | undefined> | T | null | undefined, timeoutMs = 15000, intervalMs = 50): Promise<T> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const value = await callback();
    if (value != null) {
      return value;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function createLineCollector(target: { push: (line: string) => void }) {
  let buffer = "";
  return (chunk: string | Uint8Array) => {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      target.push(buffer.slice(0, newlineIndex).replace(/\r$/, ""));
      buffer = buffer.slice(newlineIndex + 1);
      newlineIndex = buffer.indexOf("\n");
    }
  };
}

async function waitForChildExit(child: ChildProcess, timeoutMs = 20000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for child process ${child.pid ?? "unknown"} to exit.`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

test("startProjectManagementAiWorker logs manager and worker readiness", async () => {
  configureDatabaseConnection(null);

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-worker-"));
  const stdoutLines: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutLines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
    await initRepository(rootDir, { baseDir: ".", runtimePorts: [], force: false });
    const repo = await findRepoContext(rootDir);
    const worker = await startProjectManagementAiWorker({ repoRoot: repo.repoRoot });
    await worker.close();
    await stopAiCommandJobManager(repo.repoRoot);

    const output = stdoutLines.join("");
    assert.match(output, /\[ai-job-queue\] manager-ready/);
    assert.match(output, /queue=project-management-ai-update/);
    assert.match(output, /supervise=false/);
    assert.match(output, /\[ai-job-queue\] worker-ready/);
    assert.match(output, /pollingIntervalSeconds=0\.5/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("worker entrypoint shutdown drains active AI job without killing its child process", { timeout: 20000 }, async () => {
  configureDatabaseConnection(null);

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-worker-"));
  let workerChild: ChildProcess | undefined;
  let databaseStarted = false;
  let repoRoot = rootDir;

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
    await initRepository(rootDir, { baseDir: ".", runtimePorts: [], force: false });
    const repo = await findRepoContext(rootDir);
    repoRoot = repo.repoRoot;
    const database = await startDatabaseSocketServer(repo.repoRoot);
    databaseStarted = true;
    configureDatabaseConnection(database.connectionString);

    const stdoutLines: string[] = [];
    const stderrLines: string[] = [];
    const collectStdout = createLineCollector({ push: (line) => stdoutLines.push(line) });
    const collectStderr = createLineCollector({ push: (line) => stderrLines.push(line) });
    const workerEntrypointPath = fileURLToPath(new URL("../entrypoints/worker-entrypoint.ts", import.meta.url));
    workerChild = spawn("node", ["--import", "tsx", workerEntrypointPath, "--cwd", repo.repoRoot, "--database-url", database.connectionString], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    workerChild.stdout?.on("data", collectStdout);
    workerChild.stderr?.on("data", collectStderr);

    await waitFor(() => {
      return stdoutLines.some((line) => line.includes('"type":"worker-ready"')) ? true : null;
    });

    const startedJob = await enqueueProjectManagementAiJob({
      repoRoot: repo.repoRoot,
      payload: {
        branch: "main",
        commandId: "smart",
        worktreePath: path.join(repo.repoRoot, "main"),
        input: "test drain",
        renderedCommand: `node -e "setTimeout(() => { process.stdout.write('done\\n'); process.exit(0); }, 1500)"`,
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        aiCommands: {
          smart: "smart",
          simple: "simple",
          autoStartRuntime: false,
        },
        documentId: "test-document",
      },
    });

    const runningJob = await waitFor(async () => {
      const job = await getAiCommandJob(repo.repoRoot, "main", { reconcile: false });
      return job?.jobId === startedJob.jobId && typeof job.pid === "number" ? job : null;
    });

    workerChild.kill("SIGTERM");

    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(workerChild.exitCode, null);
    assert.doesNotThrow(() => process.kill(runningJob.pid!, 0));

    const completedJob = await waitFor(async () => {
      const job = await getAiCommandJob(repo.repoRoot, "main", { reconcile: false });
      return job?.jobId === startedJob.jobId && job.status === "completed" ? job : null;
    }, 20000, 100);

    assert.equal(completedJob.exitCode, 0);
    assert.match(completedJob.stdout, /done/);

    const workerExit = await waitForChildExit(workerChild);
    assert.equal(workerExit.code, 0);
    assert.equal(stderrLines.join("\n"), "");
  } finally {
    if (workerChild && workerChild.exitCode === null && workerChild.signalCode === null) {
      workerChild.kill("SIGKILL");
      await waitForChildExit(workerChild).catch(() => undefined);
    }
    await stopAiCommandJobManager(repoRoot).catch(() => undefined);
    await stopOperationalStateStore(repoRoot).catch(() => undefined);
    configureDatabaseConnection(null);
    if (databaseStarted) {
      await stopDatabaseSocketServer(repoRoot).catch(() => undefined);
    }
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test("queued project-management AI jobs stay running before the worker spawns the process", async () => {
  configureDatabaseConnection(null);

  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-ai-worker-"));

  try {
    await createBareRepoLayout({ rootDir });
    await ensurePrimaryWorktrees({ rootDir, createMissingBranches: true });
    await initRepository(rootDir, { baseDir: ".", runtimePorts: [], force: false });
    const repo = await findRepoContext(rootDir);

    const origin = {
      kind: "project-management-document-run",
      label: "Project management document run",
      location: {
        tab: "project-management",
        projectManagementSubTab: "document",
        documentId: "doc-123",
        projectManagementDocumentViewMode: "document",
      },
    } as const;

    const queuedJob = await enqueueProjectManagementAiJob({
      repoRoot: repo.repoRoot,
      payload: {
        branch: "main",
        commandId: "smart",
        worktreePath: path.join(repo.repoRoot, "main"),
        input: "draft the next steps",
        renderedCommand: "printf %s 'waiting for worker'",
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
        aiCommands: {
          smart: "smart",
          simple: "simple",
          autoStartRuntime: false,
        },
        documentId: "doc-123",
        origin,
      },
    });

    assert.equal(queuedJob.status, "running");
    assert.equal(queuedJob.processName, getAiCommandProcessName(queuedJob.jobId));
    assert.equal(queuedJob.origin?.kind, "project-management-document-run");
    assert.equal(queuedJob.documentId, "doc-123");

    const reconciledJob = await getAiCommandJob(repo.repoRoot, "main");
    assert.ok(reconciledJob);
    assert.equal(reconciledJob.jobId, queuedJob.jobId);
    assert.equal(reconciledJob.status, "running");
    assert.equal(reconciledJob.processName, getAiCommandProcessName(queuedJob.jobId));
    assert.equal(reconciledJob.pid, null);
    assert.equal(reconciledJob.error ?? null, null);
    assert.equal(reconciledJob.origin?.kind, "project-management-document-run");
    assert.equal(reconciledJob.origin?.location.documentId, "doc-123");
    assert.equal(reconciledJob.documentId, "doc-123");
  } finally {
    await stopAiCommandJobManager(rootDir).catch(() => undefined);
    await stopOperationalStateStore(rootDir).catch(() => undefined);
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});
