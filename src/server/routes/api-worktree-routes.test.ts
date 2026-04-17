import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "#test-runtime";
import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "../../shared/constants.js";
import { worktreeId } from "../../shared/worktree-id.js";
import {
  createApiTestRepo,
  createFakeAiProcesses,
  getRunningJob,
  readStateSnapshot,
  removePathWithRetry,
  startApiServer,
  startRunningAiJob,
  waitFor,
  waitForPathToDisappear,
} from "./api-test-helpers.js";
import { loadConfig, readConfigContents, serializeConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { createWorktree } from "../services/git-service.js";
import { getAiCommandJob, startAiCommandJob, waitForAiCommandJob } from "../services/ai-command-service.js";
import { stopAllBackgroundCommands } from "../services/background-command-service.js";
import { getWorktreeDocumentLink } from "../services/worktree-link-service.js";
import type { AiCommandOrigin } from "../../shared/types.js";

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

test("PUT /api/settings/auto-sync persists the configured remote", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);

    const response = await server.fetch("/api/settings/auto-sync", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoSync: { remote: "backup" } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      branch: repo.configSourceRef,
      filePath: path.join(repo.configWorktreePath, repo.configFile),
      autoSync: { remote: "backup" },
    });

    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    assert.equal(config.autoSync.remote, "backup");

    const getResponse = await server.fetch("/api/settings/auto-sync");
    assert.equal(getResponse.status, 200);
    assert.deepEqual(await getResponse.json(), {
      branch: repo.configSourceRef,
      filePath: path.join(repo.configWorktreePath, repo.configFile),
      autoSync: { remote: "backup" },
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/worktrees/:branch/auto-sync/enable rejects non-documents branches", async () => {
  const repo = await createApiTestRepo();

  try {
    const server = await startApiServer(repo);
    const response = await server.fetch("/api/worktrees/feature-ai-log/auto-sync/enable", {
      method: "POST",
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      message: "Auto sync is only available on the documents branch.",
    });

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("POST /api/worktrees/:branch/auto-sync/enable pauses when the documents worktree is dirty", async () => {
  const repo = await createApiTestRepo();

  try {
    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const documentsWorktree = await createWorktree(repo.repoRoot, config, { branch: "documents" });
    await setupAutoSyncRemote(repo.repoRoot, documentsWorktree.worktreePath);
    await fs.writeFile(path.join(documentsWorktree.worktreePath, "dirty.txt"), "local change\n", "utf8");

    const server = await startApiServer(repo, { autoSyncIntervalMs: 50 });
    const response = await server.fetch("/api/worktrees/documents/auto-sync/enable", {
      method: "POST",
    });

    assert.equal(response.status, 200);

    await waitFor(async () => {
      const state = await readWorktreeAutoSyncState(server, "documents");
      return state?.status === "paused" && state.enabled === false;
    });

    const autoSyncState = await readWorktreeAutoSyncState(server, "documents");
    assert.ok(autoSyncState);
    assert.equal(autoSyncState.enabled, false);
    assert.equal(autoSyncState.status, "paused");
    assert.match(autoSyncState.message ?? "", /local changes/i);

    await server.close();
  } finally {
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("documents auto sync pulls remote changes on an interval and disable stops later syncs", { concurrency: false, timeout: 20000 }, async () => {
  const repo = await createApiTestRepo();

  try {
    const config = await loadConfig({
      path: repo.configPath,
      repoRoot: repo.repoRoot,
      gitFile: repo.configFile,
    });
    const documentsWorktree = await createWorktree(repo.repoRoot, config, { branch: "documents" });
    const { clonePath } = await setupAutoSyncRemote(repo.repoRoot, documentsWorktree.worktreePath);
    const server = await startApiServer(repo, { autoSyncIntervalMs: 50 });

    const enableResponse = await server.fetch("/api/worktrees/documents/auto-sync/enable", {
      method: "POST",
    });
    assert.equal(enableResponse.status, 200);

    await waitFor(async () => {
      const state = await readWorktreeAutoSyncState(server, "documents");
      return state?.enabled === true && state.status === "idle";
    });

    await pushRemoteCommit(clonePath, "remote-update-1.txt", "first sync\n", "remote update 1");

    await waitFor(async () => {
      try {
        const contents = await fs.readFile(path.join(documentsWorktree.worktreePath, "remote-update-1.txt"), "utf8");
        return contents === "first sync\n";
      } catch {
        return false;
      }
    }, 10000);

    await waitFor(async () => {
      const state = await readWorktreeAutoSyncState(server, "documents");
      return state?.status === "idle" && Boolean(state.lastSuccessAt);
    });

    const disableResponse = await server.fetch("/api/worktrees/documents/auto-sync/disable", {
      method: "POST",
    });
    assert.equal(disableResponse.status, 200);

    await waitFor(async () => {
      const state = await readWorktreeAutoSyncState(server, "documents");
      return state?.enabled === false && state.status === "disabled";
    });

    await pushRemoteCommit(clonePath, "remote-update-2.txt", "should stay remote\n", "remote update 2");
    await new Promise((resolve) => setTimeout(resolve, 250));

    await assert.rejects(fs.access(path.join(documentsWorktree.worktreePath, "remote-update-2.txt")));

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
    const statePayload = await readStateSnapshot<{
      worktrees: Array<{ branch: string; worktreePath: string }>;
    }>(server);

    const featureWorktree = statePayload.worktrees.find((entry) => entry.branch === "feature-ai-log");

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

    const branchList = await runGit(repo.repoRoot, ["branch", "--list", "feature-delete-default"]);
    assert.equal(branchList.trim(), "");

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

    const branchList = await runGit(repo.repoRoot, ["branch", "--list", "feature-delete-leftovers"]);
    assert.equal(branchList.trim(), "");

    const worktreeList = await runGit(repo.repoRoot, ["worktree", "list", "--porcelain"]);
    assert.doesNotMatch(worktreeList, /feature-delete-leftovers/);

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
      const job = await getRunningJob(repo.repoRoot, "feature-ai-log");
      return Boolean(job);
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
    await runGit(feature.worktreePath, ["commit", "--allow-empty", "-m", "initial"]);
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

    const latestSubject = await runGit(feature.worktreePath, ["log", "-1", "--format=%s"]);
    assert.equal(latestSubject.trim(), "commit me");

    const status = await runGit(feature.worktreePath, ["status", "--short"]);
    assert.equal(status.trim(), "");
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
    await runGit(feature.worktreePath, ["commit", "--allow-empty", "-m", "initial"]);
    const beforeHead = await runGit(feature.worktreePath, ["rev-parse", "HEAD"]);

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

    const afterHead = await runGit(feature.worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(afterHead.trim(), beforeHead.trim());

    const status = await runGit(feature.worktreePath, ["status", "--short"]);
    assert.equal(status.trim(), "");
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
    await runGit(worktreePath, ["commit", "--allow-empty", "-m", "initial"]);
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

    const subject = await runGit(repo.repoRoot, ["log", "-1", "--pretty=%s", "feature-ai-log"]);
    assert.equal(subject.trim(), "commit me");

    const status = await runGit(worktreePath, ["status", "--short"]);
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
    await runGit(worktreePath, ["commit", "--allow-empty", "-m", "initial"]);
    const beforeHead = await runGit(worktreePath, ["rev-parse", "HEAD"]);

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

    const afterHead = await runGit(worktreePath, ["rev-parse", "HEAD"]);
    assert.equal(afterHead.trim(), beforeHead.trim());

    const status = await runGit(worktreePath, ["status", "--short"]);
    assert.equal(status.trim(), "");
  } finally {
    await server.close();
    await removePathWithRetry(repo.repoRoot);
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
      execute: async () => await new Promise<void>(() => {}),
  })).started;
  const server = await startApiServer(repo);

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
  const aiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options: { command: string }) {
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
    async waitForProcess() {
      return {
        name: "wtm:ai:test-env",
        pid: 9991,
        status: "stopped",
        exitCode: 0,
      };
    },
    isProcessActive(status: string | undefined) {
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
      const stateResponse = await server.fetch("/api/state");
      if (stateResponse.status !== 200) {
        return false;
      }

      const statePayload = await stateResponse.json() as {
        worktrees: Array<{ branch: string; runtime?: { branch: string; tmuxSession: string } }>;
      };
      const runtime = statePayload.worktrees.find((entry) => entry.branch === "feature-ai-env")?.runtime;
      return runtime?.branch === "feature-ai-env" && runtime.tmuxSession === payload.runtime?.tmuxSession;
    });
  } finally {
    await stopAllBackgroundCommands(repo.repoRoot, featureAiEnv).catch(() => undefined);
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("worktree AI auto-starts a runtime and stops it after completion when the runtime was created for the AI run", { concurrency: false, timeout: 30000 }, async () => {
  const repo = await createApiTestRepo();
  const currentContents = await readConfigContents({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const nextContents = updateAiCommandInConfigContents(currentContents, {
    smart: "printf %s $WTM_AI_INPUT",
    simple:
      "node -e \"const text = process.argv[1] || ''; const isCommitPrompt = text.includes('single-line git commit message') || text.includes('concise git commit message') || text.includes('git commit message'); console.log(isCommitPrompt ? 'commit me' : text);\" $WTM_AI_INPUT",
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
  const aiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options: { env: NodeJS.ProcessEnv }) {
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
    async waitForProcess() {
      return {
        name: "wtm:ai:test-auto-stop",
        pid: 9992,
        status: "stopped",
        exitCode: 0,
      };
    },
    isProcessActive(status: string | undefined) {
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
      job: { jobId: string; branch: string };
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

    const settledJob = await waitForAiCommandJob(
      repo.repoRoot,
      worktreeId(path.join(repo.repoRoot, "feature-ai-auto-stop")),
      payload.job.jobId,
    );
    assert.equal(settledJob.status, "completed");

    await waitFor(async () => {
      const stateResponse = await server.fetch("/api/state");
      if (stateResponse.status !== 200) {
        return false;
      }

      const statePayload = await stateResponse.json() as {
        worktrees: Array<{ branch: string; worktreePath: string; runtime?: { branch: string } }>;
      };
      const matchingWorktree = statePayload.worktrees.find(
        (entry) => entry.branch === "feature-ai-auto-stop"
          && entry.worktreePath === path.join(repo.repoRoot, "feature-ai-auto-stop"),
      );
      return matchingWorktree?.runtime === undefined;
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
  const aiProcesses = {
    ...createFakeAiProcesses().aiProcesses,
    async startProcess(options: { env: NodeJS.ProcessEnv; command: string }) {
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
    async waitForProcess() {
      return {
        name: "wtm:ai:test-runtime-restart",
        pid: 9993,
        status: "stopped",
        exitCode: 0,
      };
    },
    isProcessActive(status: string | undefined) {
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

async function runGit(cwd: string, args: string[], env?: NodeJS.ProcessEnv) {
  const { stdout } = await import("../utils/process.js").then(({ runCommand }) => runCommand("git", args, { cwd, env }));
  return stdout;
}

async function readWorktreeAutoSyncState(
  server: Awaited<ReturnType<typeof startApiServer>>,
  branch: string,
): Promise<{
  enabled: boolean;
  status: string;
  remote: string;
  message?: string | null;
  lastSuccessAt?: string;
} | null> {
  const response = await server.fetch("/api/state");
  assert.equal(response.status, 200);
  const payload = await response.json() as {
    worktrees: Array<{
      branch: string;
      autoSync?: {
        enabled: boolean;
        status: string;
        remote: string;
        message?: string | null;
        lastSuccessAt?: string;
      } | null;
    }>;
  };

  return payload.worktrees.find((entry) => entry.branch === branch)?.autoSync ?? null;
}

async function setupAutoSyncRemote(repoRoot: string, worktreePath: string) {
  const remotePath = path.join(repoRoot, ".auto-sync-origin.git");
  const clonePath = path.join(repoRoot, ".auto-sync-origin-clone");

  await runGit(repoRoot, ["init", "--bare", remotePath]);
  await runGit(worktreePath, ["remote", "add", "origin", remotePath]);
  await runGit(worktreePath, ["push", "-u", "origin", "HEAD:documents"]);
  await runGit(repoRoot, ["clone", "--branch", "documents", remotePath, clonePath]);

  return { remotePath, clonePath };
}

async function pushRemoteCommit(clonePath: string, fileName: string, contents: string, message: string) {
  await fs.writeFile(path.join(clonePath, fileName), contents, "utf8");
  await runGit(clonePath, ["add", fileName]);
  await runGit(clonePath, ["commit", "-m", message], {
    ...process.env,
    GIT_AUTHOR_NAME: "Test User",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test User",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  await runGit(clonePath, ["push", "origin", "documents"]);
}
