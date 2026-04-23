import assert from "node:assert/strict";
import test from "#test-runtime";
import {
  buildWorktreeAiCompletedComment,
  buildWorktreeAiStartedComment,
  buildWorktreeMergeComment,
} from "./project-management-comment-formatters.js";

test("buildWorktreeAiStartedComment formats markdown metadata", () => {
  const comment = buildWorktreeAiStartedComment({
    branch: "feature/comments",
    commandId: "smart",
    requestSummary: "  tighten   comment formatting\nfor document runs  ",
  });

  assert.equal(comment, [
    "## Worktree AI started",
    "",
    "- Branch: `feature/comments`",
    "- Command: `smart`",
    "- Request: tighten comment formatting for document runs",
  ].join("\n"));
});

test("buildWorktreeAiCompletedComment renders stdout and stderr inside collapsible output details", () => {
  const comment = buildWorktreeAiCompletedComment({
    branch: "feature/comments",
    commandId: "simple",
    requestSummary: "summarize the worktree run",
    stdout: "planned change\nimplemented change\n",
    stderr: "warning: verify snapshot\n",
  });

  assert.match(comment, /## Worktree AI completed/);
  assert.match(comment, /- Branch: `feature\/comments`/);
  assert.match(comment, /- Command: `simple`/);
  assert.match(comment, /- Output: 2 stdout lines, 1 stderr line/);
  assert.match(comment, /- Request: summarize the worktree run/);
  assert.match(comment, /<details>/);
  assert.match(comment, /<summary>Output details<\/summary>/);
  assert.match(comment, /#### Stdout/);
  assert.match(comment, /```text\nplanned change\nimplemented change\n```/);
  assert.match(comment, /#### Stderr/);
  assert.match(comment, /```text\nwarning: verify snapshot\n```/);
  assert.match(comment, /<\/details>/);
});

test("buildWorktreeAiCompletedComment omits empty output sections", () => {
  const comment = buildWorktreeAiCompletedComment({
    branch: "feature/comments",
    commandId: "smart",
    stdout: "   ",
    stderr: "",
  });

  assert.doesNotMatch(comment, /<details>/);
  assert.match(comment, /- Output: 0 stdout lines, 0 stderr lines/);
  assert.doesNotMatch(comment, /```text/);
});

test("buildWorktreeMergeComment formats merged commit bullets", () => {
  const comment = buildWorktreeMergeComment({
    branch: "feature/comments",
    baseBranch: "main",
    commits: [
      {
        hash: "1234567890abcdef1234567890abcdef12345678",
        shortHash: "1234567",
        subject: "Add markdown merge comment",
        authorName: "Casey Reviewer",
        authoredAt: "2026-03-31T10:15:00.000Z",
      },
    ],
  });

  assert.equal(comment, [
    "## Worktree merged",
    "",
    "Merged `feature/comments` into `main`.",
    "",
    "### Merged commits (1)",
    "- `1234567` Add markdown merge comment — Casey Reviewer (2026-03-31)",
  ].join("\n"));
});

test("buildWorktreeMergeComment includes empty commit fallback", () => {
  const comment = buildWorktreeMergeComment({
    branch: "feature/comments",
    baseBranch: "main",
    commits: [],
  });

  assert.match(comment, /### Merged commits \(0\)/);
  assert.match(comment, /- No merge commits were reported for this branch\./);
});
