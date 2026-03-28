export interface BackgroundCommandConfigEntry {
  command: string;
}

export interface QuickLinkConfigEntry {
  name: string;
  url: string;
}

export type AiCommandId = "smart" | "simple";

export interface AiCommandConfig {
  smart: string;
  simple: string;
}

export interface WorktreeManagerConfig {
  favicon: string;
  preferredPort?: number;
  env: Record<string, string>;
  runtimePorts: string[];
  derivedEnv: Record<string, string>;
  quickLinks: QuickLinkConfigEntry[];
  aiCommands: AiCommandConfig;
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

export interface WorktreeDeletionState {
  canDelete: boolean;
  reason: string | null;
  requiresConfirmation: boolean;
  hasLocalChanges: boolean;
  hasUnmergedCommits: boolean;
  deleteBranchByDefault: boolean;
  isDefaultBranch: boolean;
  isDefaultWorktree: boolean;
  isSettingsWorktree: boolean;
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

export interface AiCommandOutputEvent {
  id: string;
  source: "stdout" | "stderr";
  text: string;
  timestamp: string;
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
  linkedDocument?: WorktreeLinkedDocumentSummary | null;
  runtime?: WorktreeRuntime;
  deletion?: WorktreeDeletionState;
}

export interface WorktreeLinkedDocumentSummary {
  id: string;
  number: number;
  title: string;
  summary: string;
  kind: ProjectManagementDocumentKind;
  pullRequest: ProjectManagementPullRequest | null;
  status: string;
  archived: boolean;
}

export interface CreateWorktreeRequest {
  branch: string;
  documentId?: string;
}

export interface DeleteWorktreeRequest {
  confirmWorktreeName?: string;
  deleteBranch?: boolean;
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

export interface ApiStateStreamEvent {
  type: "snapshot" | "update";
  state: ApiStateResponse;
}

export interface ConfigDocumentResponse {
  branch: string;
  filePath: string;
  contents: string;
  editable: boolean;
}

export interface AiCommandSettingsResponse {
  branch: string;
  filePath: string;
  aiCommands: AiCommandConfig;
}

export interface UpdateAiCommandSettingsRequest {
  aiCommands: AiCommandConfig;
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
  conflicted: boolean;
  changedFiles: number;
  conflictedFiles: number;
  untrackedFiles: number;
}

export interface GitMergeStatus {
  canMerge: boolean;
  hasConflicts: boolean;
  reason: string | null;
  conflicts: GitMergeConflict[];
}

export interface GitMergeConflict {
  path: string;
  preview: string | null;
  truncated: boolean;
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
  workingTreeConflicts: GitMergeConflict[];
  mergeStatus: GitMergeStatus;
  mergeIntoCompareStatus: GitMergeStatus;
}

export interface MergeGitBranchRequest {
  baseBranch?: string;
}

export interface ResolveGitMergeConflictsRequest {
  baseBranch?: string;
  commandId?: AiCommandId;
}

export interface CommitGitChangesRequest {
  baseBranch?: string;
  commandId?: AiCommandId;
  message?: string;
}

export interface GenerateGitCommitMessageRequest {
  baseBranch?: string;
  commandId?: AiCommandId;
}

export interface GenerateGitCommitMessageResponse {
  branch: string;
  commandId: AiCommandId;
  message: string;
}

export interface CommitGitChangesResponse {
  branch: string;
  commandId: AiCommandId;
  message: string;
  commitSha: string;
  comparison: GitComparisonResponse;
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

export type ProjectManagementDocumentKind = "document" | "pull-request";

export type ProjectManagementPullRequestState = "open" | "closed" | "merged";

export interface ProjectManagementPullRequest {
  baseBranch: string;
  compareBranch: string;
  state: ProjectManagementPullRequestState;
  draft: boolean;
}

export interface ProjectManagementDocumentSummary {
  id: string;
  number: number;
  title: string;
  summary: string;
  kind: ProjectManagementDocumentKind;
  pullRequest: ProjectManagementPullRequest | null;
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
  comments: ProjectManagementComment[];
}

export interface ProjectManagementComment {
  id: string;
  body: string;
  createdAt: string;
  authorName: string;
  authorEmail: string;
}

export interface ProjectManagementHistoryEntry {
  commitSha: string;
  batchId: string;
  createdAt: string;
  actorId: string;
  authorName: string;
  authorEmail: string;
  documentId: string;
  number: number;
  title: string;
  tags: string[];
  status: string;
  assignee: string;
  archived: boolean;
  changeCount: number;
  action: "create" | "update" | "archive" | "restore" | "comment";
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
  summary?: string;
  markdown: string;
  kind?: ProjectManagementDocumentKind;
  pullRequest?: ProjectManagementPullRequest | null;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
}

export interface UpdateProjectManagementDocumentRequest {
  title: string;
  summary?: string;
  markdown: string;
  kind?: ProjectManagementDocumentKind;
  pullRequest?: ProjectManagementPullRequest | null;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
  archived?: boolean;
}

export interface ProjectManagementBatchUpdateEntry {
  documentId?: string;
  title: string;
  summary?: string;
  markdown: string;
  kind?: ProjectManagementDocumentKind;
  pullRequest?: ProjectManagementPullRequest | null;
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

export interface UpdateProjectManagementStatusRequest {
  status: string;
}

export interface AddProjectManagementCommentRequest {
  body: string;
}

export interface RunAiCommandRequest {
  input: string;
  documentId?: string;
  commandId?: AiCommandId;
}

export interface RunProjectManagementDocumentAiRequest {
  input?: string;
  commandId?: AiCommandId;
  origin?: AiCommandOrigin | null;
}

export type AiCommandOriginTab = "environment" | "git" | "project-management";

export type AiCommandOriginEnvironmentSubTab = "terminal" | "background";

export type AiCommandOriginProjectManagementSubTab = "document" | "board" | "dependency-tree" | "history" | "create";

export type AiCommandOriginKind =
  | "worktree-environment"
  | "project-management-document"
  | "project-management-document-run"
  | "git-conflict-resolution";

export interface AiCommandOriginLocation {
  tab: AiCommandOriginTab;
  branch?: string | null;
  gitBaseBranch?: string | null;
  environmentSubTab?: AiCommandOriginEnvironmentSubTab;
  projectManagementSubTab?: AiCommandOriginProjectManagementSubTab;
  documentId?: string | null;
  projectManagementDocumentViewMode?: "document" | "edit";
}

export interface AiCommandOrigin {
  kind: AiCommandOriginKind;
  label: string;
  description?: string | null;
  location: AiCommandOriginLocation;
}

export type AiCommandJobStatus = "running" | "completed" | "failed";

export interface AiCommandJob {
  jobId: string;
  fileName: string;
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  command: string;
  input: string;
  status: AiCommandJobStatus;
  startedAt: string;
  completedAt?: string;
  stdout: string;
  stderr: string;
  outputEvents?: AiCommandOutputEvent[];
  pid?: number | null;
  exitCode?: number | null;
  processName?: string | null;
  logPath?: string | null;
  error?: string | null;
  origin?: AiCommandOrigin | null;
}

export interface RunAiCommandResponse {
  job: AiCommandJob;
  runtime?: WorktreeRuntime;
}

export interface AiCommandStreamEvent {
  type: "snapshot" | "update";
  job: AiCommandJob | null;
}

export interface AiCommandLogError {
  name?: string;
  message: string;
  stack?: string;
}

export type AiCommandLogStatus = "running" | "completed" | "failed";

export interface AiCommandLogSummary {
  jobId: string;
  fileName: string;
  timestamp: string;
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  worktreePath: string;
  command: string;
  requestPreview: string;
  status: AiCommandLogStatus;
  pid?: number | null;
  origin?: AiCommandOrigin | null;
}

export interface AiCommandLogEntry {
  jobId: string;
  fileName: string;
  timestamp: string;
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  worktreePath: string;
  command: string;
  request: string;
  response: {
    stdout: string;
    stderr: string;
    events?: AiCommandOutputEvent[];
  };
  status: AiCommandLogStatus;
  pid?: number | null;
  exitCode?: number | null;
  processName?: string | null;
  completedAt?: string;
  error: AiCommandLogError | null;
  origin?: AiCommandOrigin | null;
}

export interface AiCommandLogsResponse {
  logs: AiCommandLogSummary[];
  runningJobs: AiCommandJob[];
}

export interface AiCommandLogResponse {
  log: AiCommandLogEntry;
}

export interface AiCommandLogStreamEvent {
  type: "snapshot" | "update";
  log: AiCommandLogEntry | null;
}

export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number | null }
  | { type: "ready"; session: string; clientId: string | null }
  | { type: "error"; message: string };
