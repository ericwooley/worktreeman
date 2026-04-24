import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import test from "#test-runtime";
import express from "express";
import request from "supertest";
import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { getTmuxSessionName } from "../../shared/tmux.js";
import { worktreeId } from "../../shared/worktree-id.js";
import { createApiRouter } from "./api.js";
import {
  allocateTestPort,
  createApiTestRepo,
  openSse,
  readStateSnapshot,
  startApiServer,
  writeAiLogFixture,
} from "./api-test-helpers.js";
import { loadConfig } from "../services/config-service.js";
import { createWorktree } from "../services/git-service.js";
import { createOperationalStateStore } from "../services/operational-state-service.js";
import { closeManagedDatabaseClient, getManagedDatabaseClient } from "../services/database-client-service.js";
import { findWorktreePathForRef } from "../utils/paths.js";
import { runCommand } from "../utils/process.js";
import { startServer } from "../app.js";
import { resolveTmuxSessionName } from "../services/terminal-service.js";
import type { AiCommandOrigin, SystemStatusResponse } from "../../shared/types.js";

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

test("GET /api/events/stream multiplexes initial dashboard snapshots", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const stream = await openSse(`${await server.url()}/api/events/stream`);

    try {
      const stateSnapshot = await stream.nextEvent() as unknown as { type: "state"; event: { type: string; state: { worktrees: unknown[] } } };
      const shutdownSnapshot = await stream.nextEvent() as unknown as { type: "shutdown-status"; event: { type: string; status: { active: boolean } } };
      const systemSnapshot = await stream.nextEvent() as unknown as { type: "system-status"; event: { type: string; status: { capturedAt: string } } };
      const aiLogsSnapshot = await stream.nextEvent() as unknown as { type: "ai-logs"; event: { type: string; logs: { logs: unknown[]; runningJobs: unknown[] } } };
      const usersSnapshot = await stream.nextEvent() as unknown as { type: "project-management-users"; event: { type: string; users: { users: unknown[] } } };
      const documentsSnapshot = await stream.nextEvent() as unknown as { type: "project-management-documents"; event: { type: string; documents: { documents: unknown[] } } };

      assert.equal(stateSnapshot.type, "state");
      assert.equal(stateSnapshot.event.type, "snapshot");
      assert.ok(Array.isArray(stateSnapshot.event.state.worktrees));

      assert.equal(shutdownSnapshot.type, "shutdown-status");
      assert.equal(shutdownSnapshot.event.type, "snapshot");
      assert.equal(typeof shutdownSnapshot.event.status.active, "boolean");

      assert.equal(systemSnapshot.type, "system-status");
      assert.equal(systemSnapshot.event.type, "snapshot");
      assert.equal(typeof systemSnapshot.event.status.capturedAt, "string");

      assert.equal(aiLogsSnapshot.type, "ai-logs");
      assert.equal(aiLogsSnapshot.event.type, "snapshot");
      assert.ok(Array.isArray(aiLogsSnapshot.event.logs.logs));
      assert.ok(Array.isArray(aiLogsSnapshot.event.logs.runningJobs));

      assert.equal(usersSnapshot.type, "project-management-users");
      assert.equal(usersSnapshot.event.type, "snapshot");
      assert.ok(Array.isArray(usersSnapshot.event.users.users));

      assert.equal(documentsSnapshot.type, "project-management-documents");
      assert.equal(documentsSnapshot.event.type, "snapshot");
      assert.ok(Array.isArray(documentsSnapshot.event.documents.documents));
    } finally {
      await stream.close();
      await server.close();
    }
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/events/stream multiplexes AI log updates", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
  const fileName = `${worktreeId(worktreePath)}-events-stream-log.json`;
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
    command: "printf %s 'events stream me'",
    request: "events stream me",
    processName: "wtm:ai:events-stream-log",
    pid: 9010,
    stdout: "first line\n",
  });

  try {
    const server = await startApiServer(repo, { aiLogStreamPollIntervalMs: 10 });
    const stream = await openSse(`${await server.url()}/api/events/stream`);

    try {
      let aiLogsSnapshot: {
        type: "ai-logs";
        event: {
          type: string;
          logs: {
            logs: Array<{ fileName: string; status: string; requestPreview?: string; command?: string }>;
            runningJobs: Array<{ fileName: string; status: string; origin?: AiCommandOrigin | null }>;
          };
        };
      } | null = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const event = await stream.nextEvent() as unknown as {
          type: string;
          event?: {
            type: string;
            logs: {
            logs: Array<{ fileName: string; status: string; requestPreview?: string; command?: string }>;
            runningJobs: Array<{ fileName: string; status: string; origin?: AiCommandOrigin | null }>;
          };
        };
        };

        if (event.type === "ai-logs" && event.event) {
          aiLogsSnapshot = {
            type: "ai-logs",
            event: event.event,
          };
          break;
        }
      }

      assert.ok(aiLogsSnapshot);

      assert.equal(aiLogsSnapshot.type, "ai-logs");
      assert.equal(aiLogsSnapshot.event.type, "snapshot");
      assert.equal(aiLogsSnapshot.event.logs.logs.some((entry: { fileName: string; status: string }) => entry.fileName === fileName), false);
      assert.equal(aiLogsSnapshot.event.logs.runningJobs.length, 1);
      assert.equal(aiLogsSnapshot.event.logs.runningJobs[0].fileName, fileName);
      assert.equal(aiLogsSnapshot.event.logs.runningJobs[0].status, "running");
      assert.deepEqual(aiLogsSnapshot.event.logs.runningJobs[0].origin, origin);
      assert.equal(aiLogsSnapshot.event.logs.runningJobs[0].fileName, fileName);

      await writeAiLogFixture({
        repoRoot: repo.repoRoot,
        fileName,
        branch: "feature-ai-log",
        origin,
        worktreePath,
        command: "printf %s 'events stream me'",
        request: "events stream me",
        processName: "wtm:ai:events-stream-log",
        pid: 9010,
        stdout: "first line\nsecond line\n",
        exitCode: 0,
        completedAt: "2026-03-27T10:01:30.000Z",
      });

      for (let attempt = 0; attempt < 8; attempt += 1) {
        const event = await stream.nextEvent() as unknown as {
          type: string;
          event?: {
            type: string;
            logs: {
               logs: Array<{ fileName: string; status: string; origin?: AiCommandOrigin | null; requestPreview?: string; command?: string }>;
               runningJobs: Array<{ fileName: string; status: string }>;
             };
           };
        };

        if (event.type !== "ai-logs") {
          continue;
        }

        const completedLog = event.event?.logs.logs.find((entry) => entry.fileName === fileName);
        if (!completedLog || completedLog.status !== "completed") {
          continue;
        }

        assert.equal(event.event?.type, "update");
        assert.deepEqual(completedLog.origin, origin);
        assert.equal(typeof completedLog.requestPreview, "string");
        assert.equal("command" in completedLog, false);
        assert.equal(event.event?.logs.runningJobs.every((entry) => entry.fileName !== fileName), true);
        return;
      }

      assert.fail("Did not receive the expected multiplexed AI log update.");
    } finally {
      await stream.close();
      await server.close();
    }
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("GET /api/events/stream skips unchanged ai-log payload rebuilds", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const worktreePath = path.join(repo.repoRoot, "feature-ai-log");
  const fileName = `${worktreeId(worktreePath)}-events-stream-stable-log.json`;

  await writeAiLogFixture({
    repoRoot: repo.repoRoot,
    fileName,
    branch: "feature-ai-log",
    worktreePath,
    command: "printf %s 'stable log'",
    request: "stable log",
    stdout: "done\n",
    exitCode: 0,
    completedAt: "2026-03-27T10:01:30.000Z",
  });

  try {
    const server = await startApiServer(repo, {
      aiLogStreamPollIntervalMs: 10,
      stateStreamFullRefreshIntervalMs: 60_000,
    });
    const stream = await openSse(`${await server.url()}/api/events/stream`);

    try {
      const seenTypes: string[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const event = await stream.nextEvent(1000) as unknown as { type: string };
        seenTypes.push(event.type);
      }

      assert.equal(seenTypes.filter((type) => type === "ai-logs").length, 1);
    } finally {
      await stream.close();
      await server.close();
    }
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
    await firstServer.close({ shutdownRuntimes: false });

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

test("startApiServer close tears down runtime sessions by default", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const featureAiLogPath = path.join(repo.repoRoot, "feature-ai-log");
  const featureAiLogId = worktreeId(featureAiLogPath);
  const tmuxSessionName = getTmuxSessionName(repo.repoRoot, featureAiLogId);

  try {
    const server = await startApiServer(repo, { stateStreamFullRefreshIntervalMs: 50 });
    const startResponse = await server.fetch(`/api/worktrees/${encodeURIComponent("feature-ai-log")}/runtime/start`, {
      method: "POST",
    });
    assert.equal(startResponse.status, 200);

    await server.close();

    const operationalState = await createOperationalStateStore(repo.repoRoot);
    const runtime = await operationalState.getRuntimeById(featureAiLogId);
    assert.equal(runtime, null);

    await assert.rejects(async () => {
      await runCommand("tmux", ["has-session", "-t", tmuxSessionName], { cwd: featureAiLogPath });
    });
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

      const update = await stream.nextEvent(10_000) as unknown as {
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
  const apiRouter = createApiRouter({
    repoRoot: repo.repoRoot,
    configPath: repo.configPath,
    configSourceRef: repo.configSourceRef,
    configFile: repo.configFile,
    configWorktreePath: repo.configWorktreePath,
    operationalState,
  });
  app.use("/api", apiRouter);

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
    await apiRouter.dispose();
    await closeManagedDatabaseClient(repo.repoRoot, "jobs").catch(() => undefined);
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
    await new Promise((resolve) => setTimeout(resolve, 100));
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
