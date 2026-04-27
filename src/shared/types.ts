import type { WorktreeId } from "./worktree-id.js";

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
  autoStartRuntime: boolean;
}

export interface AutoSyncConfig {
  remote: string;
}

export type WorktreeAutoSyncStatus = "disabled" | "idle" | "running" | "paused";

export type WorktreeAutoSyncSshAgentStatus = "not-required" | "ready" | "missing" | "unavailable";

export interface WorktreeAutoSyncState {
  worktreeId: WorktreeId;
  branch: string;
  worktreePath: string;
  enabled: boolean;
  status: WorktreeAutoSyncStatus;
  remote: string;
  message: string | null;
  sshAgentStatus: WorktreeAutoSyncSshAgentStatus;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastPulledAt?: string;
  lastPushedAt?: string;
}

export interface ProjectManagementUserConfigEntry {
  name: string;
  email: string;
}

export interface ProjectManagementUsersConfig {
  customUsers: ProjectManagementUserConfigEntry[];
  archivedUserIds: string[];
}

export interface WorktreeManagerConfig {
  favicon: string;
  preferredPort?: number;
  env: Record<string, string>;
  runtimePorts: string[];
  derivedEnv: Record<string, string>;
  quickLinks: QuickLinkConfigEntry[];
  autoSync: AutoSyncConfig;
  aiCommands: AiCommandConfig;
  startupCommands: string[];
  backgroundCommands: Record<string, BackgroundCommandConfigEntry>;
  projectManagement: {
    users: ProjectManagementUsersConfig;
  };
  worktrees: {
    baseDir: string;
  };
}

export interface WorktreeRuntime {
  id: WorktreeId;
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
  runId?: string;
  entry?: number;
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
  id: WorktreeId;
  branch: string;
  worktreePath: string;
  headSha?: string;
  isBare: boolean;
  isDetached: boolean;
  locked: boolean;
  prunable: boolean;
  linkedDocument?: WorktreeLinkedDocumentSummary | null;
  runtime?: WorktreeRuntime;
  autoSync?: WorktreeAutoSyncState;
  reviewLoop?: WorktreeReviewLoopState;
  deletion?: WorktreeDeletionState;
}

export type WorktreeReviewLoopStatus = "idle" | "running" | "passed" | "failed";

export type WorktreeReviewLoopPhase = "implement" | "review";

export interface WorktreeReviewIssue {
  id: string;
  summary: string;
  details: string;
}

export interface WorktreeReviewResult {
  passed: boolean;
  issues: WorktreeReviewIssue[];
}

export interface WorktreeReviewLoopState {
  worktreeId: WorktreeId;
  branch: string;
  worktreePath: string;
  status: WorktreeReviewLoopStatus;
  currentPhase: WorktreeReviewLoopPhase | null;
  attemptCount: number;
  maxAttempts: number;
  reviewDocumentId: string;
  originalRequest: string;
  latestRequest: string;
  activeJobId?: string | null;
  lastCompletedJobId?: string | null;
  latestReviewResult?: WorktreeReviewResult | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string | null;
  failureMessage?: string | null;
}

export interface WorktreeLinkedDocumentSummary {
  id: string;
  number: number;
  title: string;
  summary: string;
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
  selectedWorktreeId?: WorktreeId;
  worktrees: WorktreeRecord[];
}

export interface ApiStateStreamEvent {
  type: "snapshot" | "update";
  state: ApiStateResponse;
}

export interface GitComparisonStreamEvent {
  type: "snapshot" | "update";
  comparison: GitComparisonResponse;
}

export interface ProjectManagementDocumentsStreamEvent {
  type: "snapshot" | "update";
  documents: ProjectManagementListResponse;
}

export interface ProjectManagementUsersStreamEvent {
  type: "snapshot" | "update";
  users: ProjectManagementUsersResponse;
}

export interface ProjectManagementReviewsStreamEvent {
  type: "snapshot" | "update";
  reviews: ProjectManagementReviewsResponse;
}

export interface SystemStatusStreamEvent {
  type: "snapshot" | "update";
  status: SystemStatusResponse;
}

export interface ShutdownStatusStreamEvent {
  type: "snapshot" | "update";
  status: ShutdownStatus;
}

export type DashboardEventsStreamEvent =
  | { type: "state"; event: ApiStateStreamEvent }
  | { type: "shutdown-status"; event: ShutdownStatusStreamEvent }
  | { type: "ai-logs"; event: AiCommandLogsStreamEvent }
  | { type: "project-management-documents"; event: ProjectManagementDocumentsStreamEvent }
  | { type: "project-management-reviews"; event: ProjectManagementReviewsStreamEvent }
  | { type: "project-management-users"; event: ProjectManagementUsersStreamEvent }
  | { type: "system-status"; event: SystemStatusStreamEvent };

export interface TmuxClientsStreamEvent {
  type: "snapshot" | "update";
  branch: string;
  clients: TmuxClientInfo[];
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

export interface AutoSyncSettingsResponse {
  branch: string;
  filePath: string;
  autoSync: AutoSyncConfig;
}

export interface UpdateAutoSyncSettingsRequest {
  autoSync: AutoSyncConfig;
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

export interface GitBranchHistoryResponse {
  branch: string;
  commits: GitCompareCommit[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface GitCommitDetail {
  hash: string;
  shortHash: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  parents: string[];
}

export interface GitCommitDetailResponse {
  branch: string | null;
  commit: GitCommitDetail;
  stats: string;
  diff: string;
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
  preserveConflicts?: boolean;
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

export type SystemSubTab = "performance" | "jobs";

export interface SystemPerformanceSnapshot {
  hostname: string;
  platform: string;
  arch: string;
  nodeVersion: string;
  uptimeSeconds: number;
  cpu: {
    coreCount: number;
    model: string;
    speedMhz: number | null;
    loadAverage: [number, number, number];
    loadAveragePerCore: [number, number, number];
  };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    usageRatio: number;
  };
  worktrees: {
    total: number;
    runtimeCount: number;
    linkedDocumentCount: number;
  };
}

export interface SystemJobPayloadSummary {
  branch: string | null;
  documentId: string | null;
  commandId: AiCommandId | null;
  worktreePath: string | null;
  originKind: string | null;
  originLabel: string | null;
  renderedCommandPreview: string | null;
  inputPreview: string | null;
  applyDocumentUpdateToDocumentId: string | null;
  reviewDocumentId: string | null;
  reviewRequestSummaryPreview: string | null;
  reviewAction: "implement" | "review" | null;
  autoReviewLoop: boolean;
  autoCommitDirtyWorktree: boolean;
}

export interface SystemJobRecord {
  id: string;
  queue: string;
  state: string;
  priority: number;
  retryLimit: number;
  retryCount: number;
  retryDelay: number | null;
  retryDelayMax: number | null;
  retryBackoff: boolean;
  expireSeconds: number | null;
  deletionSeconds: number | null;
  policy: string | null;
  singletonKey: string | null;
  singletonOn: string | null;
  deadLetter: string | null;
  startAfter: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  keepUntil: string | null;
  heartbeatAt: string | null;
  heartbeatSeconds: number | null;
  runtimeSeconds: number | null;
  hasOutput: boolean;
  payloadSummary: SystemJobPayloadSummary;
}

export interface SystemJobsSnapshot {
  available: boolean;
  unavailableReason: string | null;
  total: number;
  countsByState: Record<string, number>;
  items: SystemJobRecord[];
}

export interface SystemStatusResponse {
  capturedAt: string;
  performance: SystemPerformanceSnapshot;
  jobs: SystemJobsSnapshot;
}

export interface ProjectManagementDocumentSummary {
  id: string;
  number: number;
  title: string;
  summary: string;
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

export type ProjectManagementReviewEntryKind = "comment" | "activity";

export type ProjectManagementReviewEntrySource = "user" | "ai" | "system";

export type ProjectManagementReviewEventType = "comment" | "ai-started" | "ai-completed" | "merge";

export interface ProjectManagementReviewEntry {
  id: string;
  documentId: string;
  kind: ProjectManagementReviewEntryKind;
  source: ProjectManagementReviewEntrySource;
  eventType: ProjectManagementReviewEventType;
  body: string;
  createdAt: string;
  updatedAt: string;
  authorName: string;
  authorEmail: string;
}

export interface ProjectManagementDocumentReview {
  documentId: string;
  entries: ProjectManagementReviewEntry[];
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

export interface ProjectManagementDocumentSummaryResponse {
  branch: string;
  headSha: string;
  document: ProjectManagementDocumentSummary;
}

export interface ProjectManagementHistoryResponse {
  branch: string;
  headSha: string;
  history: ProjectManagementHistoryEntry[];
}

export interface ProjectManagementReviewsResponse {
  branch: string;
  headSha: string;
  reviews: ProjectManagementDocumentReview[];
}

export interface ProjectManagementDocumentReviewResponse {
  branch: string;
  headSha: string;
  review: ProjectManagementDocumentReview;
}

export interface ProjectManagementBatchResponse {
  branch: string;
  headSha: string;
  documentIds: string[];
}

export interface ProjectManagementUser {
  id: string;
  name: string;
  email: string;
  source: "git" | "config";
  archived: boolean;
  avatarUrl: string;
  commitCount: number;
  lastCommitAt: string | null;
}

export interface ProjectManagementUsersResponse {
  branch: string;
  users: ProjectManagementUser[];
  config: ProjectManagementUsersConfig;
}

export interface UpdateProjectManagementUsersRequest {
  config: ProjectManagementUsersConfig;
}

export interface CreateProjectManagementDocumentRequest {
  title: string;
  summary?: string;
  markdown: string;
  tags: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
}

export interface UpdateProjectManagementDocumentRequest {
  title?: string;
  summary?: string;
  markdown?: string;
  tags?: string[];
  dependencies?: string[];
  status?: string;
  assignee?: string;
  archived?: boolean;
}

export interface ProjectManagementBatchUpdateEntry {
  documentId?: string;
  title?: string;
  summary?: string;
  markdown?: string;
  tags?: string[];
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

export interface AddProjectManagementReviewEntryRequest {
  body: string;
  kind?: ProjectManagementReviewEntryKind;
  source?: ProjectManagementReviewEntrySource;
  eventType?: ProjectManagementReviewEventType;
}

export interface RunAiCommandRequest {
  input: string;
  documentId?: string;
  reviewDocumentId?: string;
  baseBranch?: string;
  commandId?: AiCommandId;
  origin?: AiCommandOrigin | null;
  reviewAction?: "implement" | "review";
  autoReviewLoop?: boolean;
  reviewFollowUp?: {
    originalRequest: string;
    newRequest: string;
  };
}

export interface RunProjectManagementDocumentAiRequest {
  input?: string;
  commandId?: AiCommandId;
  origin?: AiCommandOrigin | null;
  worktreeStrategy?: "new" | "continue-current";
  targetBranch?: string;
  worktreeName?: string;
  autoReviewLoop?: boolean;
}

export type AiCommandOriginTab = "environment" | "git" | "project-management" | "review";

export type AiCommandOriginEnvironmentSubTab = "terminal" | "background";

export type AiCommandOriginProjectManagementSubTab = "document" | "review" | "board" | "dependency-tree" | "history" | "create" | "users";

export type AiCommandOriginKind =
  | "worktree-environment"
  | "worktree-review"
  | "project-management-document"
  | "project-management-document-run"
  | "git-conflict-resolution";

export interface AiCommandOriginLocation {
  worktreeId?: WorktreeId | null;
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
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
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
  worktreePath?: string | null;
  error?: string | null;
  origin?: AiCommandOrigin | null;
}

export interface RunAiCommandResponse {
  job: AiCommandJob;
  runtime?: WorktreeRuntime;
}

export interface ReconnectTerminalResponse {
  tmuxSession: string;
  clients: TmuxClientInfo[];
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
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
  documentId?: string | null;
  commandId: AiCommandId;
  worktreePath: string;
  requestPreview: string;
  status: AiCommandLogStatus;
  pid?: number | null;
  origin?: AiCommandOrigin | null;
}

export interface AiCommandLogEntry {
  jobId: string;
  fileName: string;
  timestamp: string;
  worktreeId: WorktreeId;
  branch: string;
  sessionId?: string | null;
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
  historySummary?: string | null;
  historySummaryGeneratedAt?: string;
  historySummarySourceHash?: string | null;
}

export interface AiCommandLogsResponse {
  logs: AiCommandLogSummary[];
  runningJobs: AiCommandJob[];
}

export interface AiCommandLogsStreamEvent {
  type: "snapshot" | "update";
  logs: AiCommandLogsResponse;
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
