import type {
  ApiStateResponse,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  ShutdownStatus,
  TmuxClientInfo,
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

  return (await response.json()) as T;
}

export function getState(): Promise<ApiStateResponse> {
  return request<ApiStateResponse>("/api/state");
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

export function getBackgroundCommandLogs(branch: string, commandName: string): Promise<BackgroundCommandLogsResponse> {
  return request<BackgroundCommandLogsResponse>(
    `/api/worktrees/${encodeURIComponent(branch)}/background-commands/${encodeURIComponent(commandName)}/logs`,
  );
}
