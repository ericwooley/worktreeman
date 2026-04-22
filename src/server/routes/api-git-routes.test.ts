import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import test from "#test-runtime";
import { worktreeId } from "../../shared/worktree-id.js";
import {
  createApiTestRepo,
  createFakeAiProcesses,
  openSse,
  startApiServer,
  startRunningAiJob,
} from "./api-test-helpers.js";
import { loadConfig, readConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { createWorktree } from "../services/git-service.js";
import { getProjectManagementDocument } from "../services/project-management-service.js";
import { getProjectManagementDocumentReview } from "../services/project-management-review-service.js";
import { runCommand } from "../utils/process.js";
import { getWorktreeDocumentLink, setWorktreeDocumentLink } from "../services/worktree-link-service.js";
import type { AiCommandOrigin } from "../../shared/types.js";

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
    assert.equal(updatedDocument.document.title, "Merge tracking doc");

    const updatedReview = await getProjectManagementDocumentReview(repo.repoRoot, createDocumentPayload.document.id);
    const latestComment = updatedReview.review.entries.at(-1);
    assert.ok(latestComment);
    assert.equal(latestComment.eventType, "merge");
    assert.equal(latestComment.source, "system");
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

test("git compare merge can preserve conflicted worktree state when merging base into worktree", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-preserve-conflict-merge" });
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

    const response = await server.fetch(`/api/git/compare/main/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseBranch: "feature-preserve-conflict-merge",
        preserveConflicts: true,
      }),
    });

    assert.equal(response.status, 200);
    const payload = await response.json() as {
      baseBranch: string;
      compareBranch: string;
      workingTreeSummary: { conflicted: boolean; conflictedFiles: number };
      workingTreeConflicts: Array<{ path: string; preview: string | null }>;
      mergeIntoCompareStatus: { hasConflicts: boolean; conflicts: Array<unknown> };
    };
    assert.equal(payload.baseBranch, "main");
    assert.equal(payload.compareBranch, "feature-preserve-conflict-merge");
    assert.equal(payload.workingTreeSummary.conflicted, true);
    assert.equal(payload.workingTreeSummary.conflictedFiles, 1);
    assert.equal(payload.workingTreeConflicts.length, 1);
    assert.equal(payload.workingTreeConflicts[0]?.path, "shared.txt");
    assert.match(payload.workingTreeConflicts[0]?.preview ?? "", /<<<<<<< HEAD|<<<<<<< /);
    assert.equal(payload.mergeIntoCompareStatus.hasConflicts, false);
    assert.equal(payload.mergeIntoCompareStatus.conflicts.length, 0);
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare stream emits an update immediately after merge changes the selected branch", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-stream-merge" });
  const mainPath = path.join(repo.repoRoot, "main");
  const server = await startApiServer(repo, {
    stateStreamFullRefreshIntervalMs: 60_000,
  });

  try {
    await fs.writeFile(path.join(mainPath, "stream-main.txt"), "from main\n", "utf8");
    await runCommand("git", ["add", "stream-main.txt"], { cwd: mainPath });
    await runCommand("git", ["commit", "-m", "stream main change"], {
      cwd: mainPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

    const stream = await openSse(`${await server.url()}/api/git/compare/stream?compareBranch=${encodeURIComponent(feature.branch)}&baseBranch=main`);
    try {
      const snapshot = await stream.nextEvent();
      assert.equal(snapshot.type, "snapshot");
      const snapshotComparison = (snapshot as { comparison?: { behind?: number } }).comparison;
      assert.equal(snapshotComparison?.behind, 1);

      const mergeResponse = await server.fetch(`/api/git/compare/main/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseBranch: feature.branch }),
      });
      assert.equal(mergeResponse.status, 200);

      const update = await stream.nextEvent(5000);
      assert.equal(update.type, "update");
      const updateComparison = (update as {
        comparison?: {
          baseBranch?: string;
          compareBranch?: string;
          behind?: number;
          workingTreeSummary?: { dirty?: boolean };
        };
      }).comparison;
      assert.equal(updateComparison?.baseBranch, "main");
      assert.equal(updateComparison?.compareBranch, feature.branch);
      assert.equal(updateComparison?.behind, 0);
      assert.equal(updateComparison?.workingTreeSummary?.dirty, false);
    } finally {
      await stream.close();
    }
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("git compare stream emits an update after an external worktree change without waiting for the fallback interval", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const config = await loadConfig({
    path: repo.configPath,
    repoRoot: repo.repoRoot,
    gitFile: repo.configFile,
  });
  const feature = await createWorktree(repo.repoRoot, config, { branch: "feature-stream-watch" });
  const server = await startApiServer(repo, {
    stateStreamFullRefreshIntervalMs: 60_000,
    gitWatchDebounceMs: 50,
  });

  try {
    const stream = await openSse(`${await server.url()}/api/git/compare/stream?compareBranch=${encodeURIComponent(feature.branch)}&baseBranch=main`);
    try {
      const snapshot = await stream.nextEvent();
      assert.equal(snapshot.type, "snapshot");
      const snapshotComparison = (snapshot as {
        comparison?: { workingTreeSummary?: { dirty?: boolean }; ahead?: number };
      }).comparison;
      assert.equal(snapshotComparison?.workingTreeSummary?.dirty, false);
      assert.equal(snapshotComparison?.ahead, 0);

      await fs.writeFile(path.join(feature.worktreePath, "external-watch.txt"), "changed outside api\n", "utf8");

      const update = await stream.nextEvent(5000);
      assert.equal(update.type, "update");
      const updateComparison = (update as {
        comparison?: {
          compareBranch?: string;
          ahead?: number;
          workingTreeSummary?: { dirty?: boolean; changedFiles?: number; untrackedFiles?: number };
        };
      }).comparison;
      assert.equal(updateComparison?.compareBranch, feature.branch);
      assert.equal(updateComparison?.workingTreeSummary?.dirty, true);
      assert.ok((updateComparison?.workingTreeSummary?.changedFiles ?? 0) >= 1 || (updateComparison?.workingTreeSummary?.untrackedFiles ?? 0) >= 1);
    } finally {
      await stream.close();
    }
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
