import type { AiCommandJob, AiCommandLogEntry } from "@shared/types";

export function toAiCommandJobFromLog(logDetail: AiCommandLogEntry): AiCommandJob {
  return {
    jobId: logDetail.jobId,
    fileName: logDetail.fileName,
    worktreeId: logDetail.worktreeId,
    branch: logDetail.branch,
    documentId: logDetail.documentId ?? null,
    commandId: logDetail.commandId,
    sessionId: logDetail.sessionId ?? null,
    command: logDetail.command,
    input: logDetail.request,
    status: logDetail.status,
    startedAt: logDetail.timestamp,
    completedAt: logDetail.completedAt,
    stdout: logDetail.response.stdout,
    stderr: logDetail.response.stderr,
    outputEvents: logDetail.response.events?.map((entry) => ({ ...entry })) ?? [],
    pid: logDetail.pid ?? null,
    exitCode: logDetail.exitCode ?? null,
    processName: logDetail.processName ?? null,
    error: logDetail.error?.message ?? null,
    origin: logDetail.origin ?? null,
    worktreePath: logDetail.worktreePath,
  };
}
