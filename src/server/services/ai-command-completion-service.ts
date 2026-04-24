import type { AiCommandConfig, AiCommandId } from "../../shared/types.js";
import { autoCommitGitChanges } from "./git-service.js";
import { addProjectManagementReviewEntry } from "./project-management-review-service.js";
import { getProjectManagementDocument, updateProjectManagementDocument } from "./project-management-service.js";
import { buildWorktreeAiCompletedComment } from "./project-management-comment-formatters.js";
import { logServerEvent } from "../utils/server-logger.js";

const PROJECT_MANAGEMENT_DOCUMENT_OUTPUT_PATTERN = /<wtm-new-document>([\s\S]*?)<\/wtm-new-document>/i;
const PROJECT_MANAGEMENT_REVIEW_OUTPUT_PATTERN = /<wtm-review>([\s\S]*?)<\/wtm-review>/i;

function extractUpdatedProjectManagementMarkdown(stdout: string) {
  const match = stdout.match(PROJECT_MANAGEMENT_DOCUMENT_OUTPUT_PATTERN);
  const nextMarkdown = match?.[1]?.trim();
  if (!nextMarkdown) {
    throw new Error("AI command finished without returning <wtm-new-document>...</wtm-new-document>. Inspect the saved AI log output to see the raw response.");
  }

  return nextMarkdown;
}

function extractTaggedReviewMarkdown(stdout: string) {
  const match = stdout.match(PROJECT_MANAGEMENT_REVIEW_OUTPUT_PATTERN);
  const nextReview = match?.[1]?.trim();
  if (!nextReview) {
    throw new Error("AI command finished without returning <wtm-review>...</wtm-review>. Inspect the saved AI log output to see the raw response.");
  }

  return nextReview;
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
  reviewDocumentId?: string | null;
  reviewRequestSummary?: string | null;
  reviewAction?: "implement" | "review" | null;
  autoCommitDirtyWorktree?: boolean;
}) {
  if (options.applyDocumentUpdateToDocumentId) {
    const nextMarkdown = extractUpdatedProjectManagementMarkdown(options.stdout);

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

  if (!options.reviewDocumentId) {
    return;
  }

  const reviewBody = options.reviewAction === "review"
    ? extractTaggedReviewMarkdown(options.stdout)
    : buildWorktreeAiCompletedComment({
        branch: options.branch,
        commandId: options.commandId,
        requestSummary: options.reviewRequestSummary,
        stdout: options.stdout,
        stderr: options.stderr,
        reviewAction: options.reviewAction,
      });

  try {
    await addProjectManagementReviewEntry(options.repoRoot, options.reviewDocumentId, {
      body: reviewBody,
      kind: options.reviewAction === "review" ? "comment" : "activity",
      source: "ai",
      eventType: "ai-completed",
    });
  } catch (error) {
    logServerEvent("project-management-review", "failed", {
      branch: options.branch,
      documentId: options.reviewDocumentId,
      error: error instanceof Error ? error.message : String(error),
    }, "error");
  }
}
