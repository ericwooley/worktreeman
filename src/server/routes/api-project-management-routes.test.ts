import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "#test-runtime";
import { worktreeId } from "../../shared/worktree-id.js";
import { buildAiCommandProcessEnv } from "./api-helpers.js";
import {
  createApiTestRepo,
  createFakeAiProcesses,
  openSse,
  readStateSnapshot,
  startApiServer,
  waitFor,
} from "./api-test-helpers.js";
import { loadConfig, parseConfigContents, readConfigContents, serializeConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import { createOperationalStateStore } from "../services/operational-state-service.js";
import { getProjectManagementDocument, getProjectManagementDocumentHistory } from "../services/project-management-service.js";
import { getProjectManagementDocumentReview } from "../services/project-management-review-service.js";
import { getWorktreeDocumentLink } from "../services/worktree-link-service.js";
import { runCommand } from "../utils/process.js";
import type { AiCommandOrigin } from "../../shared/types.js";

test("project-management AI runs update the saved document on the server", { concurrency: false, timeout: 15000 }, async () => {
  const repo = await createApiTestRepo();
  const fakeAiProcesses = createFakeAiProcesses();
  let capturedCommand = "";
  let capturedPrompt = "";
  const aiProcesses = {
    ...fakeAiProcesses.aiProcesses,
    async startProcess(options: { command: string }) {
      capturedCommand = options.command;
      const match = options.command.match(/^printf %s '([\s\S]*)'$/);
      capturedPrompt = match ? match[1].replace(/'\\''/g, "'") : options.command;
      return await fakeAiProcesses.aiProcesses.startProcess(options as never);
    },
  };
  fakeAiProcesses.queueStartScript([
    { status: "online", pid: 5012, stdout: "<wtm-new-document># Updated By AI\n\n- durable update\n</wtm-new-document>\n", stderr: "" },
    { status: "stopped", pid: 5012, stdout: "<wtm-new-document># Updated By AI\n\n- durable update\n</wtm-new-document>\n", stderr: "", exitCode: 0 },
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
    assert.equal(capturedPrompt.includes("Output format: return the complete updated markdown document wrapped inside <wtm-new-document> and </wtm-new-document>."), true);
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
      "node -e \"const fs = require('node:fs'); fs.writeFileSync('summary-prompt.txt', process.argv[1]); fs.writeFileSync('summary-ai-session.txt', process.env.AI_SESSION_ID || ''); console.log('Generated UI summary.');\" $WTM_AI_INPUT",
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
    const summarySessionId = await fs.readFile(path.join(repo.repoRoot, "summary-ai-session.txt"), "utf8");
    assert.equal(prompt.includes('You are writing the short summary for the project-management document "Launch Checklist"'), true);
    assert.equal(prompt.includes("Return only the final short summary as raw text."), true);
    assert.equal(prompt.includes("Write 1-2 sentences that make the document easy to scan in the UI."), true);
    assert.equal(prompt.includes("Title: Launch Checklist"), true);
    assert.equal(prompt.includes("Status: todo"), true);
    assert.equal(prompt.includes("Assignee: Avery"), true);
    assert.equal(prompt.includes("Tags: release, ops"), true);
    assert.equal(prompt.includes("Current markdown:"), true);
    assert.equal(summarySessionId.length > 0, true);
    assert.equal(
      summarySessionId,
      buildAiCommandProcessEnv({
        repoRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        env: {},
      }).AI_SESSION_ID,
    );

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
    { status: "online", pid: 5013, stdout: "<wtm-new-document># Clean Markdown\n\nOnly stdout belongs here.\n</wtm-new-document>\n", stderr: "> build · gpt-4.1\n" },
    { status: "stopped", pid: 5013, stdout: "<wtm-new-document># Clean Markdown\n\nOnly stdout belongs here.\n</wtm-new-document>\n", stderr: "> build · gpt-4.1\n", exitCode: 0 },
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

    assert.equal(detailPayload.log.response.stdout, "<wtm-new-document># Clean Markdown\n\nOnly stdout belongs here.\n</wtm-new-document>\n");
    assert.equal(detailPayload.log.response.stderr, "> build · gpt-4.1\n");
    assert.deepEqual(detailPayload.log.response.events?.map((event) => ({ source: event.source, text: event.text })), [
      { source: "stdout", text: "<wtm-new-document># Clean Markdown\n\nOnly stdout belongs here.\n</wtm-new-document>\n" },
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
        && detailPayload.log.error?.message === "AI command finished without returning <wtm-new-document>...</wtm-new-document>. Inspect the saved AI log output to see the raw response.";
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
    assert.equal(detailPayload.log.response.stderr, "AI command finished without returning <wtm-new-document>...</wtm-new-document>. Inspect the saved AI log output to see the raw response.");
    assert.equal(detailPayload.log.error?.message, "AI command finished without returning <wtm-new-document>...</wtm-new-document>. Inspect the saved AI log output to see the raw response.");

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

test("project-management review routes preserve summary and add attributed entries", { concurrency: false }, async () => {
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
        summary: "Track the review timeline launch.",
        markdown: "# Comments rollout\n",
        tags: ["feature", "ux"],
        status: "todo",
        assignee: "Riley",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as { document: { id: string; summary: string } };
    assert.equal(createPayload.document.summary, "Track the review timeline launch.");

    const documentId = createPayload.document.id;

    const commentResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "Need one more pass on author attribution." }),
    });
    assert.equal(commentResponse.status, 201);
    const commentPayload = await commentResponse.json() as {
      review: {
        documentId: string;
        entries: Array<{
          body: string;
          authorName: string;
          authorEmail: string;
          eventType: string;
        }>;
      };
    };
    assert.equal(commentPayload.review.documentId, documentId);
    assert.equal(commentPayload.review.entries.length, 1);
    assert.equal(commentPayload.review.entries[0]?.body, "Need one more pass on author attribution.");
    assert.equal(commentPayload.review.entries[0]?.authorName, "Riley Maintainer");
    assert.equal(commentPayload.review.entries[0]?.authorEmail, "riley@example.com");
    assert.equal(commentPayload.review.entries[0]?.eventType, "comment");

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, documentId);
    assert.equal(updatedDocument.document.summary, "Track the review timeline launch.");

    const updatedReview = await getProjectManagementDocumentReview(repo.repoRoot, documentId);
    assert.equal(updatedReview.review.entries.length, 1);
    assert.equal(updatedReview.review.entries[0]?.body, "Need one more pass on author attribution.");
    assert.equal(updatedReview.review.entries[0]?.authorName, "Riley Maintainer");
    assert.equal(updatedReview.review.entries[0]?.authorEmail, "riley@example.com");

    const invalidCommentResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(documentId)}/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "   " }),
    });
    assert.equal(invalidCommentResponse.status, 400);
    const invalidCommentPayload = await invalidCommentResponse.json() as { message: string };
    assert.equal(invalidCommentPayload.message, "Review body is required.");
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
        historyCount: number;
      };
    };
    assert.equal(statusPayload.document.status, "done");
    assert.equal(statusPayload.document.summary, "Deliver the feature after foundation work lands.");
    assert.deepEqual(statusPayload.document.dependencies, [foundationPayload.document.id]);
    assert.equal(statusPayload.document.assignee, "Taylor");
    assert.equal(statusPayload.document.historyCount, 2);

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

test("project-management status route supports repeated lane moves for the same document", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const createResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Repeated Lane Moves",
        markdown: "# Repeated Lane Moves\n",
        tags: ["plan"],
        status: "backlog",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as { document: { id: string } };

    for (const status of ["todo", "in-progress", "done", "todo"]) {
      const statusResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(createPayload.document.id)}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      assert.equal(statusResponse.status, 200);
      const statusPayload = await statusResponse.json() as { document: { status: string } };
      assert.equal(statusPayload.document.status, status);
    }

    const updatedDocument = await getProjectManagementDocument(repo.repoRoot, createPayload.document.id);
    assert.equal(updatedDocument.document.status, "todo");

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, createPayload.document.id);
    assert.equal(history.history.length, 6);
    assert.equal(history.history.at(-1)?.status, "todo");
  } finally {
    await server.close();
    await fs.rm(repo.repoRoot, { recursive: true, force: true });
  }
});

test("project-management updates route accepts status-only patches for existing documents", { concurrency: false }, async () => {
  const repo = await createApiTestRepo();
  const server = await startApiServer(repo);

  try {
    const createResponse = await server.fetch(`/api/project-management/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Status Only Update",
        summary: "Keep the rest of the document intact.",
        markdown: "# Status Only Update\n",
        tags: ["plan", "board"],
        dependencies: [],
        status: "todo",
        assignee: "Taylor",
      }),
    });
    assert.equal(createResponse.status, 201);
    const createPayload = await createResponse.json() as { document: { id: string } };

    const updateResponse = await server.fetch(`/api/project-management/documents/${encodeURIComponent(createPayload.document.id)}/updates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    assert.equal(updateResponse.status, 200);
    const updatePayload = await updateResponse.json() as {
      document: {
        title: string;
        summary: string;
        tags: string[];
        status: string;
        assignee: string;
      };
    };
    assert.equal(updatePayload.document.title, "Status Only Update");
    assert.equal(updatePayload.document.summary, "Keep the rest of the document intact.");
    assert.deepEqual(updatePayload.document.tags, ["plan", "board"]);
    assert.equal(updatePayload.document.status, "done");
    assert.equal(updatePayload.document.assignee, "Taylor");

    const persisted = await getProjectManagementDocument(repo.repoRoot, createPayload.document.id);
    assert.equal(persisted.document.title, "Status Only Update");
    assert.equal(persisted.document.summary, "Keep the rest of the document intact.");
    assert.equal(persisted.document.markdown, "# Status Only Update\n");
    assert.deepEqual(persisted.document.tags, ["plan", "board"]);
    assert.equal(persisted.document.status, "done");
    assert.equal(persisted.document.assignee, "Taylor");
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
    simple:
      "node -e \"const text = process.argv[1] || ''; const isCommitPrompt = text.includes('single-line git commit message') || text.includes('concise git commit message') || text.includes('git commit message'); console.log(isCommitPrompt ? 'commit me' : text);\" $WTM_AI_INPUT",
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
      body: JSON.stringify({}),
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
    const firstSessionMatch = capturedEnv.match(/^AI_SESSION_ID=(.*)$/m);
    assert.equal(capturedEnv.includes(`WORKTREE_BRANCH=${payload.job.branch}`), true);
    assert.equal(capturedEnv.includes(`WORKTREE_PATH=${createdWorktree.worktreePath}`), true);
    assert.equal(capturedEnv.includes(`TMUX_SESSION_NAME=${createdWorktree.runtime?.tmuxSession}`), true);
    assert.ok(firstSessionMatch);
    assert.equal(firstSessionMatch[1]?.length ? true : false, true);
    assert.equal(
      firstSessionMatch[1],
      buildAiCommandProcessEnv({
        repoRoot: repo.repoRoot,
        worktreeId: worktreeId(createdWorktree.worktreePath),
        documentId: outline.id,
        worktreePath: createdWorktree.worktreePath,
        env: {},
      }).AI_SESSION_ID,
    );
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
      const snapshotJob = (snapshot as { job?: { branch?: string; status?: string } | null }).job;
      assert.equal(snapshotJob?.branch, payload.job.branch);
      await waitFor(async () => {
        const logsResponse = await server.fetch(`/api/ai/logs`);
        if (logsResponse.status !== 200) {
          return false;
        }
        const logsPayload = await logsResponse.json() as {
          logs: Array<{ jobId: string; branch: string; status: string; origin?: AiCommandOrigin | null }>;
        };
        return logsPayload.logs.some((entry) => entry.branch === payload.job.branch && entry.status === "completed");
      });

      let completedSeen = snapshotJob?.status === "completed";
      while (!completedSeen) {
        const event = await stream.nextEvent();
        const job = (event as { job?: { status?: string } | null }).job;
        completedSeen = job?.status === "completed";
      }
      assert.equal(completedSeen, true);
    } finally {
      await stream.close();
    }

    const updated = await getProjectManagementDocument(repo.repoRoot, outline.id);
    assert.equal(updated.document.title, "Project Outline");
    assert.equal(updated.document.status, "in-progress");
    assert.equal(updated.document.markdown.includes("implemented"), false);

    const updatedReview = await getProjectManagementDocumentReview(repo.repoRoot, outline.id);
    assert.equal(updatedReview.review.entries.length >= 2, true);
    const startedComment = updatedReview.review.entries.at(-2);
    const latestComment = updatedReview.review.entries.at(-1);
    assert.ok(startedComment);
    assert.ok(latestComment);
    assert.equal(startedComment.eventType, "ai-started");
    assert.equal(startedComment.source, "ai");
    assert.match(startedComment.body, /## Worktree AI started/);
    assert.equal(startedComment.body.includes(`- Branch: \`${payload.job.branch}\``), true);
    assert.match(startedComment.body, /- Command: `smart`/);
    assert.equal(latestComment.eventType, "ai-completed");
    assert.equal(latestComment.source, "ai");
    assert.match(latestComment.body, /## Worktree AI completed/);
    assert.equal(latestComment.body.includes(`- Branch: \`${payload.job.branch}\``), true);
    assert.match(latestComment.body, /- Command: `smart`/);
    assert.match(latestComment.body, /- Output: 2 stdout lines, 0 stderr lines/);
    assert.match(latestComment.body, /<details>/);
    assert.match(latestComment.body, /<summary>Output details<\/summary>/);
    assert.match(latestComment.body, /#### Stdout/);
    assert.match(latestComment.body, /```text\nplanning\.\.\.\nimplemented/);

    const history = await getProjectManagementDocumentHistory(repo.repoRoot, outline.id);
    assert.equal(history.history.length >= 2, true);
    assert.equal(history.history.at(-1)?.action, "update");

    const aiLogsResponse = await server.fetch(`/api/ai/logs`);
    assert.equal(aiLogsResponse.status, 200);
    const aiLogsPayload = await aiLogsResponse.json() as {
      logs: Array<{ jobId: string; branch: string; status: string; origin?: AiCommandOrigin | null }>;
    };
    const completedLog = aiLogsPayload.logs.find((entry) => entry.branch === payload.job.branch && entry.status === "completed");
    assert.ok(completedLog);
    assert.equal(completedLog.origin?.kind, "project-management-document-run");
    assert.equal(completedLog.origin?.location.tab, "project-management");
    assert.equal(completedLog.origin?.location.projectManagementSubTab, "document");
    assert.equal(completedLog.origin?.location.documentId, outline.id);
    assert.equal(completedLog.origin?.location.projectManagementDocumentViewMode, "document");

    const completedLogDetailResponse = await server.fetch(`/api/ai/logs/${encodeURIComponent(completedLog.jobId)}`);
    assert.equal(completedLogDetailResponse.status, 200);
    const completedLogDetailPayload = await completedLogDetailResponse.json() as {
      log: {
        response: {
          stdout: string;
        };
      };
    };
    assert.match(completedLogDetailPayload.log.response.stdout, /implemented/);

    const alternateSessionId = buildAiCommandProcessEnv({
      repoRoot: repo.repoRoot,
      worktreeId: worktreeId(path.join(repo.repoRoot, "pm-project-outline-project-outline-2")),
      documentId: outline.id,
      worktreePath: path.join(repo.repoRoot, "pm-project-outline-project-outline-2"),
      env: {},
    }).AI_SESSION_ID;
    assert.equal(alternateSessionId, firstSessionMatch[1]);

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
  parsedConfig.aiCommands.simple =
    "node -e \"const text = process.argv[1] || ''; const isCommitPrompt = text.includes('single-line git commit message') || text.includes('concise git commit message') || text.includes('git commit message'); console.log(isCommitPrompt ? 'commit me' : text);\" $WTM_AI_INPUT";
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

test("project-management document AI continues the selected linked worktree when requested", { concurrency: false, timeout: 30000 }, async () => {
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

test("project-management document AI uses a suffixed branch when explicitly starting a new worktree again", { concurrency: false, timeout: 30000 }, async () => {
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
