import type { AiCommandId, GitCompareCommit } from "../../shared/types.js";

type WorktreeReviewAction = "implement" | "review";

function getAiActivityHeading(phase: "started" | "completed", reviewAction?: WorktreeReviewAction | null) {
  if (reviewAction === "review") {
    return phase === "started" ? "## Worktree AI review started" : "## Worktree AI review completed";
  }

  return phase === "started" ? "## Worktree AI started" : "## Worktree AI completed";
}

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatLogBlock(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n");
}

function countNonEmptyLines(value: string): number {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .length;
}

function formatLogSection(title: string, value: string): string | null {
  const block = formatLogBlock(value);
  if (!block) {
    return null;
  }

  return [
    `#### ${title}`,
    "",
    "```text",
    block,
    "```",
    "",
  ].join("\n");
}

function formatCombinedLogDetails(stdout: string, stderr: string): string | null {
  const sections = [
    formatLogSection("Stdout", stdout),
    formatLogSection("Stderr", stderr),
  ].filter((section): section is string => Boolean(section));

  if (!sections.length) {
    return null;
  }

  return [
    "<details>",
    "<summary>Output details</summary>",
    "",
    ...sections.flatMap((section, index) => (index === 0 ? [section] : ["", section])),
    "</details>",
  ].join("\n");
}

function formatCommitDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) {
    return value;
  }

  return date.toISOString().slice(0, 10);
}

export function buildWorktreeAiStartedComment(details: {
  branch: string;
  commandId: AiCommandId;
  requestSummary?: string | null;
  reviewAction?: WorktreeReviewAction | null;
}) {
  const lines = [
    getAiActivityHeading("started", details.reviewAction),
    "",
    `- Branch: \`${details.branch}\``,
    `- Command: \`${details.commandId}\``,
  ];

  if (details.requestSummary?.trim()) {
    lines.push(`- Request: ${normalizeInlineText(details.requestSummary)}`);
  }

  return lines.join("\n");
}

export function buildWorktreeAiCompletedComment(details: {
  branch: string;
  commandId: AiCommandId;
  requestSummary?: string | null;
  stdout: string;
  stderr: string;
  reviewAction?: WorktreeReviewAction | null;
}) {
  const stdoutLineCount = countNonEmptyLines(details.stdout);
  const stderrLineCount = countNonEmptyLines(details.stderr);
  const lines = [
    getAiActivityHeading("completed", details.reviewAction),
    "",
    `- Branch: \`${details.branch}\``,
    `- Command: \`${details.commandId}\``,
    `- Output: ${stdoutLineCount} stdout line${stdoutLineCount === 1 ? "" : "s"}, ${stderrLineCount} stderr line${stderrLineCount === 1 ? "" : "s"}`,
  ];

  if (details.requestSummary?.trim()) {
    lines.push(`- Request: ${normalizeInlineText(details.requestSummary)}`);
  }

  const outputDetails = formatCombinedLogDetails(details.stdout, details.stderr);
  if (outputDetails) {
    lines.push("", outputDetails);
  }

  return lines.join("\n");
}

export function buildWorktreeMergeComment(details: {
  branch: string;
  baseBranch: string;
  commits: GitCompareCommit[];
}) {
  const lines = [
    "## Worktree merged",
    "",
    `Merged \`${details.branch}\` into \`${details.baseBranch}\`.`,
    "",
    `### Merged commits (${details.commits.length})`,
  ];

  if (!details.commits.length) {
    lines.push("- No merge commits were reported for this branch.");
    return lines.join("\n");
  }

  for (const commit of details.commits) {
    lines.push(`- \`${commit.shortHash}\` ${commit.subject} — ${commit.authorName} (${formatCommitDate(commit.authoredAt)})`);
  }

  return lines.join("\n");
}
