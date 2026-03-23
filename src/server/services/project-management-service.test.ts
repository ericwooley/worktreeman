import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE } from "../../shared/constants.js";
import { runCommand } from "../utils/process.js";
import { createBareRepoLayout } from "./repository-layout-service.js";
import {
  appendProjectManagementBatch,
  clearProjectManagementCache,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
  updateProjectManagementDocument,
} from "./project-management-service.js";

async function createTestRepo(): Promise<string> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "wtm-project-management-"));
  await createBareRepoLayout({ rootDir });
  clearProjectManagementCache(rootDir);
  return rootDir;
}

async function destroyTestRepo(rootDir: string): Promise<void> {
  clearProjectManagementCache(rootDir);
  await fs.rm(rootDir, { recursive: true, force: true });
}

test("listProjectManagementDocuments bootstraps the branch with Project Outline", async () => {
  const repoRoot = await createTestRepo();

  try {
    const documents = await listProjectManagementDocuments(repoRoot);
    const revList = await runCommand("git", ["rev-list", "--count", documents.headSha], { cwd: repoRoot });

    assert.equal(documents.documents.length, 1);
    assert.equal(documents.documents[0].number, 1);
    assert.equal(documents.documents[0].title, DEFAULT_PROJECT_MANAGEMENT_DOCUMENT_TITLE);
    assert.deepEqual(documents.documents[0].tags, ["plan"]);
    assert.equal(Number(revList.stdout.trim()), 1);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("create and update project-management documents persist markdown and normalized tags", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Bug Inbox",
      markdown: "# Bug Inbox\n\nTrack issues here.\n",
      tags: ["Bug", " bug ", "Research Notes"],
      status: "todo",
      assignee: "Alex",
    });

    assert.equal(created.document.title, "Bug Inbox");
    assert.equal(created.document.number, 2);
    assert.deepEqual(created.document.tags, ["bug", "research-notes"]);
    assert.equal(created.document.status, "todo");
    assert.equal(created.document.assignee, "Alex");
    assert.equal(created.document.archived, false);

    const updated = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: "Bug Inbox",
      markdown: "# Bug Inbox\n\n- Investigate login loop\n",
      tags: ["bug", "blocked"],
      status: "blocked",
      assignee: "Taylor",
    });

    assert.match(updated.document.markdown, /Investigate login loop/);
    assert.deepEqual(updated.document.tags, ["bug", "blocked"]);
    assert.equal(updated.document.status, "blocked");
    assert.equal(updated.document.assignee, "Taylor");

    const history = await getProjectManagementDocumentHistory(repoRoot, created.document.id);
    assert.equal(history.history.length, 2);
    assert.deepEqual(history.history.map((entry) => entry.action), ["create", "update"]);
    assert.match(history.history[1].diff, /-status: todo/);
    assert.match(history.history[1].diff, /\+status: blocked/);
    assert.match(history.history[1].diff, /\+\- Investigate login loop|\+Investigate login loop|Investigate login loop/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("reference status is preserved but excluded from the board status set", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Reference Notes",
      markdown: "# Reference Notes\n",
      tags: ["reference"],
      status: "reference",
    });

    assert.equal(created.document.status, "reference");

    const list = await listProjectManagementDocuments(repoRoot);
    assert.equal(list.availableStatuses.includes("reference"), true);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("appendProjectManagementBatch writes multiple document updates in one commit", async () => {
  const repoRoot = await createTestRepo();

  try {
    const batch = await appendProjectManagementBatch(repoRoot, {
      entries: [
        {
          title: "Epic Alpha",
          markdown: "# Epic Alpha\n",
          tags: ["epic"],
          status: "in-progress",
          assignee: "Morgan",
        },
        {
          title: "Feature Beta",
          markdown: "# Feature Beta\n",
          tags: ["feature"],
          status: "todo",
          assignee: "Casey",
        },
      ],
    });

    assert.equal(batch.documentIds.length, 2);

    const list = await listProjectManagementDocuments(repoRoot);
    const matching = list.documents.filter((entry) => batch.documentIds.includes(entry.id));
    assert.equal(matching.length, 2);
    assert.deepEqual(matching.map((entry) => entry.number).sort((left, right) => left - right), [2, 3]);

    const historyA = await getProjectManagementDocumentHistory(repoRoot, batch.documentIds[0]);
    const historyB = await getProjectManagementDocumentHistory(repoRoot, batch.documentIds[1]);
    assert.equal(historyA.history.length, 1);
    assert.equal(historyB.history.length, 1);
    assert.equal(historyA.history[0].commitSha, historyB.history[0].commitSha);
    assert.ok(historyA.history[0].number >= 2);
    assert.equal(historyA.history[0].status, "in-progress");
    assert.equal(historyB.history[0].assignee, "Casey");
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("documents can be archived and restored with metadata preserved", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Decision Log",
      markdown: "# Decision Log\n",
      tags: ["decision"],
      status: "done",
      assignee: "Jordan",
    });

    const archived = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: created.document.title,
      markdown: created.document.markdown,
      tags: created.document.tags,
      status: created.document.status,
      assignee: created.document.assignee,
      archived: true,
    });

    assert.equal(archived.document.archived, true);

    const restored = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: archived.document.title,
      markdown: archived.document.markdown,
      tags: archived.document.tags,
      status: archived.document.status,
      assignee: archived.document.assignee,
      archived: false,
    });

    assert.equal(restored.document.archived, false);

    const history = await getProjectManagementDocumentHistory(repoRoot, created.document.id);
    assert.deepEqual(history.history.map((entry) => entry.action), ["create", "archive", "restore"]);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("clearing the in-memory cache rebuilds state from git history", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Plan Delta",
      markdown: "# Plan Delta\n",
      tags: ["plan"],
    });

    await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: "Plan Delta",
      markdown: "# Plan Delta\n\nUpdated after cache clear.\n",
      tags: ["plan", "decision"],
    });

    clearProjectManagementCache(repoRoot);

    const rebuilt = await getProjectManagementDocument(repoRoot, created.document.id);
    assert.match(rebuilt.document.markdown, /Updated after cache clear/);
    assert.deepEqual(rebuilt.document.tags, ["plan", "decision"]);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("concurrent appends succeed via update-ref retry and preserve all documents", async () => {
  const repoRoot = await createTestRepo();

  try {
    const results = await Promise.all([
      createProjectManagementDocument(repoRoot, {
        title: "Feature One",
        markdown: "# Feature One\n",
        tags: ["feature"],
      }),
      createProjectManagementDocument(repoRoot, {
        title: "Feature Two",
        markdown: "# Feature Two\n",
        tags: ["feature"],
      }),
      createProjectManagementDocument(repoRoot, {
        title: "Bug Three",
        markdown: "# Bug Three\n",
        tags: ["bug"],
      }),
    ]);

    const list = await listProjectManagementDocuments(repoRoot);
    const createdIds = new Set(results.map((entry) => entry.document.id));
    const listIds = new Set(list.documents.map((entry) => entry.id));

    for (const documentId of createdIds) {
      assert.equal(listIds.has(documentId), true);
    }
  } finally {
    await destroyTestRepo(repoRoot);
  }
});
