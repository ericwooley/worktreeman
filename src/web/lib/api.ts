import type {
  AppendProjectManagementBatchRequest,
  ApiStateResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  GitComparisonResponse,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  ShutdownStatus,
  TmuxClientInfo,
  UpdateProjectManagementDocumentRequest,
  WorktreeRuntime,
} from "@shared/types";

export interface EnvSyncResponse {
  copiedFiles: string[];
}

async function request<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `Request failed with status ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("application/json")) {
    const body = await response.text();
    if (contentType.includes("text/html") || /^\s*</.test(body)) {
      throw new Error("API returned HTML instead of JSON. Restart the server to pick up backend route changes.");
    }

    throw new Error(`Expected JSON response but received ${contentType || "an unknown content type"}.`);
  }

  return (await response.json()) as T;
}

export function getState(): Promise<ApiStateResponse> {
  return request<ApiStateResponse>("/api/state");
}

export function getConfigDocument(): Promise<ConfigDocumentResponse> {
  return request<ConfigDocumentResponse>("/api/config/document");
}

export function saveConfigDocument(contents: string): Promise<ConfigDocumentResponse> {
  return request<ConfigDocumentResponse>("/api/config/document", {
    method: "PUT",
    body: JSON.stringify({ contents }),
  });
}

export function getGitComparison(compareBranch: string, baseBranch?: string): Promise<GitComparisonResponse> {
  const params = new URLSearchParams({ compareBranch });
  if (baseBranch) {
    params.set("baseBranch", baseBranch);
  }

  return request<GitComparisonResponse>(`/api/git/compare?${params.toString()}`);
}

export function listProjectManagementDocuments(): Promise<ProjectManagementListResponse> {
  return request<ProjectManagementListResponse>("/api/project-management/documents");
}

export function getProjectManagementDocument(documentId: string): Promise<ProjectManagementDocumentResponse> {
  return request<ProjectManagementDocumentResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}`);
}

export function getProjectManagementHistory(documentId: string): Promise<ProjectManagementHistoryResponse> {
  return request<ProjectManagementHistoryResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/history`);
}

export function createProjectManagementDocument(
  payload: CreateProjectManagementDocumentRequest,
): Promise<ProjectManagementDocumentResponse> {
  return request<ProjectManagementDocumentResponse>("/api/project-management/documents", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProjectManagementDocument(
  documentId: string,
  payload: UpdateProjectManagementDocumentRequest,
): Promise<ProjectManagementDocumentResponse> {
  return request<ProjectManagementDocumentResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/updates`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function appendProjectManagementBatch(
  payload: AppendProjectManagementBatchRequest,
): Promise<ProjectManagementBatchResponse> {
  return request<ProjectManagementBatchResponse>("/api/project-management/batches", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createWorktree(branch: string, worktreePath?: string): Promise<EnvSyncResponse | void> {
  return request<EnvSyncResponse | void>("/api/worktrees", {
    method: "POST",
    body: JSON.stringify({ branch, path: worktreePath }),
  });
}

export function deleteWorktree(branch: string): Promise<void> {
  return request<void>(`/api/worktrees/${encodeURIComponent(branch)}`, {
    method: "DELETE",
  });
}

export function startRuntime(branch: string): Promise<WorktreeRuntime> {
  return request<WorktreeRuntime>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/start`, {
    method: "POST",
  });
}

export function stopRuntime(branch: string): Promise<void> {
  return request<void>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/stop`, {
    method: "POST",
  });
}

export function syncEnvFiles(branch: string): Promise<EnvSyncResponse> {
  return request<EnvSyncResponse>(`/api/worktrees/${encodeURIComponent(branch)}/env/sync`, {
    method: "POST",
  });
}

export function getTmuxClients(branch: string): Promise<TmuxClientInfo[]> {
  return request<TmuxClientInfo[]>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/tmux-clients`);
}

export function disconnectTmuxClient(branch: string, clientId: string): Promise<void> {
  return request<void>(
    `/api/worktrees/${encodeURIComponent(branch)}/runtime/tmux-clients/${encodeURIComponent(clientId)}/disconnect`,
    {
      method: "POST",
    },
  );
}

export function subscribeToShutdownStatus(onStatus: (status: ShutdownStatus) => void): () => void {
  const source = new EventSource("/api/shutdown-status");

  source.onmessage = (event) => {
    onStatus(JSON.parse(event.data) as ShutdownStatus);
  };

  return () => {
    source.close();
  };
}

export function getBackgroundCommands(branch: string): Promise<BackgroundCommandState[]> {
  return request<BackgroundCommandState[]>(`/api/worktrees/${encodeURIComponent(branch)}/background-commands`);
}

export function startBackgroundCommand(branch: string, commandName: string): Promise<BackgroundCommandState[]> {
  return request<BackgroundCommandState[]>(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/start`,
    { method: "POST" },
  );
}

export function stopBackgroundCommand(branch: string, commandName: string): Promise<BackgroundCommandState[]> {
  return request<BackgroundCommandState[]>(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/stop`,
    { method: "POST" },
  );
}

export function restartBackgroundCommand(branch: string, commandName: string): Promise<BackgroundCommandState[]> {
  return request<BackgroundCommandState[]>(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/restart`,
    { method: "POST" },
  );
}

export function getBackgroundCommandLogs(branch: string, commandName: string): Promise<BackgroundCommandLogsResponse> {
  return request<BackgroundCommandLogsResponse>(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/logs`,
  );
}

export function subscribeToBackgroundCommandLogs(
  branch: string,
  commandName: string,
  onEvent: (event: BackgroundCommandLogStreamEvent) => void,
): () => void {
  let closed = false;
  const source = new EventSource(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/logs/stream`,
  );

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as BackgroundCommandLogStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }

    source.close();
  };

  return () => {
    closed = true;
    source.close();
  };
}
