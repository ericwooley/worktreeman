export interface BackgroundCommandConfigEntry {
  command: string;
}

export interface QuickLinkConfigEntry {
  name: string;
  url: string;
}

export interface WorktreeManagerConfig {
  env: Record<string, string>;
  runtimePorts: string[];
  derivedEnv: Record<string, string>;
  quickLinks: QuickLinkConfigEntry[];
  startupCommands: string[];
  backgroundCommands: Record<string, BackgroundCommandConfigEntry>;
  worktrees: {
    baseDir: string;
  };
}

export interface WorktreeRuntime {
  branch: string;
  worktreePath: string;
  env: Record<string, string>;
  quickLinks: QuickLinkConfigEntry[];
  allocatedPorts: Record<string, number>;
  tmuxSession: string;
  runtimeStartedAt?: string;
}

export interface BackgroundCommandState {
  name: string;
  command: string;
  processName: string;
  manager: "pm2";
  running: boolean;
  status: string;
  requiresRuntime: boolean;
  canStart: boolean;
  note?: string;
  pid?: number;
  startedAt?: string;
}

export interface BackgroundCommandLogLine {
  id: string;
  source: "stdout" | "stderr";
  text: string;
  timestamp?: string;
}

export interface BackgroundCommandLogsResponse {
  commandName: string;
  lines: BackgroundCommandLogLine[];
}

export interface BackgroundCommandLogStreamEvent {
  type: "snapshot" | "append";
  commandName: string;
  lines: BackgroundCommandLogLine[];
}

export interface TmuxClientInfo {
  id: string;
  pid: number;
  tty: string;
  name: string;
  sessionName: string;
  createdAt?: string;
  lastActiveAt?: string;
  isControlMode: boolean;
}

export interface WorktreeRecord {
  branch: string;
  worktreePath: string;
  headSha?: string;
  isBare: boolean;
  isDetached: boolean;
  locked: boolean;
  prunable: boolean;
  runtime?: WorktreeRuntime;
}

export interface CreateWorktreeRequest {
  branch: string;
  path?: string;
}

export interface ApiStateResponse {
  repoRoot: string;
  configPath: string;
  configFile: string;
  configSourceRef: string;
  configWorktreePath?: string;
  config: WorktreeManagerConfig;
  worktrees: WorktreeRecord[];
}

export interface ConfigDocumentResponse {
  branch: string;
  filePath: string;
  contents: string;
  editable: boolean;
}

export interface GitBranchOption {
  name: string;
  default?: boolean;
  current?: boolean;
  hasWorktree?: boolean;
}

export interface GitCompareCommit {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authoredAt: string;
}

export interface GitWorkingTreeSummary {
  dirty: boolean;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  changedFiles: number;
  untrackedFiles: number;
}

export interface GitComparisonResponse {
  defaultBranch: string;
  baseBranch: string;
  compareBranch: string;
  mergeBase: GitCompareCommit | null;
  ahead: number;
  behind: number;
  branches: GitBranchOption[];
  baseCommits: GitCompareCommit[];
  compareCommits: GitCompareCommit[];
  diff: string;
  workingTreeDiff: string;
  effectiveDiff: string;
  workingTreeSummary: GitWorkingTreeSummary;
}

export interface ShutdownLogEntry {
  id: number;
  level: "info" | "error";
  message: string;
  timestamp: string;
}

export interface ShutdownStatus {
  active: boolean;
  completed: boolean;
  failed: boolean;
  logs: ShutdownLogEntry[];
}

export interface ProjectManagementDocumentSummary {
  id: string;
  number: number;
  title: string;
  tags: string[];
  dependencies: string[];
  status: string;
  assignee: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
  historyCount: number;
}

export interface ProjectManagementDocument extends ProjectManagementDocumentSummary {
  markdown: string;
}

export interface ProjectManagementHistoryEntry {
  commitSha: string;
  batchId: string;
  createdAt: string;
  actorId: string;
  documentId: string;
  number: number;
  title: string;
  tags: string[];
  status: string;
  assignee: string;
  archived: boolean;
  changeCount: number;
  action: "create" | "update" | "archive" | "restore";
  diff: string;
}

export interface ProjectManagementListResponse {
  branch: string;
  headSha: string;
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  availableStatuses: string[];
}

export interface ProjectManagementDocumentResponse {
  branch: string;
  headSha: string;
  document: ProjectManagementDocument;
}

export interface ProjectManagementHistoryResponse {
  branch: string;
  headSha: string;
  history: ProjectManagementHistoryEntry[];
}

export interface ProjectManagementBatchResponse {
  branch: string;
  headSha: string;
  documentIds: string[];
}

export interface CreateProjectManagementDocumentRequest {
  title: string;
  markdown: string;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
}

export interface UpdateProjectManagementDocumentRequest {
  title: string;
  markdown: string;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
  archived?: boolean;
}

export interface ProjectManagementBatchUpdateEntry {
  documentId?: string;
  title: string;
  markdown: string;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
  archived?: boolean;
}

export interface AppendProjectManagementBatchRequest {
  entries: ProjectManagementBatchUpdateEntry[];
}

export interface UpdateProjectManagementDependenciesRequest {
  dependencyIds: string[];
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "ready"; session: string; clientId: string | null }
  | { type: "error"; message: string };
