import type { AiCommandJob, AiCommandOriginKind } from "@shared/types";

export type BrowserNotificationPermission = NotificationPermission | "unsupported";

interface BrowserAttentionState {
  visibilityState: DocumentVisibilityState;
  hasFocus: boolean;
}

interface BrowserNotificationApi {
  permission: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
}

const NOTIFICATION_REASON_MAX_LENGTH = 120;

function getAiCommandLabel(commandId: AiCommandJob["commandId"]): string {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

function truncateNotificationReason(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  return normalized.length > NOTIFICATION_REASON_MAX_LENGTH
    ? `${normalized.slice(0, NOTIFICATION_REASON_MAX_LENGTH - 3)}...`
    : normalized;
}

function describeAiJobOrigin(kind?: AiCommandOriginKind | null): string {
  switch (kind) {
    case "project-management-document":
      return "Document update";
    case "project-management-document-run":
      return "Worktree task";
    case "git-conflict-resolution":
      return "Conflict resolution";
    case "worktree-environment":
      return "Worktree command";
    default:
      return "AI task";
  }
}

export function shouldNotifyAiJobCompletion(options: {
  previousJob: AiCommandJob | null;
  nextJob: AiCommandJob | null;
  permission: BrowserNotificationPermission;
  attentionState: BrowserAttentionState;
}): boolean {
  const { previousJob, nextJob, permission, attentionState } = options;

  if (!previousJob || !nextJob) {
    return false;
  }

  if (permission !== "granted") {
    return false;
  }

  if (previousJob.jobId !== nextJob.jobId) {
    return false;
  }

  if (previousJob.status !== "running" || nextJob.status === "running") {
    return false;
  }

  return attentionState.visibilityState !== "visible" || !attentionState.hasFocus;
}

export function buildAiJobNotification(job: AiCommandJob): { title: string; body: string; tag: string } {
  const label = getAiCommandLabel(job.commandId);
  const taskLabel = describeAiJobOrigin(job.origin?.kind);
  const title = job.status === "failed" ? `${label} failed` : `${label} finished`;
  const reason = truncateNotificationReason(job.error || job.stderr || "");

  if (job.status === "failed") {
    return {
      title,
      body: reason
        ? `${taskLabel} failed in ${job.branch}: ${reason}`
        : `${taskLabel} failed in ${job.branch}. Open the AI log for details.`,
      tag: `ai-job-${job.jobId}`,
    };
  }

  return {
    title,
    body: `${taskLabel} finished in ${job.branch}.`,
    tag: `ai-job-${job.jobId}`,
  };
}

export async function requestBrowserNotificationPermission(
  notificationApi?: BrowserNotificationApi | null,
): Promise<BrowserNotificationPermission> {
  if (!notificationApi) {
    return "unsupported";
  }

  if (notificationApi.permission !== "default" || !notificationApi.requestPermission) {
    return notificationApi.permission;
  }

  return notificationApi.requestPermission();
}
