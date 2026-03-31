import type { AiCommandConfig, AiCommandId } from "../../shared/types.js";
import { autoCommitGitChanges } from "./git-service.js";
import { addProjectManagementComment, getProjectManagementDocument, updateProjectManagementDocument } from "./project-management-service.js";
import { buildWorktreeAiCompletedComment } from "./project-management-comment-formatters.js";
import { logServerEvent } from "../utils/server-logger.js";

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
      body: buildWorktreeAiCompletedComment({
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
