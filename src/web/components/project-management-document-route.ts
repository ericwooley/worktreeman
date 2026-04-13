export type ProjectManagementDocumentPresentation = "modal" | "page";

const PROJECT_MANAGEMENT_DOCUMENT_PATH_PATTERN = /^\/project-management\/documents\/([^/]+)\/?$/;

export function buildProjectManagementDocumentPath(documentId: string): string {
  return `/project-management/documents/${encodeURIComponent(documentId)}`;
}

export function readProjectManagementDocumentPath(pathname: string): {
  documentId: string | null;
  presentation: ProjectManagementDocumentPresentation;
} {
  const match = pathname.match(PROJECT_MANAGEMENT_DOCUMENT_PATH_PATTERN);
  if (!match) {
    return {
      documentId: null,
      presentation: "modal",
    };
  }

  try {
    return {
      documentId: decodeURIComponent(match[1]),
      presentation: "page",
    };
  } catch {
    return {
      documentId: match[1],
      presentation: "page",
    };
  }
}
