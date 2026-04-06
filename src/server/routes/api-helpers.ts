import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandOrigin,
  AiCommandOutputEvent,
  BackgroundCommandState,
  ProjectManagementDocumentResponse,
  ProjectManagementListResponse,
  WorktreeManagerConfig,
  WorktreeRuntime,
} from "../../shared/types.js";
import {
  DEFAULT_PROJECT_MANAGEMENT_BRANCH,
  LOGS_DIR,
} from "../../shared/constants.js";
import {
  parseAiCommandOrigin,
  resolveAiCommandTemplate,
  toAiCommandLogError,
} from "../../shared/ai-command-utils.js";
import {
  createProjectManagementDocumentWorktreeBranch,
  createProjectManagementDocumentWorktreeBranchCandidate,
  normalizeProjectManagementDocumentWorktreeName,
} from "../../shared/project-management-worktree.js";
import { quoteShellArg } from "../../shared/shell-utils.js";
import { worktreeId as createWorktreeId, type WorktreeId } from "../../shared/worktree-id.js";
import { getAiCommandJob } from "../services/ai-command-service.js";
import { listWorktrees } from "../services/git-service.js";
import { sanitizeBranchName } from "../utils/paths.js";
import { createOperationalStateStore } from "../services/operational-state-service.js";
import { runCommand } from "../utils/process.js";
import {
  formatDurationMs,
  logServerEvent,
} from "../utils/server-logger.js";
import type { ApiAiProcesses } from "./api-types.js";

export function createAiLogIdentifiers(worktreeId: WorktreeId, date = new Date()) {
  return {
    jobId: randomUUID(),
    fileName: createAiLogFileName(worktreeId, date),
    startedAt: date.toISOString(),
  };
}

export function formatLogSnippet(value: string, maxLength = 240): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function createAiLogTimestamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

function createAiLogFileName(worktreeId: WorktreeId, date = new Date()): string {
  return `${createAiLogTimestamp(date)}-${worktreeId}-ai-request.json`;
}

export function runBackgroundTask(task: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
  return task().catch(onError);
}

export function resolveAiLogsDir(repoRoot: string): string {
  return path.resolve(repoRoot, LOGS_DIR);
}

export function resolveAiLogWorktreeId(options: {
  worktreeId?: WorktreeId;
  worktreePath: string;
}): WorktreeId {
  return options.worktreeId ?? createWorktreeId(options.worktreePath);
}

async function writeAiRequestLog(options: {
  fileName: string;
  jobId: string;
  repoRoot: string;
  worktreeId?: WorktreeId;
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
  const worktreeId = resolveAiLogWorktreeId(options);
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
    worktreeId,
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
  await store.syncAiCommandOutputEvents(entry.jobId, entry.fileName, entry.worktreeId, entry.branch, entry.response.events);
  return options.fileName;
}

export async function safeWriteAiRequestLog(options: {
  fileName: string;
  jobId: string;
  repoRoot: string;
  worktreeId?: WorktreeId;
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
      worktreeId: options.worktreeId,
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

export function appendAiCommandOutputEvents(
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

export function parseAiCommandId(value: unknown): AiCommandId {
  return value === "simple" ? "simple" : "smart";
}

export function resolveRequestedAiCommandId(value: unknown, _options?: { documentId?: string | null }): AiCommandId {
  if (value === "smart" || value === "simple") {
    return value;
  }

  return "smart";
}

function formatPromptList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function formatNamedEntries(entries: Array<[string, string | number]>): string {
  return entries.length > 0
    ? entries.map(([key, value]) => `${key}=${value}`).join(", ")
    : "none";
}

export function buildAiEnvironmentContext(options: {
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

export function buildWorktreeAiPrompt(options: {
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

export function buildProjectManagementAiPrompt(options: {
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
  try {
    await runCommand("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot, env: process.env });
    return true;
  } catch {
    return false;
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveProjectManagementDocumentWorktreeBranch(options: {
  repoRoot: string;
  baseDir: string;
  document: ProjectManagementDocumentResponse["document"];
  preferredName?: string | null;
}): Promise<string> {
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

export function buildProjectManagementExecutionAiPrompt(options: {
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
    "Current markdown:",
    options.document.markdown,
  ].filter(Boolean).join("\n");
}

export function createWorktreeEnvironmentOrigin(branch: string, worktreeId?: WorktreeId): AiCommandOrigin {
  return {
    kind: "worktree-environment",
    label: "Worktree environment",
    description: `Started from ${branch}.`,
    location: {
      tab: "environment",
      branch,
      worktreeId: worktreeId ?? null,
      environmentSubTab: "terminal",
    },
  };
}

export function createProjectManagementDocumentOrigin(options: {
  branch: string;
  worktreeId?: WorktreeId;
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
      worktreeId: options.worktreeId,
      branch: options.branch,
      documentId: options.document.id,
      projectManagementSubTab: "document",
      projectManagementDocumentViewMode: options.viewMode,
    },
  };
}

export function createGitConflictResolutionOrigin(options: {
  branch: string;
  worktreeId?: WorktreeId;
  baseBranch: string;
}): AiCommandOrigin {
  return {
    kind: "git-conflict-resolution",
    label: "Git conflict resolution",
    description: `Resolve conflicts while merging ${options.baseBranch} into ${options.branch}.`,
    location: {
      tab: "git",
      branch: options.branch,
      worktreeId: options.worktreeId,
      gitBaseBranch: options.baseBranch,
    },
  };
}

export function createGitPullRequestReviewOrigin(options: {
  branch: string;
  worktreeId?: WorktreeId;
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
      worktreeId: options.worktreeId,
      gitBaseBranch: options.baseBranch,
      documentId: options.documentId ?? null,
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
    "Current markdown:",
    options.document.markdown,
  ].join("\n");
}

export async function generateProjectManagementDocumentSummary(options: {
  repoRoot: string;
  config: WorktreeManagerConfig;
  document: ProjectManagementDocumentResponse["document"];
  relatedDocuments: ProjectManagementListResponse["documents"];
}): Promise<string | null> {
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
  const renderedCommand = template.split("$WTM_AI_INPUT").join(quoteShellArg(input));

  try {
    const { stdout } = await runCommand("bash", ["-lc", renderedCommand], {
      cwd: options.repoRoot,
      env: {
        ...process.env,
        ...options.config.env,
        WTM_AI_INPUT: input,
        WORKTREE_BRANCH: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
        WORKTREE_PATH: options.repoRoot,
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
  const worktreePath = typeof parsed.worktreePath === "string" ? parsed.worktreePath : "";
  const worktreeId = resolveAiLogWorktreeId({ worktreePath });

  return {
    jobId: typeof parsed.jobId === "string" ? parsed.jobId : fileName,
    fileName,
    timestamp,
    worktreeId,
    branch: typeof parsed.branch === "string" ? parsed.branch : "",
    documentId: typeof parsed.documentId === "string" ? parsed.documentId : null,
    commandId: parseAiCommandId(parsed.commandId),
    origin: parseAiCommandOrigin(parsed.origin),
    worktreePath,
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
  const historicalStatus = isAiCommandLogFinalizing(entry) && entry.documentId ? "completed" : entry.status;
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    timestamp: entry.timestamp,
    worktreeId: entry.worktreeId,
    branch: entry.branch,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
    worktreePath: entry.worktreePath,
    command: entry.command,
    requestPreview: toAiCommandLogPreview(entry.request),
    status: historicalStatus,
    pid: entry.pid ?? null,
    origin: entry.origin ?? null,
  };
}

function isAiCommandLogFinalizing(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && typeof entry.completedAt === "string";
}

export function isAiCommandLogActivelyRunning(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && !isAiCommandLogFinalizing(entry);
}

export function toHistoricalAiCommandLogSummaries(entries: AiCommandLogEntry[]): AiCommandLogSummary[] {
  return entries.filter((entry) => entry.status !== "running" || isAiCommandLogFinalizing(entry)).map(toAiCommandLogSummary);
}

export async function listAiCommandLogEntries(repoRoot: string): Promise<AiCommandLogEntry[]> {
  return (await createOperationalStateStore(repoRoot)).listAiCommandLogEntries();
}

export function toRunningAiCommandJob(entry: AiCommandLogEntry): AiCommandJob {
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    worktreeId: entry.worktreeId,
    branch: entry.branch,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
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
    origin: entry.origin ?? null,
  };
}

function hasObservedAiCommandLogProcess(entry: AiCommandLogEntry): boolean {
  return entry.pid != null
    || entry.exitCode != null
    || entry.response.stdout.length > 0
    || entry.response.stderr.length > 0
    || (entry.response.events?.length ?? 0) > 0;
}

function hasObservedAiCommandJobProcess(job: AiCommandJob): boolean {
  return job.pid != null
    || job.exitCode != null
    || typeof job.completedAt === "string"
    || job.stdout.length > 0
    || job.stderr.length > 0
    || (job.outputEvents?.length ?? 0) > 0;
}

function mergeAiCommandLogEntryWithJob(entry: AiCommandLogEntry, job: AiCommandJob): AiCommandLogEntry {
  return {
    ...entry,
    documentId: job.documentId ?? entry.documentId ?? null,
    origin: job.origin ?? entry.origin ?? null,
    worktreePath: job.worktreePath ?? entry.worktreePath,
    response: {
      stdout: job.stdout,
      stderr: job.stderr,
      events: job.outputEvents?.map((event) => ({ ...event })) ?? [],
    },
    status: job.status,
    pid: job.pid ?? null,
    exitCode: job.exitCode ?? null,
    processName: job.processName ?? null,
    completedAt: job.completedAt,
    error: job.error ? { message: job.error } : null,
  };
}

function shouldPreferAiCommandJobState(entry: AiCommandLogEntry, job: AiCommandJob): boolean {
  return entry.status !== job.status
    || entry.completedAt !== job.completedAt
    || entry.pid !== (job.pid ?? null)
    || entry.exitCode !== (job.exitCode ?? null)
    || entry.response.stdout !== job.stdout
    || entry.response.stderr !== job.stderr
    || (entry.response.events?.length ?? 0) !== (job.outputEvents?.length ?? 0)
    || (entry.error?.message ?? null) !== (job.error ?? null)
    || (entry.documentId ?? null) !== (job.documentId ?? null);
}

export async function readAiCommandLogEntryByJobId(repoRoot: string, jobId: string): Promise<AiCommandLogEntry> {
  const entry = await (await createOperationalStateStore(repoRoot)).getAiCommandLogEntryByJobId(jobId);
  if (!entry) {
    const error = new Error(`Unknown AI log ${jobId}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  return entry;
}

export async function readAiCommandLogEntryByIdentifier(repoRoot: string, identifier: string): Promise<AiCommandLogEntry> {
  const store = await createOperationalStateStore(repoRoot);
  const byJobId = await store.getAiCommandLogEntryByJobId(identifier);
  if (byJobId) {
    return byJobId;
  }

  const byFileName = await store.getAiCommandLogEntryByFileName(identifier);
  if (byFileName) {
    return byFileName;
  }

  const error = new Error(`Unknown AI log ${identifier}`) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  throw error;
}

export function renderAiCommand(template: string, input: string): string {
  return template.split("$WTM_AI_INPUT").join(quoteShellArg(input));
}

export async function reconcileAiCommandLogEntry(options: {
  entry: AiCommandLogEntry;
  repoRoot: string;
  aiProcesses: ApiAiProcesses;
  reconcileJobs?: boolean;
}): Promise<AiCommandLogEntry> {
  if (options.entry.status !== "running") {
    return options.entry;
  }

  if (!hasObservedAiCommandLogProcess(options.entry)) {
    if (!options.reconcileJobs) {
      return options.entry;
    }

    const store = await createOperationalStateStore(options.repoRoot);
    const currentJob = await store.getAiCommandJobById(options.entry.worktreeId);
    if (!currentJob || currentJob.jobId !== options.entry.jobId) {
      return options.entry;
    }

    if (currentJob.status === "running" && !hasObservedAiCommandJobProcess(currentJob)) {
      return options.entry;
    }

    const reconciledJob = currentJob.status === "running"
      ? await getAiCommandJob(options.repoRoot, options.entry.worktreeId, {
          aiProcesses: {
            getProcess: options.aiProcesses.getProcess,
            readProcessLogs: options.aiProcesses.readProcessLogs,
            isProcessActive: options.aiProcesses.isProcessActive,
          },
          reconcile: true,
        })
      : currentJob;
    const refreshedEntry = await readAiCommandLogEntryByJobId(options.repoRoot, options.entry.jobId).catch(() => null);
    const preferredJob = reconciledJob && reconciledJob.jobId === options.entry.jobId ? reconciledJob : currentJob;
    if (refreshedEntry && !shouldPreferAiCommandJobState(refreshedEntry, preferredJob)) {
      return refreshedEntry;
    }

    return mergeAiCommandLogEntryWithJob(refreshedEntry ?? options.entry, preferredJob);
  }

  if (!options.reconcileJobs) {
    return options.entry;
  }
  const reconciledJob = await getAiCommandJob(options.repoRoot, options.entry.worktreeId, {
    aiProcesses: {
      getProcess: options.aiProcesses.getProcess,
      readProcessLogs: options.aiProcesses.readProcessLogs,
      isProcessActive: options.aiProcesses.isProcessActive,
    },
    reconcile: options.reconcileJobs ?? true,
  });
  const refreshedEntry = await readAiCommandLogEntryByJobId(options.repoRoot, options.entry.jobId);
  if (reconciledJob && reconciledJob.jobId === options.entry.jobId && shouldPreferAiCommandJobState(refreshedEntry, reconciledJob)) {
    return mergeAiCommandLogEntryWithJob(refreshedEntry, reconciledJob);
  }

  return refreshedEntry;
}

export async function resolveHistoricalAiCommandLogEntry(options: {
  entry: AiCommandLogEntry;
  repoRoot: string;
  aiProcesses: ApiAiProcesses;
  reconcileJobs?: boolean;
}): Promise<AiCommandLogEntry> {
  const firstPass = await reconcileAiCommandLogEntry(options);
  if (!options.reconcileJobs || firstPass.status !== "running" || !hasObservedAiCommandLogProcess(firstPass) || !isAiCommandLogActivelyRunning(firstPass)) {
    return firstPass;
  }

  return reconcileAiCommandLogEntry({
    ...options,
    entry: firstPass,
  });
}
