import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "#test-runtime";
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
  moveProjectManagementDocumentTowardInProgress,
  updateProjectManagementDocument,
  updateProjectManagementDependencies,
  updateProjectManagementStatus,
} from "./project-management-service.js";
import { closeManagedDatabaseClient } from "./database-client-service.js";
import { addProjectManagementReviewEntry, getProjectManagementDocumentReview } from "./project-management-review-service.js";

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

test("create and update project-management documents persist markdown, summary, and normalized tags", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Bug Inbox",
      summary: "Track incoming bugs and research follow-ups.",
      markdown: "# Bug Inbox\n\nTrack issues here.\n",
      tags: ["Bug", " bug ", "Research Notes"],
      status: "todo",
      assignee: "Alex",
    });

    assert.equal(created.document.title, "Bug Inbox");
    assert.equal(created.document.number, 2);
    assert.equal(created.document.summary, "Track incoming bugs and research follow-ups.");
    assert.deepEqual(created.document.tags, ["bug", "research-notes"]);
    assert.equal(created.document.status, "todo");
    assert.equal(created.document.assignee, "Alex");
    assert.equal(created.document.archived, false);

    const createdList = await listProjectManagementDocuments(repoRoot);
    const createdSummary = createdList.documents.find((entry) => entry.id === created.document.id);
    assert.equal(createdSummary?.summary, "Track incoming bugs and research follow-ups.");

    const updated = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: "Bug Inbox",
      summary: "Track incoming bugs, reviews, and owner handoffs.",
      markdown: "# Bug Inbox\n\n- Investigate login loop\n",
      tags: ["bug", "review"],
      status: "review_passed",
      assignee: "Taylor",
    });
    const updatedDetail = await getProjectManagementDocument(repoRoot, created.document.id);

    assert.match(updatedDetail.document.markdown, /Investigate login loop/);
    assert.equal(updated.document.summary, "Track incoming bugs, reviews, and owner handoffs.");
    assert.deepEqual(updated.document.tags, ["bug", "review"]);
    assert.equal(updated.document.status, "review_passed");
    assert.equal(updated.document.assignee, "Taylor");

    const history = await getProjectManagementDocumentHistory(repoRoot, created.document.id);
    assert.equal(history.history.length, 2);
    assert.deepEqual(history.history.map((entry) => entry.action), ["create", "update"]);
    assert.match(history.history[1].diff, /-status: todo/);
    assert.match(history.history[1].diff, /\+status: review_passed/);
    assert.match(history.history[1].diff, /-summary: Track incoming bugs and research follow-ups\./);
    assert.match(history.history[1].diff, /\+summary: Track incoming bugs, reviews, and owner handoffs\./);
    assert.match(history.history[1].diff, /\+\- Investigate login loop|\+Investigate login loop|Investigate login loop/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("review entries use the repo git user for attribution", async () => {
  const repoRoot = await createTestRepo();

  try {
    await runCommand("git", ["config", "user.name", "Casey Reviewer"], { cwd: repoRoot });
    await runCommand("git", ["config", "user.email", "casey@example.com"], { cwd: repoRoot });

    const created = await createProjectManagementDocument(repoRoot, {
      title: "Review Queue",
      summary: "Collect feedback before shipping.",
      markdown: "# Review Queue\n",
      tags: ["review"],
    });

    const reviewed = await addProjectManagementReviewEntry(repoRoot, created.document.id, {
      body: "  Waiting on final QA verification.  ",
    });

    assert.equal(reviewed.review.documentId, created.document.id);
    assert.equal(reviewed.review.entries.length, 1);
    assert.equal(reviewed.review.entries[0]?.body, "Waiting on final QA verification.");
    assert.equal(reviewed.review.entries[0]?.authorName, "Casey Reviewer");
    assert.equal(reviewed.review.entries[0]?.authorEmail, "casey@example.com");
    assert.equal(reviewed.review.entries[0]?.eventType, "comment");

    const commit = await runCommand("git", ["show", "-s", "--format=%an <%ae>", reviewed.headSha], { cwd: repoRoot });
    assert.equal(commit.stdout.trim(), "Casey Reviewer <casey@example.com>");

    const persisted = await getProjectManagementDocument(repoRoot, created.document.id);
    assert.equal(persisted.document.summary, "Collect feedback before shipping.");

    const persistedReview = await getProjectManagementDocumentReview(repoRoot, created.document.id);
    assert.equal(persistedReview.review.entries.length, 1);
    assert.equal(persistedReview.review.entries[0]?.body, "Waiting on final QA verification.");
    assert.equal(persistedReview.review.entries[0]?.authorName, "Casey Reviewer");
    assert.equal(persistedReview.review.entries[0]?.authorEmail, "casey@example.com");
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("review entries fall back to default author when git is unavailable", async () => {
  const repoRoot = await createTestRepo();
  const originalPath = process.env.PATH;
  const shimDir = await fs.mkdtemp(path.join(repoRoot, "git-shim-"));
  const realGit = (await runCommand("which", ["git"], { cwd: repoRoot })).stdout.trim();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Offline author fallback",
      summary: "Ensure comments still persist when git config lookups fail.",
      markdown: "# Offline author fallback\n",
      tags: ["fallback"],
    });

    const shimPath = path.join(shimDir, "git");
    await fs.writeFile(shimPath, `#!/bin/sh
if [ "$1" = "config" ] && [ "$2" = "--get" ]; then
  exit 127
fi
exec ${realGit} "$@"
`, "utf8");
    await fs.chmod(shimPath, 0o755);
    process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

    const reviewed = await addProjectManagementReviewEntry(repoRoot, created.document.id, {
      body: "Git config lookup failures should not break comment writes.",
    });

    assert.equal(reviewed.review.entries.at(-1)?.authorName, "worktreeman");
    assert.equal(reviewed.review.entries.at(-1)?.authorEmail, "worktreeman@example.com");

    const persistedReview = await getProjectManagementDocumentReview(repoRoot, created.document.id);
    assert.equal(persistedReview.review.entries.at(-1)?.authorName, "worktreeman");
    assert.equal(persistedReview.review.entries.at(-1)?.authorEmail, "worktreeman@example.com");
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(shimDir, { recursive: true, force: true });
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
    assert.equal(list.availableStatuses.includes("review_passed"), true);
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
      markdown: created.document.markdown,
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

test("appendProjectManagementBatch updates multiple existing documents in one commit", async () => {
  const repoRoot = await createTestRepo();

  try {
    const first = await createProjectManagementDocument(repoRoot, {
      title: "Board Card Alpha",
      summary: "Move this card together with the next one.",
      markdown: "# Board Card Alpha\n",
      tags: ["feature"],
      status: "todo",
      assignee: "Avery",
    });
    const second = await createProjectManagementDocument(repoRoot, {
      title: "Board Card Beta",
      summary: "Archive this card in the same batch.",
      markdown: "# Board Card Beta\n",
      tags: ["bug"],
      status: "todo",
      assignee: "Casey",
    });

    const batch = await appendProjectManagementBatch(repoRoot, {
      entries: [
        {
          documentId: first.document.id,
          title: first.document.title,
          summary: first.document.summary,
          markdown: first.document.markdown,
          tags: first.document.tags,
          dependencies: first.document.dependencies,
          status: "in-progress",
          assignee: first.document.assignee,
          archived: false,
        },
        {
          documentId: second.document.id,
          title: second.document.title,
          summary: second.document.summary,
          markdown: second.document.markdown,
          tags: second.document.tags,
          dependencies: second.document.dependencies,
          status: "done",
          assignee: second.document.assignee,
          archived: true,
        },
      ],
    });

    assert.deepEqual(batch.documentIds.sort(), [first.document.id, second.document.id].sort());

    const firstUpdated = await getProjectManagementDocument(repoRoot, first.document.id);
    const secondUpdated = await getProjectManagementDocument(repoRoot, second.document.id);
    assert.equal(firstUpdated.document.status, "in-progress");
    assert.equal(firstUpdated.document.summary, first.document.summary);
    assert.deepEqual(firstUpdated.document.tags, first.document.tags);
    assert.equal(firstUpdated.document.archived, false);
    assert.equal(secondUpdated.document.status, "done");
    assert.equal(secondUpdated.document.archived, true);
    assert.equal(secondUpdated.document.assignee, second.document.assignee);

    const firstHistory = await getProjectManagementDocumentHistory(repoRoot, first.document.id);
    const secondHistory = await getProjectManagementDocumentHistory(repoRoot, second.document.id);
    assert.equal(firstHistory.history.length, 2);
    assert.equal(secondHistory.history.length, 2);
    assert.equal(firstHistory.history.at(-1)?.commitSha, secondHistory.history.at(-1)?.commitSha);
    assert.match(firstHistory.history.at(-1)?.diff ?? "", /\+status: in-progress/);
    assert.match(secondHistory.history.at(-1)?.diff ?? "", /\+archived: true/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("dependencies persist on create and can be updated independently", async () => {
  const repoRoot = await createTestRepo();

  try {
    const foundation = await createProjectManagementDocument(repoRoot, {
      title: "Foundation",
      markdown: "# Foundation\n",
      tags: ["plan"],
    });

    const dependent = await createProjectManagementDocument(repoRoot, {
      title: "Dependent Feature",
      summary: "Deliver the feature after foundation work lands.",
      markdown: "# Dependent Feature\n",
      tags: ["feature"],
      dependencies: [foundation.document.id],
    });

    assert.deepEqual(dependent.document.dependencies, [foundation.document.id]);
    assert.equal(dependent.document.summary, "Deliver the feature after foundation work lands.");

    const outline = await listProjectManagementDocuments(repoRoot);
    const dependentSummary = outline.documents.find((entry) => entry.id === dependent.document.id);
    assert.deepEqual(dependentSummary?.dependencies, [foundation.document.id]);
    assert.equal(dependentSummary?.summary, "Deliver the feature after foundation work lands.");

    const updated = await updateProjectManagementDependencies(repoRoot, dependent.document.id, []);
    assert.deepEqual(updated.document.dependencies, []);
    assert.equal(updated.document.summary, "Deliver the feature after foundation work lands.");

    const history = await getProjectManagementDocumentHistory(repoRoot, dependent.document.id);
    assert.match(history.history.at(-1)?.diff ?? "", /dependencies:/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("status can be updated independently without changing dependencies or summary", async () => {
  const repoRoot = await createTestRepo();

  try {
    const foundation = await createProjectManagementDocument(repoRoot, {
      title: "Foundation",
      markdown: "# Foundation\n",
      tags: ["plan"],
    });

    const dependent = await createProjectManagementDocument(repoRoot, {
      title: "Dependent Feature",
      summary: "Deliver the feature after foundation work lands.",
      markdown: "# Dependent Feature\n",
      tags: ["feature"],
      dependencies: [foundation.document.id],
      status: "todo",
      assignee: "Taylor",
    });

    const updated = await updateProjectManagementStatus(repoRoot, dependent.document.id, "in-progress");
    assert.equal(updated.document.status, "in-progress");
    assert.equal(updated.document.summary, "Deliver the feature after foundation work lands.");
    assert.deepEqual(updated.document.dependencies, [foundation.document.id]);
    assert.equal(updated.document.assignee, "Taylor");

    const list = await listProjectManagementDocuments(repoRoot);
    const dependentSummary = list.documents.find((entry) => entry.id === dependent.document.id);
    assert.equal(dependentSummary?.status, "in-progress");
    assert.equal(dependentSummary?.summary, "Deliver the feature after foundation work lands.");
    assert.deepEqual(dependentSummary?.dependencies, [foundation.document.id]);

    const history = await getProjectManagementDocumentHistory(repoRoot, dependent.document.id);
    assert.match(history.history.at(-1)?.diff ?? "", /-status: todo/);
    assert.match(history.history.at(-1)?.diff ?? "", /\+status: in-progress/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("status updates reuse persisted document fields when only a lane change is requested", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Board Move",
      summary: "Keep the existing document contents while moving lanes.",
      markdown: "# Board Move\n\nPreserve me.\n",
      tags: ["plan", "board"],
      status: "todo",
      assignee: "Taylor",
    });

    const updated = await updateProjectManagementStatus(repoRoot, created.document.id, "done");

    assert.equal(updated.document.status, "done");
    assert.equal(updated.document.title, "Board Move");
    assert.equal(updated.document.summary, "Keep the existing document contents while moving lanes.");
    assert.deepEqual(updated.document.tags, ["plan", "board"]);
    assert.equal(updated.document.assignee, "Taylor");

    const persisted = await getProjectManagementDocument(repoRoot, created.document.id);
    assert.equal(persisted.document.markdown, "# Board Move\n\nPreserve me.\n");
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("moving a document toward in-progress only advances backlog and todo documents", async () => {
  const repoRoot = await createTestRepo();

  try {
    const backlog = await createProjectManagementDocument(repoRoot, {
      title: "Backlog document",
      markdown: "# Backlog document\n",
      tags: ["plan"],
      status: "backlog",
    });
    const todo = await createProjectManagementDocument(repoRoot, {
      title: "Todo document",
      markdown: "# Todo document\n",
      tags: ["feature"],
      status: "todo",
    });
    const reviewPassed = await createProjectManagementDocument(repoRoot, {
      title: "Review passed document",
      markdown: "# Review passed document\n",
      tags: ["review"],
      status: "review_passed",
    });
    const done = await createProjectManagementDocument(repoRoot, {
      title: "Done document",
      markdown: "# Done document\n",
      tags: ["feature"],
      status: "done",
    });
    const reference = await createProjectManagementDocument(repoRoot, {
      title: "Reference document",
      markdown: "# Reference document\n",
      tags: ["reference"],
      status: "reference",
    });

    const backlogMoved = await moveProjectManagementDocumentTowardInProgress(repoRoot, backlog.document.id);
    const todoMoved = await moveProjectManagementDocumentTowardInProgress(repoRoot, todo.document.id);
    const reviewPassedMoved = await moveProjectManagementDocumentTowardInProgress(repoRoot, reviewPassed.document.id);
    const doneMoved = await moveProjectManagementDocumentTowardInProgress(repoRoot, done.document.id);
    const referenceMoved = await moveProjectManagementDocumentTowardInProgress(repoRoot, reference.document.id);

    assert.equal(backlogMoved.document.status, "in-progress");
    assert.equal(todoMoved.document.status, "in-progress");
    assert.equal(reviewPassedMoved.document.status, "review_passed");
    assert.equal(doneMoved.document.status, "done");
    assert.equal(referenceMoved.document.status, "reference");

    const backlogHistory = await getProjectManagementDocumentHistory(repoRoot, backlog.document.id);
    const todoHistory = await getProjectManagementDocumentHistory(repoRoot, todo.document.id);
    const reviewPassedHistory = await getProjectManagementDocumentHistory(repoRoot, reviewPassed.document.id);
    const doneHistory = await getProjectManagementDocumentHistory(repoRoot, done.document.id);
    const referenceHistory = await getProjectManagementDocumentHistory(repoRoot, reference.document.id);

    assert.equal(backlogHistory.history.length, 2);
    assert.equal(todoHistory.history.length, 2);
    assert.equal(reviewPassedHistory.history.length, 1);
    assert.equal(doneHistory.history.length, 1);
    assert.equal(referenceHistory.history.length, 1);
    assert.match(backlogHistory.history.at(-1)?.diff ?? "", /\+status: in-progress/);
    assert.match(todoHistory.history.at(-1)?.diff ?? "", /\+status: in-progress/);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("dependency cycles are rejected", async () => {
  const repoRoot = await createTestRepo();

  try {
    const alpha = await createProjectManagementDocument(repoRoot, {
      title: "Alpha",
      markdown: "# Alpha\n",
      tags: ["plan"],
    });
    const beta = await createProjectManagementDocument(repoRoot, {
      title: "Beta",
      markdown: "# Beta\n",
      tags: ["feature"],
      dependencies: [alpha.document.id],
    });
    const gamma = await createProjectManagementDocument(repoRoot, {
      title: "Gamma",
      markdown: "# Gamma\n",
      tags: ["feature"],
      dependencies: [beta.document.id],
    });

    await assert.rejects(
      updateProjectManagementDependencies(repoRoot, alpha.document.id, [gamma.document.id]),
      /Dependency cycles are not allowed/,
    );

    const alphaAfter = await getProjectManagementDocument(repoRoot, alpha.document.id);
    assert.deepEqual(alphaAfter.document.dependencies, []);
  } finally {
    await destroyTestRepo(repoRoot);
  }
});

test("clearing the in-memory cache reuses the persisted Postgres store without replaying history", async () => {
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

    const originalPath = process.env.PATH;
    const shimDir = await fs.mkdtemp(path.join(repoRoot, "git-cache-shim-"));
    const realGit = (await runCommand("which", ["git"], { cwd: repoRoot })).stdout.trim();

    clearProjectManagementCache(repoRoot);
    await closeManagedDatabaseClient(repoRoot, "project-management-cache");

    try {
      const shimPath = path.join(shimDir, "git");
      await fs.writeFile(shimPath, `#!/bin/sh
if [ "$1" = "rev-list" ] || [ "$1" = "cat-file" ] || [ "$1" = "merge-base" ]; then
  echo "unexpected git replay" >&2
  exit 99
fi
exec ${realGit} "$@"
`, "utf8");
      await fs.chmod(shimPath, 0o755);
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

      const rebuilt = await getProjectManagementDocument(repoRoot, created.document.id);
      assert.match(rebuilt.document.markdown, /Updated after cache clear/);
      assert.deepEqual(rebuilt.document.tags, ["plan", "decision"]);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  } finally {
    await closeManagedDatabaseClient(repoRoot, "project-management-cache").catch(() => undefined);
    await destroyTestRepo(repoRoot);
  }
});

test("clearing the in-memory cache incrementally applies new commits when the persisted head is an ancestor", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Persisted Snapshot",
      markdown: "# Persisted Snapshot\n",
      tags: ["plan"],
    });

    const updated = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: "Persisted Snapshot",
      markdown: "# Persisted Snapshot\n\nWarm cache content.\n",
      tags: ["plan", "cached"],
    });

    await runCommand("git", ["update-ref", "refs/heads/wtm-project-management", created.headSha, updated.headSha], { cwd: repoRoot });
    clearProjectManagementCache(repoRoot);
    await closeManagedDatabaseClient(repoRoot, "project-management-cache");

    const rewound = await getProjectManagementDocument(repoRoot, created.document.id);
    assert.equal(rewound.headSha, created.headSha);
    assert.deepEqual(rewound.document.tags, ["plan"]);

    const originalPath = process.env.PATH;
    const shimDir = await fs.mkdtemp(path.join(repoRoot, "git-cache-shim-"));
    const realGit = (await runCommand("which", ["git"], { cwd: repoRoot })).stdout.trim();

    await runCommand("git", ["update-ref", "refs/heads/wtm-project-management", updated.headSha, created.headSha], { cwd: repoRoot });

    clearProjectManagementCache(repoRoot);
    await closeManagedDatabaseClient(repoRoot, "project-management-cache");

    try {
      const shimPath = path.join(shimDir, "git");
      await fs.writeFile(shimPath, `#!/bin/sh
if [ "$1" = "merge-base" ] || [ "$1" = "rev-parse" ] || [ "$1" = "config" ] || [ "$1" = "log" ]; then
  exec ${realGit} "$@"
fi
if [ "$1" = "rev-list" ]; then
  if [ "$2" = "--reverse" ] && [ "$3" = "${created.headSha}..${updated.headSha}" ]; then
    exec ${realGit} "$@"
  fi
  echo "unexpected full rev-list replay" >&2
  exit 99
fi
if [ "$1" = "cat-file" ]; then
  if [ "$2" = "-p" ] && [ "$3" = "${updated.headSha}:batch.json" ]; then
    exec ${realGit} "$@"
  fi
  echo "unexpected historical cat-file replay" >&2
  exit 99
fi
echo "unexpected git command: $1" >&2
exit 99
`, "utf8");
      await fs.chmod(shimPath, 0o755);
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

      const rebuilt = await getProjectManagementDocument(repoRoot, created.document.id);
      assert.equal(rebuilt.headSha, updated.headSha);
      assert.match(rebuilt.document.markdown, /Warm cache content/);
      assert.deepEqual(rebuilt.document.tags, ["plan", "cached"]);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  } finally {
    await closeManagedDatabaseClient(repoRoot, "project-management-cache").catch(() => undefined);
    await destroyTestRepo(repoRoot);
  }
});

test("clearing the in-memory cache rebuilds from scratch when the persisted head is not an ancestor", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Rebuild Required",
      markdown: "# Rebuild Required\n",
      tags: ["plan"],
    });

    const updated = await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: "Rebuild Required",
      markdown: "# Rebuild Required\n\nBefore rebuild.\n",
      tags: ["plan", "before-rebuild"],
    });

    const batchContents = await runCommand("git", ["show", `${updated.headSha}:batch.json`], { cwd: repoRoot });
    const blob = await runCommand("git", ["hash-object", "-w", "--stdin"], {
      cwd: repoRoot,
      stdin: batchContents.stdout,
    });
    const tree = await runCommand("git", ["mktree"], {
      cwd: repoRoot,
      stdin: `100644 blob ${blob.stdout.trim()}\tbatch.json\n`,
    });
    const replacementCommit = await runCommand(
      "git",
      ["commit-tree", tree.stdout.trim(), "-p", created.headSha, "-m", "pm: rebuild branch"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Manual Rebuild",
          GIT_AUTHOR_EMAIL: "rebuild@example.com",
          GIT_COMMITTER_NAME: "Manual Rebuild",
          GIT_COMMITTER_EMAIL: "rebuild@example.com",
        },
      },
    );
    const replacementHead = replacementCommit.stdout.trim();
    await runCommand("git", ["update-ref", "refs/heads/wtm-project-management", replacementHead, updated.headSha], { cwd: repoRoot });

    const originalPath = process.env.PATH;
    const shimDir = await fs.mkdtemp(path.join(repoRoot, "git-rebuild-shim-"));
    const realGit = (await runCommand("which", ["git"], { cwd: repoRoot })).stdout.trim();

    clearProjectManagementCache(repoRoot);
    await closeManagedDatabaseClient(repoRoot, "project-management-cache");

    try {
      const shimPath = path.join(shimDir, "git");
      await fs.writeFile(shimPath, `#!/bin/sh
if [ "$1" = "merge-base" ] || [ "$1" = "rev-parse" ] || [ "$1" = "config" ] || [ "$1" = "log" ] || [ "$1" = "cat-file" ]; then
  exec ${realGit} "$@"
fi
if [ "$1" = "rev-list" ]; then
  if [ "$2" = "--reverse" ] && [ "$3" = "${replacementHead}" ]; then
    exec ${realGit} "$@"
  fi
  echo "expected full rebuild rev-list" >&2
  exit 99
fi
echo "unexpected git command: $1" >&2
exit 99
`, "utf8");
      await fs.chmod(shimPath, 0o755);
      process.env.PATH = `${shimDir}:${originalPath ?? ""}`;

      const rebuilt = await getProjectManagementDocument(repoRoot, created.document.id);
      assert.equal(rebuilt.headSha, replacementHead);
      assert.match(rebuilt.document.markdown, /Before rebuild/);
      assert.deepEqual(rebuilt.document.tags, ["plan", "before-rebuild"]);
    } finally {
      process.env.PATH = originalPath;
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  } finally {
    await closeManagedDatabaseClient(repoRoot, "project-management-cache").catch(() => undefined);
    await destroyTestRepo(repoRoot);
  }
});

test("project-management history diffs are truncated to a bounded in-memory size", async () => {
  const repoRoot = await createTestRepo();

  try {
    const created = await createProjectManagementDocument(repoRoot, {
      title: "Large Diff Document",
      markdown: "# Large Diff Document\n",
      tags: ["plan"],
    });

    const largeMarkdown = `# Large Diff Document\n\n${"A very large line of markdown content.\n".repeat(5000)}`;
    await updateProjectManagementDocument(repoRoot, created.document.id, {
      title: created.document.title,
      markdown: largeMarkdown,
      tags: created.document.tags,
    });

    const history = await getProjectManagementDocumentHistory(repoRoot, created.document.id);
    const latestDiff = history.history.at(-1)?.diff ?? "";
    assert.match(latestDiff, /Diff truncated because it exceeded the in-memory history limit\./);
    assert.equal(latestDiff.length <= 20_128, true);
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
