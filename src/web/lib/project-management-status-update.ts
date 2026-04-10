import type {
  ProjectManagementDocumentSummary,
  ProjectManagementListResponse,
} from "@shared/types";

export function mergeUpdatedProjectManagementDocumentIntoList(
  current: ProjectManagementListResponse | null,
  document: ProjectManagementDocumentSummary,
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
