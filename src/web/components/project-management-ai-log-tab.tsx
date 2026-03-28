import { useEffect, useMemo, useRef } from "react";
import type {
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandOrigin,
  AiCommandOutputEvent,
} from "@shared/types";
import { marked } from "marked";
import { MatrixAccordion, MatrixBadge, MatrixDetailField, MatrixMetric } from "./matrix-primitives";
import { formatAutoRefreshStatus } from "../lib/auto-refresh-status";

function getAiCommandLabel(commandId: "smart" | "simple") {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

function formatSelectedLabel(logDetail: AiCommandLogEntry | null) {
  if (!logDetail) {
    return "None";
  }

  return `${logDetail.branch} - ${logDetail.status}`;
}

function getLiveDetailDescription(logDetail: AiCommandLogEntry | null) {
  if (!logDetail) {
    return "Select an AI log to inspect mixed output, timing gaps, and any captured failure details.";
  }

  if (logDetail.status === "running") {
    return "Live output is streaming while this job is still running.";
  }

  return "Captured request, mixed output, and any failure details for this completed run.";
}

function getStatusTone(status: string) {
  if (status === "running") {
    return "warning" as const;
  }

  if (status === "failed") {
    return "danger" as const;
  }

  return "active" as const;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return "Unavailable";
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString();
}

function formatElapsedSincePrevious(previousTimestamp: string, nextTimestamp: string) {
  const previous = Date.parse(previousTimestamp);
  const next = Date.parse(nextTimestamp);

  if (Number.isNaN(previous) || Number.isNaN(next) || next <= previous) {
    return null;
  }

  const deltaMs = next - previous;
  const totalSeconds = Math.round(deltaMs / 1000);
  if (totalSeconds < 60) {
    return `+${Math.max(1, totalSeconds)} second${totalSeconds === 1 ? "" : "s"} since previous output`;
  }

  const totalMinutes = Math.round(deltaMs / 60000);
  if (totalMinutes < 60) {
    return `+${totalMinutes} minute${totalMinutes === 1 ? "" : "s"} since previous output`;
  }

  const totalHours = Math.floor(totalMinutes / 60);
  const remainingMinutes = totalMinutes % 60;
  if (!remainingMinutes) {
    return `+${totalHours} hour${totalHours === 1 ? "" : "s"} since previous output`;
  }

  return `+${totalHours} hour${totalHours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"} since previous output`;
}

function getOriginContextTitle(origin: AiCommandOrigin | null | undefined, branch: string) {
  if (!origin) {
    return `AI run · ${branch}`;
  }

  if (origin.kind === "worktree-environment") {
    const source = origin.location.environmentSubTab === "background" ? "Background command" : "Environment terminal";
    return `${source} · ${origin.location.branch ?? branch}`;
  }

  if (origin.kind === "project-management-document") {
    return `Document edit · ${origin.label}`;
  }

  if (origin.kind === "project-management-document-run") {
    return `Execution run · ${origin.label}`;
  }

  if (origin.kind === "git-conflict-resolution") {
    return `Git conflict resolution · ${origin.location.branch ?? branch}`;
  }

  return origin.label;
}

function getOriginContextSubtitle(origin: AiCommandOrigin | null | undefined, branch: string) {
  if (origin?.description) {
    return origin.description;
  }

  if (origin?.label) {
    return origin.label;
  }

  return `Started from ${branch}.`;
}

function getOriginDescription(origin: AiCommandOrigin | null | undefined) {
  return origin?.description ?? "This run does not include a saved start location.";
}

function renderMarkdownOutput(markdown: string, tone: "default" | "danger" = "default") {
  return (
    <div className="max-h-[24rem] overflow-auto border theme-border-subtle p-3">
      <div
        className={`pm-markdown text-sm ${tone === "danger" ? "theme-text-danger" : "theme-text"}`}
        dangerouslySetInnerHTML={{ __html: marked.parse(markdown || "(empty)") }}
      />
    </div>
  );
}

function getOutputEvents(logDetail: AiCommandLogEntry): AiCommandOutputEvent[] {
  if (logDetail.response.events?.length) {
    return logDetail.response.events;
  }

  const fallbackEvents: AiCommandOutputEvent[] = [];
  if (logDetail.response.stdout) {
    fallbackEvents.push({
      id: `${logDetail.fileName}:stdout`,
      source: "stdout",
      text: logDetail.response.stdout,
      timestamp: logDetail.timestamp,
    });
  }

  if (logDetail.response.stderr) {
    fallbackEvents.push({
      id: `${logDetail.fileName}:stderr`,
      source: "stderr",
      text: logDetail.response.stderr,
      timestamp: logDetail.completedAt ?? logDetail.timestamp,
    });
  }

  return fallbackEvents;
}

function getCandidateStartedAt(candidate: AiCommandJob | AiCommandLogSummary) {
  return "startedAt" in candidate ? candidate.startedAt : candidate.timestamp;
}

interface ProjectManagementAiLogTabProps {
  logs: AiCommandLogSummary[];
  logDetail: AiCommandLogEntry | null;
  loading: boolean;
  error?: string | null;
  lastUpdatedAt?: string | null;
  runningJobs: AiCommandJob[];
  onSelectLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onCancelJob: (branch: string) => Promise<AiCommandJob | null>;
  onOpenOrigin: (origin: AiCommandOrigin) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

export function ProjectManagementAiLogTab({
  logs,
  logDetail,
  loading,
  error = null,
  lastUpdatedAt = null,
  runningJobs,
  onSelectLog,
  onCancelJob,
  onOpenOrigin,
  onRetry,
}: ProjectManagementAiLogTabProps) {
  const primaryCandidate = runningJobs[0] ?? logs[0] ?? null;
  const autoSelectedFileRef = useRef<string | null>(null);
  const refreshStatusLabel = formatAutoRefreshStatus(lastUpdatedAt);

  useEffect(() => {
    if (loading || logDetail || !primaryCandidate) {
      return;
    }

    if (autoSelectedFileRef.current === primaryCandidate.fileName) {
      return;
    }

    autoSelectedFileRef.current = primaryCandidate.fileName;
    void onSelectLog(primaryCandidate.fileName, { silent: true });
  }, [loading, logDetail, onSelectLog, primaryCandidate]);

  const detailOutputEvents = useMemo(
    () => (logDetail ? getOutputEvents(logDetail) : []),
    [logDetail],
  );

  const recentEntries = useMemo(() => logs.slice(0, 4), [logs]);

  function renderAccordionSummary(title: string, description: string) {
    return (
      <div>
        <p className="text-sm font-semibold theme-text-strong">{title}</p>
        <p className="mt-1 text-xs theme-text-muted">{description}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-3">
        <MatrixMetric label="Running jobs" value={String(runningJobs.length)} />
        <MatrixMetric label="Saved logs" value={String(logs.length)} />
        <MatrixMetric label="Selected log" value={formatSelectedLabel(logDetail)} />
      </div>

      <div className="flex items-start justify-between gap-3 border theme-border-subtle p-4">
        <div>
          <p className="matrix-kicker">AI activity</p>
          <h3 className="mt-2 text-lg font-semibold theme-text-strong">Saved runs and live output</h3>
          <p className="mt-1 text-sm theme-text-muted">Inspect active work, review completed output, and jump back to where each AI run started.</p>
        </div>
        <div className="flex flex-col items-end gap-2 text-xs">
          {error ? (
            <>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <MatrixBadge tone="danger" compact>Sync issue</MatrixBadge>
                {onRetry ? (
                  <button
                    type="button"
                    className="matrix-button rounded-none px-2 py-1 text-xs"
                    onClick={() => void onRetry()}
                  >
                    Retry
                  </button>
                ) : null}
              </div>
              <span className="text-right theme-text-danger">{error}</span>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {loading ? <MatrixBadge tone="warning">Loading…</MatrixBadge> : null}
                <MatrixBadge tone={runningJobs.length ? "warning" : "neutral"} compact>
                  {runningJobs.length ? "Live updates on" : "Idle"}
                </MatrixBadge>
              </div>
              <span className="theme-text-muted">{refreshStatusLabel}</span>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="border theme-border-subtle p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Running now</p>
              <MatrixBadge tone={runningJobs.length ? "warning" : "neutral"} compact>
                {runningJobs.length}
              </MatrixBadge>
            </div>
            <div className="mt-3 space-y-2">
              {runningJobs.length ? runningJobs.map((job) => (
                <div
                  key={job.jobId}
                  className={`border px-3 py-3 transition ${logDetail?.fileName === job.fileName ? "theme-pill-emphasis theme-text-strong" : "theme-border-subtle theme-surface-soft"}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => void onSelectLog(job.fileName, { silent: true })}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold theme-text-strong">{getOriginContextTitle(job.origin, job.branch)}</p>
                          <p className="mt-1 text-xs theme-text-muted">{job.branch}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
                          <MatrixBadge tone={getStatusTone(job.status)} compact>{job.status}</MatrixBadge>
                        </div>
                      </div>
                      <p className="mt-2 text-xs theme-text-muted">Started {formatTimestamp(job.startedAt)}</p>
                      <p className="mt-1 line-clamp-2 text-xs theme-text-muted">{getOriginContextSubtitle(job.origin, job.branch)}</p>
                      {job.pid ? <p className="mt-1 text-xs theme-text-muted">PID {job.pid}</p> : null}
                    </button>
                    <div className="flex flex-col gap-2">
                      {job.origin ? (
                        <button
                          type="button"
                          className="matrix-button rounded-none px-2 py-1 text-xs"
                          onClick={() => void onOpenOrigin(job.origin as AiCommandOrigin)}
                        >
                          Open origin
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="matrix-button rounded-none px-2 py-1 text-xs"
                        onClick={() => void onCancelJob(job.branch)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              )) : (
                <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                  No AI jobs are currently running.
                </div>
              )}
            </div>
          </div>

          <div className="border theme-border-subtle p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Saved logs</p>
              {loading ? <MatrixBadge tone="warning" compact>loading</MatrixBadge> : null}
            </div>
            <div className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
              {logs.length ? logs.map((log) => (
                <button
                  key={log.fileName}
                  type="button"
                  className={`w-full border px-3 py-3 text-left transition ${logDetail?.fileName === log.fileName ? "theme-pill-emphasis theme-text-strong" : "theme-border-subtle theme-surface-soft hover:theme-surface-soft"}`}
                  onClick={() => void onSelectLog(log.fileName, { silent: true })}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{getOriginContextTitle(log.origin, log.branch)}</p>
                      <p className="mt-1 text-xs theme-text-muted">{log.branch}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <MatrixBadge tone="neutral" compact>{getAiCommandLabel(log.commandId)}</MatrixBadge>
                      <MatrixBadge tone={getStatusTone(log.status)} compact>{log.status}</MatrixBadge>
                    </div>
                  </div>
                  <p className="mt-2 text-xs theme-text-muted">{formatTimestamp(log.timestamp)}</p>
                  <p className="mt-1 line-clamp-2 text-xs theme-text-muted">{getOriginContextSubtitle(log.origin, log.branch)}</p>
                </button>
              )) : (
                <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                  No AI logs have been written yet.
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="border theme-border-subtle p-4">
          {logDetail ? (
            <div className="space-y-4">
              <div className="border theme-border-subtle p-4 theme-surface-soft">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="matrix-kicker">AI log detail</p>
                  <MatrixBadge tone={getStatusTone(logDetail.status)} compact>{logDetail.status}</MatrixBadge>
                  <MatrixBadge tone="neutral" compact>{getAiCommandLabel(logDetail.commandId)}</MatrixBadge>
                  <MatrixBadge tone="neutral" compact>{logDetail.fileName}</MatrixBadge>
                  {logDetail.status === "running" ? <MatrixBadge tone="warning" compact>live</MatrixBadge> : null}
                  {logDetail.status === "running" ? (
                    <button
                      type="button"
                      className="matrix-button rounded-none px-2 py-1 text-xs"
                      onClick={() => void onCancelJob(logDetail.branch)}
                    >
                      Cancel job
                    </button>
                  ) : null}
                </div>
                <h3 className="mt-3 text-xl font-semibold theme-text-strong">{getOriginContextTitle(logDetail.origin, logDetail.branch)}</h3>
                <p className="mt-2 text-sm theme-text-muted">{getLiveDetailDescription(logDetail)}</p>
              </div>

              <div className="theme-inline-panel p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Started from</p>
                    <p className="mt-2 text-sm font-semibold theme-text-strong">{getOriginContextTitle(logDetail.origin, logDetail.branch)}</p>
                    <p className="mt-1 text-xs theme-text-muted">{getOriginDescription(logDetail.origin)}</p>
                  </div>
                  {logDetail.origin ? (
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      onClick={() => void onOpenOrigin(logDetail.origin as AiCommandOrigin)}
                    >
                      Open origin
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="grid gap-3 md:grid-cols-2">
                <MatrixDetailField label="Branch" value={logDetail.branch} mono />
                <MatrixDetailField label="Started" value={formatTimestamp(logDetail.timestamp)} />
                <MatrixDetailField label="Completed" value={formatTimestamp(logDetail.completedAt)} />
                <MatrixDetailField label="PID" value={logDetail.pid ? String(logDetail.pid) : "Unavailable"} />
                <MatrixDetailField label="Exit code" value={typeof logDetail.exitCode === "number" ? String(logDetail.exitCode) : "Pending"} />
                <MatrixDetailField label="AI command" value={getAiCommandLabel(logDetail.commandId)} />
                <MatrixDetailField label="Output updates" value={String(detailOutputEvents.length)} />
                <MatrixDetailField label="Worktree path" value={logDetail.worktreePath} mono />
                <MatrixDetailField label="Command" value={logDetail.command} mono />
              </div>

              <div className="border theme-border-subtle p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold theme-text-strong">Mixed output timeline</p>
                    <p className="mt-1 text-xs theme-text-muted">Stdout and stderr stay in one stream so pauses and warnings are easier to follow.</p>
                  </div>
                  <MatrixBadge tone={detailOutputEvents.some((event) => event.source === "stderr") ? "warning" : "neutral"} compact>
                    {detailOutputEvents.length} update{detailOutputEvents.length === 1 ? "" : "s"}
                  </MatrixBadge>
                </div>
                {detailOutputEvents.length ? (
                  <div className="mt-4 space-y-3">
                    {detailOutputEvents.map((event, index) => {
                      const elapsedLabel = index > 0
                        ? formatElapsedSincePrevious(detailOutputEvents[index - 1]!.timestamp, event.timestamp)
                        : null;

                      return (
                        <div key={event.id} className="space-y-2">
                          {elapsedLabel ? (
                            <p className="theme-timestamp text-[11px] uppercase tracking-[0.14em]">{elapsedLabel}</p>
                          ) : null}
                          <div className={`border px-3 py-3 ${event.source === "stderr" ? "theme-log-entry-error" : "theme-log-entry"}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <MatrixBadge tone={event.source === "stderr" ? "warning" : "neutral"} compact>{event.source}</MatrixBadge>
                              <span className="theme-timestamp text-xs">{formatTimestamp(event.timestamp)}</span>
                            </div>
                            <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs">{event.text}</pre>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-4 matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                    No output has been captured for this run yet.
                  </div>
                )}
              </div>

              <MatrixAccordion summary={renderAccordionSummary("Request", "Prompt passed into the configured AI command.")} defaultOpen>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.request}</pre>
              </MatrixAccordion>

              <MatrixAccordion
                summary={renderAccordionSummary("Response stdout", "The AI command output captured from stdout.")}
                defaultOpen
              >
                {renderMarkdownOutput(logDetail.response.stdout)}
              </MatrixAccordion>

              <MatrixAccordion summary={renderAccordionSummary("Response stderr", "The AI command output captured from stderr.")}>
                {renderMarkdownOutput(logDetail.response.stderr, "danger")}
              </MatrixAccordion>

              {logDetail.error ? (
                <MatrixAccordion summary={renderAccordionSummary("Error", "Normalized error details captured for failed runs.")}>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-danger">{JSON.stringify(logDetail.error, null, 2)}</pre>
                </MatrixAccordion>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="theme-inline-panel p-4">
                <p className="matrix-kicker">AI log overview</p>
                <h3 className="mt-2 text-lg font-semibold theme-text-strong">Keep the latest run in view</h3>
                <p className="mt-2 text-sm theme-text-muted">
                  {primaryCandidate
                    ? "The newest run is ready to open, and recent entries stay visible here even before you click into a specific log."
                    : "AI runs from environment, git, and project-management flows will appear here with mixed output and timing context."}
                </p>
                {primaryCandidate ? (
                  <div className="mt-4 border theme-border-subtle p-4 theme-surface-soft">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold theme-text-strong">{getOriginContextTitle(primaryCandidate.origin, primaryCandidate.branch)}</p>
                        <p className="mt-1 text-xs theme-text-muted">{primaryCandidate.branch}</p>
                        <p className="mt-2 text-xs theme-text-muted">
                          {formatTimestamp(getCandidateStartedAt(primaryCandidate))}
                        </p>
                        <p className="mt-1 text-xs theme-text-muted">{getOriginContextSubtitle(primaryCandidate.origin, primaryCandidate.branch)}</p>
                      </div>
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-2 text-sm"
                        onClick={() => void onSelectLog(primaryCandidate.fileName, { silent: true })}
                      >
                        Open latest run
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="border theme-border-subtle p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-semibold theme-text-strong">Recent activity</p>
                  <MatrixBadge tone={recentEntries.length ? "neutral" : "idle"} compact>{recentEntries.length}</MatrixBadge>
                </div>
                {recentEntries.length ? (
                  <div className="mt-4 space-y-2">
                    {recentEntries.map((entry) => (
                      <button
                        key={entry.fileName}
                        type="button"
                        className="w-full border theme-border-subtle px-3 py-3 text-left transition theme-surface-soft hover:theme-surface-soft"
                        onClick={() => void onSelectLog(entry.fileName, { silent: true })}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold theme-text-strong">{getOriginContextTitle(entry.origin, entry.branch)}</p>
                            <p className="mt-1 text-xs theme-text-muted">{entry.branch}</p>
                          </div>
                          <MatrixBadge tone={getStatusTone(entry.status)} compact>{entry.status}</MatrixBadge>
                        </div>
                        <p className="mt-2 text-xs theme-text-muted">{formatTimestamp(entry.timestamp)}</p>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                    No AI logs have been written yet.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
