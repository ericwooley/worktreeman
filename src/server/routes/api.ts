import express from "express";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import type {
  AppendProjectManagementBatchRequest,
  AiCommandConfig,
  AiCommandId,
  ApiStateResponse,
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
  ConfigDocumentResponse,
  CreateProjectManagementDocumentRequest,
  CreateWorktreeRequest,
  GitComparisonResponse,
  ProjectManagementBatchResponse,
  ProjectManagementDocumentResponse,
  ProjectManagementHistoryResponse,
  ProjectManagementListResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  UpdateProjectManagementDependenciesRequest,
  TmuxClientInfo,
  UpdateAiCommandSettingsRequest,
  UpdateProjectManagementDocumentRequest,
  WorktreeManagerConfig,
} from "../../shared/types.js";
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
import { createWorktree, getGitComparison, listWorktrees, removeWorktree } from "../services/git-service.js";
import { buildRuntimeProcessEnv, createRuntime, runStartupCommands } from "../services/runtime-service.js";
import { syncEnvFiles } from "../services/env-sync-service.js";
import { loadConfig, parseConfigContents, readConfigContents, updateAiCommandInConfigContents } from "../services/config-service.js";
import type { ShutdownStatus } from "../../shared/types.js";
import { failAiCommandJob, getAiCommandJob, startAiCommandJob, subscribeToAiCommandJob, waitForAiCommandJob } from "../services/ai-command-service.js";
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
  appendProjectManagementBatch,
  createProjectManagementDocument,
  getProjectManagementDocument,
  getProjectManagementDocumentHistory,
  listProjectManagementDocuments,
  updateProjectManagementDependencies,
  updateProjectManagementDocument,
} from "../services/project-management-service.js";
import type { ShutdownStatusService } from "../services/shutdown-status-service.js";
import type { RuntimeStore } from "../state/runtime-store.js";

interface ApiRouterOptions {
  repoRoot: string;
  configPath: string;
  configSourceRef: string;
  configFile: string;
  configWorktreePath: string;
  runtimes: RuntimeStore;
  shutdownStatus: ShutdownStatusService;
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
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: Record<string, string>;
  }, context: {
    notifyStarted: (job: AiCommandJob) => void;
  }) => Promise<void>;
}

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
  worktreePath: string;
  renderedCommand: string;
  input: string;
  stdout?: string;
  stderr?: string;
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
    worktreePath: options.worktreePath,
    command: options.renderedCommand,
    pid: options.pid ?? null,
    exitCode: options.exitCode ?? null,
    processName: options.processName ?? null,
    request: options.input,
    response: {
      stdout: options.stdout ?? "",
      stderr: options.stderr ?? "",
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
  worktreePath: string;
  renderedCommand: string;
  input: string;
  stdout?: string;
  stderr?: string;
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

function toAiCommandLogPreview(request: string): string {
  return formatLogSnippet(request, 160);
}

function parseAiCommandId(value: unknown): AiCommandId {
  return value === "simple" ? "simple" : "smart";
}

function resolveAiCommandTemplate(aiCommands: AiCommandConfig, commandId: AiCommandId): string {
  return (aiCommands[commandId] ?? "").trim();
}

function buildProjectManagementAiPrompt(options: {
  branch: string;
  worktreePath: string;
  requestedChange: string;
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

function parseAiCommandLogEntry(fileName: string, payload: string): AiCommandLogEntry {
  const parsed = JSON.parse(payload) as {
    jobId?: unknown;
    timestamp?: unknown;
    startedAt?: unknown;
    completedAt?: unknown;
    branch?: unknown;
    documentId?: unknown;
    commandId?: unknown;
    worktreePath?: unknown;
    command?: unknown;
    pid?: unknown;
    exitCode?: unknown;
    processName?: unknown;
    request?: unknown;
    response?: { stdout?: unknown; stderr?: unknown } | null;
    error?: unknown;
  };

  const request = typeof parsed.request === "string" ? parsed.request : "";
  const error = toAiCommandLogError(parsed.error);

  return {
    jobId: typeof parsed.jobId === "string" ? parsed.jobId : fileName,
    fileName,
    timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    branch: typeof parsed.branch === "string" ? parsed.branch : "",
    documentId: typeof parsed.documentId === "string" ? parsed.documentId : null,
    commandId: parseAiCommandId(parsed.commandId),
    worktreePath: typeof parsed.worktreePath === "string" ? parsed.worktreePath : "",
    command: typeof parsed.command === "string" ? parsed.command : "",
    request,
    response: {
      stdout: typeof parsed.response?.stdout === "string" ? parsed.response.stdout : "",
      stderr: typeof parsed.response?.stderr === "string" ? parsed.response.stderr : "",
    },
    status: getAiCommandLogStatus(error, parsed.completedAt),
    pid: typeof parsed.pid === "number" ? parsed.pid : null,
    exitCode: typeof parsed.exitCode === "number" ? parsed.exitCode : parsed.exitCode === null ? null : undefined,
    processName: typeof parsed.processName === "string" ? parsed.processName : null,
    completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
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
    command: entry.command,
    input: entry.request,
    status: entry.status,
    startedAt: entry.timestamp,
    completedAt: entry.completedAt,
    stdout: entry.response.stdout,
    stderr: entry.response.stderr,
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
      worktreePath: options.entry.worktreePath,
      renderedCommand: options.entry.command,
      input: options.entry.request,
      stdout: options.entry.response.stdout,
      stderr: options.entry.response.stderr,
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
      worktreePath: options.entry.worktreePath,
      renderedCommand: options.entry.command,
      input: options.entry.request,
      stdout: logs.stdout,
      stderr: logs.stderr,
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
    worktreePath: options.entry.worktreePath,
    renderedCommand: options.entry.command,
    input: options.entry.request,
    stdout: logs.stdout || options.entry.response.stdout,
    stderr: logs.stderr || options.entry.response.stderr,
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
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
  }) => startAiCommandJob({
    branch: details.branch,
    documentId: details.documentId ?? null,
    commandId: details.commandId,
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

      payload.hooks.onSpawn?.({
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
            payload.hooks.onStdout?.(chunk);
          }
        } else if (logs.stdout !== lastStdout) {
          const chunk = logs.stdout.slice(Math.min(lastStdout.length, logs.stdout.length));
          if (chunk) {
            payload.hooks.onStdout?.(chunk);
          }
        }

        if (logs.stderr.startsWith(lastStderr)) {
          const chunk = logs.stderr.slice(lastStderr.length);
          if (chunk) {
            payload.hooks.onStderr?.(chunk);
          }
        } else if (logs.stderr !== lastStderr) {
          const chunk = logs.stderr.slice(Math.min(lastStderr.length, logs.stderr.length));
          if (chunk) {
            payload.hooks.onStderr?.(chunk);
          }
        }

        lastStdout = logs.stdout;
        lastStderr = logs.stderr;

        if (!nextProcess || !aiProcesses.isProcessActive(nextProcess.status)) {
          payload.hooks.onExit?.({ exitCode: nextProcess?.exitCode ?? null });
          if ((nextProcess?.exitCode ?? 0) !== 0) {
            throw new Error(`AI process exited with code ${nextProcess?.exitCode ?? "unknown"}.`);
          }

          return logs;
        }

        await new Promise((resolve) => setTimeout(resolve, aiProcessPollIntervalMs));
      }
    },
    writeLog: safeWriteAiRequestLog,
    onComplete: details.documentId
      ? async ({ stdout }) => {
        const nextMarkdown = stdout.trim();
        if (!nextMarkdown) {
          throw new Error("AI command finished without returning updated markdown.");
        }

        const currentDocument = await getProjectManagementDocument(options.repoRoot, details.documentId!);
        await updateProjectManagementDocument(options.repoRoot, details.documentId!, {
          title: currentDocument.document.title,
          markdown: nextMarkdown,
          tags: currentDocument.document.tags,
          dependencies: currentDocument.document.dependencies,
          status: currentDocument.document.status,
          assignee: currentDocument.document.assignee,
          archived: currentDocument.document.archived,
        });
      }
      : undefined,
  });

  const enqueueProjectManagementDocumentAiJob = async (details: {
    branch: string;
    documentId: string;
    commandId: AiCommandId;
    input: string;
    renderedCommand: string;
    worktreePath: string;
    env: NodeJS.ProcessEnv;
  }) => enqueueProjectManagementAiJob({
    repoRoot: options.repoRoot,
    payload: {
      branch: details.branch,
      commandId: details.commandId,
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
        input: payload.input,
        renderedCommand: payload.renderedCommand,
        worktreePath: payload.worktreePath,
        env: payload.env,
      });
      context.notifyStarted(startedJob);
    },
  });

  const resolveEnvSyncSourceRoot = async (_worktrees: Awaited<ReturnType<typeof listWorktrees>>) => options.configWorktreePath;

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
        worktrees: options.runtimes.mergeInto(worktrees),
      };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.get("/shutdown-status", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const writeStatus = (status: ShutdownStatus) => {
      res.write(`data: ${JSON.stringify(status)}\n\n`);
    };

    const unsubscribe = options.shutdownStatus.subscribe(writeStatus);

    req.on("close", () => {
      unsubscribe();
      res.end();
    });
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
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      const writeEvent = (type: "snapshot" | "update", branch: string) => {
        const event = {
          type,
          job: getAiCommandJob(branch),
        };
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      };

      const branch = req.params.branch;
      writeEvent("snapshot", branch);
      const unsubscribe = subscribeToAiCommandJob(branch, () => {
        writeEvent("update", branch);
      });
      const keepAlive = setInterval(() => {
        res.write(`: keep-alive\n\n`);
      }, 15000);

      req.on("close", () => {
        unsubscribe();
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
      const body = req.body as CreateProjectManagementDocumentRequest;
      if (!body?.title?.trim()) {
        res.status(400).json({ message: "Document title is required." });
        return;
      }

      const payload: ProjectManagementDocumentResponse = await createProjectManagementDocument(options.repoRoot, {
        title: body.title,
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        tags: Array.isArray(body.tags) ? body.tags.map((entry) => String(entry)) : [],
        dependencies: Array.isArray(body.dependencies) ? body.dependencies.map((entry) => String(entry)) : [],
        status: typeof body.status === "string" ? body.status : undefined,
        assignee: typeof body.assignee === "string" ? body.assignee : undefined,
      });
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

  router.post("/worktrees", async (req, res, next) => {
    try {
      const config = await loadCurrentConfig();
      const body = req.body as CreateWorktreeRequest;
      if (!body?.branch?.trim()) {
        res.status(400).json({ message: "branch is required" });
        return;
      }

      const worktree = await createWorktree(options.repoRoot, config, body);
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

      const existingRuntime = options.runtimes.get(worktree.branch);
      if (existingRuntime) {
        res.json(existingRuntime);
        return;
      }

      const { runtime } = await createRuntime(config, options.repoRoot, worktree.branch, worktree.worktreePath);
      options.runtimes.set(runtime);
      await ensureRuntimeTerminalSession(runtime, options.repoRoot);
      await runStartupCommands(config.startupCommands, worktree.worktreePath, buildRuntimeProcessEnv(runtime));
      await startConfiguredBackgroundCommands({
        config,
        branch: worktree.branch,
        worktreePath: worktree.worktreePath,
        runtime,
      });
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

    try {
      const config = await loadCurrentConfig();
      const worktrees = await listWorktrees(options.repoRoot);
      const worktree = worktrees.find((entry) => entry.branch === req.params.branch);
      const body = req.body as RunAiCommandRequest;
      input = typeof body?.input === "string" ? body.input : "";
      commandId = parseAiCommandId(body?.commandId);
      const documentId = typeof body?.documentId === "string" && body.documentId.trim() ? body.documentId.trim() : null;

      if (!worktree) {
        await writeImmediateAiFailureLog({
          branch: req.params.branch,
          documentId,
          commandId,
          worktreePath: "",
          renderedCommand: "",
          input,
          error: new Error(`Unknown worktree ${req.params.branch}`),
        });
        res.status(404).json({ message: `Unknown worktree ${req.params.branch}` });
        return;
      }

      worktreePath = worktree.worktreePath;

      const template = resolveAiCommandTemplate(config.aiCommands, commandId);
      if (!template) {
        await writeImmediateAiFailureLog({
          branch: worktree.branch,
          documentId,
          commandId,
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
          worktreePath,
          renderedCommand: template,
          input,
          error: new Error("AI command input is required."),
        });
        res.status(400).json({ message: "AI command input is required." });
        return;
      }

      if (documentId) {
        try {
          const documentPayload = await getProjectManagementDocument(options.repoRoot, documentId);
          const documentsPayload = await listProjectManagementDocuments(options.repoRoot);
          input = buildProjectManagementAiPrompt({
            branch: worktree.branch,
            worktreePath,
            requestedChange: input.trim(),
            document: documentPayload.document,
            relatedDocuments: documentsPayload.documents,
          });
        } catch (error) {
          const reason = error instanceof Error ? error : new Error(String(error));
          await writeImmediateAiFailureLog({
            branch: worktree.branch,
            documentId,
            commandId,
            worktreePath,
            renderedCommand: template,
            input,
            error: reason,
          });
          res.status(404).json({ message: `Unknown project management document ${documentId}.` });
          return;
        }
      }

      if (getAiCommandJob(worktree.branch)?.status === "running") {
        res.status(409).json({ message: `AI command already running for ${worktree.branch}.` });
        return;
      }

      console.info(
        `[ai-command] starting branch=${worktree.branch} path=${worktree.worktreePath} input=${JSON.stringify(formatLogSnippet(input))}`,
      );

      const runtime = options.runtimes.get(worktree.branch);
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
        input,
        renderedCommand,
        worktreePath,
        env,
      };
      const job = documentId
        ? await enqueueProjectManagementDocumentAiJob({
          branch: runDetails.branch,
          documentId,
          commandId: runDetails.commandId,
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
      const inMemoryJob = getAiCommandJob(req.params.branch);
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
        ? failAiCommandJob({
          branch: req.params.branch,
          jobId: job.jobId,
          error: cancellationMessage,
        })
        : null;

      if (!failedJob && persistedLog) {
        await safeWriteAiRequestLog({
          fileName: persistedLog.fileName,
          jobId: persistedLog.jobId,
          repoRoot: options.repoRoot,
          branch: persistedLog.branch,
          documentId: persistedLog.documentId ?? null,
          commandId: persistedLog.commandId,
          worktreePath: persistedLog.worktreePath,
          renderedCommand: persistedLog.command,
          input: persistedLog.request,
          stdout: persistedLog.response.stdout,
          stderr: `${persistedLog.response.stderr}${cancellationMessage}`,
          startedAt: persistedLog.timestamp,
          completedAt: new Date().toISOString(),
          pid: persistedLog.pid ?? null,
          exitCode: persistedLog.exitCode ?? null,
          processName: persistedLog.processName,
          error: new Error(cancellationMessage),
        });
      }

      const settledJob = await Promise.race([
        waitForAiCommandJob(req.params.branch, job.jobId),
        new Promise<typeof job>((resolve) => {
          setTimeout(() => {
            void (async () => {
              const nextInMemoryJob = getAiCommandJob(req.params.branch);
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
            })();
          }, Math.max(aiProcessPollIntervalMs * 4, 500));
        }),
      ]);

      const payload: RunAiCommandResponse = { job: failedJob ?? settledJob };
      res.json(payload);
    } catch (error) {
      next(error);
    }
  });

  router.post("/worktrees/:branch/runtime/stop", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
      if (!runtime) {
        res.status(404).json({ message: `No runtime for branch ${req.params.branch}` });
        return;
      }

      await stopAllBackgroundCommands(req.params.branch, runtime.worktreePath);
      await killTmuxSession(runtime);
      options.runtimes.delete(req.params.branch);
      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.get("/worktrees/:branch/runtime/tmux-clients", async (req, res, next) => {
    try {
      const runtime = options.runtimes.get(req.params.branch);
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
        runtime,
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

      const runtime = options.runtimes.get(worktree.branch);
      if (runtime) {
        await stopAllBackgroundCommands(worktree.branch, runtime.worktreePath);
        await killTmuxSession(runtime);
        options.runtimes.delete(worktree.branch);
      } else {
        await killTmuxSessionByName(getTmuxSessionName(options.repoRoot, worktree.branch), worktree.worktreePath);
      }

      await removeWorktree(options.repoRoot, worktree.worktreePath);
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
        options.runtimes.get(worktree.branch),
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
        runtime: options.runtimes.get(worktree.branch),
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
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
        options.runtimes.get(worktree.branch),
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
        runtime: options.runtimes.get(worktree.branch),
        commandName: decodedName,
      });

      const commands: BackgroundCommandState[] = await listBackgroundCommands(
        config,
        worktree.branch,
        worktree.worktreePath,
        options.runtimes.get(worktree.branch),
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
