import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AiCommandConfig,
  AiCommandId,
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogsResponse,
  AiCommandLogSummary,
  AiCommandOrigin,
  RunAiCommandRequest,
  AiCommandOutputEvent,
  BackgroundCommandState,
  GitComparisonResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementListResponse,
  ProjectManagementReviewEntry,
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
import type { AiCommandLogIndexEntry } from "../services/operational-state-service.js";
import { getProjectManagementDocumentReview } from "../services/project-management-review-service.js";
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

function createAiSessionId(options: {
  repoRoot: string;
  worktreeId: WorktreeId;
  documentId?: string | null;
}): string {
  const scope = typeof options.documentId === "string" && options.documentId
    ? `document:${options.documentId}`
    : `worktree:${options.worktreeId}`;
  return createHash("sha256").update(`${options.repoRoot}\u0000${scope}`).digest("hex");
}

export function buildAiCommandProcessEnv(options: {
  repoRoot: string;
  worktreePath: string;
  worktreeId?: WorktreeId;
  documentId?: string | null;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const worktreeId = resolveAiLogWorktreeId(options);
  return {
    ...options.env,
    AI_SESSION_ID: createAiSessionId({
      repoRoot: options.repoRoot,
      worktreeId,
      documentId: options.documentId,
    }),
  };
}

export function readAiSessionIdFromEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): string | null {
  const sessionId = env.AI_SESSION_ID;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : null;
}

async function writeAiRequestLog(options: {
  fileName: string;
  jobId: string;
  repoRoot: string;
  worktreeId?: WorktreeId;
  branch: string;
  sessionId?: string | null;
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
    sessionId: options.sessionId ?? null,
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
  sessionId?: string | null;
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

function buildPromptSection(title: string, ...content: Array<string | null | undefined>): string {
  return [title, ...content.filter((value): value is string => Boolean(value && value.trim()))].join("\n");
}

function buildPrompt(options: {
  preamble?: Array<string | null | undefined>;
  sections: Array<string | null | undefined>;
  closing?: Array<string | null | undefined>;
}): string {
  return [
    ...(options.preamble ?? []).filter((value): value is string => Boolean(value && value.trim())),
    ...options.sections.filter((value): value is string => Boolean(value && value.trim())),
    ...(options.closing ?? []).filter((value): value is string => Boolean(value && value.trim())),
  ].join("\n\n");
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
  return buildPrompt({
    sections: [
      options.environmentContext,
      buildPromptSection("Operator request:", options.request),
    ],
  });
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

  return buildPrompt({
    preamble: [
      `You are rewriting the project-management markdown document \"${options.document.title}\" for worktree ${options.branch}.`,
      `Worktree path: ${options.worktreePath}`,
      `Requested change: ${options.requestedChange}`,
      options.environmentContext,
      "Your job is to return a full replacement markdown document, not commentary about the document.",
      "The server will persist your response as the next version of this existing project-management document. Document history is the rollback mechanism.",
      "You are not creating files, not writing a .md file, not returning a patch, and not describing what you would change.",
      "Output format: return the complete updated markdown document wrapped inside <wtm-new-document> and </wtm-new-document>. The response may contain nothing outside those tags. Do not wrap the document in code fences.",
      "Quality bar: produce an execution-ready plan for the selected worktree. Make the document concrete, well-ordered, specific, and directly useful to an engineer or agent doing the work.",
      "Call out assumptions, blockers, dependencies, and sequencing explicitly when they matter. Replace vague guidance with actionable steps.",
      "Preserve the document's purpose, but improve clarity, structure, and usefulness based on the requested change and the current repository context.",
    ],
    sections: [
      buildPromptSection(
        "Document context:",
        `Document number: #${options.document.number}`,
        `Status: ${options.document.status}`,
        `Assignee: ${options.document.assignee || "Unassigned"}`,
        `Tags: ${options.document.tags.join(", ") || "none"}`,
        `Dependencies: ${dependencySummary || "none"}`,
      ),
      buildPromptSection("Current markdown:", options.document.markdown),
    ],
  });
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
  return buildPrompt({
    preamble: [
      `You are implementing the work described by the project-management document \"${options.document.title}\".`,
      "Use this document as the main instruction set for the engineering work to perform in the repository.",
      options.environmentContext,
      "Make code changes directly in the repository. Do not rewrite the project-management document unless the prompt explicitly asks for that.",
      "If the document describes a bug, fix it. If it describes a feature, implement it. If it describes a refactor or infrastructure change, carry it out in code.",
      "Follow the repository conventions already present in this worktree and add or update tests that prove the change.",
      "This is not an interactive user session, so make your best educated guesses and keep moving unless the prompt requires something specific you cannot infer.",
      "Commit your work regularly as you complete meaningful milestones.",
      "Return your normal coding-agent response after doing the work, including a concise summary of what you changed and how you verified it.",
    ],
    sections: [
      buildPromptSection(
        "Execution context:",
        options.requestedChange ? `Additional operator guidance: ${options.requestedChange}` : null,
        dependencySummary ? `Dependencies: ${dependencySummary}` : null,
      ),
      buildPromptSection("Current markdown:", options.document.markdown),
    ],
  });
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

export function createWorktreeReviewOrigin(options: {
  branch: string;
  worktreeId?: WorktreeId;
  documentId: string;
  reviewAction?: RunAiCommandRequest["reviewAction"];
}): AiCommandOrigin {
  const label = options.reviewAction === "review" ? "Review pass" : "Review follow-up";
  const description = options.reviewAction === "review"
    ? `Review branch changes for linked document ${options.documentId}.`
    : `Continue review activity for linked document ${options.documentId}.`;

  return {
    kind: "worktree-review",
    label,
    description,
    location: {
      tab: "review",
      branch: options.branch,
      worktreeId: options.worktreeId,
      documentId: options.documentId,
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

function buildReviewFollowUpSummaryPrompt(options: {
  branch: string;
  documentTitle: string;
  originalRequest: string;
  priorOutputs: string[];
}) {
  return [
    `You are summarizing previous AI work for the review activity linked to \"${options.documentTitle}\" on branch ${options.branch}.`,
    "The server will use your response as compact context for the next follow-up AI run.",
    "Return only the final summary as raw text.",
    "Write a concise engineer-facing summary that captures what prior AI runs already did, key outcomes, unresolved risks, and any notable failures.",
    "Do not use markdown headings, bullets, code fences, or commentary outside the summary.",
    "Prefer a short paragraph unless the content is too dense.",
    "",
    `Original request: ${options.originalRequest}`,
    "",
    "Previous AI outputs:",
    ...options.priorOutputs.map((entry, index) => `Run ${index + 1}:\n${entry}`),
  ].join("\n\n");
}

const REVIEW_FOLLOW_UP_RAW_HISTORY_LIMIT = 4;
const REVIEW_FOLLOW_UP_OLDER_SUMMARY_LIMIT = 6;
const REVIEW_FOLLOW_UP_SUMMARY_INPUT_LIMIT = 8;
const REVIEW_FOLLOW_UP_REQUEST_MAX_LENGTH = 1_200;
const REVIEW_FOLLOW_UP_OUTPUT_MAX_LENGTH = 2_400;
const REVIEW_FOLLOW_UP_SUMMARY_TEXT_MAX_LENGTH = 480;
const REVIEW_THREAD_ENTRY_BODY_MAX_LENGTH = 1_200;
const REVIEW_OUTPUT_SUMMARY_HASH_VERSION = "review-output-summary-v2";

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
      env: buildAiCommandProcessEnv({
        repoRoot: options.repoRoot,
        worktreePath: options.repoRoot,
        env: {
          ...process.env,
          ...options.config.env,
          WTM_AI_INPUT: input,
          WORKTREE_BRANCH: DEFAULT_PROJECT_MANAGEMENT_BRANCH,
          WORKTREE_PATH: options.repoRoot,
        },
      }),
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

function formatReviewFollowUpLogOutput(entry: AiCommandLogEntry): string | null {
  const request = formatReviewFollowUpMultilineSnippet(entry.request, REVIEW_FOLLOW_UP_REQUEST_MAX_LENGTH);
  const sections = [
    entry.response.stdout.trim()
      ? `stdout:\n${formatReviewFollowUpMultilineSnippet(entry.response.stdout, REVIEW_FOLLOW_UP_OUTPUT_MAX_LENGTH)}`
      : null,
    entry.error?.message?.trim() ? `error: ${entry.error.message.trim()}` : null,
  ].filter((value): value is string => Boolean(value));

  if (!sections.length) {
    return null;
  }

  return [
    `Request: ${request || "(empty request)"}`,
    ...sections,
  ].join("\n\n");
}

function isExecutionReviewHistoryEntry(entry: AiCommandLogEntry): boolean {
  const originKind = entry.origin?.kind;
  if (originKind === "worktree-review" || originKind === "project-management-document-run") {
    return true;
  }

  const request = entry.request.trim();
  if (!request) {
    return false;
  }

  if (request.includes('You are rewriting the project-management markdown document')) {
    return false;
  }

  return request.includes('You are implementing the work described by the project-management document')
    || request.includes('Review follow-up for linked document');
}

function formatReviewFollowUpHistoryEntry(entry: AiCommandLogEntry): string {
  const sections = [
    `- Timestamp: ${entry.timestamp}`,
    `- Branch: ${entry.branch}`,
    `- Command: ${entry.commandId}`,
    `- Status: ${entry.status}`,
    `- Request summary: ${formatReviewFollowUpMultilineSnippet(entry.request, REVIEW_FOLLOW_UP_REQUEST_MAX_LENGTH) || "(empty request)"}`,
    entry.response.stdout.trim()
      ? `- Stdout:\n${formatReviewFollowUpMultilineSnippet(entry.response.stdout, REVIEW_FOLLOW_UP_OUTPUT_MAX_LENGTH)}`
      : null,
    entry.error?.message?.trim() ? `- Error: ${entry.error.message.trim()}` : null,
  ].filter((value): value is string => Boolean(value));

  return sections.join("\n\n");
}

function formatReviewFollowUpMultilineSnippet(value: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}\n...[truncated]`;
}

function buildReviewHistorySummarySourceHash(entry: AiCommandLogEntry): string {
  return createHash("sha256").update(JSON.stringify({
    branch: entry.branch,
    commandId: entry.commandId,
    status: entry.status,
    request: entry.request.trim(),
    stdout: entry.response.stdout.trim(),
    error: entry.error?.message?.trim() ?? "",
  })).digest("hex");
}

function createReviewHistorySummary(entry: AiCommandLogEntry): string | null {
  const requestSummary = formatLogSnippet(entry.request, 160) || "(empty request)";
  const outcomeSummary = formatLogSnippet(entry.response.stdout, 220)
    || formatLogSnippet(entry.error?.message ?? "", 220)
    || "No stdout or explicit error was captured.";

  return formatReviewFollowUpMultilineSnippet(
    [
      `${entry.timestamp} on ${entry.branch} (${entry.commandId}, ${entry.status}).`,
      `Request: ${requestSummary}`,
      `Outcome: ${outcomeSummary}`,
    ].join(" "),
    REVIEW_FOLLOW_UP_SUMMARY_TEXT_MAX_LENGTH,
  );
}

async function getCachedReviewHistorySummary(options: {
  repoRoot: string;
  entry: AiCommandLogEntry;
}): Promise<string | null> {
  const sourceHash = buildReviewHistorySummarySourceHash(options.entry);
  const cachedSummary = options.entry.historySummary?.trim() ?? "";
  if (cachedSummary && options.entry.historySummarySourceHash === sourceHash) {
    return cachedSummary;
  }

  const summary = createReviewHistorySummary(options.entry);
  if (!summary) {
    return null;
  }

  const store = await createOperationalStateStore(options.repoRoot);
  await store.upsertAiCommandLogEntry({
    ...options.entry,
    historySummary: summary,
    historySummaryGeneratedAt: new Date().toISOString(),
    historySummarySourceHash: sourceHash,
  }, { preserveOutputText: true });
  return summary;
}

async function buildReviewFollowUpHistoryContext(options: {
  repoRoot: string;
  executionHistoryLogs: AiCommandLogEntry[];
}): Promise<{ priorHistoryLog: string; summaryInputs: string[] }> {
  if (!options.executionHistoryLogs.length) {
    return {
      priorHistoryLog: "No prior implementation runs were available for this review yet.",
      summaryInputs: [],
    };
  }

  const rawHistoryEntries = options.executionHistoryLogs.slice(-REVIEW_FOLLOW_UP_RAW_HISTORY_LIMIT);
  const olderHistoryEntries = options.executionHistoryLogs.slice(0, -rawHistoryEntries.length);
  const olderHistorySummaries = (await Promise.all(
    olderHistoryEntries.map((entry) => getCachedReviewHistorySummary({ repoRoot: options.repoRoot, entry })),
  )).filter((entry): entry is string => Boolean(entry));
  const visibleOlderSummaries = olderHistorySummaries.slice(-REVIEW_FOLLOW_UP_OLDER_SUMMARY_LIMIT);
  const omittedOlderSummaryCount = Math.max(olderHistorySummaries.length - visibleOlderSummaries.length, 0);
  const recentRawHistory = rawHistoryEntries.map(formatReviewFollowUpHistoryEntry);
  const sections: string[] = [];

  if (visibleOlderSummaries.length) {
    sections.push([
      `Earlier AI runs summarized (${olderHistorySummaries.length} total):`,
      ...visibleOlderSummaries.map((summary, index) => `${index + 1}. ${summary}`),
      omittedOlderSummaryCount > 0
        ? `${omittedOlderSummaryCount} additional earlier run summaries were omitted to keep this follow-up request bounded.`
        : null,
    ].filter((value): value is string => Boolean(value)).join("\n"));
  }

  if (recentRawHistory.length) {
    sections.push([
      visibleOlderSummaries.length ? "Most recent AI runs:" : null,
      recentRawHistory.join("\n\n---\n\n"),
    ].filter((value): value is string => Boolean(value)).join("\n"));
  }

  const recentOutputInputs = rawHistoryEntries
    .map(formatReviewFollowUpLogOutput)
    .filter((entry): entry is string => Boolean(entry));
  const summaryInputs = [...visibleOlderSummaries, ...recentOutputInputs].slice(-REVIEW_FOLLOW_UP_SUMMARY_INPUT_LIMIT);

  return {
    priorHistoryLog: sections.join("\n\n") || "No prior implementation runs were available for this review yet.",
    summaryInputs,
  };
}

function extractReviewEntryRequestSummary(body: string): string | null {
  const match = body.match(/^- Request:\s*(.+)$/m);
  return match?.[1]?.trim() || null;
}

function formatReviewEntryBodySnippet(body: string): string {
  const normalized = body
    .replace(/<details>[\s\S]*?<\/details>/gi, "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/<[^>]+>/g, "")
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();

  return formatReviewFollowUpMultilineSnippet(normalized, REVIEW_THREAD_ENTRY_BODY_MAX_LENGTH);
}

function getReviewThreadEntryTitle(entry: ProjectManagementReviewEntry): string {
  if (entry.eventType === "ai-started") {
    return "AI work started";
  }

  if (entry.eventType === "ai-completed") {
    return "AI work completed";
  }

  if (entry.eventType === "merge") {
    return "Merge activity";
  }

  if (entry.source === "ai") {
    return "AI review note";
  }

  if (entry.source === "system") {
    return "System review note";
  }

  return "Review feedback";
}

function normalizeReviewRequestMatch(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

function buildReviewOutputSummarySourceHash(entry: AiCommandLogEntry): string {
  return createHash("sha256").update(JSON.stringify({
    version: REVIEW_OUTPUT_SUMMARY_HASH_VERSION,
    branch: entry.branch,
    commandId: entry.commandId,
    status: entry.status,
    completedAt: entry.completedAt ?? null,
    request: entry.request.trim(),
    stdout: entry.response.stdout.trim(),
    error: entry.error?.message?.trim() ?? "",
  })).digest("hex");
}

function createReviewOutputSummary(entry: AiCommandLogEntry): string | null {
  const outcomeSummary = formatLogSnippet(entry.response.stdout, 260)
    || formatLogSnippet(entry.error?.message ?? "", 220)
    || "No stdout or explicit error was captured.";

  return formatReviewFollowUpMultilineSnippet(
    [
      `${entry.branch} ${entry.commandId} run (${entry.status}).`,
      `Stdout summary: ${outcomeSummary}`,
      entry.error?.message?.trim() ? `Explicit error: ${entry.error.message.trim()}` : null,
    ].filter((value): value is string => Boolean(value)).join(" "),
    REVIEW_FOLLOW_UP_SUMMARY_TEXT_MAX_LENGTH,
  );
}

async function getCachedReviewOutputSummary(options: {
  repoRoot: string;
  entry: AiCommandLogEntry;
}): Promise<string | null> {
  const sourceHash = buildReviewOutputSummarySourceHash(options.entry);
  const cachedSummary = options.entry.historySummary?.trim() ?? "";
  if (cachedSummary && options.entry.historySummarySourceHash === sourceHash) {
    return cachedSummary;
  }

  const summary = createReviewOutputSummary(options.entry);
  if (!summary) {
    return null;
  }

  const store = await createOperationalStateStore(options.repoRoot);
  await store.upsertAiCommandLogEntry({
    ...options.entry,
    historySummary: summary,
    historySummaryGeneratedAt: new Date().toISOString(),
    historySummarySourceHash: sourceHash,
  }, { preserveOutputText: true });
  return summary;
}

function findMatchingReviewLogIndex(entry: ProjectManagementReviewEntry, logs: AiCommandLogEntry[]): number {
  const requestSummary = normalizeReviewRequestMatch(extractReviewEntryRequestSummary(entry.body));
  if (requestSummary) {
    const exactIndex = logs.findIndex((log) => normalizeReviewRequestMatch(log.request) === requestSummary);
    if (exactIndex >= 0) {
      return exactIndex;
    }

    const partialIndex = logs.findIndex((log) => {
      const normalizedRequest = normalizeReviewRequestMatch(log.request);
      return normalizedRequest.includes(requestSummary) || requestSummary.includes(normalizedRequest);
    });
    if (partialIndex >= 0) {
      return partialIndex;
    }
  }

  const entryTime = Date.parse(entry.updatedAt || entry.createdAt);
  if (!Number.isFinite(entryTime)) {
    return logs.length ? 0 : -1;
  }

  let bestIndex = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, log] of logs.entries()) {
    const logTime = Date.parse(log.completedAt ?? log.timestamp);
    if (!Number.isFinite(logTime)) {
      continue;
    }

    const distance = Math.abs(logTime - entryTime);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  return bestIndex >= 0 ? bestIndex : (logs.length ? 0 : -1);
}

function matchReviewEntriesToLogs(entries: ProjectManagementReviewEntry[], logs: AiCommandLogEntry[]) {
  const remainingLogs = [...logs];
  const matchedLogs = new Map<string, AiCommandLogEntry>();

  for (const entry of entries) {
    if (entry.eventType !== "ai-completed") {
      continue;
    }

    const matchIndex = findMatchingReviewLogIndex(entry, remainingLogs);
    if (matchIndex < 0) {
      continue;
    }

    const [matchedLog] = remainingLogs.splice(matchIndex, 1);
    if (matchedLog) {
      matchedLogs.set(entry.id, matchedLog);
    }
  }

  return matchedLogs;
}

async function formatReviewThreadContextEntry(options: {
  repoRoot: string;
  index: number;
  entry: ProjectManagementReviewEntry;
  matchedLog: AiCommandLogEntry | null;
}): Promise<string> {
  const author = options.entry.authorName || options.entry.authorEmail || options.entry.source;
  const bodySnippet = formatReviewEntryBodySnippet(options.entry.body) || "(empty review entry)";
  const outputSummary = options.matchedLog
    ? await getCachedReviewOutputSummary({ repoRoot: options.repoRoot, entry: options.matchedLog })
    : null;

  return [
    `${options.index}. ${getReviewThreadEntryTitle(options.entry)}`,
    `- Timestamp: ${options.entry.createdAt}`,
    `- Author: ${author}`,
    `- Review entry:\n${bodySnippet}`,
    outputSummary ? `- Cached stdout summary:\n${outputSummary}` : null,
  ].filter((value): value is string => Boolean(value)).join("\n");
}

async function buildOrderedReviewThreadContext(options: {
  repoRoot: string;
  documentId: string;
}): Promise<{ reviewThreadContext: string; originalContextFallback: string | null; latestFullReviewEntry: string | null }> {
  const review = await getProjectManagementDocumentReview(options.repoRoot, options.documentId);
  const entries = review.review.entries;
  if (!entries.length) {
    return {
      reviewThreadContext: "No visible review feedback was recorded for this document yet.",
      originalContextFallback: null,
      latestFullReviewEntry: null,
    };
  }

  const reviewLogs = (await listAiCommandLogEntries(options.repoRoot))
    .filter((entry) => entry.documentId === options.documentId)
    .filter((entry) => entry.status !== "running")
    .filter((entry) => entry.origin?.kind === "worktree-review")
    .sort((left, right) => (left.completedAt ?? left.timestamp).localeCompare(right.completedAt ?? right.timestamp));
  const matchedLogs = matchReviewEntriesToLogs(entries, reviewLogs);
  const formattedEntries = await Promise.all(entries.map((entry, index) => formatReviewThreadContextEntry({
    repoRoot: options.repoRoot,
    index: index + 1,
    entry,
    matchedLog: matchedLogs.get(entry.id) ?? null,
  })));
  const originalContextFallback = entries
    .map((entry) => extractReviewEntryRequestSummary(entry.body))
    .find((value): value is string => Boolean(value?.trim()))
    ?? reviewLogs.find((entry) => entry.request.trim())?.request.trim()
    ?? null;
  const latestFullReviewEntry = [...entries]
    .reverse()
    .find((entry) => entry.kind === "comment")?.body.trim() ?? null;

  return {
    reviewThreadContext: formattedEntries.join("\n\n"),
    originalContextFallback,
    latestFullReviewEntry,
  };
}

export async function buildReviewFollowUpRequest(options: {
  repoRoot: string;
  config: WorktreeManagerConfig;
  branch: string;
  worktreePath: string;
  documentId: string;
  documentTitle: string;
  documentSummary?: string | null;
  documentMarkdown?: string | null;
  followUp: NonNullable<RunAiCommandRequest["reviewFollowUp"]>;
}): Promise<string> {
  const { reviewThreadContext, originalContextFallback, latestFullReviewEntry } = await buildOrderedReviewThreadContext({
    repoRoot: options.repoRoot,
    documentId: options.documentId,
  });

  const originalRequest = options.followUp.originalRequest.trim()
    || originalContextFallback
    || options.documentSummary?.trim()
    || options.documentTitle;

  const environmentContext = buildAiEnvironmentContext({
    repoRoot: options.repoRoot,
    config: options.config,
    branch: options.branch,
    worktreePath: options.worktreePath,
    backgroundCommands: [],
  });

  return buildPrompt({
    preamble: [
      `Review follow-up for linked document \"${options.documentTitle}\".`,
      "Implement the work described by this document in the current worktree.",
      environmentContext,
      "Continue the implementation directly in code. Treat the linked document as requirements context and the review thread as the ordered record of feedback and prior AI work.",
      "Focus on finishing the requested engineering work. Do not spend response space on disclaimers about actions you did not take.",
      "Return your normal coding-agent response with what changed, any important residual issues, and how you verified the work.",
    ],
    sections: [
      buildPromptSection("Original context:", originalRequest),
      buildPromptSection(
        "Linked document context:",
        `Title: ${options.documentTitle}`,
        `Summary: ${options.documentSummary?.trim() || "(no summary)"}`,
        options.documentMarkdown?.trim() ? `Markdown:\n${options.documentMarkdown.trim()}` : "Markdown: (no markdown)",
      ),
      buildPromptSection("Ordered review thread context:", reviewThreadContext),
      latestFullReviewEntry ? buildPromptSection("Latest full review entry:", latestFullReviewEntry) : null,
      buildPromptSection("New follow-up request:", options.followUp.newRequest.trim()),
    ],
    closing: ["Implement the requested work in code in this repository."],
  });
}

function formatReviewDiff(diff: string) {
  const trimmed = diff.trim();
  return trimmed ? trimmed : "(no branch diff or working tree changes were available)";
}

export async function buildReviewOnlyRequest(options: {
  repoRoot: string;
  config: WorktreeManagerConfig;
  branch: string;
  worktreePath: string;
  documentId: string;
  documentTitle: string;
  documentSummary?: string | null;
  documentMarkdown?: string | null;
  request: string;
  comparison: GitComparisonResponse;
}): Promise<string> {
  const { reviewThreadContext, originalContextFallback } = await buildOrderedReviewThreadContext({
    repoRoot: options.repoRoot,
    documentId: options.documentId,
  });

  const originalRequest = originalContextFallback
    || options.documentSummary?.trim()
    || options.documentTitle;

  const environmentContext = buildAiEnvironmentContext({
    repoRoot: options.repoRoot,
    config: options.config,
    branch: options.branch,
    worktreePath: options.worktreePath,
    backgroundCommands: [],
  });

  return buildPrompt({
    preamble: [
      `Review branch changes for linked document \"${options.documentTitle}\".`,
      environmentContext,
      "Do not change code, files, git state, or the project-management document. This is a review-only pass.",
      "Review whether everything in the original document is correct, whether everything in the requested updates is correct, and whether the current branch diff actually satisfies them.",
      "Return markdown only. Put the actual review content inside <wtm-review>...</wtm-review> so the application can extract and display it.",
      "Also include machine-readable XML outside the review block using exactly one <wtm-review-result passed=\"true|false\"> element.",
      "When passed=\"false\", include one or more <wtm-review-issue id=\"short-kebab-id\"><summary>short summary</summary><details>specific fix guidance</details></wtm-review-issue> elements inside <wtm-review-result>.",
      "When passed=\"true\", do not include any <wtm-review-issue> elements.",
      "Inside the tagged review, prioritize bugs, risks, behavioral regressions, missing verification, and mismatches between the document, requested updates, and the implemented diff.",
    ],
    sections: [
      buildPromptSection("Original context:", originalRequest),
      buildPromptSection(
        "Linked document context:",
        `Title: ${options.documentTitle}`,
        `Summary: ${options.documentSummary?.trim() || "(no summary)"}`,
        options.documentMarkdown?.trim() ? `Markdown:\n${options.documentMarkdown.trim()}` : "Markdown: (no markdown)",
      ),
      buildPromptSection("Ordered review thread context:", reviewThreadContext),
      buildPromptSection("Requested review focus:", options.request.trim()),
      buildPromptSection(
        "Branch diff to review:",
        `Base branch: ${options.comparison.baseBranch}`,
        `Compare branch: ${options.comparison.compareBranch}`,
        `Ahead: ${options.comparison.ahead}`,
        `Behind: ${options.comparison.behind}`,
        `Effective diff:\n${formatReviewDiff(options.comparison.effectiveDiff)}`,
      ),
    ],
    closing: [
      "Do not apply fixes. Review only.",
      "The final response must be markdown only, and the actual review must appear inside <wtm-review>...</wtm-review>.",
      "The final response must also include the exact <wtm-review-result passed=\"true|false\">...</wtm-review-result> XML after the review block.",
    ],
  });
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
    requestPreview: toAiCommandLogPreview(entry.request),
    status: historicalStatus,
    pid: entry.pid ?? null,
    origin: entry.origin ?? null,
  };
}

function toAiCommandLogSummaryFromIndex(entry: AiCommandLogIndexEntry): AiCommandLogSummary {
  const historicalStatus = isAiCommandLogIndexFinalizing(entry) && entry.documentId ? "completed" : entry.status;
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    timestamp: entry.timestamp,
    worktreeId: entry.worktreeId,
    branch: entry.branch,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
    worktreePath: entry.worktreePath,
    requestPreview: toAiCommandLogPreview(entry.request),
    status: historicalStatus,
    pid: entry.pid ?? null,
    origin: entry.origin ?? null,
  };
}

function isAiCommandLogFinalizing(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && typeof entry.completedAt === "string";
}

function isAiCommandLogIndexFinalizing(entry: AiCommandLogIndexEntry): boolean {
  return entry.status === "running" && typeof entry.completedAt === "string";
}

export function isAiCommandLogActivelyRunning(entry: AiCommandLogEntry): boolean {
  return entry.status === "running" && !isAiCommandLogFinalizing(entry);
}

function isAiCommandLogIndexActivelyRunning(entry: AiCommandLogIndexEntry): boolean {
  return entry.status === "running" && !isAiCommandLogIndexFinalizing(entry);
}

export function toHistoricalAiCommandLogSummaries(entries: AiCommandLogEntry[]): AiCommandLogSummary[] {
  return entries.filter((entry) => entry.status !== "running" || isAiCommandLogFinalizing(entry)).map(toAiCommandLogSummary);
}

export async function buildAiCommandLogsResponse(options: {
  repoRoot: string;
  aiProcesses: ApiAiProcesses;
  reconcileJobs?: boolean;
}): Promise<AiCommandLogsResponse> {
  const store = await createOperationalStateStore(options.repoRoot);
  const rawEntries = (await store.listAiCommandLogIndexEntries()).filter((entry) => isWorktreePathInRepo(options.repoRoot, entry.worktreePath));
  const runningEntries = rawEntries.filter(isAiCommandLogIndexActivelyRunning);
  const reconciledEntries = await Promise.all(
    runningEntries.map(async (entry) => {
      const fullEntry = await store.getAiCommandLogEntryByJobId(entry.jobId);
      if (!fullEntry || !isAiCommandLogEntryInRepo(options.repoRoot, fullEntry)) {
        return null;
      }

      return await resolveHistoricalAiCommandLogEntry({
        entry: fullEntry,
        repoRoot: options.repoRoot,
        aiProcesses: options.aiProcesses,
        reconcileJobs: options.reconcileJobs,
      });
    }),
  );
  const resolvedRunningEntries = reconciledEntries.filter((entry): entry is AiCommandLogEntry => entry !== null);
  const completedRunningLogs = resolvedRunningEntries
    .filter((entry) => !isAiCommandLogActivelyRunning(entry))
    .map(toAiCommandLogSummary);
  const historicalLogs = rawEntries
    .filter((entry) => !isAiCommandLogIndexActivelyRunning(entry) || isAiCommandLogIndexFinalizing(entry))
    .map(toAiCommandLogSummaryFromIndex)
    .filter((entry) => completedRunningLogs.every((resolved) => resolved.jobId !== entry.jobId));

  return {
    logs: [...completedRunningLogs, ...historicalLogs],
    runningJobs: resolvedRunningEntries.filter(isAiCommandLogActivelyRunning).map(toRunningAiCommandJob),
  };
}

export async function listAiCommandLogEntries(repoRoot: string): Promise<AiCommandLogEntry[]> {
  const entries = await (await createOperationalStateStore(repoRoot)).listAiCommandLogEntries();
  return entries.filter((entry) => isWorktreePathInRepo(repoRoot, entry.worktreePath));
}

function isWorktreePathInRepo(repoRoot: string, worktreePath: string | null | undefined): boolean {
  if (!worktreePath) {
    return false;
  }

  const relative = path.relative(path.resolve(repoRoot), path.resolve(worktreePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isAiCommandLogEntryInRepo(repoRoot: string, entry: AiCommandLogEntry): boolean {
  return isWorktreePathInRepo(repoRoot, entry.worktreePath);
}

export function toRunningAiCommandJob(entry: AiCommandLogEntry): AiCommandJob {
  return {
    jobId: entry.jobId,
    fileName: entry.fileName,
    worktreeId: entry.worktreeId,
    branch: entry.branch,
    sessionId: entry.sessionId ?? null,
    documentId: entry.documentId ?? null,
    commandId: entry.commandId,
    command: entry.command,
    input: entry.request,
    status: entry.status,
    startedAt: entry.timestamp,
    completedAt: entry.completedAt,
    stdout: "",
    stderr: entry.status === "failed" ? (entry.error?.message ?? entry.response.stderr) : "",
    outputEvents: [],
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
    || typeof entry.completedAt === "string"
    || Boolean(entry.processName);
}

function hasObservedAiCommandJobProcess(job: AiCommandJob): boolean {
  return job.pid != null
    || job.exitCode != null
    || typeof job.completedAt === "string"
    || Boolean(job.processName);
}

function mergeAiCommandLogEntryWithJob(entry: AiCommandLogEntry, job: AiCommandJob): AiCommandLogEntry {
  return {
    ...entry,
    sessionId: job.sessionId ?? entry.sessionId ?? null,
    documentId: job.documentId ?? entry.documentId ?? null,
    origin: job.origin ?? entry.origin ?? null,
    worktreePath: job.worktreePath ?? entry.worktreePath,
    response: entry.response,
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
    || entry.processName !== (job.processName ?? null)
    || (entry.error?.message ?? null) !== (job.error ?? null)
    || (entry.documentId ?? null) !== (job.documentId ?? null);
}

export async function readAiCommandLogEntryByJobId(repoRoot: string, jobId: string): Promise<AiCommandLogEntry> {
  const entry = await (await createOperationalStateStore(repoRoot)).getAiCommandLogEntryByJobId(jobId);
  if (!entry || !isAiCommandLogEntryInRepo(repoRoot, entry)) {
    const error = new Error(`Unknown AI log ${jobId}`) as NodeJS.ErrnoException;
    error.code = "ENOENT";
    throw error;
  }
  return entry;
}

export async function readAiCommandLogEntryByIdentifier(repoRoot: string, identifier: string): Promise<AiCommandLogEntry> {
  const store = await createOperationalStateStore(repoRoot);
  const byJobId = await store.getAiCommandLogEntryByJobId(identifier);
  if (byJobId && isAiCommandLogEntryInRepo(repoRoot, byJobId)) {
    return byJobId;
  }

  const byFileName = await store.getAiCommandLogEntryByFileName(identifier);
  if (byFileName && isAiCommandLogEntryInRepo(repoRoot, byFileName)) {
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
  const refreshedEntry = await readAiCommandLogEntryByJobId(options.repoRoot, options.entry.jobId).catch(() => options.entry);
  if (refreshedEntry.status !== "running") {
    return refreshedEntry;
  }

  if (!options.reconcileJobs) {
    return refreshedEntry;
  }

  const reconciledJob = await getAiCommandJob(options.repoRoot, refreshedEntry.worktreeId, {
    aiProcesses: {
      getProcess: options.aiProcesses.getProcess,
      waitForProcess: options.aiProcesses.waitForProcess,
      isProcessActive: options.aiProcesses.isProcessActive,
    },
    reconcile: options.reconcileJobs ?? true,
    treatProcessNameAsObserved: hasObservedAiCommandLogProcess(refreshedEntry),
  });
  if (!reconciledJob || reconciledJob.jobId !== refreshedEntry.jobId) {
    return refreshedEntry;
  }

  if (!hasObservedAiCommandLogProcess(refreshedEntry) && !hasObservedAiCommandJobProcess(reconciledJob)) {
    return refreshedEntry;
  }

  if (shouldPreferAiCommandJobState(refreshedEntry, reconciledJob)) {
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
