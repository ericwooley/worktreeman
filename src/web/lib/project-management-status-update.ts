import type {
  ProjectManagementDocument,
  ProjectManagementListResponse,
  UpdateProjectManagementDocumentRequest,
} from "@shared/types";
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

export function mergeUpdatedProjectManagementDocumentIntoList(
  current: ProjectManagementListResponse | null,
  document: ProjectManagementDocument,
): ProjectManagementListResponse | null {
  if (!current) {
    return current;
  }

  const documents = current.documents.map((entry) => entry.id === document.id ? document : entry);
  const availableTags = [...new Set(documents.flatMap((entry) => entry.tags))].sort((left, right) => left.localeCompare(right));

  return {
    ...current,
    documents,
    availableTags,
  };
}
