import type {
  AiCommandConfig,
  AiCommandId,
  WorktreeReviewIssue,
  WorktreeReviewResult,
} from "../../shared/types.js";
import { autoCommitGitChanges } from "./git-service.js";
import { addProjectManagementReviewEntry } from "./project-management-review-service.js";
import { getProjectManagementDocument, updateProjectManagementDocument } from "./project-management-service.js";
import { buildWorktreeAiCompletedComment } from "./project-management-comment-formatters.js";
import { logServerEvent } from "../utils/server-logger.js";

const PROJECT_MANAGEMENT_DOCUMENT_OUTPUT_PATTERN = /<wtm-new-document>([\s\S]*?)<\/wtm-new-document>/i;
const PROJECT_MANAGEMENT_REVIEW_OUTPUT_PATTERN = /<wtm-review>([\s\S]*?)<\/wtm-review>/i;
const PROJECT_MANAGEMENT_REVIEW_RESULT_PATTERN = /<wtm-review-result\s+passed="(true|false)">([\s\S]*?)<\/wtm-review-result>/i;
const PROJECT_MANAGEMENT_REVIEW_ISSUE_PATTERN = /<wtm-review-issue\s+id="([^"]+)">([\s\S]*?)<\/wtm-review-issue>/gi;
const PROJECT_MANAGEMENT_REVIEW_ISSUE_SUMMARY_PATTERN = /<summary>([\s\S]*?)<\/summary>/i;
const PROJECT_MANAGEMENT_REVIEW_ISSUE_DETAILS_PATTERN = /<details>([\s\S]*?)<\/details>/i;

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

export function extractTaggedReviewResult(stdout: string): WorktreeReviewResult {
  const match = stdout.match(PROJECT_MANAGEMENT_REVIEW_RESULT_PATTERN);
  const passedValue = match?.[1]?.trim().toLowerCase();
  const innerXml = match?.[2] ?? "";
  if (passedValue !== "true" && passedValue !== "false") {
    throw new Error("AI command finished without returning <wtm-review-result passed=\"true|false\">...</wtm-review-result>. Inspect the saved AI log output to see the raw response.");
  }

  const issues: WorktreeReviewIssue[] = [];
  for (const issueMatch of innerXml.matchAll(PROJECT_MANAGEMENT_REVIEW_ISSUE_PATTERN)) {
    const id = issueMatch[1]?.trim();
    const body = issueMatch[2] ?? "";
    const summary = body.match(PROJECT_MANAGEMENT_REVIEW_ISSUE_SUMMARY_PATTERN)?.[1]?.trim() ?? "";
    const details = body.match(PROJECT_MANAGEMENT_REVIEW_ISSUE_DETAILS_PATTERN)?.[1]?.trim() ?? "";
    if (!id || !summary || !details) {
      throw new Error("AI command returned an invalid <wtm-review-issue>. Each issue must include id, <summary>, and <details>.");
    }

    issues.push({ id, summary, details });
  }

  const passed = passedValue === "true";
  if (passed && issues.length > 0) {
    throw new Error("AI command returned review issues even though <wtm-review-result passed=\"true\"> was set.");
  }
  if (!passed && issues.length === 0) {
    throw new Error("AI command returned <wtm-review-result passed=\"false\"> without any <wtm-review-issue> entries.");
  }

  return { passed, issues };
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
}): Promise<WorktreeReviewResult | null> {
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
    return null;
  }

  const reviewResult = options.reviewAction === "review"
    ? extractTaggedReviewResult(options.stdout)
    : null;
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

  return reviewResult;
}
