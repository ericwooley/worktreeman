import assert from "node:assert/strict";
import test from "#test-runtime";
import type { ProjectManagementDocument } from "@shared/types";
import { ApiError } from "./api";
import {
  buildProjectManagementStatusFallbackPayload,
  shouldFallbackProjectManagementStatusUpdate,
} from "./project-management-status-update";

const sampleDocument: ProjectManagementDocument = {
  id: "doc-1",
  number: 1,
  title: "Dependencies",
  summary: "Track prerequisite document work.",
  markdown: "# Dependencies\n",
  kind: "document",
  pullRequest: null,
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

test("status update fallback only triggers for missing dedicated route", () => {
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new ApiError("missing", 404)), true);
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new ApiError("server", 500)), false);
  assert.equal(shouldFallbackProjectManagementStatusUpdate(new Error("missing")), false);
});

test("status update fallback payload preserves existing document fields", () => {
  assert.deepEqual(buildProjectManagementStatusFallbackPayload(sampleDocument, "done"), {
    title: "Dependencies",
    summary: "Track prerequisite document work.",
    markdown: "# Dependencies\n",
    kind: "document",
    pullRequest: null,
    tags: ["feature", "ux"],
    dependencies: ["doc-2"],
    status: "done",
    assignee: "Eric",
    archived: false,
  });
});

test("status update fallback omits empty summaries", () => {
  assert.deepEqual(buildProjectManagementStatusFallbackPayload({
    ...sampleDocument,
    summary: "",
  }, "blocked"), {
    title: "Dependencies",
    summary: undefined,
    markdown: "# Dependencies\n",
    kind: "document",
    pullRequest: null,
    tags: ["feature", "ux"],
    dependencies: ["doc-2"],
    status: "blocked",
    assignee: "Eric",
    archived: false,
  });
});
