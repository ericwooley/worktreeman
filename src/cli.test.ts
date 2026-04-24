import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "#test-runtime";
import { vi } from "vitest";
import { createApiTestRepo } from "./server/routes/api-test-helpers.js";

test.afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("./server/utils/paths.js");
  vi.doUnmock("./server/services/config-service.js");
  vi.doUnmock("./server/services/git-service.js");
  vi.doUnmock("./server/services/operational-state-service.js");
  vi.doUnmock("./server/services/project-management-service.js");
  vi.doUnmock("./server/services/runtime-service.js");
  vi.doUnmock("./server/services/terminal-service.js");
  vi.doUnmock("./server/services/background-command-service.js");
});

async function captureStdout<T>(runOutput: () => Promise<T>): Promise<{ result: T; stdout: string }> {
  let stdout = "";
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;

  try {
    const result = await runOutput();
    return { result, stdout };
  } finally {
    process.stdout.write = originalWrite;
  }
}

test("worktreeman api documents commands return project-management JSON", async () => {
  const repoContext = {
    repoRoot: "/repo",
    gitDir: "/repo/.git",
    bareDir: "/repo/.bare",
    configPath: "/repo/wtm-settings/worktree.yml",
    configFile: "worktree.yml",
    configSourceRef: "wtm-settings",
    configWorktreePath: "/repo/wtm-settings",
  };
  const listProjectManagementDocuments = vi.fn(async () => ({
    branch: "wtm-project-management",
    headSha: "abc123",
    availableTags: ["plan"],
    availableStatuses: ["backlog"],
    documents: [{
      id: "project-outline",
      number: 1,
      title: "Project Outline",
      summary: "Summary",
      tags: ["plan"],
      dependencies: [],
      status: "backlog",
      assignee: "",
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      historyCount: 1,
    }],
  }));
  const getProjectManagementDocument = vi.fn(async (_repoRoot: string, documentId: string) => ({
    branch: "wtm-project-management",
    headSha: "abc123",
    document: {
      id: documentId,
      number: 1,
      title: "Project Outline",
      summary: "Summary",
      tags: ["plan"],
      dependencies: [],
      status: "backlog",
      assignee: "",
      archived: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      historyCount: 1,
      markdown: "# Project Outline\n",
    },
  }));
  const getProjectManagementDocumentHistory = vi.fn(async () => ({
    branch: "wtm-project-management",
    headSha: "abc123",
    history: [{
      commitSha: "abc123",
      batchId: "batch-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      actorId: "actor-1",
      authorName: "worktreeman",
      authorEmail: "worktreeman@example.com",
      documentId: "project-outline",
      number: 1,
      title: "Project Outline",
      tags: ["plan"],
      status: "backlog",
      assignee: "",
      archived: false,
      changeCount: 1,
      action: "create" as const,
      diff: "",
    }],
  }));

  vi.doMock("./server/utils/paths.js", () => ({
    findRepoContext: vi.fn(async () => repoContext),
  }));
  vi.doMock("./server/services/project-management-service.js", () => ({
    listProjectManagementDocuments,
    getProjectManagementDocument,
    getProjectManagementDocumentHistory,
  }));

  const { runCli } = await import("./cli.js");

  const listOutput = await captureStdout(() => runCli(["api", "documents", "list", "--cwd", "/repo/main"]));
    const listPayload = JSON.parse(listOutput.stdout) as {
      documents: Array<{ id: string; title: string }>;
    };
    const outline = listPayload.documents.find((entry) => entry.title === "Project Outline");
    assert.ok(outline);

    const readOutput = await captureStdout(() => runCli(["api", "documents", "read", outline.id, "--cwd", "/repo/main"]));
    const readPayload = JSON.parse(readOutput.stdout) as {
      document: { id: string; title: string; markdown: string };
    };
    assert.equal(readPayload.document.id, outline.id);
    assert.equal(readPayload.document.title, "Project Outline");
    assert.match(readPayload.document.markdown, /Project Outline/);

    const historyOutput = await captureStdout(() => runCli(["api", "documents", "history", outline.id, "--cwd", "/repo/main"]));
    const historyPayload = JSON.parse(historyOutput.stdout) as {
      history: Array<{ action: string }>;
    };
    assert.equal(historyPayload.history.length >= 1, true);
    assert.equal(historyPayload.history[0]?.action, "create");

  assert.equal(listProjectManagementDocuments.mock.calls.length, 1);
  assert.equal(getProjectManagementDocument.mock.calls[0]?.[1], "project-outline");
  assert.equal(getProjectManagementDocumentHistory.mock.calls[0]?.[1], "project-outline");
});

test("worktreeman api dev status resolves the current worktree from cwd", async () => {
  const repo = await createApiTestRepo();
  const featureWorktreePath = path.join(repo.repoRoot, "feature-ai-log");

  try {
    vi.resetModules();
    vi.doUnmock("./server/utils/paths.js");
    vi.doUnmock("./server/services/project-management-service.js");
    const { runCli } = await import("./cli.js");
    const statusOutput = await captureStdout(() => runCli(["api", "dev", "status", "--cwd", featureWorktreePath]));
    const statusPayload = JSON.parse(statusOutput.stdout) as {
      branch: string;
      worktreePath: string;
      runtime: unknown;
      backgroundCommands: unknown[];
    };

    assert.equal(statusPayload.branch, "feature-ai-log");
    assert.equal(statusPayload.worktreePath, featureWorktreePath);
    assert.equal(statusPayload.runtime, null);
    assert.ok(Array.isArray(statusPayload.backgroundCommands));
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktreeman api dev commands manage runtime and filter logs", async () => {
  const repoContext = {
    repoRoot: "/repo",
    gitDir: "/repo/.git",
    bareDir: "/repo/.bare",
    configPath: "/repo/wtm-settings/worktree.yml",
    configFile: "worktree.yml",
    configSourceRef: "wtm-settings",
    configWorktreePath: "/repo/wtm-settings",
  };
  const worktree = {
    id: "wt-feature" as never,
    branch: "feature-ai-cli",
    worktreePath: "/repo/feature-ai-cli",
    isBare: false,
    isDetached: false,
    locked: false,
    prunable: false,
  };
  const config = {
    favicon: "",
    env: { NODE_ENV: "development" },
    runtimePorts: ["VITE_PORT", "WT_PORT"],
    derivedEnv: {},
    quickLinks: [],
    autoSync: { remote: "origin" },
    aiCommands: { smart: "", simple: "", autoStartRuntime: false },
    startupCommands: ["pnpm install"],
    backgroundCommands: {
      web: { command: "pnpm dev:web" },
    },
    projectManagement: {
      users: {
        customUsers: [],
        archivedUserIds: [],
      },
    },
    worktrees: {
      baseDir: "worktrees",
    },
  };
  const runtime = {
    id: worktree.id,
    branch: worktree.branch,
    worktreePath: worktree.worktreePath,
    env: { WORKTREE_BRANCH: worktree.branch, VITE_PORT: "4173" },
    quickLinks: [],
    allocatedPorts: { VITE_PORT: 4173 },
    tmuxSession: "wtm-feature-ai-cli",
    runtimeStartedAt: "2026-01-01T00:00:00.000Z",
  };
  const statusBackgroundCommands = [{
    name: "web",
    command: "pnpm dev:web",
    processName: "wtm:wt-feature:web",
    manager: "pm2" as const,
    running: false,
    status: "stopped",
    requiresRuntime: true,
    canStart: false,
    note: "Start the environment first.",
  }];
  const runningBackgroundCommands = [{
    name: "web",
    command: "pnpm dev:web",
    processName: "wtm:wt-feature:web",
    manager: "pm2" as const,
    running: true,
    status: "online",
    requiresRuntime: true,
    canStart: true,
    pid: 1234,
    startedAt: "2026-01-01T00:00:01.000Z",
  }];
  const state = {
    runtime: null as typeof runtime | null,
  };

  const findRepoContext = vi.fn(async () => repoContext);
  const loadConfig = vi.fn(async () => config);
  const listWorktrees = vi.fn(async () => [worktree]);
  const getRuntimeById = vi.fn(async () => state.runtime);
  const setRuntime = vi.fn(async (nextRuntime: typeof runtime) => {
    state.runtime = nextRuntime;
  });
  const deleteRuntimeById = vi.fn(async () => {
    state.runtime = null;
  });
  const createOperationalStateStore = vi.fn(async () => ({
    getRuntimeById,
    setRuntime,
    deleteRuntimeById,
  }));
  const createRuntime = vi.fn(async () => ({ runtime }));
  const buildRuntimeProcessEnv = vi.fn(() => ({ ...runtime.env }));
  const runStartupCommands = vi.fn(async () => undefined);
  const ensureRuntimeTerminalSession = vi.fn(async () => undefined);
  const startConfiguredBackgroundCommands = vi.fn(async () => undefined);
  const stopAllBackgroundCommands = vi.fn(async () => undefined);
  const killTmuxSession = vi.fn(async () => undefined);
  const killTmuxSessionByName = vi.fn(async () => undefined);
  const getTmuxSessionName = vi.fn(() => runtime.tmuxSession);
  const listBackgroundCommands = vi.fn(async (_config: unknown, _repoRoot: string, _worktree: unknown, currentRuntime: unknown) => (
    currentRuntime ? runningBackgroundCommands : statusBackgroundCommands
  ));
  const getBackgroundCommandLogs = vi.fn(async () => ({
    commandName: "web",
    lines: [
      { id: "stdout-1", source: "stdout" as const, text: "ready on 4173" },
      { id: "stderr-1", source: "stderr" as const, text: "Warning: slow route" },
      { id: "stderr-2", source: "stderr" as const, text: "ERROR failed to compile" },
    ],
  }));

  vi.doMock("./server/utils/paths.js", () => ({
    findRepoContext,
  }));
  vi.doMock("./server/services/config-service.js", () => ({
    loadConfig,
  }));
  vi.doMock("./server/services/git-service.js", () => ({
    listWorktrees,
  }));
  vi.doMock("./server/services/operational-state-service.js", () => ({
    createOperationalStateStore,
  }));
  vi.doMock("./server/services/runtime-service.js", () => ({
    createRuntime,
    buildRuntimeProcessEnv,
    runStartupCommands,
  }));
  vi.doMock("./server/services/terminal-service.js", () => ({
    ensureRuntimeTerminalSession,
    killTmuxSession,
    killTmuxSessionByName,
    getTmuxSessionName,
  }));
  vi.doMock("./server/services/background-command-service.js", () => ({
    getBackgroundCommandLogs,
    listBackgroundCommands,
    startConfiguredBackgroundCommands,
    stopAllBackgroundCommands,
  }));

  const { runCli } = await import("./cli.js");

  const startOutput = await captureStdout(() => runCli(["api", "dev", "start", "--cwd", worktree.worktreePath]));
  const startPayload = JSON.parse(startOutput.stdout) as {
    branch: string;
    runtime: { tmuxSession: string; allocatedPorts: Record<string, number> };
    backgroundCommands: Array<{ status: string; running: boolean }>;
  };
  assert.equal(startPayload.branch, worktree.branch);
  assert.equal(startPayload.runtime.tmuxSession, runtime.tmuxSession);
  assert.equal(startPayload.runtime.allocatedPorts.VITE_PORT, 4173);
  assert.equal(startPayload.backgroundCommands[0]?.status, "online");
  assert.equal(startPayload.backgroundCommands[0]?.running, true);
  assert.equal(createRuntime.mock.calls.length, 1);
  assert.equal(setRuntime.mock.calls.length, 1);
  assert.deepEqual(runStartupCommands.mock.calls[0]?.slice(0, 2), [config.startupCommands, worktree.worktreePath]);
  assert.equal(startConfiguredBackgroundCommands.mock.calls.length, 1);

  const logsReadOutput = await captureStdout(() => runCli([
    "api",
    "dev",
    "logs",
    "read",
    "--command",
    "web",
    "--source",
    "stderr",
    "--cwd",
    worktree.worktreePath,
  ]));
  const logsReadPayload = JSON.parse(logsReadOutput.stdout) as {
    commandName: string;
    source: string;
    lines: Array<{ source: string; text: string }>;
  };
  assert.equal(logsReadPayload.commandName, "web");
  assert.equal(logsReadPayload.source, "stderr");
  assert.equal(logsReadPayload.lines.length, 2);
  assert.equal(logsReadPayload.lines.every((line) => line.source === "stderr"), true);

  const logsGrepOutput = await captureStdout(() => runCli([
    "api",
    "dev",
    "logs",
    "grep",
    "error",
    "--command",
    "web",
    "--source",
    "stderr",
    "--ignore-case",
    "--cwd",
    worktree.worktreePath,
  ]));
  const logsGrepPayload = JSON.parse(logsGrepOutput.stdout) as {
    source: string;
    pattern: string;
    ignoreCase: boolean;
    lines: Array<{ text: string }>;
  };
  assert.equal(logsGrepPayload.source, "stderr");
  assert.equal(logsGrepPayload.pattern, "error");
  assert.equal(logsGrepPayload.ignoreCase, true);
  assert.equal(logsGrepPayload.lines.length, 1);
  assert.equal(logsGrepPayload.lines[0]?.text, "ERROR failed to compile");

  const stopOutput = await captureStdout(() => runCli(["api", "dev", "stop", "--cwd", worktree.worktreePath]));
  const stopPayload = JSON.parse(stopOutput.stdout) as {
    ok: boolean;
    runtime: null;
    backgroundCommands: Array<{ status: string; running: boolean }>;
  };
  assert.equal(stopPayload.ok, true);
  assert.equal(stopPayload.runtime, null);
  assert.equal(stopPayload.backgroundCommands[0]?.status, "stopped");
  assert.equal(stopPayload.backgroundCommands[0]?.running, false);
  assert.equal(stopAllBackgroundCommands.mock.calls.length, 1);
  assert.equal(killTmuxSession.mock.calls.length, 1);
  assert.equal(deleteRuntimeById.mock.calls.length, 1);
  assert.equal(killTmuxSessionByName.mock.calls.length, 0);
  assert.equal(getBackgroundCommandLogs.mock.calls.length, 2);
});

test("AI local helper instructions use repo-local npx package invocation", async () => {
  const { buildAiLocalHelperInstructions } = await import("./server/routes/api-helpers.js");

  const instructions = buildAiLocalHelperInstructions().join("\n");

  assert.equal(instructions.includes("npx -y --package file:. worktreeman api"), true);
  assert.equal(instructions.includes("current checked-out worktree code instead of a published package"), true);
  assert.equal(instructions.includes("npx -y worktreeman api"), false);
});
