import assert from "node:assert/strict";
import test from "#test-runtime";
import type { ProjectManagementDocument } from "@shared/types";
import { ApiError } from "./api";
import {
  buildProjectManagementStatusFallbackPayload,
  mergeUpdatedProjectManagementDocumentIntoList,
  shouldFallbackProjectManagementStatusUpdate,
} from "./project-management-status-update";

const sampleDocument: ProjectManagementDocument = {
  id: "doc-1",
  number: 1,
  title: "Dependencies",
  summary: "Track prerequisite document work.",
  markdown: "# Dependencies\n",
  tags: ["feature", "ux"],
  dependencies: ["doc-2"],
  status: "todo",
  assignee: "Eric",
  archived: false,
  createdAt: "2026-03-20T10:00:00.000Z",
  updatedAt: "2026-03-25T10:00:00.000Z",
  historyCount: 2,
  comments: [],
};

test("status update fallback only triggers for missing status route", () => {
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new ApiError("missing", 404)), true);
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new ApiError("bad request", 400)), false);
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new Error("boom")), false);
});

test("status update fallback payload preserves document fields and only changes status", () => {
  assert.deepEqual(buildProjectManagementStatusFallbackPayload(sampleDocument, "in-progress"), {
    title: "Dependencies",
    summary: "Track prerequisite document work.",
    markdown: "# Dependencies\n",
    tags: ["feature", "ux"],
    dependencies: ["doc-2"],
    status: "in-progress",
    assignee: "Eric",
    archived: false,
  });
});

test("mergeUpdatedProjectManagementDocumentIntoList updates the matching document and tags", () => {
  const merged = mergeUpdatedProjectManagementDocumentIntoList({
    branch: "refs/heads/main",
    headSha: "abc123",
    documents: [sampleDocument, {
      ...sampleDocument,
      id: "doc-2",
      number: 2,
      title: "Second",
      tags: ["plan"],
      dependencies: [],
      status: "todo",
      historyCount: 1,
      markdown: "# Second\n",
      comments: [],
    }],
    availableTags: ["feature", "plan", "ux"],
    availableStatuses: ["backlog", "todo", "in-progress", "blocked", "done", "reference"],
  }, {
    ...sampleDocument,
    status: "in-progress",
    tags: ["ops"],
  });

  assert.deepEqual(merged?.documents.map((entry) => ({ id: entry.id, status: entry.status, tags: entry.tags })), [
    { id: "doc-1", status: "in-progress", tags: ["ops"] },
    { id: "doc-2", status: "todo", tags: ["plan"] },
  ]);
  assert.deepEqual(merged?.availableTags, ["ops", "plan"]);
});
