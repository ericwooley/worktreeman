import type {
  AddProjectManagementReviewEntryRequest,
  AppendProjectManagementBatchRequest,
  AiCommandLogResponse,
  ApiStateStreamEvent,
  AiCommandLogStreamEvent,
  AiCommandLogsResponse,
  AiCommandSettingsResponse,
  AutoSyncSettingsResponse,
  AiCommandStreamEvent,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  CommitGitChangesRequest,
  CommitGitChangesResponse,
  ConfigDocumentResponse,
  DashboardEventsStreamEvent,
  DeleteWorktreeRequest,
  CreateProjectManagementDocumentRequest,
  ProjectManagementDocumentSummaryResponse,
  GenerateGitCommitMessageRequest,
  GenerateGitCommitMessageResponse,
  GitComparisonResponse,
  GitComparisonStreamEvent,
  MergeGitBranchRequest,
  ResolveGitMergeConflictsRequest,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementDocumentReviewResponse,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  ProjectManagementReviewsResponse,
  ProjectManagementDocumentsStreamEvent,
  ProjectManagementUsersResponse,
  ProjectManagementUsersStreamEvent,
  ReconnectTerminalResponse,
  RunAiCommandRequest,
  RunProjectManagementDocumentAiRequest,
  RunAiCommandResponse,
  ShutdownStatus,
  SystemStatusResponse,
  SystemStatusStreamEvent,
  TmuxClientInfo,
  TmuxClientsStreamEvent,
  UpdateAiCommandSettingsRequest,
  UpdateAutoSyncSettingsRequest,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementDocumentRequest,
  UpdateProjectManagementStatusRequest,
  UpdateProjectManagementUsersRequest,
  WorktreeAutoSyncState,
  WorktreeRuntime,
} from "@shared/types";

export interface EnvSyncResponse {
  copiedFiles: string[];
}

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function logStreamEvent(scope: string, event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined" || typeof console.info !== "function") {
    return;
  }

  console.info("[api-stream]", scope, event, details);
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
    throw new ApiError(payload?.message ?? `Request failed with status ${response.status}`, response.status);
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

export function subscribeToState(
  onEvent: (event: ApiStateStreamEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let closed = false;
  const source = new EventSource("/api/state/stream");

  source.onopen = () => {
    onConnectionChange?.(true);
  };

  source.onmessage = (event) => {
    onConnectionChange?.(true);
    onEvent(JSON.parse(event.data) as ApiStateStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }

    onConnectionChange?.(false);
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function subscribeToDashboardEvents(
  onEvent: (event: DashboardEventsStreamEvent) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  let closed = false;
  const url = "/api/events/stream";
  const source = new EventSource(url);
  logStreamEvent("dashboard-events", "connect", { url });

  source.onopen = () => {
    logStreamEvent("dashboard-events", "open", { readyState: source.readyState });
    onConnectionChange?.(true);
  };

  source.onmessage = (event) => {
    onConnectionChange?.(true);
    onEvent(JSON.parse(event.data) as DashboardEventsStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }

    logStreamEvent("dashboard-events", "error", { readyState: source.readyState });
    onConnectionChange?.(false);
  };

  return () => {
    closed = true;
    source.close();
  };
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

export function getAiCommandSettings(): Promise<AiCommandSettingsResponse> {
  return request<AiCommandSettingsResponse>("/api/settings/ai-command");
}

export function saveAiCommandSettings(payload: UpdateAiCommandSettingsRequest): Promise<AiCommandSettingsResponse> {
  return request<AiCommandSettingsResponse>("/api/settings/ai-command", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function getAutoSyncSettings(): Promise<AutoSyncSettingsResponse> {
  return request<AutoSyncSettingsResponse>("/api/settings/auto-sync");
}

export function saveAutoSyncSettings(payload: UpdateAutoSyncSettingsRequest): Promise<AutoSyncSettingsResponse> {
  return request<AutoSyncSettingsResponse>("/api/settings/auto-sync", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function runAiCommand(branch: string, payload: RunAiCommandRequest): Promise<RunAiCommandResponse> {
  return request<RunAiCommandResponse>(`/api/worktrees/${encodeURIComponent(branch)}/ai-command/run`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function runProjectManagementDocumentAi(
  documentId: string,
  payload: RunProjectManagementDocumentAiRequest,
): Promise<RunAiCommandResponse> {
  return request<RunAiCommandResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/ai-command/run`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function cancelAiCommand(branch: string): Promise<RunAiCommandResponse> {
  return request<RunAiCommandResponse>(`/api/worktrees/${encodeURIComponent(branch)}/ai-command/cancel`, {
    method: "POST",
  });
}

export function subscribeToAiCommandJob(
  branch: string,
  onEvent: (event: AiCommandStreamEvent) => void,
): () => void {
  let closed = false;
  const source = new EventSource(`/api/worktrees/${encodeURIComponent(branch)}/ai-command/stream`);

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as AiCommandStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function getAiCommandLogs(): Promise<AiCommandLogsResponse> {
  return request<AiCommandLogsResponse>("/api/ai/logs");
}

export function getAiCommandLog(jobId: string): Promise<AiCommandLogResponse> {
  return request<AiCommandLogResponse>(`/api/ai/logs/${encodeURIComponent(jobId)}`);
}

export function getSystemStatus(): Promise<SystemStatusResponse> {
  return request<SystemStatusResponse>("/api/system");
}

export function subscribeToSystemStatus(onEvent: (event: SystemStatusStreamEvent) => void): () => void {
  let closed = false;
  const source = new EventSource("/api/system/stream");

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as SystemStatusStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function subscribeToAiCommandLog(
  jobId: string,
  onEvent: (event: AiCommandLogStreamEvent) => void,
): () => void {
  let closed = false;
  const url = `/api/ai/logs/${encodeURIComponent(jobId)}/stream`;
  const source = new EventSource(url);
  logStreamEvent("ai-log", "connect", { url, jobId });

  source.onopen = () => {
    logStreamEvent("ai-log", "open", { readyState: source.readyState, jobId });
  };

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as AiCommandLogStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }

    logStreamEvent("ai-log", "error", { readyState: source.readyState, jobId });
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function getGitComparison(compareBranch: string, baseBranch?: string): Promise<GitComparisonResponse> {
  const params = new URLSearchParams({ compareBranch });
  if (baseBranch) {
    params.set("baseBranch", baseBranch);
  }

  return request<GitComparisonResponse>(`/api/git/compare?${params.toString()}`);
}

export function subscribeToGitComparison(
  compareBranch: string,
  baseBranch: string | undefined,
  onEvent: (event: GitComparisonStreamEvent) => void,
): () => void {
  let closed = false;
  const params = new URLSearchParams({ compareBranch });
  if (baseBranch) {
    params.set("baseBranch", baseBranch);
  }

  const source = new EventSource(`/api/git/compare/stream?${params.toString()}`);

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as GitComparisonStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function mergeGitBranch(compareBranch: string, payload?: MergeGitBranchRequest): Promise<GitComparisonResponse> {
  return request<GitComparisonResponse>(`/api/git/compare/${encodeURIComponent(compareBranch)}/merge`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function resolveGitMergeConflicts(compareBranch: string, payload?: ResolveGitMergeConflictsRequest): Promise<GitComparisonResponse> {
  return request<GitComparisonResponse>(`/api/git/compare/${encodeURIComponent(compareBranch)}/resolve-conflicts`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function commitGitChanges(branch: string, payload?: CommitGitChangesRequest): Promise<CommitGitChangesResponse> {
  return request<CommitGitChangesResponse>(`/api/git/compare/${encodeURIComponent(branch)}/commit`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function generateGitCommitMessage(
  branch: string,
  payload?: GenerateGitCommitMessageRequest,
): Promise<GenerateGitCommitMessageResponse> {
  return request<GenerateGitCommitMessageResponse>(`/api/git/compare/${encodeURIComponent(branch)}/commit-message`, {
    method: "POST",
    body: JSON.stringify(payload ?? {}),
  });
}

export function listProjectManagementDocuments(): Promise<ProjectManagementListResponse> {
  return request<ProjectManagementListResponse>("/api/project-management/documents");
}

export function subscribeToProjectManagementDocuments(
  onEvent: (event: ProjectManagementDocumentsStreamEvent) => void,
): () => void {
  let closed = false;
  const source = new EventSource("/api/project-management/documents/stream");

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as ProjectManagementDocumentsStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
    source.close();
  };
}

export function getProjectManagementUsers(): Promise<ProjectManagementUsersResponse> {
  return request<ProjectManagementUsersResponse>("/api/project-management/users");
}

export function subscribeToProjectManagementUsers(
  onEvent: (event: ProjectManagementUsersStreamEvent) => void,
): () => void {
  let closed = false;
  const source = new EventSource("/api/project-management/users/stream");

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as ProjectManagementUsersStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
    source.close();
  };
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
): Promise<ProjectManagementDocumentSummaryResponse> {
  return request<ProjectManagementDocumentSummaryResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/updates`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProjectManagementDependencies(
  documentId: string,
  payload: UpdateProjectManagementDependenciesRequest,
): Promise<ProjectManagementDocumentSummaryResponse> {
  return request<ProjectManagementDocumentSummaryResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/dependencies`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateProjectManagementStatus(
  documentId: string,
  payload: UpdateProjectManagementStatusRequest,
): Promise<ProjectManagementDocumentSummaryResponse> {
  return request<ProjectManagementDocumentSummaryResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/status`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function getProjectManagementReviews(): Promise<ProjectManagementReviewsResponse> {
  return request<ProjectManagementReviewsResponse>("/api/project-management/reviews");
}

export function getProjectManagementDocumentReview(documentId: string): Promise<ProjectManagementDocumentReviewResponse> {
  return request<ProjectManagementDocumentReviewResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/review`);
}

export function addProjectManagementReviewEntry(
  documentId: string,
  payload: AddProjectManagementReviewEntryRequest,
): Promise<ProjectManagementDocumentReviewResponse> {
  return request<ProjectManagementDocumentReviewResponse>(`/api/project-management/documents/${encodeURIComponent(documentId)}/review`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function deleteProjectManagementReviewEntry(documentId: string, reviewEntryId: string): Promise<void> {
  return request<void>(`/api/project-management/documents/${encodeURIComponent(documentId)}/review/${encodeURIComponent(reviewEntryId)}`, {
    method: "DELETE",
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

export function updateProjectManagementUsers(
  payload: UpdateProjectManagementUsersRequest,
): Promise<ProjectManagementUsersResponse> {
  return request<ProjectManagementUsersResponse>("/api/project-management/users", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function createWorktree(branch: string, documentId?: string | null): Promise<EnvSyncResponse | void> {
  return request<EnvSyncResponse | void>("/api/worktrees", {
    method: "POST",
    body: JSON.stringify({
      branch,
      documentId: documentId ?? undefined,
    }),
  });
}

export function deleteWorktree(branch: string, payload?: DeleteWorktreeRequest): Promise<void> {
  return request<void>(`/api/worktrees/${encodeURIComponent(branch)}`, {
    method: "DELETE",
    body: JSON.stringify(payload ?? {}),
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

export function restartRuntime(branch: string): Promise<WorktreeRuntime> {
  return request<WorktreeRuntime>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/restart`, {
    method: "POST",
  });
}

export function syncEnvFiles(branch: string): Promise<EnvSyncResponse> {
  return request<EnvSyncResponse>(`/api/worktrees/${encodeURIComponent(branch)}/env/sync`, {
    method: "POST",
  });
}

export function enableAutoSync(branch: string): Promise<WorktreeAutoSyncState> {
  return request<WorktreeAutoSyncState>(`/api/worktrees/${encodeURIComponent(branch)}/auto-sync/enable`, {
    method: "POST",
  });
}

export function disableAutoSync(branch: string): Promise<WorktreeAutoSyncState> {
  return request<WorktreeAutoSyncState>(`/api/worktrees/${encodeURIComponent(branch)}/auto-sync/disable`, {
    method: "POST",
  });
}

export function runAutoSync(branch: string): Promise<WorktreeAutoSyncState | null> {
  return request<WorktreeAutoSyncState | null>(`/api/worktrees/${encodeURIComponent(branch)}/auto-sync/run`, {
    method: "POST",
  });
}

export function reconnectTerminal(branch: string): Promise<ReconnectTerminalResponse> {
  return request<ReconnectTerminalResponse>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/reconnect`, {
    method: "POST",
  });
}

export function getTmuxClients(branch: string): Promise<TmuxClientInfo[]> {
  return request<TmuxClientInfo[]>(`/api/worktrees/${encodeURIComponent(branch)}/runtime/tmux-clients`);
}

export function subscribeToTmuxClients(branch: string, onEvent: (event: TmuxClientsStreamEvent) => void): () => void {
  let closed = false;
  const url = `/api/worktrees/${encodeURIComponent(branch)}/runtime/tmux-clients/stream`;
  const source = new EventSource(url);
  logStreamEvent("tmux-clients", "connect", { url, branch });

  source.onopen = () => {
    logStreamEvent("tmux-clients", "open", { readyState: source.readyState, branch });
  };

  source.onmessage = (event) => {
    onEvent(JSON.parse(event.data) as TmuxClientsStreamEvent);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }

    logStreamEvent("tmux-clients", "error", { readyState: source.readyState, branch });
  };

  return () => {
    closed = true;
    source.close();
  };
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
  let closed = false;
  const source = new EventSource("/api/shutdown-status");

  source.onmessage = (event) => {
    onStatus(JSON.parse(event.data) as ShutdownStatus);
  };

  source.onerror = () => {
    if (closed) {
      return;
    }
  };

  return () => {
    closed = true;
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
  };

  return () => {
    closed = true;
    source.close();
  };
}
