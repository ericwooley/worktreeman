import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AddProjectManagementCommentRequest,
  AppendProjectManagementBatchRequest,
  AiCommandConfig,
  AiCommandId,
  AiCommandOutputEvent,
  AiCommandOrigin,
  ApiStateResponse,
  ApiStateStreamEvent,
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogResponse,
  AiCommandLogsResponse,
  AiCommandLogStreamEvent,
  AiCommandLogSummary,
  AiCommandSettingsResponse,
  BackgroundCommandLogStreamEvent,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  CommitGitChangesRequest,
  CommitGitChangesResponse,
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  CreateWorktreeRequest,
  DeleteWorktreeRequest,
  GenerateGitCommitMessageRequest,
  GenerateGitCommitMessageResponse,
  GitComparisonResponse,
  MergeGitBranchRequest,
  ResolveGitMergeConflictsRequest,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  ProjectManagementUsersResponse,
  ReconnectTerminalResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementStatusRequest,
  TmuxClientInfo,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementDocumentRequest,
  UpdateProjectManagementUsersRequest,
  WorktreeManagerConfig,
  WorktreeRecord,
  WorktreeRuntime,
} from "../../shared/types.js";
import { DEFAULT_PROJECT_MANAGEMENT_BRANCH } from "../../shared/constants.js";
import {
  createProjectManagementDocumentWorktreeBranch,
  createProjectManagementDocumentWorktreeBranchCandidate,
  normalizeProjectManagementDocumentWorktreeName,
} from "../../shared/project-management-worktree.js";
import {
  getBackgroundCommandLogs,
  getBackgroundCommandEntries,
  listBackgroundCommands,
  restartBackgroundCommand,
  startBackgroundCommand,
  startConfiguredBackgroundCommands,
  streamBackgroundCommandLogs,
  stopAllBackgroundCommands,
  stopBackgroundCommand,
} from "../services/background-command-service.js";
import {
  autoCommitGitChanges,
  commitGitChanges,
  createWorktree,
  deleteBranch,
  formatMergeConflictResolutionPrompt,
  generateGitCommitMessage,
  getWorktreeDeletionState,
  getGitComparison,
  listWorktrees,
  mergeGitBranch,
  removeWorktree,
  validateDeleteWorktreeRequest,
} from "../services/git-service.js";
import { buildRuntimeProcessEnv, createRuntime, runStartupCommands } from "../services/runtime-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import {
  loadConfig,
  parseConfigContents,
  readConfigContents,
  updateAiCommandInConfigContents,
  updateProjectManagementUsersInConfigContents,
} from "../services/config-service.js";
import type { ShutdownStatus } from "../../shared/types.js";
import { failAiCommandJob, getAiCommandJob, startAiCommandJob, waitForAiCommandJob, type StartedAiCommandJob } from "../services/ai-command-service.js";
import {
  deleteAiCommandProcess,
  getAiCommandProcess,
  getAiCommandProcessName,
  isAiCommandProcessActive,
  readAiCommandProcessLogs,
  startAiCommandProcess,
  type AiCommandProcessDescription,
} from "../services/ai-command-process-service.js";
import { enqueueProjectManagementAiJob } from "../services/ai-command-job-manager-service.js";
import { completeAiCommandRun } from "../services/ai-command-completion-service.js";
import { disconnectTmuxClient, ensureRuntimeTerminalSession, ensureTerminalSession, getTmuxSessionName, killTmuxSession, killTmuxSessionByName, listTmuxClients } from "../services/terminal-service.js";
import {
  addProjectManagementComment,
  appendProjectManagementBatch,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
  listProjectManagementUsers,
  moveProjectManagementDocumentTowardInProgress,
  updateProjectManagementDependencies,
  updateProjectManagementDocument,
  updateProjectManagementStatus,
} from "../services/project-management-service.js";
import {
  attachWorktreeDocumentLinks,
  clearWorktreeDocumentLink,
  getWorktreeDocumentLink,
  getWorktreeDocumentLinks,
  setWorktreeDocumentLink,
} from "../services/worktree-link-service.js";
import { createOperationalStateStore, type OperationalStateStore } from "../services/operational-state-service.js";
import { sanitizeBranchName } from "../utils/paths.js";
import { runCommand } from "../utils/process.js";
import { formatDurationMs, logServerEvent } from "../utils/server-logger.js";

interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  configSourceRef: string;
  configFile: string;
  configWorktreePath: string;
  operationalState: OperationalStateStore;
  aiProcessPollIntervalMs?: number;
  aiLogStreamPollIntervalMs?: number;
  aiProcesses?: {
    startProcess: (options: {
      processName: string;
      command: string;
      input: string;
      worktreePath: string;
      env: NodeJS.ProcessEnv;
    }) => Promise<AiCommandProcessDescription>;
    getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
    deleteProcess: (processName: string) => Promise<void>;
      readProcessLogs: (processInfo: AiCommandProcessDescription | null) => Promise<{ stdout: string; stderr: string }>;
      isProcessActive: (status: string | undefined) => boolean;
  };
}

interface RunProjectManagementDocumentAiRequest {
  input?: unknown;
  commandId?: unknown;
  origin?: unknown;
  worktreeStrategy?: unknown;
  targetBranch?: unknown;
  worktreeName?: unknown;
}

const CONFIG_COMMIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "worktreeman",
  GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "worktreeman@example.com",
  GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "worktreeman",
  GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
};

function createAiLogIdentifiers(branch: string, date = new Date()) {
  return {
    jobId: randomUUID(),
    fileName: createAiLogFileName(branch, date),
    startedAt: date.toISOString(),
  };
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatLogSnippet(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function createAiLogTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createAiLogFileName(branch: string, date = new Date()): string {
  const safeBranch = branch.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `${createAiLogTimestamp(date)}-${safeBranch}-ai-request.json`;
}

function runBackgroundTask(task: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  return task().catch(onError);
}

export function resolveAiLogsDir(repoRoot: string): string {
  return path.resolve(repoRoot, ".logs");
}

async function writeAiRequestLog(options: {
  fileName: string;
  jobId: string;
  repoRoot: string;
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  worktreePath: string;
  renderedCommand: string;
  input: string;
  stdout?: string;
  stderr?: string;
  events?: AiCommandOutputEvent[];
  startedAt?: string;
  completedAt?: string;
  pid?: number | null;
  exitCode?: number | null;
  processName?: string | null;
  error?: unknown;
}): Promise<string> {
  const store = await createOperationalStateStore(options.repoRoot);
  const startedAt = options.startedAt ?? new Date().toISOString();
  const error = toAiCommandLogError(options.error);
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? (error?.message ?? "");
  const events = ensureAiCommandOutputEvents({
    runId: options.jobId,
    events: options.events,
    stdout,
    stderr,
    timestamp: startedAt,
    completedAt: options.completedAt,
  });
  const entry: AiCommandLogEntry = {
    jobId: options.jobId,
    fileName: options.fileName,
    timestamp: startedAt,
    branch: options.branch,
    documentId: options.documentId ?? null,
    commandId: options.commandId,
    origin: options.origin ?? null,
    worktreePath: options.worktreePath,
    command: options.renderedCommand,
    request: options.input,
    response: {
      stdout,
      stderr,
      events,
    },
    status: getAiCommandLogStatus(error, options.completedAt),
    pid: options.pid ?? null,
    exitCode: options.exitCode ?? null,
    processName: options.processName ?? null,
    completedAt: options.completedAt,
    error,
  };

  await store.upsertAiCommandLogEntry(entry);
  await store.syncAiCommandOutputEvents(entry.jobId, entry.fileName, entry.branch, entry.response.events);
  return options.fileName;
}

async function safeWriteAiRequestLog(options: {
  fileName: string;
  jobId: string;
  repoRoot: string;
  branch: string;
  documentId?: string | null;
  commandId: AiCommandId;
  origin?: AiCommandOrigin | null;
  worktreePath: string;
  renderedCommand: string;
  input: string;
  stdout?: string;
  stderr?: string;
  events?: AiCommandOutputEvent[];
  startedAt?: string;
  completedAt?: string;
  pid?: number | null;
  exitCode?: number | null;
  processName?: string | null;
  error?: unknown;
}): Promise<string | null> {
  try {
    return await writeAiRequestLog(options);
  } catch (logError) {
    logServerEvent("ai-command", "failed-to-write-log", {
      repoRoot: options.repoRoot,
      branch: options.branch,
      jobId: options.jobId,
      error: logError instanceof Error ? logError.message : String(logError),
    }, "error");
    return null;
  }
}

function getAiCommandLogStatus(error: unknown, completedAt: unknown): "running" | "completed" | "failed" {
  if (typeof completedAt !== "string" || !completedAt) {
    return "running";
  }

  return error ? "failed" : "completed";
}

function toAiCommandLogError(error: unknown) {
  if (!error) {
    return null;
  }

  if (typeof error === "string") {
    return { message: error };
  }

  if (typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown; stack?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : undefined,
      message: typeof candidate.message === "string" ? candidate.message : String(error),
      stack: typeof candidate.stack === "string" ? candidate.stack : undefined,
    };
  }

  return { message: String(error) };
}

function createAiCommandOutputEvent(
  runId: string,
  entry: number,
  source: "stdout" | "stderr",
  text: string,
  timestamp = new Date().toISOString(),
): AiCommandOutputEvent {
  return {
    id: randomUUID(),
    runId,
    entry,
    source,
    text,
    timestamp,
  };
}

function normalizeAiCommandOutputEvents(value: unknown, runId: string): AiCommandOutputEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((event, index) => {
    if (!event || typeof event !== "object") {
      return [];
    }

    const candidate = event as {
      id?: unknown;
      runId?: unknown;
      entry?: unknown;
      source?: unknown;
      text?: unknown;
      timestamp?: unknown;
    };
    if ((candidate.source !== "stdout" && candidate.source !== "stderr") || typeof candidate.text !== "string") {
      return [];
    }

    const normalizedEntry = typeof candidate.entry === "number" && Number.isFinite(candidate.entry)
      ? candidate.entry
      : index + 1;
    return [{
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID(),
      runId: typeof candidate.runId === "string" && candidate.runId ? candidate.runId : runId,
      entry: normalizedEntry,
      source: candidate.source,
      text: candidate.text,
      timestamp: typeof candidate.timestamp === "string" && candidate.timestamp ? candidate.timestamp : new Date().toISOString(),
    }];
  });
}

function appendAiCommandOutputEvents(
  runId: string,
  events: AiCommandOutputEvent[] | undefined,
  source: "stdout" | "stderr",
  chunk: string,
): AiCommandOutputEvent[] {
  if (!chunk) {
    return events ? events.map((event) => ({ ...event })) : [];
  }

  const nextEvents = events ? events.map((event) => ({ ...event })) : [];
  return [...nextEvents, createAiCommandOutputEvent(runId, nextEvents.length + 1, source, chunk)];
}

function ensureAiCommandOutputEvents(options: {
  runId: string;
  events: unknown;
  stdout: string;
  stderr: string;
  timestamp: string;
  completedAt?: string;
}): AiCommandOutputEvent[] {
  const normalized = normalizeAiCommandOutputEvents(options.events, options.runId);
  if (normalized.length > 0) {
    return normalized;
  }

  const fallback: AiCommandOutputEvent[] = [];
  const baseTimestamp = options.timestamp || new Date().toISOString();
  if (options.stdout) {
    fallback.push(createAiCommandOutputEvent(options.runId, fallback.length + 1, "stdout", options.stdout, baseTimestamp));
  }

  if (options.stderr) {
    fallback.push(createAiCommandOutputEvent(options.runId, fallback.length + 1, "stderr", options.stderr, options.completedAt ?? baseTimestamp));
  }

  return fallback;
}

function toAiCommandLogPreview(request: string): string {
  return formatLogSnippet(request, 160);
}

function parseAiCommandId(value: unknown): AiCommandId {
  return value === "simple" ? "simple" : "smart";
}

function resolveRequestedAiCommandId(value: unknown, options?: { documentId?: string | null }): AiCommandId {
  if (value === "smart" || value === "simple") {
    return value;
  }

  return "smart";
}

function resolveAiCommandTemplate(aiCommands: AiCommandConfig, commandId: AiCommandId): string {
  return (aiCommands[commandId] ?? "").trim();
}

function formatPromptList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatNamedEntries(entries: Array<[string, string | number]>): string {
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "none";
}

function buildAiEnvironmentContext(options: {
  repoRoot: string;
  config: WorktreeManagerConfig;
  branch: string;
  worktreePath: string;
  runtime?: WorktreeRuntime;
  backgroundCommands: BackgroundCommandState[];
}) {
  const runtimeEnvEntries = options.runtime
    ? Object.entries(options.runtime.env).sort(([left], [right]) => left.localeCompare(right))
    : [];
  const allocatedPorts = options.runtime
    ? Object.entries(options.runtime.allocatedPorts).sort(([left], [right]) => left.localeCompare(right))
    : [];
  const runningServices = options.backgroundCommands
    .filter((entry) => entry.running)
    .map((entry) => `${entry.name} (${entry.processName}, ${entry.status})`);
  const configuredServices = options.backgroundCommands
    .map((entry) => `${entry.name} (${entry.processName}, ${entry.status})`);
  const quickLinks = options.runtime?.quickLinks
    .map((entry) => `${entry.name}: ${entry.url}`)
    ?? [];
  const quickLinkNames = options.config.quickLinks.map((entry) => entry.name);
  const exampleProcessName = options.backgroundCommands[0]?.processName ?? `wtm:${options.branch}:<service>`;

  return [
    "Environment wrapper:",
    "Use this worktree snapshot as real local context. Do not invent services, ports, URLs, or process names that are not listed here.",
    `- Repository root: ${options.repoRoot}`,
    `- Branch: ${options.branch}`,
    `- Worktree path: ${options.worktreePath}`,
    options.runtime
      ? `- Runtime: active${options.runtime.runtimeStartedAt ? ` since ${options.runtime.runtimeStartedAt}` : ""}; tmux session ${options.runtime.tmuxSession}`
      : "- Runtime: inactive. No live runtime session is attached to this worktree yet.",
    options.runtime
      ? `- Process env: WORKTREE_BRANCH=${options.branch}, WORKTREE_PATH=${options.worktreePath}, TMUX_SESSION_NAME=${options.runtime.tmuxSession}`
      : `- Process env: WORKTREE_BRANCH=${options.branch}, WORKTREE_PATH=${options.worktreePath}`,
    options.runtime
      ? `- Runtime env: ${formatNamedEntries(runtimeEnvEntries)}`
      : `- Config env: ${formatNamedEntries(Object.entries(options.config.env).sort(([left], [right]) => left.localeCompare(right)))}`,
    options.runtime
      ? `- Allocated ports: ${formatNamedEntries(allocatedPorts)}`
      : `- Dynamic port env vars: ${formatPromptList([...options.config.runtimePorts].sort())}`,
    options.runtime
      ? `- Quicklinks: ${formatPromptList(quickLinks)}`
      : `- Quicklinks: unavailable until the runtime is started. Configured quicklinks: ${formatPromptList(quickLinkNames)}`,
    `- Running services: ${formatPromptList(runningServices)}`,
    `- Service inventory: ${formatPromptList(configuredServices)}`,
    `- PM2 log access: use pm2 status, pm2 logs ${exampleProcessName}, pm2 logs ${exampleProcessName} --lines 200, and pm2 describe ${exampleProcessName}`,
  ].join("\n");
}

function buildWorktreeAiPrompt(options: {
  request: string;
  environmentContext: string;
}) {
  return [
    options.environmentContext,
    "",
    "Operator request:",
    options.request,
  ].join("\n");
}

function buildProjectManagementAiPrompt(options: {
  branch: string;
  worktreePath: string;
  requestedChange: string;
  environmentContext: string;
  document: ProjectManagementDocumentResponse["document"];
  relatedDocuments: ProjectManagementListResponse["documents"];
}) {
  const dependencySummary = options.relatedDocuments
    .filter((entry) => options.document.dependencies.includes(entry.id))
    .map((entry) => `#${entry.number} ${entry.title}`)
    .join(", ");

  return [
    `You are rewriting the project-management markdown document \"${options.document.title}\" for worktree ${options.branch}.`,
    `Worktree path: ${options.worktreePath}`,
    `Requested change: ${options.requestedChange}`,
    options.environmentContext,
    "Your job is to return a full replacement markdown document, not commentary about the document.",
    "The server will persist your response as the next version of this existing project-management document. Document history is the rollback mechanism.",
    "You are not creating files, not writing a .md file, not returning a patch, and not describing what you would change. Return the final markdown itself as raw text.",
    "Output format: return only the complete updated markdown document body as plain text. Do not wrap it in code fences. Do not add explanations, preambles, summaries, or commentary outside the document.",
    "Quality bar: produce an execution-ready plan for the selected worktree. Make the document concrete, well-ordered, specific, and directly useful to an engineer or agent doing the work.",
    "Call out assumptions, blockers, dependencies, and sequencing explicitly when they matter. Replace vague guidance with actionable steps.",
    "Preserve the document's purpose, but improve clarity, structure, and usefulness based on the requested change and the current repository context.",
    "",
    `Document number: #${options.document.number}`,
    `Status: ${options.document.status}`,
    `Assignee: ${options.document.assignee || "Unassigned"}`,
    `Tags: ${options.document.tags.join(", ") || "none"}`,
    `Dependencies: ${dependencySummary || "none"}`,
    "",
    "Current markdown:",
    options.document.markdown,
  ].join("\n");
}

async function branchRefExists(repoRoot: string, branch: string): Promise<boolean> {
  const { stdout } = await runCommand("git", ["branch", "--list", "--format=%(refname:short)", "--", branch], {
    cwd: repoRoot,
  });
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .includes(branch);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveProjectManagementDocumentWorktreeBranch(options: {
  repoRoot: string;
  baseDir: string;
  document: ProjectManagementDocumentResponse["document"];
  preferredName?: string | null;
}) {
  const baseBranch = normalizeProjectManagementDocumentWorktreeName(options.preferredName)
    ?? createProjectManagementDocumentWorktreeBranch(options.document);
  const existingWorktrees = await listWorktrees(options.repoRoot);
  const existingBranches = new Set(existingWorktrees.map((entry) => entry.branch));
  const existingPaths = new Set(existingWorktrees.map((entry) => path.resolve(entry.worktreePath)));

  for (let runNumber = 1; runNumber < 10_000; runNumber += 1) {
    const candidate = createProjectManagementDocumentWorktreeBranchCandidate(baseBranch, runNumber);
    const candidatePath = path.join(options.baseDir, sanitizeBranchName(candidate));
    if (existingBranches.has(candidate) || existingPaths.has(path.resolve(candidatePath))) {
      continue;
    }

    if (await branchRefExists(options.repoRoot, candidate)) {
      continue;
    }

    if (await pathExists(candidatePath)) {
      continue;
    }

    return candidate;
  }

  throw new Error(`Unable to allocate a unique worktree branch for project management document ${options.document.id}.`);
}

function buildProjectManagementExecutionAiPrompt(options: {
  branch: string;
  worktreePath: string;
  environmentContext: string;
  document: ProjectManagementDocumentResponse["document"];
  relatedDocuments: ProjectManagementListResponse["documents"];
  requestedChange?: string;
}) {
  const dependencySummary = options.relatedDocuments
    .filter((entry) => options.document.dependencies.includes(entry.id))
    .map((entry) => `#${entry.number} ${entry.title}`)
    .join(", ");

  return [
    `You are implementing the work described by the project-management document \"${options.document.title}\".`,
    "Use this document as the main instruction set for the engineering work to perform in the repository.",
    options.environmentContext,
    "Make code changes directly in the repository. Do not rewrite the project-management document unless the prompt explicitly asks for that.",
    "If the document describes a bug, fix it. If it describes a feature, implement it. If it describes a refactor or infrastructure change, carry it out in code.",
    "Follow the repository conventions already present in this worktree and add or update tests that prove the change.",
    "This is not an interactive user session, so make your best educated guesses and keep moving unless the prompt requires something specific you cannot infer.",
    "Commit your work regularly as you complete meaningful milestones.",
    "Return your normal coding-agent response after doing the work, including a concise summary of what you changed and how you verified it.",
    options.requestedChange ? `Additional operator guidance: ${options.requestedChange}` : "",
    dependencySummary ? `Dependencies: ${dependencySummary}` : "",
    "",
    "Project-management document:",
    options.document.markdown,
  ].filter(Boolean).join("\n");
}

function createWorktreeEnvironmentOrigin(branch: string): AiCommandOrigin {
  return {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: `Started from ${branch}.`,
    location: {
      tab: "environment",
      branch,
      environmentSubTab: "terminal",
    },
  };
}

function createProjectManagementDocumentOrigin(options: {
  branch: string;
  document: ProjectManagementDocumentResponse["document"];
  kind: "project-management-document" | "project-management-document-run";
  label: string;
  viewMode: "document" | "edit";
}): AiCommandOrigin {
  return {
    kind: options.kind,
    label: options.label,
    description: `#${options.document.number} ${options.document.title}`,
    location: {
      tab: "project-management",
      branch: options.branch,
      projectManagementSubTab: "document",
      documentId: options.document.id,
      projectManagementDocumentViewMode: options.viewMode,
    },
  };
}

function createGitConflictResolutionOrigin(options: {
  branch: string;
  baseBranch: string;
}): AiCommandOrigin {
  return {
    kind: "git-conflict-resolution",
    label: "Git conflict resolution",
    description: `Resolve conflicts while merging ${options.baseBranch} into ${options.branch}.`,
    location: {
      tab: "git",
      branch: options.branch,
      gitBaseBranch: options.baseBranch,
    },
  };
}

function createGitPullRequestReviewOrigin(options: {
  branch: string;
  baseBranch: string;
  documentId?: string | null;
  label?: string;
}): AiCommandOrigin {
  return {
    kind: "git-pull-request-review",
    label: options.label ?? "Git pull request review",
    description: `Review the pull request workspace for ${options.branch} against ${options.baseBranch}.`,
    location: {
      tab: "git",
      branch: options.branch,
      gitBaseBranch: options.baseBranch,
      documentId: options.documentId ?? null,
    },
  };
}

function parseAiCommandOrigin(value: unknown): AiCommandOrigin | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = value as {
    kind?: unknown;
    label?: unknown;
    description?: unknown;
    location?: {
      tab?: unknown;
      branch?: unknown;
      gitBaseBranch?: unknown;
      environmentSubTab?: unknown;
      projectManagementSubTab?: unknown;
      documentId?: unknown;
      projectManagementDocumentViewMode?: unknown;
    } | null;
  };

  const kind = candidate.kind;
  if (
    kind !== "worktree-environment"
    && kind !== "project-management-document"
    && kind !== "project-management-document-run"
    && kind !== "git-conflict-resolution"
    && kind !== "git-pull-request-review"
  ) {
    return null;
  }

  if (typeof candidate.label !== "string" || !candidate.label.trim()) {
    return null;
  }

  const location = candidate.location;
  if (!location || typeof location !== "object") {
    return null;
  }

  const tab = location.tab;
  if (tab !== "environment" && tab !== "git" && tab !== "project-management") {
    return null;
  }

  return {
    kind,
    label: candidate.label,
    description: typeof candidate.description === "string"
      ? candidate.description
      : candidate.description === null
        ? null
        : undefined,
    location: {
      tab,
      branch: typeof location.branch === "string" ? location.branch : location.branch === null ? null : undefined,
      gitBaseBranch: typeof location.gitBaseBranch === "string"
        ? location.gitBaseBranch
        : location.gitBaseBranch === null
          ? null
          : undefined,
      environmentSubTab: location.environmentSubTab === "terminal" || location.environmentSubTab === "background"
        ? location.environmentSubTab
        : undefined,
      projectManagementSubTab:
        location.projectManagementSubTab === "document"
          || location.projectManagementSubTab === "board"
          || location.projectManagementSubTab === "dependency-tree"
          || location.projectManagementSubTab === "history"
          || location.projectManagementSubTab === "create"
          || location.projectManagementSubTab === "users"
          ? location.projectManagementSubTab
          : undefined,
      documentId: typeof location.documentId === "string"
        ? location.documentId
        : location.documentId === null
          ? null
          : undefined,
      projectManagementDocumentViewMode:
        location.projectManagementDocumentViewMode === "document" || location.projectManagementDocumentViewMode === "edit"
          ? location.projectManagementDocumentViewMode
          : undefined,
    },
  };
}

function buildProjectManagementSummaryPrompt(options: {
  branch: string;
  document: ProjectManagementDocumentResponse["document"];
  relatedDocuments: ProjectManagementListResponse["documents"];
}) {
  const dependencySummary = options.relatedDocuments
    .filter((entry) => options.document.dependencies.includes(entry.id))
    .map((entry) => `#${entry.number} ${entry.title}`)
    .join(", ");

  return [
    `You are writing the short summary for the project-management document \"${options.document.title}\" on branch ${options.branch}.`,
    "The server will persist your response into the saved document summary field in the same branch.",
    "Return only the final short summary as raw text.",
    "Write 1-2 sentences that make the document easy to scan in the UI.",
    "Keep it concise, specific, and directly useful to an engineer deciding whether to open the document.",
    "Do not use bullets, headings, markdown formatting, code fences, labels, or commentary outside the summary.",
    "Prefer 160 characters or fewer when you can, but clarity matters more than a hard limit.",
    "",
    `Title: ${options.document.title}`,
    `Status: ${options.document.status}`,
    `Assignee: ${options.document.assignee || "Unassigned"}`,
    `Tags: ${options.document.tags.join(", ") || "none"}`,
    `Dependencies: ${dependencySummary || "none"}`,
    "",
    "Document markdown:",
    options.document.markdown,
  ].join("\n");
}

async function generateProjectManagementDocumentSummary(options: {
  repoRoot: string;
  config: WorktreeManagerConfig;
  document: ProjectManagementDocumentResponse["document"];
  relatedDocuments: ProjectManagementListResponse["documents"];
}) {
  const startedAt = Date.now();
  const template = resolveAiCommandTemplate(options.config.aiCommands, "simple");
  if (!template || !template.includes("$WTM_AI_INPUT")) {
    return null;
  }

  const input = buildProjectManagementSummaryPrompt({
    branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
    document: options.document,
    relatedDocuments: options.relatedDocuments,
  });
  try {
    const { stdout } = await runCommand("bash", ["-lc", template], {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        ...options.config.env,
        WORKTREE_BRANCH: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        WORKTREE_PATH: options.repoRoot,
        WTM_AI_INPUT: input,
      },
    });
    const summary = stdout.trim();
    logServerEvent("project-management-summary", "generated", {
      documentId: options.document.id,
      duration: formatDurationMs(Date.now() - startedAt),
      empty: !summary,
    });
    return summary || null;
  } catch (error) {
    logServerEvent("project-management-summary", "failed", {
      documentId: options.document.id,
      duration: formatDurationMs(Date.now() - startedAt),
      error: error instanceof Error ? error.message : String(error),
    }, "error");
    return null;
  }
}

function parseAiCommandLogEntry(fileName: string, payload: string): AiCommandLogEntry {
  const parsed = JSON.parse(payload) as {
    jobId?: unknown;
    timestamp?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    branch?: unknown;
    documentId?: unknown;
    commandId?: unknown;
    origin?: unknown;
    worktreePath?: unknown;
    command?: unknown;
    pid?: unknown;
    exitCode?: unknown;
    processName?: unknown;
    request?: unknown;
    response?: { stdout?: unknown; stderr?: unknown; events?: unknown } | null;
    error?: unknown;
  };

  const request = typeof parsed.request === "string" ? parsed.request : "";
  const error = toAiCommandLogError(parsed.error);
  const timestamp = typeof parsed.timestamp === "string" ? parsed.timestamp : "";
  const completedAt = typeof parsed.completedAt === "string" ? parsed.completedAt : undefined;
  const stdout = typeof parsed.response?.stdout === "string" ? parsed.response.stdout : "";
  const stderr = typeof parsed.response?.stderr === "string" ? parsed.response.stderr : "";

  return {
    jobId: typeof parsed.jobId === "string" ? parsed.jobId : fileName,
    fileName,
    timestamp,
    branch: typeof parsed.branch === "string" ? parsed.branch : "",
    documentId: typeof parsed.documentId === "string" ? parsed.documentId : null,
    commandId: parseAiCommandId(parsed.commandId),
    origin: parseAiCommandOrigin(parsed.origin),
    worktreePath: typeof parsed.worktreePath === "string" ? parsed.worktreePath : "",
    command: typeof parsed.command === "string" ? parsed.command : "",
    request,
      response: {
        stdout,
        stderr,
        events: ensureAiCommandOutputEvents({
          runId: typeof parsed.jobId === "string" ? parsed.jobId : fileName,
          events: parsed.response?.events,
          stdout,
          stderr,
        timestamp,
        completedAt,
      }),
    },
    status: getAiCommandLogStatus(error, parsed.completedAt),
    pid: typeof parsed.pid === "number" ? parsed.pid : null,
    exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : parsed.exitCode === null ? null : undefined,
    processName: typeof parsed.processName === "string" ? parsed.processName : null,
    completedAt,
    error,
  };
}

function toAiCommandLogSummary(entry: AiCommandLogEntry): AiCommandLogSummary {
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    timestamp: entry.timestamp,
    branch: entry.branch,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
    origin: entry.origin ?? null,
    worktreePath: entry.worktreePath,
    command: entry.command,
    requestPreview: toAiCommandLogPreview(entry.request),
    status: entry.status,
    pid: entry.pid,
  };
}

function isAiCommandLogFinalizing(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && typeof entry.completedAt === "string";
}

function isAiCommandLogActivelyRunning(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && !isAiCommandLogFinalizing(entry);
}

function toHistoricalAiCommandLogSummaries(entries: AiCommandLogEntry[]): AiCommandLogSummary[] {
  return entries
    .filter((entry) => entry.status !== "running" || isAiCommandLogFinalizing(entry))
    .map(toAiCommandLogSummary);
}

async function listAiCommandLogEntries(repoRoot: string): Promise<AiCommandLogEntry[]> {
  const store = await createOperationalStateStore(repoRoot);
  return await store.listAiCommandLogEntries();
}

function toRunningAiCommandJob(entry: AiCommandLogEntry): AiCommandJob {
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    branch: entry.branch,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
    origin: entry.origin ?? null,
    command: entry.command,
    input: entry.request,
    status: entry.status,
    startedAt: entry.timestamp,
    completedAt: entry.completedAt,
    stdout: entry.response.stdout,
    stderr: entry.response.stderr,
    outputEvents: entry.response.events?.map((event) => ({ ...event })) ?? [],
    pid: entry.pid,
    exitCode: entry.exitCode,
    processName: entry.processName,
    worktreePath: entry.worktreePath,
    error: entry.error?.message ?? null,
  };
}

async function readAiCommandLogEntry(repoRoot: string, fileName: string): Promise<AiCommandLogEntry> {
  const store = await createOperationalStateStore(repoRoot);
  const entry = await store.getAiCommandLogEntry(fileName);
  if (entry) {
    return entry;
  }

  const error = new Error(`Unknown AI log ${fileName}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}

async function reconcileAiCommandLogEntry(options: {
  entry: AiCommandLogEntry;
  repoRoot: string;
  aiProcesses: NonNullable<ApiRouterOptions["aiProcesses"]>;
  reconcileJobs?: boolean;
}): Promise<AiCommandLogEntry> {
  if (options.entry.status !== "running") {
    return options.entry;
  }
  await getAiCommandJob(options.repoRoot, options.entry.branch, {
    aiProcesses: {
      getProcess: options.aiProcesses.getProcess,
      readProcessLogs: options.aiProcesses.readProcessLogs,
      isProcessActive: options.aiProcesses.isProcessActive,
    },
    reconcile: options.reconcileJobs ?? true,
  });
  return await readAiCommandLogEntry(options.repoRoot, options.entry.fileName);
}

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();
  const defaultAiProcesses = {
    startProcess: startAiCommandProcess,
    getProcess: getAiCommandProcess,
    deleteProcess: deleteAiCommandProcess,
    readProcessLogs: readAiCommandProcessLogs,
    isProcessActive: isAiCommandProcessActive,
  };
  const aiProcesses = options.aiProcesses
    ? options.aiProcesses
    : process.env.WTM_SERVER_ROLE === "worker"
      ? defaultAiProcesses
      : {
          ...defaultAiProcesses,
          getProcess: async () => null,
          readProcessLogs: async () => ({ stdout: "", stderr: "" }),
          isProcessActive: () => false,
        };
  const aiProcessPollIntervalMs = options.aiProcessPollIntervalMs ?? 250;
  const aiLogStreamPollIntervalMs = options.aiLogStreamPollIntervalMs ?? 500;
  const shouldReconcileAiJobs = process.env.WTM_SERVER_ROLE === "worker";
  const aiJobReadOptions = {
    aiProcesses: {
      getProcess: aiProcesses.getProcess,
      readProcessLogs: aiProcesses.readProcessLogs,
      isProcessActive: aiProcesses.isProcessActive,
    },
    reconcile: shouldReconcileAiJobs,
  };

  const loadCurrentConfig = () => loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitFile: options.configFile,
  });

  const findWorktree = async (branch: string): Promise<WorktreeRecord | undefined> => {
    const worktrees = await listWorktrees(options.repoRoot);
    return worktrees.find((entry) => entry.branch === branch);
  };

  const getRunningAiJobForBranch = async (branch: string): Promise<AiCommandJob | null> => {
    const job = await getAiCommandJob(options.repoRoot, branch, aiJobReadOptions);
    return job?.status === "running" ? job : null;
  };

  const getDeleteAiLockReason = (branch: string) => `Cancel the running AI job on ${branch} before deleting this worktree.`;

  const getMergeAiLockReason = (branch: string) => `Cancel the running AI job on ${branch} before merging these branches.`;

  const buildDeletionState = async (worktree: WorktreeRecord) => {
    const deletion = await getWorktreeDeletionState(options.repoRoot, worktree);
    if (await getRunningAiJobForBranch(worktree.branch)) {
      return {
        ...deletion,
        canDelete: false,
        reason: getDeleteAiLockReason(worktree.branch),
      };
    }

    return deletion;
  };

  const getMergeBlockedByAiReason = async (branches: Array<string | undefined>) => {
    for (const branch of branches) {
      if (!branch) {
        continue;
      }

      if (await getRunningAiJobForBranch(branch)) {
        return getMergeAiLockReason(branch);
      }
    }

    return null;
  };

  const createWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    const startedAt = Date.now();
    logServerEvent("runtime", "start-requested", {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
    });
    const { runtime } = await createRuntime(config, options.repoRoot, worktree.branch, worktree.worktreePath);
    await options.operationalState.setRuntime(runtime);
    await ensureRuntimeTerminalSession(runtime, options.repoRoot);
    await runStartupCommands(config.startupCommands, worktree.worktreePath, buildRuntimeProcessEnv(runtime));
    await startConfiguredBackgroundCommands({
      config,
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      runtime,
    });
    logServerEvent("runtime", "start-completed", {
      branch: worktree.branch,
      worktreePath: worktree.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
    });
    return runtime;
  };

  const ensureWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    const existingRuntime = await options.operationalState.getRuntime(worktree.branch);
    if (existingRuntime) {
      return existingRuntime;
    }

    return createWorktreeRuntime(config, worktree);
  };

  const stopWorktreeRuntime = async (branch: string, worktreePath?: string): Promise<void> => {
    const startedAt = Date.now();
    logServerEvent("runtime", "stop-requested", {
      branch,
      worktreePath: worktreePath ?? null,
    });
    const runtime = await options.operationalState.getRuntime(branch);
    if (!runtime) {
      if (worktreePath) {
        await killTmuxSessionByName(getTmuxSessionName(options.repoRoot, branch), worktreePath);
      }
      logServerEvent("runtime", "stop-skipped", {
        branch,
        worktreePath: worktreePath ?? null,
        duration: formatDurationMs(Date.now() - startedAt),
      });
      return;
    }

    let stopError: unknown = null;

    try {
      await stopAllBackgroundCommands(branch, runtime.worktreePath);
    } catch (error) {
      stopError = error;
    }

    try {
      await killTmuxSession(runtime);
    } catch (error) {
      stopError ??= error;
    }

    await options.operationalState.deleteRuntime(branch);

    if (stopError) {
      logServerEvent("runtime", "stop-failed", {
        branch,
        worktreePath: runtime.worktreePath,
        duration: formatDurationMs(Date.now() - startedAt),
        error: stopError instanceof Error ? stopError.message : String(stopError),
      }, "error");
      throw stopError;
    }

    logServerEvent("runtime", "stop-completed", {
      branch,
      worktreePath: runtime.worktreePath,
      duration: formatDurationMs(Date.now() - startedAt),
    });
  };

  const restartWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    await stopWorktreeRuntime(worktree.branch, worktree.worktreePath);
    return createWorktreeRuntime(config, worktree);
  };

  const scheduleRuntimeStopAfterAiJob = (details: { branch: string; jobId: string; shouldStopRuntime: boolean }) => {
    if (!details.shouldStopRuntime) {
      return;
    }

    runBackgroundTask(async () => {
      await waitForAiCommandJob(options.repoRoot, details.branch, details.jobId).catch(() => null);
      await stopWorktreeRuntime(details.branch);
    }, (error) => {
      logServerEvent("ai-command", "runtime-stop-after-job-failed", {
        branch: details.branch,
        jobId: details.jobId,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
    });
  };

  const commitConfigEdit = async (message: string) => {
    const relativeConfigPath = options.configFile;
    const worktreePath = options.configWorktreePath;

    const stagedBeforeCommit = await runCommand("git", ["status", "--short", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
    if (!stagedBeforeCommit.stdout.trim()) {
      return;
    }

    await runCommand("git", ["add", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });

    const stagedConfigDiff = await runCommand("git", ["diff", "--cached", "--name-only", "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
    if (!stagedConfigDiff.stdout.trim()) {
      return;
    }

    await runCommand("git", ["commit", "-m", message, "--", relativeConfigPath], {
      cwd: worktreePath,
      env: CONFIG_COMMIT_ENV,
    });
  };

  const loadResolvedAiLog = async (fileName: string) => {
    const entry = await readAiCommandLogEntry(options.repoRoot, fileName);
    return reconcileAiCommandLogEntry({
      entry,
      repoRoot: options.repoRoot,
      aiProcesses,
    });
  };

  const writeImmediateAiFailureLog = async (details: {
    branch: string;
    documentId?: string | null;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    worktreePath: string;
    renderedCommand: string;
    input: string;
    error: Error;
  }) => {
    const { jobId, fileName, startedAt } = createAiLogIdentifiers(details.branch);
    return safeWriteAiRequestLog({
      fileName,
      jobId,
      repoRoot: options.repoRoot,
      branch: details.branch,
      documentId: details.documentId ?? null,
      commandId: details.commandId,
      origin: details.origin ?? null,
      worktreePath: details.worktreePath,
      renderedCommand: details.renderedCommand,
      input: details.input,
      startedAt,
      completedAt: startedAt,
      pid: null,
      exitCode: null,
      processName: null,
      error: details.error,
    });
  };

  const startAiProcessJob = async (details: {
    branch: string;
    documentId?: string | null;
    commandId: AiCommandId;
    aiCommands: AiCommandConfig;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    applyDocumentUpdateToDocumentId?: string | null;
    commentDocumentId?: string | null;
    commentRequestSummary?: string | null;
    autoCommitDirtyWorktree?: boolean;
  }): Promise<StartedAiCommandJob> => startAiCommandJob({
    branch: details.branch,
    documentId: details.documentId ?? null,
    commandId: details.commandId,
    origin: details.origin ?? null,
    input: details.input,
    command: details.renderedCommand,
    repoRoot: options.repoRoot,
    worktreePath: details.worktreePath,
    execute: async (payload) => {
      const processName = getAiCommandProcessName(payload.jobId);
      const processInfo = await aiProcesses.startProcess({
        processName,
        command: details.renderedCommand,
        input: details.input,
        worktreePath: details.worktreePath,
        env: details.env,
      });

      await payload.hooks.onSpawn?.({
        pid: processInfo.pid ?? null,
        processName,
      });

      let lastStdout = "";
      let lastStderr = "";

      while (true) {
        const nextProcess = await aiProcesses.getProcess(processName);
        const logs = await aiProcesses.readProcessLogs(nextProcess ?? processInfo);

        if (logs.stdout.startsWith(lastStdout)) {
          const chunk = logs.stdout.slice(lastStdout.length);
          if (chunk) {
            await payload.hooks.onStdout?.(chunk);
          }
        } else if (logs.stdout !== lastStdout) {
          const chunk = logs.stdout.slice(Math.min(lastStdout.length, logs.stdout.length));
          if (chunk) {
            await payload.hooks.onStdout?.(chunk);
          }
        }

        if (logs.stderr.startsWith(lastStderr)) {
          const chunk = logs.stderr.slice(lastStderr.length);
          if (chunk) {
            await payload.hooks.onStderr?.(chunk);
          }
        } else if (logs.stderr !== lastStderr) {
          const chunk = logs.stderr.slice(Math.min(lastStderr.length, logs.stderr.length));
          if (chunk) {
            await payload.hooks.onStderr?.(chunk);
          }
        }

        lastStdout = logs.stdout;
        lastStderr = logs.stderr;

        if (!nextProcess) {
          await payload.hooks.onExit?.({ exitCode: null });
          throw new Error("AI process no longer available.");
        }

        if (!aiProcesses.isProcessActive(nextProcess.status)) {
          await payload.hooks.onExit?.({ exitCode: nextProcess.exitCode ?? null });
          if ((nextProcess.exitCode ?? 0) !== 0) {
            throw new Error(`AI process exited with code ${nextProcess.exitCode ?? "unknown"}.`);
          }

          return logs;
        }

        await new Promise((resolve) => setTimeout(resolve, aiProcessPollIntervalMs));
      }
    },
    onComplete: details.applyDocumentUpdateToDocumentId || details.commentDocumentId || details.autoCommitDirtyWorktree
      ? async ({ stdout, stderr }) => {
        await completeAiCommandRun({
          repoRoot: options.repoRoot,
          branch: details.branch,
          commandId: details.commandId,
          aiCommands: details.aiCommands,
          env: details.env,
          stdout,
          stderr,
          applyDocumentUpdateToDocumentId: details.applyDocumentUpdateToDocumentId,
          commentDocumentId: details.commentDocumentId,
          commentRequestSummary: details.commentRequestSummary,
          autoCommitDirtyWorktree: details.autoCommitDirtyWorktree,
        });
      }
      : undefined,
  });

  const enqueueProjectManagementDocumentAiJob = async (details: {
    branch: string;
    documentId: string;
    commandId: AiCommandId;
    aiCommands: AiCommandConfig;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    applyDocumentUpdateToDocumentId?: string | null;
    commentDocumentId?: string | null;
    commentRequestSummary?: string | null;
    autoCommitDirtyWorktree?: boolean;
  }) => enqueueProjectManagementAiJob({
    repoRoot: options.repoRoot,
    payload: {
      branch: details.branch,
      commandId: details.commandId,
      aiCommands: details.aiCommands,
      origin: details.origin ?? null,
      worktreePath: details.worktreePath,
      input: details.input,
      renderedCommand: details.renderedCommand,
      env: Object.fromEntries(Object.entries(details.env).filter(([, value]) => typeof value === "string")) as Record<string, string>,
      documentId: details.documentId,
      applyDocumentUpdateToDocumentId: details.applyDocumentUpdateToDocumentId ?? null,
      commentDocumentId: details.commentDocumentId ?? null,
      commentRequestSummary: details.commentRequestSummary ?? null,
      autoCommitDirtyWorktree: details.autoCommitDirtyWorktree ?? false,
    },
  });

  const resolveEnvSyncSourceRoot = async (_worktrees: Awaited<ReturnType<typeof listWorktrees>>) => options.configWorktreePath;

  const buildWorktreePayload = async (worktrees: Awaited<ReturnType<typeof listWorktrees>>) => {
    const merged = await options.operationalState.mergeInto(worktrees);
    const [documentsPayload, links] = await Promise.all([
      listProjectManagementDocuments(options.repoRoot),
      getWorktreeDocumentLinks(options.repoRoot),
    ]);
    const linkedWorktrees = attachWorktreeDocumentLinks(merged, links, documentsPayload.documents);
    return await Promise.all(linkedWorktrees.map(async (worktree) => ({
      ...worktree,
      deletion: await buildDeletionState(worktree),
    })));
  };

  router.get("/state", async (_req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const payload: ApiStateResponse = {
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        configFile: options.configFile,
        configSourceRef: options.configSourceRef,
        configWorktreePath: options.configWorktreePath,
        config,
        worktrees: await buildWorktreePayload(worktrees),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/state/stream", async (req, res, next) => {
    const loadState = async (): Promise<ApiStateResponse> => {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      return {
        repoRoot: options.repoRoot,
        configPath: options.configPath,
        configFile: options.configFile,
        configSourceRef: options.configSourceRef,
        configWorktreePath: options.configWorktreePath,
        config,
        worktrees: await buildWorktreePayload(worktrees),
      };
    };

    try {
      let currentState = await loadState();
      let lastPayload = JSON.stringify(currentState);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (type: ApiStateStreamEvent["type"], state: ApiStateResponse) => {
        const event: ApiStateStreamEvent = { type, state };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      writeEvent("snapshot", currentState);

      let polling = false;
      const interval = setInterval(() => {
        if (polling) {
          return;
        }

        polling = true;
        runBackgroundTask(async () => {
          const nextState = await loadState();
            currentState = nextState;
            const nextPayload = JSON.stringify(nextState);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", nextState);
            }
          }, (error) => {
            logServerEvent("state-stream", "poll-failed", {
              error: error instanceof Error ? error.message : String(error),
            }, "error");
          }).finally(() => {
            polling = false;
          });
      }, aiLogStreamPollIntervalMs);
      const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/shutdown-status", async (req, res, next) => {
    try {
      let currentStatus = await options.operationalState.getShutdownStatus();
      let lastPayload = JSON.stringify(currentStatus);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeStatus = (status: ShutdownStatus) => {
        res.write(`data: ${JSON.stringify(status)}\n\n`);
      };

      writeStatus(currentStatus);

      let polling = false;
      const interval = setInterval(() => {
        if (polling) {
          return;
        }

        polling = true;
        runBackgroundTask(async () => {
          const nextStatus = await options.operationalState.getShutdownStatus();
            currentStatus = nextStatus;
            const nextPayload = JSON.stringify(nextStatus);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeStatus(nextStatus);
            }
          }, (error) => {
            logServerEvent("shutdown-status", "poll-failed", {
              error: error instanceof Error ? error.message : String(error),
            }, "error");
          }).finally(() => {
            polling = false;
          });
      }, aiLogStreamPollIntervalMs);
      const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/config/document", async (_req, res, next) => {
    try {
      const contents = await readConfigContents({
        path: options.configPath,
        repoRoot: options.repoRoot,
        gitFile: options.configFile,
      });

      const payload: ConfigDocumentResponse = {
        branch: options.configSourceRef,
        filePath: path.join(options.configWorktreePath, options.configFile),
        contents,
        editable: true,
      };

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/config/document", async (req, res, next) => {
    try {
      const contents = typeof req.body?.contents === "string" ? req.body.contents : "";
      if (!contents.trim()) {
        res.status(400).json({ message: "Config contents are required." });
        return;
      }

      parseConfigContents(contents);

      const absoluteConfigPath = path.join(options.configWorktreePath, options.configFile);
      await fs.writeFile(absoluteConfigPath, contents, "utf8");
      await commitConfigEdit("config: update worktree config");

      const payload: ConfigDocumentResponse = {
        branch: options.configSourceRef,
        filePath: absoluteConfigPath,
        contents,
        editable: true,
      };

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/settings/ai-command", async (_req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const payload: AiCommandSettingsResponse = {
        branch: options.configSourceRef,
        filePath: path.join(options.configWorktreePath, options.configFile),
        aiCommands: config.aiCommands,
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/settings/ai-command", async (req, res, next) => {
    try {
      const body = req.body as UpdateAiCommandSettingsRequest;
      const aiCommands: AiCommandConfig = {
        smart: typeof body?.aiCommands?.smart === "string" ? body.aiCommands.smart : "",
        simple: typeof body?.aiCommands?.simple === "string" ? body.aiCommands.simple : "",
        autoStartRuntime: body?.aiCommands?.autoStartRuntime === true,
      };
      const currentContents = await readConfigContents({
        path: options.configPath,
        repoRoot: options.repoRoot,
        gitFile: options.configFile,
      });
      const nextContents = updateAiCommandInConfigContents(currentContents, aiCommands);

      const absoluteConfigPath = path.join(options.configWorktreePath, options.configFile);
      await fs.writeFile(absoluteConfigPath, nextContents, "utf8");
      await commitConfigEdit("config: update ai commands");

      const payload: AiCommandSettingsResponse = {
        branch: options.configSourceRef,
        filePath: absoluteConfigPath,
        aiCommands,
      };

      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/users", async (_req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const payload: ProjectManagementUsersResponse = await listProjectManagementUsers(
        options.repoRoot,
        config.projectManagement.users,
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.put("/project-management/users", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementUsersRequest | undefined;
      const config = body?.config;
      if (!config || typeof config !== "object") {
        res.status(400).json({ message: "Project management users config is required." });
        return;
      }

      const currentContents = await readConfigContents({
        path: options.configPath,
        repoRoot: options.repoRoot,
        gitFile: options.configFile,
      });

      const nextContents = updateProjectManagementUsersInConfigContents(currentContents, {
        customUsers: Array.isArray(config.customUsers)
          ? config.customUsers.map((entry) => ({
              name: typeof entry?.name === "string" ? entry.name : "",
              email: typeof entry?.email === "string" ? entry.email : "",
            }))
          : [],
        archivedUserIds: Array.isArray(config.archivedUserIds)
          ? config.archivedUserIds.map((entry) => String(entry))
          : [],
      });

      const absoluteConfigPath = path.join(options.configWorktreePath, options.configFile);
      await fs.writeFile(absoluteConfigPath, nextContents, "utf8");
      await commitConfigEdit("config: update project management users");

      const nextConfig = await loadCurrentConfig();
      const payload: ProjectManagementUsersResponse = await listProjectManagementUsers(
        options.repoRoot,
        nextConfig.projectManagement.users,
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/ai-command/stream", async (req, res, next) => {
    try {
      const branch = req.params.branch;
      let currentJob = await getAiCommandJob(options.repoRoot, branch, aiJobReadOptions);
      let lastPayload = JSON.stringify(currentJob);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (type: "snapshot" | "update", job: AiCommandJob | null) => {
        const event = {
          type,
          job,
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      writeEvent("snapshot", currentJob);

      let polling = false;
      const interval = setInterval(() => {
        if (polling) {
          return;
        }

        polling = true;
        runBackgroundTask(async () => {
          const nextJob = await getAiCommandJob(options.repoRoot, branch, aiJobReadOptions);
            currentJob = nextJob;
            const nextPayload = JSON.stringify(nextJob);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", nextJob);
            }
          }, (error) => {
            logServerEvent("ai-command-stream", "poll-failed", {
              branch,
              error: error instanceof Error ? error.message : String(error),
            }, "error");
          }).finally(() => {
            polling = false;
          });
      }, aiLogStreamPollIntervalMs);
      const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 15000);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai/logs", async (_req, res, next) => {
    try {
      const entries = await Promise.all(
        (await listAiCommandLogEntries(options.repoRoot)).map((entry) => reconcileAiCommandLogEntry({
          entry,
          repoRoot: options.repoRoot,
          aiProcesses,
        })),
      );
      const payload: AiCommandLogsResponse = {
        logs: toHistoricalAiCommandLogSummaries(entries),
        runningJobs: entries.filter(isAiCommandLogActivelyRunning).map(toRunningAiCommandJob),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/ai/logs/:fileName", async (req, res, next) => {
    try {
      const fileName = path.basename(decodeURIComponent(req.params.fileName));
      if (!fileName.endsWith(".json")) {
        res.status(400).json({ message: "AI log file must be a JSON file." });
        return;
      }

      const log = await loadResolvedAiLog(fileName);
      const response: AiCommandLogResponse = { log };
      res.json(response);
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        res.status(404).json({ message: `Unknown AI log ${req.params.fileName}` });
        return;
      }
      next(error);
    }
  });

  router.get("/ai/logs/:fileName/stream", async (req, res, next) => {
    try {
      const fileName = path.basename(decodeURIComponent(req.params.fileName));
      if (!fileName.endsWith(".json")) {
        res.status(400).json({ message: "AI log file must be a JSON file." });
        return;
      }

      let currentLog = await loadResolvedAiLog(fileName);
      let lastPayload = JSON.stringify(currentLog);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (type: AiCommandLogStreamEvent["type"], log: AiCommandLogEntry | null) => {
        const event: AiCommandLogStreamEvent = { type, log };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      writeEvent("snapshot", currentLog);
      const unsubscribe = await options.operationalState.subscribeToAiCommandLogNotifications((notification) => {
        if (notification.fileName !== fileName) {
          return;
        }

        void runBackgroundTask(async () => {
          try {
            currentLog = await loadResolvedAiLog(fileName);
            const nextPayload = JSON.stringify(currentLog);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", currentLog);
            }
          } catch (error) {
            const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
            if (code === "ENOENT") {
              if (lastPayload !== "null") {
                lastPayload = "null";
                writeEvent("update", null);
              }
              return;
            }

            throw error;
          }
        }, (error) => {
          logServerEvent("ai-log-stream", "listen-failed", {
            fileName,
            error: error instanceof Error ? error.message : String(error),
          }, "error");
        });
      });

      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        void unsubscribe().catch(() => undefined);
        res.end();
      });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
      if (code === "ENOENT") {
        res.status(404).json({ message: `Unknown AI log ${req.params.fileName}` });
        return;
      }
      next(error);
    }
  });

  router.get("/git/compare", async (req, res, next) => {
    try {
      const compareBranch = String(req.query.compareBranch ?? "").trim();
      const baseBranch = typeof req.query.baseBranch === "string" ? req.query.baseBranch : undefined;

      if (!compareBranch) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      const comparison: GitComparisonResponse = await getGitComparison(options.repoRoot, compareBranch, baseBranch);
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/merge", async (req, res, next) => {
    try {
      const compareBranch = decodeURIComponent(req.params.branch);
      const body = req.body as MergeGitBranchRequest | undefined;
      const baseBranch = typeof body?.baseBranch === "string" ? body.baseBranch : undefined;

      if (!compareBranch.trim()) {
        res.status(400).json({ message: "compareBranch is required" });
        return;
      }

      const mergeBlockedByAiReason = await getMergeBlockedByAiReason([compareBranch, baseBranch]);
      if (mergeBlockedByAiReason) {
        res.status(409).json({ message: mergeBlockedByAiReason });
        return;
      }

      const comparison: GitComparisonResponse = await mergeGitBranch(options.repoRoot, compareBranch, baseBranch);
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/resolve-conflicts", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as ResolveGitMergeConflictsRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const comparisonBeforeResolution = await getGitComparison(
        options.repoRoot,
        branch,
        typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
      );
      const baseBranch = comparisonBeforeResolution.baseBranch;
      const conflictsToResolve = comparisonBeforeResolution.workingTreeConflicts.length > 0
        ? comparisonBeforeResolution.workingTreeConflicts
        : comparisonBeforeResolution.mergeIntoCompareStatus.conflicts;

      if (conflictsToResolve.length === 0) {
        throw new Error(`Branch ${branch} does not currently expose merge conflicts against ${baseBranch}.`);
      }

      const runtime = await options.operationalState.getRuntime(worktree.branch);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
          ...process.env,
          ...config.env,
          WORKTREE_BRANCH: worktree.branch,
          WORKTREE_PATH: worktree.worktreePath,
        };

      const commandId = parseAiCommandId(body?.commandId ?? "smart");
      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      const origin = createGitConflictResolutionOrigin({
        branch: worktree.branch,
        baseBranch,
      });

      if (!template) {
        const error = new Error(`${commandId === "simple" ? "Simple AI" : "Smart AI"} is not configured.`);
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          commandId,
          origin,
          worktreePath: worktree.worktreePath,
          renderedCommand: template,
          input: "",
          error,
        });
        throw error;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        const error = new Error(`${commandId === "simple" ? "Simple AI" : "Smart AI"} must include $WTM_AI_INPUT.`);
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          commandId,
          origin,
          worktreePath: worktree.worktreePath,
          renderedCommand: template,
          input: "",
          error,
        });
        throw error;
      }

      for (const conflict of conflictsToResolve) {
        const input = formatMergeConflictResolutionPrompt({
          branch: worktree.branch,
          baseBranch,
          conflicts: [conflict],
        });
        const renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));
        const completedAt = new Date().toISOString();
        try {
          const { stdout, stderr } = await runCommand(process.env.SHELL || "/usr/bin/bash", ["-lc", template], {
            cwd: worktree.worktreePath,
            env: { ...env, WTM_AI_INPUT: input },
          });
          const normalized = stdout.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trimEnd();
          if (!normalized.trim()) {
            throw new Error(`AI did not return resolved contents for ${conflict.path}.`);
          }

          await fs.writeFile(path.join(worktree.worktreePath, conflict.path), `${normalized}\n`, "utf8");

          const { jobId, fileName, startedAt } = createAiLogIdentifiers(worktree.branch);
          await safeWriteAiRequestLog({
            fileName,
            jobId,
            repoRoot: options.repoRoot,
            branch: worktree.branch,
            commandId,
            origin,
            worktreePath: worktree.worktreePath,
            renderedCommand,
            input,
            stdout,
            stderr,
            startedAt,
            completedAt,
            pid: null,
            exitCode: 0,
            processName: null,
          });
        } catch (error) {
          const { jobId, fileName, startedAt } = createAiLogIdentifiers(worktree.branch);
          await safeWriteAiRequestLog({
            fileName,
            jobId,
            repoRoot: options.repoRoot,
            branch: worktree.branch,
            commandId,
            origin,
            worktreePath: worktree.worktreePath,
            renderedCommand,
            input,
            startedAt,
            completedAt,
            pid: null,
            exitCode: null,
            processName: null,
            error,
          });
          throw error;
        }
      }

      await runCommand("git", ["add", "--", ...conflictsToResolve.map((conflict) => conflict.path)], {
        cwd: worktree.worktreePath,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "worktreeman",
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "worktreeman@example.com",
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "worktreeman",
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "worktreeman@example.com",
        },
      });

      const comparison: GitComparisonResponse = await getGitComparison(options.repoRoot, branch, baseBranch);
      res.json(comparison);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/commit", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as CommitGitChangesRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const runtime = await options.operationalState.getRuntime(worktree.branch);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
          ...process.env,
          ...config.env,
          WORKTREE_BRANCH: worktree.branch,
          WORKTREE_PATH: worktree.worktreePath,
        };

      const payload: CommitGitChangesResponse = await commitGitChanges({
        repoRoot: options.repoRoot,
        branch,
        baseBranch: typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
        aiCommands: config.aiCommands,
        commandId: parseAiCommandId(body?.commandId ?? "simple"),
        env,
        message: typeof body?.message === "string" ? body.message : undefined,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/git/compare/:branch/commit-message", async (req, res, next) => {
    try {
      const branch = decodeURIComponent(req.params.branch).trim();
      const body = req.body as GenerateGitCommitMessageRequest | undefined;

      if (!branch) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${branch}` });
        return;
      }

      const runtime = await options.operationalState.getRuntime(worktree.branch);
      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
          ...process.env,
          ...config.env,
          WORKTREE_BRANCH: worktree.branch,
          WORKTREE_PATH: worktree.worktreePath,
        };

      const payload: GenerateGitCommitMessageResponse = await generateGitCommitMessage({
        repoRoot: options.repoRoot,
        branch,
        baseBranch: typeof body?.baseBranch === "string" ? body.baseBranch : undefined,
        aiCommands: config.aiCommands,
        commandId: parseAiCommandId(body?.commandId ?? "simple"),
        env,
      });
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents", async (_req, res, next) => {
    try {
      const payload: ProjectManagementListResponse = await listProjectManagementDocuments(options.repoRoot);
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents/:id", async (req, res, next) => {
    try {
      const payload: ProjectManagementDocumentResponse = await getProjectManagementDocument(
        options.repoRoot,
        decodeURIComponent(req.params.id),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/project-management/documents/:id/history", async (req, res, next) => {
    try {
      const payload: ProjectManagementHistoryResponse = await getProjectManagementDocumentHistory(
        options.repoRoot,
        decodeURIComponent(req.params.id),
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const body = req.body as CreateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      let payload: ProjectManagementDocumentResponse = await createProjectManagementDocument(options.repoRoot, {
        title: body.title,
        summary: typeof body.summary === "string" ? body.summary : undefined,
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        kind: body.kind === "pull-request" ? "pull-request" : body.kind === "document" ? "document" : undefined,
        pullRequest: body.pullRequest && typeof body.pullRequest === "object"
          ? {
              baseBranch: typeof body.pullRequest.baseBranch === "string" ? body.pullRequest.baseBranch : "",
              compareBranch: typeof body.pullRequest.compareBranch === "string" ? body.pullRequest.compareBranch : "",
              state: body.pullRequest.state === "closed" || body.pullRequest.state === "merged" ? body.pullRequest.state : "open",
              draft: Boolean(body.pullRequest.draft),
            }
          : undefined,
        tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
        dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((entry) => String(entry)) : [],
        status: typeof body.status === "string" ? body.status : undefined,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      });

      if (!payload.document.summary) {
        const relatedDocuments = (await listProjectManagementDocuments(options.repoRoot)).documents;
        const generatedSummary = await generateProjectManagementDocumentSummary({
          repoRoot: options.repoRoot,
          config,
          document: payload.document,
          relatedDocuments,
        });

        if (generatedSummary) {
          payload = await updateProjectManagementDocument(options.repoRoot, payload.document.id, {
            title: payload.document.title,
            summary: generatedSummary,
            markdown: payload.document.markdown,
            kind: payload.document.kind,
            pullRequest: payload.document.pullRequest,
            tags: payload.document.tags,
            dependencies: payload.document.dependencies,
            status: payload.document.status,
            assignee: payload.document.assignee,
            archived: payload.document.archived,
          });
        }
      }

      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/updates", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await updateProjectManagementDocument(
        options.repoRoot,
        decodeURIComponent(req.params.id),
        {
          title: body.title,
          summary: typeof body.summary === "string" ? body.summary : undefined,
          markdown: typeof body.markdown === "string" ? body.markdown : "",
          kind: body.kind === "pull-request" ? "pull-request" : body.kind === "document" ? "document" : undefined,
          pullRequest: body.pullRequest && typeof body.pullRequest === "object"
            ? {
                baseBranch: typeof body.pullRequest.baseBranch === "string" ? body.pullRequest.baseBranch : "",
                compareBranch: typeof body.pullRequest.compareBranch === "string" ? body.pullRequest.compareBranch : "",
                state: body.pullRequest.state === "closed" || body.pullRequest.state === "merged" ? body.pullRequest.state : "open",
                draft: Boolean(body.pullRequest.draft),
              }
            : undefined,
          tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
          dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((entry) => String(entry)) : [],
          status: typeof body.status === "string" ? body.status : undefined,
          assignee: typeof body.assignee === "string" ? body.assignee : undefined,
          archived: typeof body.archived === "boolean" ? body.archived : undefined,
        },
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/batches", async (req, res, next) => {
    try {
      const body = req.body as AppendProjectManagementBatchRequest;
      if (!Array.isArray(body?.entries) || body.entries.length === 0) {
        res.status(400).json({ message: "At least one batch entry is required." });
        return;
      }

      const payload: ProjectManagementBatchResponse = await appendProjectManagementBatch(options.repoRoot, {
        entries: body.entries.map((entry) => ({
          documentId: typeof entry.documentId === "string" ? entry.documentId : undefined,
          title: String(entry.title ?? ""),
          summary: typeof entry.summary === "string" ? entry.summary : undefined,
          markdown: typeof entry.markdown === "string" ? entry.markdown : "",
          kind: entry.kind === "pull-request" ? "pull-request" : entry.kind === "document" ? "document" : undefined,
          pullRequest: entry.pullRequest && typeof entry.pullRequest === "object"
            ? {
                baseBranch: typeof entry.pullRequest.baseBranch === "string" ? entry.pullRequest.baseBranch : "",
                compareBranch: typeof entry.pullRequest.compareBranch === "string" ? entry.pullRequest.compareBranch : "",
                state: entry.pullRequest.state === "closed" || entry.pullRequest.state === "merged" ? entry.pullRequest.state : "open",
                draft: Boolean(entry.pullRequest.draft),
              }
            : undefined,
          tags: Array.isArray(entry.tags) ? entry.tags.map((tag) => String(tag)) : [],
          dependencies: Array.isArray(entry.dependencies) ? entry.dependencies.map((dependencyId) => String(dependencyId)) : [],
          status: typeof entry.status === "string" ? entry.status : undefined,
          assignee: typeof entry.assignee === "string" ? entry.assignee : undefined,
          archived: typeof entry.archived === "boolean" ? entry.archived : undefined,
        })),
      });
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/dependencies", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementDependenciesRequest;
      const payload: ProjectManagementDocumentResponse = await updateProjectManagementDependencies(
        options.repoRoot,
        decodeURIComponent(req.params.id),
        Array.isArray(body?.dependencyIds) ? body.dependencyIds.map((entry) => String(entry)) : [],
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/status", async (req, res, next) => {
    try {
      const body = req.body as UpdateProjectManagementStatusRequest;
      if (!body?.status?.trim()) {
        res.status(400).json({ message: "Document status is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await updateProjectManagementStatus(
        options.repoRoot,
        decodeURIComponent(req.params.id),
        body.status,
      );
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/comments", async (req, res, next) => {
    try {
      const body = req.body as AddProjectManagementCommentRequest;
      if (!body?.body?.trim()) {
        res.status(400).json({ message: "Comment body is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await addProjectManagementComment(
        options.repoRoot,
        decodeURIComponent(req.params.id),
        { body: body.body },
      );
      res.status(201).json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/project-management/documents/:id/ai-command/run", async (req, res, next) => {
    let worktreePath = "";
    let branch = "";
    let input = "";
    let commandId: AiCommandId = "smart";
    let origin: AiCommandOrigin | null = null;
    let stopAutoStartedRuntimeOnError = false;

    try {
      const config = await loadCurrentConfig();
      const documentId = decodeURIComponent(req.params.id).trim();
      const body = req.body as RunProjectManagementDocumentAiRequest | undefined;
      const requestedChange = typeof body?.input === "string" ? body.input : null;
      const requestedOrigin = parseAiCommandOrigin(body?.origin);
      const requestedWorktreeStrategy = body?.worktreeStrategy === "continue-current"
        ? "continue-current"
        : "new";
      const requestedTargetBranch = typeof body?.targetBranch === "string" && body.targetBranch.trim()
        ? body.targetBranch.trim()
        : null;
      const requestedWorktreeName = typeof body?.worktreeName === "string" && body.worktreeName.trim()
        ? body.worktreeName.trim()
        : null;
      const documentPayload = await getProjectManagementDocument(options.repoRoot, documentId);
      const documentsPayload = await listProjectManagementDocuments(options.repoRoot);

      if (requestedWorktreeStrategy === "continue-current") {
        if (!requestedTargetBranch) {
          res.status(400).json({ message: "A linked worktree branch is required to continue current work." });
          return;
        }

        const requestedLink = await getWorktreeDocumentLink(options.repoRoot, requestedTargetBranch);
        if (!requestedLink || requestedLink.documentId !== documentId) {
          res.status(404).json({ message: `No linked worktree ${requestedTargetBranch} exists for document ${documentId}.` });
          return;
        }

        const existingWorktree = await findWorktree(requestedTargetBranch);
        if (!existingWorktree) {
          res.status(404).json({ message: `Unknown worktree ${requestedTargetBranch}` });
          return;
        }

        branch = existingWorktree.branch;
        worktreePath = existingWorktree.worktreePath;
      } else {
        branch = await resolveProjectManagementDocumentWorktreeBranch({
          repoRoot: options.repoRoot,
          baseDir: path.resolve(options.repoRoot, config.worktrees.baseDir),
          document: documentPayload.document,
          preferredName: requestedWorktreeName,
        });
      }

      commandId = resolveRequestedAiCommandId(body?.commandId, { documentId });
      const defaultOrigin = createProjectManagementDocumentOrigin({
        branch,
        document: documentPayload.document,
        kind: "project-management-document-run",
        label: "Project management document run",
        viewMode: "document",
      });
      origin = requestedOrigin?.kind === "project-management-document-run"
        && requestedOrigin.location.tab === "project-management"
        ? {
          ...requestedOrigin,
          description: requestedOrigin.description?.trim() || defaultOrigin.description,
          location: {
            ...requestedOrigin.location,
            tab: "project-management",
            branch,
            documentId: documentPayload.document.id,
            projectManagementSubTab: requestedOrigin.location.projectManagementSubTab ?? "document",
            projectManagementDocumentViewMode: requestedOrigin.location.projectManagementDocumentViewMode ?? "document",
          },
        }
        : defaultOrigin;

      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      if (!template) {
        await writeImmediateAiFailureLog({
          branch,
          documentId,
          commandId,
          origin,
          worktreePath: "",
          renderedCommand: template,
          input: documentId,
          error: new Error("AI Command is not configured."),
        });
        res.status(400).json({ message: "AI Command is not configured." });
        return;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        await writeImmediateAiFailureLog({
          branch,
          documentId,
          commandId,
          origin,
          worktreePath: "",
          renderedCommand: template,
          input: documentId,
          error: new Error("AI Command must include $WTM_AI_INPUT."),
        });
        res.status(400).json({ message: "AI Command must include $WTM_AI_INPUT." });
        return;
      }

      const worktreesBefore = await listWorktrees(options.repoRoot);
      let worktree = worktreesBefore.find((entry) => entry.branch === branch) ?? null;
      if (!worktree) {
        worktree = await createWorktree(options.repoRoot, config, { branch });
        const sourceRoot = await resolveEnvSyncSourceRoot(await listWorktrees(options.repoRoot));
        if (sourceRoot) {
          await syncEnvFiles(sourceRoot, worktree.worktreePath);
        }
      }

      await setWorktreeDocumentLink(options.repoRoot, {
        branch,
        worktreePath: worktree.worktreePath,
        documentId,
      });

      worktreePath = worktree.worktreePath;
      if ((await getAiCommandJob(options.repoRoot, branch, aiJobReadOptions))?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${branch}.` });
        return;
      }

      const existingRuntime = await options.operationalState.getRuntime(branch);
      const runtime = existingRuntime ?? (config.aiCommands.autoStartRuntime ? await ensureWorktreeRuntime(config, worktree) : undefined);
      stopAutoStartedRuntimeOnError = !existingRuntime && runtime != null;
      const backgroundCommands = await listBackgroundCommands(config, branch, worktreePath, runtime);
      const environmentContext = buildAiEnvironmentContext({
        repoRoot: options.repoRoot,
        config,
        branch,
        worktreePath,
        runtime,
        backgroundCommands,
      });
      input = buildProjectManagementExecutionAiPrompt({
        branch,
        worktreePath,
        environmentContext,
        document: documentPayload.document,
        relatedDocuments: documentsPayload.documents,
        requestedChange: requestedChange ?? undefined,
      });
      const env = runtime ? buildRuntimeProcessEnv(runtime) : { ...process.env };

      const job = await enqueueProjectManagementDocumentAiJob({
        branch,
        documentId,
        commandId,
        aiCommands: config.aiCommands,
        origin,
        input,
        renderedCommand: template,
        worktreePath,
        env,
        commentDocumentId: documentId,
        commentRequestSummary: requestedChange,
        autoCommitDirtyWorktree: true,
      });
      await moveProjectManagementDocumentTowardInProgress(options.repoRoot, documentId);
      scheduleRuntimeStopAfterAiJob({
        branch,
        jobId: job.jobId,
        shouldStopRuntime: stopAutoStartedRuntimeOnError,
      });
      stopAutoStartedRuntimeOnError = false;

      const payload: RunAiCommandResponse = { job, runtime };
      res.json(payload);
    } catch (error) {
      if (stopAutoStartedRuntimeOnError && branch) {
        await stopWorktreeRuntime(branch).catch((cleanupError) => {
          logServerEvent("ai-command", "runtime-stop-after-project-management-error-failed", {
            branch,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }, "error");
        });
      }

      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Unknown project management document ")) {
        await writeImmediateAiFailureLog({
          branch: branch || `pm-${sanitizeBranchName(decodeURIComponent(req.params.id)) || "document"}`,
          documentId: decodeURIComponent(req.params.id),
          commandId,
          origin,
          worktreePath,
          renderedCommand: "",
          input,
          error: new Error(message),
        });
        res.status(404).json({ message });
        return;
      }

      logServerEvent("project-management-ai", "request-failed", {
        documentId: req.params.id,
        branch,
        commandId,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      next(error);
    }
  });

  router.post("/worktrees", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const body = req.body as CreateWorktreeRequest;
      if (!body?.branch?.trim()) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const documentId = typeof body.documentId === "string" && body.documentId.trim()
        ? body.documentId.trim()
        : null;
      if (documentId) {
        try {
          await getProjectManagementDocument(options.repoRoot, documentId);
        } catch {
          res.status(404).json({ message: `Unknown project management document ${documentId}.` });
          return;
        }
      }

      const worktree = await createWorktree(options.repoRoot, config, body);
      if (documentId) {
        await setWorktreeDocumentLink(options.repoRoot, {
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          documentId,
        });
      }
      const worktrees = await listWorktrees(options.repoRoot);
      const sourceRoot = await resolveEnvSyncSourceRoot(worktrees);

      if (sourceRoot) {
        const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
        res.status(201).json(result);
        return;
      }

      res.status(201).json({ copiedFiles: [] });
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/start", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktree = await findWorktree(req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await ensureWorktreeRuntime(config, worktree);
      res.json(runtime);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/env/sync", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const sourceRoot = await resolveEnvSyncSourceRoot(worktrees);

      if (!sourceRoot) {
        res.status(404).json({ message: `Unable to locate the source config worktree for ${options.configSourceRef}.` });
        return;
      }

      const result = await syncEnvFiles(sourceRoot, worktree.worktreePath);
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/ai-command/run", async (req, res, next) => {
    let input = "";
    let renderedCommand = "";
    let worktreePath = "";
    let commandId: AiCommandId = "smart";
    let origin: AiCommandOrigin | null = null;
    let branch = req.params.branch;
    let stopAutoStartedRuntimeOnError = false;
    let explicitDocumentPayload: ProjectManagementDocumentResponse | null = null;
    let documentsPayload: ProjectManagementListResponse | null = null;

    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
      const body = req.body as RunAiCommandRequest;
      input = typeof body?.input === "string" ? body.input : "";
      const explicitDocumentId = typeof body?.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : null;
      const requestedCommentDocumentId = typeof body?.commentDocumentId === "string" && body.commentDocumentId.trim()
        ? body.commentDocumentId.trim()
        : null;
      const requestedOrigin = parseAiCommandOrigin(body?.origin);
      const linkedDocumentId = explicitDocumentId
        ? null
        : (await getWorktreeDocumentLink(options.repoRoot, req.params.branch))?.documentId ?? null;
      const documentId = explicitDocumentId ?? linkedDocumentId;
      const commentDocumentId = explicitDocumentId ? null : requestedCommentDocumentId ?? linkedDocumentId;
      commandId = resolveRequestedAiCommandId(body?.commandId, { documentId: explicitDocumentId });

      if (!worktree) {
        await writeImmediateAiFailureLog({
          branch: req.params.branch,
          documentId,
          commandId,
          origin,
          worktreePath: "",
          renderedCommand: "",
          input,
          error: new Error(`Unknown worktree ${req.params.branch}`),
        });
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      worktreePath = worktree.worktreePath;
      branch = worktree.branch;
      origin = requestedOrigin?.kind === "git-pull-request-review"
        ? createGitPullRequestReviewOrigin({
          branch: worktree.branch,
          baseBranch: requestedOrigin.location.gitBaseBranch ?? worktree.branch,
          documentId: commentDocumentId,
          label: requestedOrigin.label,
        })
        : requestedOrigin ?? createWorktreeEnvironmentOrigin(worktree.branch);

      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      if (!template) {
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI Command is not configured."),
        });
        res.status(400).json({ message: "AI Command is not configured." });
        return;
      }

      if (!template.includes("$WTM_AI_INPUT")) {
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI Command must include $WTM_AI_INPUT."),
        });
        res.status(400).json({ message: "AI Command must include $WTM_AI_INPUT." });
        return;
      }

      if (!input.trim()) {
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          documentId,
          commandId,
          origin,
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI command input is required."),
        });
        res.status(400).json({ message: "AI command input is required." });
        return;
      }

      if (explicitDocumentId) {
        try {
          explicitDocumentPayload = await getProjectManagementDocument(options.repoRoot, explicitDocumentId);
          documentsPayload = await listProjectManagementDocuments(options.repoRoot);
          origin = requestedOrigin ?? createProjectManagementDocumentOrigin({
            branch: worktree.branch,
            document: explicitDocumentPayload.document,
            kind: "project-management-document",
            label: "Project management document",
            viewMode: "edit",
          });
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          origin = {
            kind: "project-management-document",
            label: "Project management document",
            description: explicitDocumentId,
            location: {
              tab: "project-management",
              branch: worktree.branch,
              projectManagementSubTab: "document",
              documentId: explicitDocumentId,
              projectManagementDocumentViewMode: "edit",
            },
          };
          await writeImmediateAiFailureLog({
            branch: worktree.branch,
            documentId: explicitDocumentId,
            commandId,
            origin,
            worktreePath,
            renderedCommand: template,
            input,
            error: reason,
          });
          res.status(404).json({ message: `Unknown project management document ${explicitDocumentId}.` });
          return;
        }
      }

      if ((await getAiCommandJob(options.repoRoot, worktree.branch, aiJobReadOptions))?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${worktree.branch}.` });
        return;
      }

      const existingRuntime = await options.operationalState.getRuntime(worktree.branch);
      const runtime = existingRuntime ?? (config.aiCommands.autoStartRuntime ? await ensureWorktreeRuntime(config, worktree) : undefined);
      stopAutoStartedRuntimeOnError = !existingRuntime && runtime != null;
      const backgroundCommands = await listBackgroundCommands(config, worktree.branch, worktreePath, runtime);
      const environmentContext = buildAiEnvironmentContext({
        repoRoot: options.repoRoot,
        config,
        branch: worktree.branch,
        worktreePath,
        runtime,
        backgroundCommands,
      });

      if (explicitDocumentId && explicitDocumentPayload && documentsPayload) {
        input = buildProjectManagementAiPrompt({
          branch: worktree.branch,
          worktreePath,
          requestedChange: input.trim(),
          environmentContext,
          document: explicitDocumentPayload.document,
          relatedDocuments: documentsPayload.documents,
        });
      }

      logServerEvent("ai-command", "request-started", {
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        documentId,
        commandId,
        origin: origin?.kind ?? null,
        input: formatLogSnippet(input),
      });

      if (!explicitDocumentId) {
        input = buildWorktreeAiPrompt({
          request: input,
          environmentContext,
        });
      }

      const env = runtime ? buildRuntimeProcessEnv(runtime) : { ...process.env };

      renderedCommand = template;
      const runDetails = {
        branch: worktree.branch,
        documentId,
        commandId,
        aiCommands: config.aiCommands,
        origin,
        input,
        renderedCommand,
        worktreePath,
        env,
        applyDocumentUpdateToDocumentId: explicitDocumentId,
        commentDocumentId,
        commentRequestSummary: explicitDocumentId ? null : body.input,
        autoCommitDirtyWorktree: true,
      };
      const job = explicitDocumentId
        ? await enqueueProjectManagementDocumentAiJob({
          branch: runDetails.branch,
          documentId: explicitDocumentId,
          commandId: runDetails.commandId,
          aiCommands: runDetails.aiCommands,
          origin: runDetails.origin,
          input: runDetails.input,
          renderedCommand: runDetails.renderedCommand,
          worktreePath: runDetails.worktreePath,
          env: runDetails.env,
          applyDocumentUpdateToDocumentId: runDetails.applyDocumentUpdateToDocumentId,
          commentDocumentId: runDetails.commentDocumentId,
          commentRequestSummary: runDetails.commentRequestSummary,
          autoCommitDirtyWorktree: runDetails.autoCommitDirtyWorktree,
        })
        : await (await startAiProcessJob(runDetails)).started;
      scheduleRuntimeStopAfterAiJob({
        branch: worktree.branch,
        jobId: job.jobId,
        shouldStopRuntime: stopAutoStartedRuntimeOnError,
      });
      stopAutoStartedRuntimeOnError = false;

      const payload: RunAiCommandResponse = { job, runtime };
      res.json(payload);
    } catch (error) {
      if (stopAutoStartedRuntimeOnError && branch) {
        await stopWorktreeRuntime(branch).catch((cleanupError) => {
          logServerEvent("ai-command", "runtime-stop-after-request-error-failed", {
            branch,
            error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          }, "error");
        });
      }

      logServerEvent("ai-command", "request-failed", {
        branch: req.params.branch,
        commandId,
        origin: origin?.kind ?? null,
        error: error instanceof Error ? error.message : String(error),
      }, "error");
      next(error);
    }
  });

  router.post("/worktrees/:branch/ai-command/cancel", async (req, res, next) => {
    try {
      const inMemoryJob = await getAiCommandJob(options.repoRoot, req.params.branch, aiJobReadOptions);
      const persistedLog = (await Promise.all(
        (await listAiCommandLogEntries(options.repoRoot)).map((entry) => reconcileAiCommandLogEntry({
          entry,
          repoRoot: options.repoRoot,
          aiProcesses,
        })),
      )).find((entry) => entry.branch === req.params.branch && isAiCommandLogActivelyRunning(entry)) ?? null;

      const job = inMemoryJob?.status === "running"
        ? inMemoryJob
        : persistedLog
          ? toRunningAiCommandJob(persistedLog)
          : null;

      if (!job || job.status !== "running") {
        res.status(404).json({ message: `No running AI command for ${req.params.branch}.` });
        return;
      }

      if (!job.processName) {
        res.status(409).json({ message: `Running AI command for ${req.params.branch} cannot be cancelled yet.` });
        return;
      }

      await aiProcesses.deleteProcess(job.processName);

      const cancellationMessage = "AI process exited with code unknown. Cancellation requested by the user.";
      const failedJob = inMemoryJob?.status === "running"
        ? await failAiCommandJob({
          repoRoot: options.repoRoot,
          branch: req.params.branch,
          jobId: job.jobId,
          error: cancellationMessage,
          outputEvents: appendAiCommandOutputEvents(job.jobId, job.outputEvents, "stderr", cancellationMessage),
        })
        : null;

      if (failedJob) {
        await safeWriteAiRequestLog({
          fileName: failedJob.fileName,
          jobId: failedJob.jobId,
          repoRoot: options.repoRoot,
          branch: failedJob.branch,
          documentId: failedJob.documentId ?? null,
          commandId: failedJob.commandId,
          origin: failedJob.origin ?? null,
          worktreePath: persistedLog?.worktreePath ?? job.branch,
          renderedCommand: failedJob.command,
          input: failedJob.input,
          stdout: failedJob.stdout,
          stderr: failedJob.stderr,
          events: failedJob.outputEvents,
          startedAt: failedJob.startedAt,
          completedAt: failedJob.completedAt,
          pid: failedJob.pid ?? null,
          exitCode: failedJob.exitCode ?? null,
          processName: failedJob.processName,
          error: failedJob.error ? new Error(failedJob.error) : null,
        });
      } else if (persistedLog) {
        await safeWriteAiRequestLog({
          fileName: persistedLog.fileName,
          jobId: persistedLog.jobId,
          repoRoot: options.repoRoot,
          branch: persistedLog.branch,
          documentId: persistedLog.documentId ?? null,
          commandId: persistedLog.commandId,
          origin: persistedLog.origin ?? null,
          worktreePath: persistedLog.worktreePath,
          renderedCommand: persistedLog.command,
          input: persistedLog.request,
          stdout: persistedLog.response.stdout,
          stderr: `${persistedLog.response.stderr}${cancellationMessage}`,
          events: appendAiCommandOutputEvents(persistedLog.jobId, persistedLog.response.events, "stderr", cancellationMessage),
          startedAt: persistedLog.timestamp,
          completedAt: new Date().toISOString(),
          pid: persistedLog.pid ?? null,
          exitCode: persistedLog.exitCode ?? null,
          processName: persistedLog.processName,
          error: new Error(cancellationMessage),
        });
      }

      let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
      const settledJob = await Promise.race([
        waitForAiCommandJob(options.repoRoot, req.params.branch, job.jobId),
        new Promise<typeof job>((resolve) => {
          fallbackTimer = setTimeout(() => {
            runBackgroundTask(async () => {
              try {
                const nextInMemoryJob = await getAiCommandJob(options.repoRoot, req.params.branch, aiJobReadOptions);
                if (nextInMemoryJob) {
                  resolve(nextInMemoryJob);
                  return;
                }

                if (persistedLog) {
                  const nextLog = await loadResolvedAiLog(persistedLog.fileName);
                  resolve(toRunningAiCommandJob(nextLog));
                  return;
                }

                resolve(job);
              } catch {
                resolve(job);
              }
            }, () => {
              resolve(job);
            });
          }, Math.max(aiProcessPollIntervalMs * 4, 500));
        }),
      ]);
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
      }

      const finalJob = failedJob ?? settledJob;
      try {
        const resolvedLog = await readAiCommandLogEntry(options.repoRoot, finalJob.fileName);
        const hasCancellationEvent = resolvedLog.response.events?.some(
          (event) => event.source === "stderr" && /Cancellation requested by the user/.test(event.text),
        ) ?? false;
        const nextStderr = /Cancellation requested by the user/.test(resolvedLog.response.stderr)
          ? resolvedLog.response.stderr
          : `${resolvedLog.response.stderr}${cancellationMessage}`;
        await safeWriteAiRequestLog({
          fileName: resolvedLog.fileName,
          jobId: resolvedLog.jobId,
          repoRoot: options.repoRoot,
          branch: resolvedLog.branch,
          documentId: resolvedLog.documentId ?? null,
          commandId: resolvedLog.commandId,
          origin: resolvedLog.origin ?? null,
          worktreePath: resolvedLog.worktreePath,
          renderedCommand: resolvedLog.command,
          input: resolvedLog.request,
          stdout: resolvedLog.response.stdout,
          stderr: nextStderr,
          events: hasCancellationEvent
            ? resolvedLog.response.events
            : appendAiCommandOutputEvents(resolvedLog.jobId, resolvedLog.response.events, "stderr", cancellationMessage),
          startedAt: resolvedLog.timestamp,
          completedAt: resolvedLog.completedAt ?? finalJob.completedAt ?? new Date().toISOString(),
          pid: finalJob.pid ?? resolvedLog.pid ?? null,
          exitCode: finalJob.exitCode ?? resolvedLog.exitCode ?? null,
          processName: finalJob.processName ?? resolvedLog.processName ?? null,
          error: new Error(cancellationMessage),
        });
      } catch {
        // Best-effort persistence only; the cancellation response should still succeed.
      }

      const payload: RunAiCommandResponse = { job: finalJob };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/stop", async (req, res, next) => {
    try {
      const worktree = await findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await options.operationalState.getRuntime(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await stopWorktreeRuntime(req.params.branch, worktree.worktreePath);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/restart", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktree = await findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await restartWorktreeRuntime(config, worktree);
      res.json(runtime);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/reconnect", async (req, res, next) => {
    try {
      const worktree = await findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const runtime = await options.operationalState.getRuntime(worktree.branch) ?? undefined;
      const tmuxSession = await ensureTerminalSession({
        repoRoot: options.repoRoot,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime,
      });
      const clients = await listTmuxClients({
        tmuxSession,
        worktreePath: worktree.worktreePath,
      });
      const payload: ReconnectTerminalResponse = {
        tmuxSession,
        clients,
        runtime,
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const runtime = await options.operationalState.getRuntime(req.params.branch);
      const worktree = await findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

        const tmuxSession = await ensureTerminalSession({
          repoRoot: options.repoRoot,
          branch: worktree.branch,
          worktreePath: worktree.worktreePath,
          runtime: runtime ?? undefined,
        });

      const clients: TmuxClientInfo[] = await listTmuxClients({
        tmuxSession,
        worktreePath: worktree.worktreePath,
      });
      res.json(clients);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/tmux-clients/:clientId/disconnect", async (req, res, next) => {
    try {
      const worktree = await findWorktree(req.params.branch);
      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      await disconnectTmuxClient({ worktreePath: worktree.worktreePath }, decodeURIComponent(req.params.clientId));
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/worktrees/:branch", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const request: DeleteWorktreeRequest = {
        confirmWorktreeName: typeof req.body?.confirmWorktreeName === "string" ? req.body.confirmWorktreeName : undefined,
        deleteBranch: typeof req.body?.deleteBranch === "boolean" ? req.body.deleteBranch : true,
      };
      const deletion = await buildDeletionState(worktree);
      try {
        validateDeleteWorktreeRequest(worktree, deletion, request);
      } catch (error) {
        res.status(await getRunningAiJobForBranch(worktree.branch) ? 409 : 400).json({
          message: error instanceof Error ? error.message : "Invalid delete request.",
        });
        return;
      }

      await stopWorktreeRuntime(worktree.branch, worktree.worktreePath);

      await removeWorktree(options.repoRoot, worktree.worktreePath);
      await clearWorktreeDocumentLink(options.repoRoot, worktree.branch);
      if (request.deleteBranch) {
        await deleteBranch(options.repoRoot, worktree.branch);
      }
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/start", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await startBackgroundCommand({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime: (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/stop", async (req, res, next) => {
    try {
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(await loadCurrentConfig())[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await stopBackgroundCommand(worktree.branch, worktree.worktreePath, decodedName);

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        await loadCurrentConfig(),
        worktree.branch,
        worktree.worktreePath,
        (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/background-commands/:name/restart", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const decodedName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[decodedName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${decodedName}` });
        return;
      }

      await restartBackgroundCommand({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime: (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        (await options.operationalState.getRuntime(worktree.branch)) ?? undefined,
      );
      res.json(commands);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const logs: BackgroundCommandLogsResponse = await getBackgroundCommandLogs(
        config,
        worktree.branch,
        worktree.worktreePath,
        decodeURIComponent(req.params.name),
      );
      res.json(logs);
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/background-commands/:name/logs/stream", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

      if (!worktree) {
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      const commandName = decodeURIComponent(req.params.name);
      const command = getBackgroundCommandEntries(config)[commandName];
      if (!command) {
        res.status(404).json({ message: `Unknown background command ${commandName}` });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (payload: BackgroundCommandLogStreamEvent) => {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      };

      const history = await getBackgroundCommandLogs(config, worktree.branch, worktree.worktreePath, commandName);
      writeEvent({ type: "snapshot", commandName: history.commandName, lines: history.lines });

      const dispose = await streamBackgroundCommandLogs({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        commandName,
        onEvent: (event) => writeEvent(event),
        onError: (message) => writeEvent({
          type: "append",
          commandName,
          lines: [{
            id: `stream-error:${Date.now()}`,
            source: "stderr",
            text: message,
            timestamp: new Date().toISOString(),
          }],
        }),
      });

      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(keepAlive);
        dispose();
        res.end();
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
