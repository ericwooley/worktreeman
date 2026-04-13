import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "#test-runtime";
import { worktreeId } from "../../shared/worktree-id.js";
import {
  createApiTestRepo,
  createFakeAiProcesses,
  openSse,
  startApiServer,
  writeAiLogFixture,
} from "./api-test-helpers.js";
import { loadConfig } from "../services/config-service.js";
import { createWorktree } from "../services/git-service.js";
import { createOperationalStateStore } from "../services/operational-state-service.js";
import type { AiCommandOrigin } from "../../shared/types.js";

function fixtureJobId(worktreePath: string, fileName: string): string {
  return `job-${worktreeId(worktreePath)}-${fileName}`;
}

function fixtureFileName(worktreePath: string, label: string): string {
  return `${worktreeId(worktreePath)}-${label}`;
}

test("AI log routes list logs and expose running jobs", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
  const fileName = fixtureFileName(worktreePath, "running-log.json");
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
    fileName,
    branch: "feature-ai-log",
    origin,
    worktreePath,
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

    assert.equal(listPayload.logs.some((entry) => entry.fileName === fileName), false);
    assert.equal(listPayload.runningJobs.length, 1);
    assert.equal(listPayload.runningJobs[0].fileName, fileName);
    assert.equal(listPayload.runningJobs[0].branch, "feature-ai-log");
    assert.equal(listPayload.runningJobs[0].status, "running");
    assert.equal(listPayload.runningJobs[0].pid ?? null, 7331);
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
    assert.equal(detailPayload.log.pid ?? null, 7331);
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
  const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
  const fileName = fixtureFileName(worktreePath, "stream-log.json");
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
    fileName,
    branch: "feature-ai-log",
    origin,
    worktreePath,
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
    const sse = await openSse(`${await server.url()}/api/ai/logs/${encodeURIComponent(fixtureJobId(worktreePath, fileName))}/stream`);

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
      fileName,
      branch: "feature-ai-log",
      origin,
      worktreePath,
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
      fileName,
      branch: "feature-ai-log",
      origin,
      worktreePath,
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
  const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
  const fileName = fixtureFileName(worktreePath, "missing-process.json");
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
    fileName,
    branch: "feature-ai-log",
    origin,
    worktreePath,
    command: "printf %s 'recover me'",
    request: "recover me",
    processName: "wtm:ai:missing-process",
    stdout: "partial output",
  });
  const server = await startApiServer(repo, {
    aiProcesses: fakeAiProcesses.aiProcesses,
  });

  try {
    const detailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(fileName)}`);
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
    assert.equal(listPayload.logs[0].fileName, fileName);
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
        job?: { status?: string; error?: string | null; stderr?: string; branch?: string } | null;
      }).job;

      assert.equal(snapshot.type, "snapshot");
      assert.equal(snapshotJob?.branch, "feature-ai-restart");
      assert.equal(snapshotJob?.status, "failed");
      assert.match(snapshotJob?.stderr ?? "", /no longer available/);
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
