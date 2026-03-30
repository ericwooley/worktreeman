import type { AiCommandId, AiCommandJob, AiCommandOutputEvent } from "@shared/types";

import { MatrixBadge } from "./matrix-primitives";

function getAiCommandLabel(commandId: AiCommandId): string {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

function getAiJobTone(status: AiCommandJob["status"]) {
  if (status === "running") {
    return "warning" as const;
  }

  if (status === "failed") {
    return "danger" as const;
  }

  return "active" as const;
}

function getAiOutputText(job: AiCommandJob): string {
  if (job.stdout && job.stderr) {
    return `${job.stdout}\n\n--- stderr ---\n${job.stderr}`;
  }

  if (job.stdout) {
    return job.stdout;
  }

  if (job.stderr) {
    return job.stderr;
  }

  return job.status === "running" ? "Waiting for live output..." : "No output captured.";
}

export function getAiOutputEvents(job: AiCommandJob): AiCommandOutputEvent[] {
  if (job.outputEvents?.length) {
    return job.outputEvents;
  }

  const fallbackEvents: AiCommandOutputEvent[] = [];
  if (job.stdout) {
    fallbackEvents.push({
      id: `${job.fileName}:stdout`,
      source: "stdout",
      text: job.stdout,
      timestamp: job.startedAt,
    });
  }

  if (job.stderr) {
    fallbackEvents.push({
      id: `${job.fileName}:stderr`,
      source: "stderr",
      text: job.stderr,
      timestamp: job.completedAt ?? job.startedAt,
    });
  }

  return fallbackEvents;
}

interface ProjectManagementAiOutputViewerProps {
  source: "worktree" | "document";
  job: AiCommandJob;
  summary: string | null;
  expanded?: boolean;
  onCancel: () => void;
  onOpenModal?: () => void;
}

export function ProjectManagementAiOutputViewer({
  source,
  job,
  summary,
  expanded = false,
  onCancel,
  onOpenModal,
}: ProjectManagementAiOutputViewerProps) {
  const running = job.status === "running";
  const title = source === "worktree" ? "Worktree AI" : "Document AI";
  const outputEvents = getAiOutputEvents(job);
  const description = source === "worktree"
    ? running
      ? `Streaming mixed stdout and stderr from ${job.branch} while the worktree run is active.`
      : summary ?? `Captured output from ${job.branch}.`
    : running
      ? `Streaming mixed stdout and stderr while the saved document updates in ${job.branch}.`
      : summary ?? `Captured output from ${job.branch}.`;
  const supplementalSummary = summary && summary !== description ? summary : null;

  return (
    <div className={`pm-ai-output-shell border theme-border-subtle ${running ? "pm-ai-output-shell-running" : ""} ${expanded ? "p-5" : "p-4"}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pm-ai-live-orb ${running ? "pm-ai-live-orb-running" : ""}`} aria-hidden="true" />
            <p className="matrix-kicker">{title}</p>
            <MatrixBadge tone={getAiJobTone(job.status)} compact>{running ? "live" : job.status}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{job.branch}</MatrixBadge>
            {job.pid ? <MatrixBadge tone="neutral" compact>{`PID ${job.pid}`}</MatrixBadge> : null}
          </div>
          <h3 className={`mt-2 font-semibold theme-text-strong ${expanded ? "text-xl" : "text-lg"}`}>
            {running ? `${title} is working` : `${title} output`}
          </h3>
          <p className="mt-1 text-sm theme-text-muted">{description}</p>
          {supplementalSummary ? <p className="mt-2 text-xs theme-text-soft">{supplementalSummary}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          {running ? (
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              onClick={onCancel}
            >
              Cancel AI
            </button>
          ) : null}
          {onOpenModal ? (
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              onClick={onOpenModal}
            >
              Open output modal
            </button>
          ) : null}
        </div>
      </div>

      {running ? (
        <div className="pm-ai-output-activity mt-4" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
          <span />
        </div>
      ) : null}

      {outputEvents.length ? (
        <div className={`mt-4 space-y-3 overflow-auto ${expanded ? "max-h-[65vh]" : "max-h-[24rem]"}`}>
          {outputEvents.map((event) => (
            <div key={event.id} className={`border px-3 py-3 ${event.source === "stderr" ? "theme-log-entry-error" : "theme-log-entry"}`}>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <MatrixBadge tone={event.source === "stderr" ? "warning" : "neutral"} compact>{event.source}</MatrixBadge>
              </div>
              <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{event.text}</pre>
            </div>
          ))}
        </div>
      ) : (
        <pre className={`pm-ai-output-pre mt-4 overflow-auto px-4 py-4 font-mono text-xs leading-6 ${expanded ? "max-h-[65vh]" : "max-h-[24rem]"}`}>
          {getAiOutputText(job)}
        </pre>
      )}
    </div>
  );
}
