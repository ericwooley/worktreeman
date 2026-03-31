import type { AiCommandId, GitCompareCommit } from "../../shared/types.js";

function normalizeInlineText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function formatLogBlock(value: string, options?: { maxCharacters?: number; maxLines?: number }): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  const maxCharacters = options?.maxCharacters ?? 4_000;
  const maxLines = options?.maxLines ?? 80;
  const lines = trimmed
    .split(/\r?\n/)
    .slice(0, maxLines)
    .map((line) => line.trimEnd());
  let joined = lines.join("\n");

  if (joined.length > maxCharacters) {
    joined = `${joined.slice(0, maxCharacters)}\n…`;
  } else if (trimmed.length > joined.length || trimmed.split(/\r?\n/).length > lines.length) {
    joined = `${joined}\n…`;
  }

  return joined
    .split("\n")
    .map((line) => line ? `> ${line}` : ">")
    .join("\n");
}

function formatLogAccordion(title: string, value: string): string | null {
  const block = formatLogBlock(value);
  if (!block) {
    return null;
  }

  return [
    `<details>`,
    `<summary>${title}</summary>`,
    "",
    block,
    "",
    `</details>`,
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
}) {
  const lines = [
    "## Worktree AI started",
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
}) {
  const lines = [
    "## Worktree AI completed",
    "",
    `- Branch: \`${details.branch}\``,
    `- Command: \`${details.commandId}\``,
  ];

  if (details.requestSummary?.trim()) {
    lines.push(`- Request: ${normalizeInlineText(details.requestSummary)}`);
  }

  const stdoutAccordion = formatLogAccordion("Stdout", details.stdout);
  const stderrAccordion = formatLogAccordion("Stderr", details.stderr);
  if (stdoutAccordion || stderrAccordion) {
    lines.push("", "### Output");
  }
  if (stdoutAccordion) {
    lines.push("", stdoutAccordion);
  }
  if (stderrAccordion) {
    lines.push("", stderrAccordion);
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
