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
  vi.doUnmock("./server/services/project-management-service.js");
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
