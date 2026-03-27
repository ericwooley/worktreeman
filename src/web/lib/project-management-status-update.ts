import type { ProjectManagementDocument, UpdateProjectManagementDocumentRequest } from "@shared/types";
import { ApiError } from "./api";

export function shouldFallbackProjectManagementStatusUpdate(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

export function buildProjectManagementStatusFallbackPayload(
  document: ProjectManagementDocument,
  status: string,
): UpdateProjectManagementDocumentRequest {
  return {
    title: document.title,
    summary: document.summary || undefined,
    markdown: document.markdown,
    tags: document.tags,
    dependencies: document.dependencies,
    status,
    assignee: document.assignee,
    archived: document.archived,
  };
}
