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

test("buildWorktreeAiCompletedComment renders stdout and stderr accordions with quote blocks", () => {
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
  assert.match(comment, /- Request: summarize the worktree run/);
  assert.match(comment, /### Output/);
  assert.match(comment, /<summary>Stdout<\/summary>/);
  assert.match(comment, /> planned change\n> implemented change/);
  assert.match(comment, /<summary>Stderr<\/summary>/);
  assert.match(comment, /> warning: verify snapshot/);
});

test("buildWorktreeAiCompletedComment omits empty output sections", () => {
  const comment = buildWorktreeAiCompletedComment({
    branch: "feature/comments",
    commandId: "smart",
    stdout: "   ",
    stderr: "",
  });

  assert.doesNotMatch(comment, /### Output/);
  assert.doesNotMatch(comment, /<details>/);
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
