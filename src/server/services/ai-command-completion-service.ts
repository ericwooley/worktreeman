import type { AiCommandConfig, AiCommandId } from "../../shared/types.js";
import { autoCommitGitChanges } from "./git-service.js";
import { addProjectManagementComment, getProjectManagementDocument, updateProjectManagementDocument } from "./project-management-service.js";
import { logServerEvent } from "../utils/server-logger.js";

function formatLogSnippet(value: string, maxLength = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function buildWorktreeAiComment(details: {
  branch: string;
  commandId: AiCommandId;
  requestSummary?: string | null;
  stdout: string;
  stderr: string;
}) {
  const lines = [
    `AI worktree run completed for \`${details.branch}\`.`,
    "",
    `- Command: ${details.commandId}`,
  ];

  if (details.requestSummary?.trim()) {
    lines.push(`- Request: ${formatLogSnippet(details.requestSummary, 280)}`);
  }

  const stdoutSnippet = formatLogSnippet(details.stdout, 280);
  if (stdoutSnippet) {
    lines.push(`- Stdout: ${stdoutSnippet}`);
  }

  const stderrSnippet = formatLogSnippet(details.stderr, 280);
  if (stderrSnippet) {
    lines.push(`- Stderr: ${stderrSnippet}`);
  }

  return lines.join("\n");
}

export async function completeAiCommandRun(options: {
  repoRoot: string;
  branch: string;
  commandId: AiCommandId;
  aiCommands: AiCommandConfig;
  env: NodeJS.ProcessEnv;
  stdout: string;
  stderr: string;
  applyDocumentUpdateToDocumentId?: string | null;
  commentDocumentId?: string | null;
  commentRequestSummary?: string | null;
  autoCommitDirtyWorktree?: boolean;
}) {
  if (options.applyDocumentUpdateToDocumentId) {
    const nextMarkdown = options.stdout.trim();
    if (!nextMarkdown) {
      throw new Error("AI command finished without returning updated markdown.");
    }

    const currentDocument = await getProjectManagementDocument(options.repoRoot, options.applyDocumentUpdateToDocumentId);
    await updateProjectManagementDocument(options.repoRoot, options.applyDocumentUpdateToDocumentId, {
      title: currentDocument.document.title,
      summary: currentDocument.document.summary,
      markdown: nextMarkdown,
      tags: currentDocument.document.tags,
      dependencies: currentDocument.document.dependencies,
      status: currentDocument.document.status,
      assignee: currentDocument.document.assignee,
      archived: currentDocument.document.archived,
    });
  }

  if (options.autoCommitDirtyWorktree) {
    const autoCommit = await autoCommitGitChanges({
      repoRoot: options.repoRoot,
      branch: options.branch,
      aiCommands: options.aiCommands,
      env: options.env,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      if (/has no local changes to commit\.$/.test(message)) {
        return null;
      }

      throw error;
    });

    if (autoCommit) {
      logServerEvent("ai-command", "auto-commit-created", {
        branch: options.branch,
        commandId: autoCommit.commandId,
        commitSha: autoCommit.commitSha,
        message: autoCommit.message,
      });
    }
  }

  if (!options.commentDocumentId) {
    return;
  }

  try {
    await addProjectManagementComment(options.repoRoot, options.commentDocumentId, {
      body: buildWorktreeAiComment({
        branch: options.branch,
        commandId: options.commandId,
        requestSummary: options.commentRequestSummary,
        stdout: options.stdout,
        stderr: options.stderr,
      }),
    });
  } catch (error) {
    logServerEvent("project-management-comment", "failed", {
      branch: options.branch,
      documentId: options.commentDocumentId,
      error: error instanceof Error ? error.message : String(error),
    }, "error");
  }
}
