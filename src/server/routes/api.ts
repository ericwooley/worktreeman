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
  RunAiCommandRequest,
  RunAiCommandResponse,
  UpdateProjectManagementDependenciesRequest,
  UpdateProjectManagementStatusRequest,
  TmuxClientInfo,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementDocumentRequest,
  WorktreeManagerConfig,
  WorktreeRecord,
  WorktreeRuntime,
} from "../../shared/types.js";
import { DEFAULT_PROJECT_MANAGEMENT_BRANCH } from "../../shared/constants.js";
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
import { loadConfig, parseConfigContents, readConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import type { ShutdownStatus } from "../../shared/types.js";
import { failAiCommandJob, getAiCommandJob, startAiCommandJob, waitForAiCommandJob } from "../services/ai-command-service.js";
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
import { disconnectTmuxClient, ensureRuntimeTerminalSession, ensureTerminalSession, getTmuxSessionName, killTmuxSession, killTmuxSessionByName, listTmuxClients } from "../services/terminal-service.js";
import {
  addProjectManagementComment,
  appendProjectManagementBatch,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
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
import type { OperationalStateStore } from "../services/operational-state-service.js";
import { sanitizeBranchName } from "../utils/paths.js";
import { runCommand } from "../utils/process.js";

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
      worktreePath: string;
      env: NodeJS.ProcessEnv;
      outFile: string;
      errFile: string;
    }) => Promise<AiCommandProcessDescription>;
    getProcess: (processName: string) => Promise<AiCommandProcessDescription | null>;
    deleteProcess: (processName: string) => Promise<void>;
    readProcessLogs: (processInfo: AiCommandProcessDescription | null) => Promise<{ stdout: string; stderr: string }>;
    isProcessActive: (status: string | undefined) => boolean;
  };
  onEnqueueProjectManagementAiJob?: (payload: {
    branch: string;
    documentId: string;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: Record<string, string>;
  }, context: {
    notifyStarted: (job: AiCommandJob) => void;
  }) => Promise<void>;
}

interface RunProjectManagementDocumentAiRequest {
  input?: unknown;
  commandId?: unknown;
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
  const logsDir = resolveAiLogsDir(options.repoRoot);
  await fs.mkdir(logsDir, { recursive: true });

  const logPath = path.join(logsDir, options.fileName);

  const payload = {
    jobId: options.jobId,
    timestamp: options.startedAt ?? new Date().toISOString(),
    startedAt: options.startedAt ?? new Date().toISOString(),
    completedAt: options.completedAt ?? null,
    branch: options.branch,
    documentId: options.documentId ?? null,
    commandId: options.commandId,
    origin: options.origin ?? null,
    worktreePath: options.worktreePath,
    command: options.renderedCommand,
    pid: options.pid ?? null,
    exitCode: options.exitCode ?? null,
    processName: options.processName ?? null,
    request: options.input,
    response: {
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
      events: normalizeAiCommandOutputEvents(options.events),
    },
    error: options.error instanceof Error
      ? {
        name: options.error.name,
        message: options.error.message,
        stack: options.error.stack,
      }
      : options.error
        ? String(options.error)
        : null,
  };

  const tempLogPath = `${logPath}.${randomUUID()}.tmp`;
  await fs.writeFile(tempLogPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  await fs.rename(tempLogPath, logPath);
  return logPath;
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
    console.error(`[ai-command] failed to write log repoRoot=${options.repoRoot} branch=${options.branch}`, logError);
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

function createAiCommandOutputEvent(source: "stdout" | "stderr", text: string, timestamp = new Date().toISOString()): AiCommandOutputEvent {
  return {
    id: randomUUID(),
    source,
    text,
    timestamp,
  };
}

function normalizeAiCommandOutputEvents(value: unknown): AiCommandOutputEvent[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object") {
      return [];
    }

    const candidate = entry as { id?: unknown; source?: unknown; text?: unknown; timestamp?: unknown };
    if ((candidate.source !== "stdout" && candidate.source !== "stderr") || typeof candidate.text !== "string") {
      return [];
    }

    return [{
      id: typeof candidate.id === "string" && candidate.id ? candidate.id : randomUUID(),
      source: candidate.source,
      text: candidate.text,
      timestamp: typeof candidate.timestamp === "string" && candidate.timestamp ? candidate.timestamp : new Date().toISOString(),
    }];
  });
}

function appendAiCommandOutputEvents(events: AiCommandOutputEvent[] | undefined, source: "stdout" | "stderr", chunk: string): AiCommandOutputEvent[] {
  if (!chunk) {
    return events ? [...events] : [];
  }

  return [...(events ?? []), createAiCommandOutputEvent(source, chunk)];
}

function ensureAiCommandOutputEvents(options: {
  events: unknown;
  stdout: string;
  stderr: string;
  timestamp: string;
  completedAt?: string;
}): AiCommandOutputEvent[] {
  const normalized = normalizeAiCommandOutputEvents(options.events);
  if (normalized.length > 0) {
    return normalized;
  }

  const fallback: AiCommandOutputEvent[] = [];
  const baseTimestamp = options.timestamp || new Date().toISOString();
  if (options.stdout) {
    fallback.push(createAiCommandOutputEvent("stdout", options.stdout, baseTimestamp));
  }

  if (options.stderr) {
    fallback.push(createAiCommandOutputEvent("stderr", options.stderr, options.completedAt ?? baseTimestamp));
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

function createProjectManagementDocumentWorktreeBranch(document: ProjectManagementDocumentResponse["document"]) {
  const branch = sanitizeBranchName(`pm-${document.id}-${document.title}`).slice(0, 72);
  return branch || `pm-${sanitizeBranchName(document.id) || "document"}`;
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

function buildWorktreeAiComment(details: {
  branch: string;
  commandId: AiCommandId;
  requestSummary?: string | null;
  stdout: string;
  stderr: string;
}) {
  const lines = [
    `AI worktree run completed for \`${details.branch}\`.`,
    "",
    `- Command: ${details.commandId}`,
  ];

  if (details.requestSummary?.trim()) {
    lines.push(`- Request: ${formatLogSnippet(details.requestSummary, 280)}`);
  }

  const stdoutSnippet = formatLogSnippet(details.stdout, 280);
  if (stdoutSnippet) {
    lines.push(`- Stdout: ${stdoutSnippet}`);
  }

  const stderrSnippet = formatLogSnippet(details.stderr, 280);
  if (stderrSnippet) {
    lines.push(`- Stderr: ${stderrSnippet}`);
  }

  return lines.join("\n");
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
  const template = resolveAiCommandTemplate(options.config.aiCommands, "simple");
  if (!template || !template.includes("$WTM_AI_INPUT")) {
    return null;
  }

  const input = buildProjectManagementSummaryPrompt({
    branch: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
    document: options.document,
    relatedDocuments: options.relatedDocuments,
  });
  const renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));

  try {
    const { stdout } = await runCommand("bash", ["-lc", renderedCommand], {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        ...options.config.env,
        WORKTREE_BRANCH: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        WORKTREE_PATH: options.repoRoot,
      },
    });
    const summary = stdout.trim();
    return summary || null;
  } catch (error) {
    console.error(`[project-management-summary] failed document=${options.document.id}`, error);
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

async function listAiCommandLogEntries(repoRoot: string): Promise<AiCommandLogEntry[]> {
  const logsDir = resolveAiLogsDir(repoRoot);
  let fileNames: string[] = [];

  try {
    fileNames = await fs.readdir(logsDir);
  } catch (error) {
    const code = error instanceof Error && "code" in error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const entries = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .map(async (fileName) => {
        const payload = await fs.readFile(path.join(logsDir, fileName), "utf8");
        return parseAiCommandLogEntry(fileName, payload);
      }),
  );

  return entries.sort((left, right) => {
    const timestampCompare = Date.parse(right.timestamp) - Date.parse(left.timestamp);
    if (timestampCompare !== 0) {
      return timestampCompare;
    }

    return right.fileName.localeCompare(left.fileName);
  });
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
    error: entry.error?.message ?? null,
  };
}

async function readAiCommandLogEntry(repoRoot: string, fileName: string): Promise<AiCommandLogEntry> {
  const logPath = path.join(resolveAiLogsDir(repoRoot), fileName);
  const payload = await fs.readFile(logPath, "utf8");
  return parseAiCommandLogEntry(fileName, payload);
}

async function reconcileAiCommandLogEntry(options: {
  entry: AiCommandLogEntry;
  repoRoot: string;
  aiProcesses: NonNullable<ApiRouterOptions["aiProcesses"]>;
}): Promise<AiCommandLogEntry> {
  if (options.entry.status !== "running") {
    return options.entry;
  }

  if (!options.entry.processName) {
    const completedAt = new Date().toISOString();
    await safeWriteAiRequestLog({
      fileName: options.entry.fileName,
      jobId: options.entry.jobId,
      repoRoot: options.repoRoot,
      branch: options.entry.branch,
      documentId: options.entry.documentId ?? null,
      commandId: options.entry.commandId,
      origin: options.entry.origin ?? null,
      worktreePath: options.entry.worktreePath,
      renderedCommand: options.entry.command,
      input: options.entry.request,
      stdout: options.entry.response.stdout,
      stderr: options.entry.response.stderr,
      events: options.entry.response.events,
      startedAt: options.entry.timestamp,
      completedAt,
      pid: options.entry.pid,
      exitCode: options.entry.exitCode ?? null,
      processName: options.entry.processName ?? null,
      error: options.entry.error ?? new Error("AI process metadata was missing while the log was still marked running."),
    });
    return readAiCommandLogEntry(options.repoRoot, options.entry.fileName);
  }

  const processInfo = await options.aiProcesses.getProcess(options.entry.processName);
  if (processInfo && options.aiProcesses.isProcessActive(processInfo.status)) {
    const logs = await options.aiProcesses.readProcessLogs(processInfo);
    const nextPid = processInfo.pid ?? options.entry.pid ?? null;
    const nextEvents = appendAiCommandOutputEvents(
      appendAiCommandOutputEvents(
        options.entry.response.events,
        "stdout",
        logs.stdout.startsWith(options.entry.response.stdout)
          ? logs.stdout.slice(options.entry.response.stdout.length)
          : logs.stdout !== options.entry.response.stdout
            ? logs.stdout.slice(Math.min(options.entry.response.stdout.length, logs.stdout.length))
            : "",
      ),
      "stderr",
      logs.stderr.startsWith(options.entry.response.stderr)
        ? logs.stderr.slice(options.entry.response.stderr.length)
        : logs.stderr !== options.entry.response.stderr
          ? logs.stderr.slice(Math.min(options.entry.response.stderr.length, logs.stderr.length))
          : "",
    );
    const hasChanged = logs.stdout !== options.entry.response.stdout
      || logs.stderr !== options.entry.response.stderr
      || nextPid !== (options.entry.pid ?? null);

    if (!hasChanged) {
      return options.entry;
    }

    await safeWriteAiRequestLog({
      fileName: options.entry.fileName,
      jobId: options.entry.jobId,
      repoRoot: options.repoRoot,
      branch: options.entry.branch,
      documentId: options.entry.documentId ?? null,
      commandId: options.entry.commandId,
      origin: options.entry.origin ?? null,
      worktreePath: options.entry.worktreePath,
      renderedCommand: options.entry.command,
      input: options.entry.request,
      stdout: logs.stdout,
      stderr: logs.stderr,
      events: nextEvents,
      startedAt: options.entry.timestamp,
      completedAt: undefined,
      pid: nextPid,
      exitCode: options.entry.exitCode ?? null,
      processName: options.entry.processName,
      error: options.entry.error,
    });

    return readAiCommandLogEntry(options.repoRoot, options.entry.fileName);
  }

  const logs = await options.aiProcesses.readProcessLogs(processInfo);
  const completedAt = new Date().toISOString();
  const resolvedExitCode = processInfo?.exitCode ?? options.entry.exitCode ?? null;
  const error = resolvedExitCode === 0
    ? null
    : options.entry.error ?? new Error(processInfo
      ? `AI process exited with code ${resolvedExitCode ?? "unknown"}.`
      : "AI process was no longer available. The server may have restarted or the process may have crashed.");

  await safeWriteAiRequestLog({
    fileName: options.entry.fileName,
    jobId: options.entry.jobId,
    repoRoot: options.repoRoot,
    branch: options.entry.branch,
    documentId: options.entry.documentId ?? null,
    commandId: options.entry.commandId,
    origin: options.entry.origin ?? null,
    worktreePath: options.entry.worktreePath,
    renderedCommand: options.entry.command,
    input: options.entry.request,
    stdout: logs.stdout || options.entry.response.stdout,
    stderr: logs.stderr || options.entry.response.stderr,
    events: appendAiCommandOutputEvents(
      appendAiCommandOutputEvents(
        options.entry.response.events,
        "stdout",
        (logs.stdout || options.entry.response.stdout).startsWith(options.entry.response.stdout)
          ? (logs.stdout || options.entry.response.stdout).slice(options.entry.response.stdout.length)
          : (logs.stdout || options.entry.response.stdout) !== options.entry.response.stdout
            ? (logs.stdout || options.entry.response.stdout).slice(Math.min(options.entry.response.stdout.length, (logs.stdout || options.entry.response.stdout).length))
            : "",
      ),
      "stderr",
      (logs.stderr || options.entry.response.stderr).startsWith(options.entry.response.stderr)
        ? (logs.stderr || options.entry.response.stderr).slice(options.entry.response.stderr.length)
        : (logs.stderr || options.entry.response.stderr) !== options.entry.response.stderr
          ? (logs.stderr || options.entry.response.stderr).slice(Math.min(options.entry.response.stderr.length, (logs.stderr || options.entry.response.stderr).length))
          : "",
    ),
    startedAt: options.entry.timestamp,
    completedAt,
    pid: processInfo?.pid ?? options.entry.pid ?? null,
    exitCode: resolvedExitCode,
    processName: options.entry.processName,
    error,
  });

  return readAiCommandLogEntry(options.repoRoot, options.entry.fileName);
}

export function createApiRouter(options: ApiRouterOptions): express.Router {
  const router = express.Router();
  const aiProcesses = options.aiProcesses ?? {
    startProcess: startAiCommandProcess,
    getProcess: getAiCommandProcess,
    deleteProcess: deleteAiCommandProcess,
    readProcessLogs: readAiCommandProcessLogs,
    isProcessActive: isAiCommandProcessActive,
  };
  const aiProcessPollIntervalMs = options.aiProcessPollIntervalMs ?? 250;
  const aiLogStreamPollIntervalMs = options.aiLogStreamPollIntervalMs ?? 500;

  const loadCurrentConfig = () => loadConfig({
    path: options.configPath,
    repoRoot: options.repoRoot,
    gitFile: options.configFile,
  });

  const ensureWorktreeRuntime = async (
    config: WorktreeManagerConfig,
    worktree: WorktreeRecord,
  ): Promise<WorktreeRuntime> => {
    const existingRuntime = await options.operationalState.getRuntime(worktree.branch);
    if (existingRuntime) {
      return existingRuntime;
    }

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
    return runtime;
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
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
    applyDocumentUpdateToDocumentId?: string | null;
    commentDocumentId?: string | null;
    commentRequestSummary?: string | null;
  }) => startAiCommandJob({
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
      const logsDir = resolveAiLogsDir(options.repoRoot);
      const outFile = path.join(logsDir, `${payload.jobId}.stdout.log`);
      const errFile = path.join(logsDir, `${payload.jobId}.stderr.log`);
      const processInfo = await aiProcesses.startProcess({
        processName,
        command: details.renderedCommand,
        worktreePath: details.worktreePath,
        env: details.env,
        outFile,
        errFile,
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
    writeLog: safeWriteAiRequestLog,
    onComplete: details.applyDocumentUpdateToDocumentId || details.commentDocumentId
      ? async ({ stdout, stderr }) => {
        if (details.applyDocumentUpdateToDocumentId) {
          const nextMarkdown = stdout.trim();
          if (!nextMarkdown) {
            throw new Error("AI command finished without returning updated markdown.");
          }

          const currentDocument = await getProjectManagementDocument(options.repoRoot, details.applyDocumentUpdateToDocumentId);
          await updateProjectManagementDocument(options.repoRoot, details.applyDocumentUpdateToDocumentId, {
            title: currentDocument.document.title,
            summary: currentDocument.document.summary,
            markdown: nextMarkdown,
            tags: currentDocument.document.tags,
            dependencies: currentDocument.document.dependencies,
            status: currentDocument.document.status,
            assignee: currentDocument.document.assignee,
            archived: currentDocument.document.archived,
          });
        }

        if (details.commentDocumentId) {
          try {
            await addProjectManagementComment(options.repoRoot, details.commentDocumentId, {
              body: buildWorktreeAiComment({
                branch: details.branch,
                commandId: details.commandId,
                requestSummary: details.commentRequestSummary,
                stdout,
                stderr,
              }),
            });
          } catch (error) {
            console.error(`[project-management-comment] failed branch=${details.branch} document=${details.commentDocumentId}`, error);
          }
        }
      }
      : undefined,
  });

  const enqueueProjectManagementDocumentAiJob = async (details: {
    branch: string;
    documentId: string;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
  }) => enqueueProjectManagementAiJob({
    repoRoot: options.repoRoot,
    payload: {
      branch: details.branch,
      commandId: details.commandId,
      origin: details.origin ?? null,
      worktreePath: details.worktreePath,
      input: details.input,
      renderedCommand: details.renderedCommand,
      env: Object.fromEntries(Object.entries(details.env).filter(([, value]) => typeof value === "string")) as Record<string, string>,
      documentId: details.documentId,
    },
    onProcessProjectManagementAiJob: options.onEnqueueProjectManagementAiJob
      ? async (payload, context) => options.onEnqueueProjectManagementAiJob?.(payload, {
        notifyStarted: context.notifyStarted,
      })
      : async (payload, context) => {
      const startedJob = await startAiProcessJob({
        branch: payload.branch,
        documentId: payload.documentId,
        commandId: payload.commandId,
        origin: payload.origin ?? null,
        input: payload.input,
        renderedCommand: payload.renderedCommand,
        worktreePath: payload.worktreePath,
        env: payload.env,
        applyDocumentUpdateToDocumentId: payload.documentId,
      });
      context.notifyStarted(startedJob);
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
      deletion: await getWorktreeDeletionState(options.repoRoot, worktree),
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
        void loadState()
          .then((nextState) => {
            currentState = nextState;
            const nextPayload = JSON.stringify(nextState);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", nextState);
            }
          })
          .finally(() => {
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
        void options.operationalState.getShutdownStatus()
          .then((nextStatus) => {
            currentStatus = nextStatus;
            const nextPayload = JSON.stringify(nextStatus);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeStatus(nextStatus);
            }
          })
          .finally(() => {
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

  router.get("/worktrees/:branch/ai-command/stream", async (req, res, next) => {
    try {
      const branch = req.params.branch;
      let currentJob = await getAiCommandJob(options.repoRoot, branch);
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
        void getAiCommandJob(options.repoRoot, branch)
          .then((nextJob) => {
            currentJob = nextJob;
            const nextPayload = JSON.stringify(nextJob);
            if (nextPayload !== lastPayload) {
              lastPayload = nextPayload;
              writeEvent("update", nextJob);
            }
          })
          .finally(() => {
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
        logs: entries.map(toAiCommandLogSummary),
        runningJobs: entries.filter((entry) => entry.status === "running").map(toRunningAiCommandJob),
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

      let polling = false;
      const poll = async () => {
        if (polling) {
          return;
        }

        polling = true;
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
            writeEvent("update", null);
          }
        } finally {
          polling = false;
        }
      };

      const interval = setInterval(() => {
        void poll();
      }, aiLogStreamPollIntervalMs);
      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, 15000);

      req.on("close", () => {
        clearInterval(interval);
        clearInterval(keepAlive);
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
          const { stdout, stderr } = await runCommand(process.env.SHELL || "/usr/bin/bash", ["-lc", renderedCommand], {
            cwd: worktree.worktreePath,
            env,
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

    try {
      const config = await loadCurrentConfig();
      const documentId = decodeURIComponent(req.params.id).trim();
      const body = req.body as RunProjectManagementDocumentAiRequest | undefined;
      const requestedChange = typeof body?.input === "string" ? body.input : null;
      const documentPayload = await getProjectManagementDocument(options.repoRoot, documentId);
      const documentsPayload = await listProjectManagementDocuments(options.repoRoot);

      branch = createProjectManagementDocumentWorktreeBranch(documentPayload.document);
      commandId = resolveRequestedAiCommandId(body?.commandId, { documentId });
      origin = createProjectManagementDocumentOrigin({
        branch,
        document: documentPayload.document,
        kind: "project-management-document-run",
        label: "Project management document run",
        viewMode: "document",
      });

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
      if ((await getAiCommandJob(options.repoRoot, branch))?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${branch}.` });
        return;
      }

      const runtime = await ensureWorktreeRuntime(config, worktree);
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
      });
      const env = buildRuntimeProcessEnv(runtime);

      const renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));
      const job = await startAiProcessJob({
        branch,
        documentId,
        commandId,
        origin,
        input,
        renderedCommand,
        worktreePath,
        env,
        commentDocumentId: documentId,
        commentRequestSummary: requestedChange,
      });

      const payload: RunAiCommandResponse = { job, runtime };
      res.json(payload);
    } catch (error) {
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

      console.error(`[project-management-ai] failed document=${req.params.id}`, error);
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
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);

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

    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
      const body = req.body as RunAiCommandRequest;
      input = typeof body?.input === "string" ? body.input : "";
      const explicitDocumentId = typeof body?.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : null;
      const linkedDocumentId = explicitDocumentId
        ? null
        : (await getWorktreeDocumentLink(options.repoRoot, req.params.branch))?.documentId ?? null;
      const documentId = explicitDocumentId ?? linkedDocumentId;
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
      origin = createWorktreeEnvironmentOrigin(worktree.branch);

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

      const runtime = await options.operationalState.getRuntime(worktree.branch);
      const backgroundCommands = await listBackgroundCommands(config, worktree.branch, worktreePath, runtime ?? undefined);
      const environmentContext = buildAiEnvironmentContext({
        repoRoot: options.repoRoot,
        config,
        branch: worktree.branch,
        worktreePath,
        runtime: runtime ?? undefined,
        backgroundCommands,
      });

      if (explicitDocumentId) {
        try {
          const documentPayload = await getProjectManagementDocument(options.repoRoot, explicitDocumentId);
          const documentsPayload = await listProjectManagementDocuments(options.repoRoot);
          origin = createProjectManagementDocumentOrigin({
            branch: worktree.branch,
            document: documentPayload.document,
            kind: "project-management-document",
            label: "Project management document",
            viewMode: "edit",
          });
          input = buildProjectManagementAiPrompt({
            branch: worktree.branch,
            worktreePath,
            requestedChange: input.trim(),
            environmentContext,
            document: documentPayload.document,
            relatedDocuments: documentsPayload.documents,
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

      if ((await getAiCommandJob(options.repoRoot, worktree.branch))?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${worktree.branch}.` });
        return;
      }

      console.info(
        `[ai-command] starting branch=${worktree.branch} path=${worktree.worktreePath} input=${JSON.stringify(formatLogSnippet(input))}`,
      );

      if (!explicitDocumentId) {
        input = buildWorktreeAiPrompt({
          request: input,
          environmentContext,
        });
      }

      const env = runtime
        ? buildRuntimeProcessEnv(runtime)
        : {
          ...process.env,
          ...config.env,
          WORKTREE_BRANCH: worktree.branch,
          WORKTREE_PATH: worktree.worktreePath,
        };

      renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));
      const runDetails = {
        branch: worktree.branch,
        documentId,
        commandId,
        origin,
        input,
        renderedCommand,
        worktreePath,
        env,
        applyDocumentUpdateToDocumentId: explicitDocumentId,
        commentDocumentId: explicitDocumentId ? null : linkedDocumentId,
        commentRequestSummary: explicitDocumentId ? null : body.input,
      };
      const job = explicitDocumentId
        ? await enqueueProjectManagementDocumentAiJob({
          branch: runDetails.branch,
          documentId: explicitDocumentId,
          commandId: runDetails.commandId,
          origin: runDetails.origin,
          input: runDetails.input,
          renderedCommand: runDetails.renderedCommand,
          worktreePath: runDetails.worktreePath,
          env: runDetails.env,
        })
        : await startAiProcessJob(runDetails);

      const payload: RunAiCommandResponse = { job };
      res.json(payload);
    } catch (error) {
      console.error(`[ai-command] failed branch=${req.params.branch}`, error);
      next(error);
    }
  });

  router.post("/worktrees/:branch/ai-command/cancel", async (req, res, next) => {
    try {
      const inMemoryJob = await getAiCommandJob(options.repoRoot, req.params.branch);
      const persistedLog = (await Promise.all(
        (await listAiCommandLogEntries(options.repoRoot)).map((entry) => reconcileAiCommandLogEntry({
          entry,
          repoRoot: options.repoRoot,
          aiProcesses,
        })),
      )).find((entry) => entry.branch === req.params.branch && entry.status === "running") ?? null;

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
          outputEvents: appendAiCommandOutputEvents(job.outputEvents, "stderr", cancellationMessage),
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
          events: appendAiCommandOutputEvents(persistedLog.response.events, "stderr", cancellationMessage),
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
            void (async () => {
              try {
                const nextInMemoryJob = await getAiCommandJob(options.repoRoot, req.params.branch);
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
            })();
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
            : appendAiCommandOutputEvents(resolvedLog.response.events, "stderr", cancellationMessage),
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
      const runtime = await options.operationalState.getRuntime(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await stopAllBackgroundCommands(req.params.branch, runtime.worktreePath);
      await killTmuxSession(runtime);
      await options.operationalState.deleteRuntime(req.params.branch);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const runtime = await options.operationalState.getRuntime(req.params.branch);
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
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
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
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
      const deletion = await getWorktreeDeletionState(options.repoRoot, worktree);
      try {
        validateDeleteWorktreeRequest(worktree, deletion, request);
      } catch (error) {
        res.status(400).json({
          message: error instanceof Error ? error.message : "Invalid delete request.",
        });
        return;
      }

      const runtime = await options.operationalState.getRuntime(worktree.branch);
      if (runtime) {
        await stopAllBackgroundCommands(worktree.branch, runtime.worktreePath);
        await killTmuxSession(runtime);
        await options.operationalState.deleteRuntime(worktree.branch);
      } else {
        await killTmuxSessionByName(getTmuxSessionName(options.repoRoot, worktree.branch), worktree.worktreePath);
      }

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
