import { useMemo } from "react";
import type {
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandOrigin,
  AiCommandOutputEvent,
} from "@shared/types";
import { MatrixCard, MatrixCardFooter, MatrixCardHeader } from "./matrix-card";
import { MatrixAccordion, MatrixBadge, MatrixDetailField, MatrixMetric, MatrixSectionIntro, MatrixSpinner } from "./matrix-primitives";
import { LoadingOverlay } from "./loading";
import { useItemLoading } from "../hooks/useItemLoading";
import { useAiLogAutoSelect } from "../hooks/useAiLogAutoSelect";
import { toAiCommandJobFromLog } from "../lib/ai-command-log";
import { formatAutoRefreshStatus } from "../lib/auto-refresh-status";
import { ProjectManagementAiOutputViewer } from "./project-management-ai-output-viewer";

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
    return "Select an AI log to inspect mixed output and any captured failure details.";
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

function getEntryActionLabel(origin: AiCommandOrigin | null | undefined) {
  return origin ? "Open origin" : "Open run";
}

function getOutputEvents(logDetail: AiCommandLogEntry): AiCommandOutputEvent[] {
  if (logDetail.response.events?.length) {
    return logDetail.response.events;
  }

  const fallbackEvents: AiCommandOutputEvent[] = [];
  if (logDetail.response.stdout) {
    fallbackEvents.push({
      id: `${logDetail.jobId}:stdout`,
      source: "stdout",
      text: logDetail.response.stdout,
      timestamp: logDetail.timestamp,
    });
  }

  if (logDetail.response.stderr) {
    fallbackEvents.push({
      id: `${logDetail.jobId}:stderr`,
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
  selectedJobId?: string | null;
  loading: boolean;
  error?: string | null;
  lastUpdatedAt?: string | null;
  runningJobs: AiCommandJob[];
  onSelectLog: (jobId: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onCancelJob: (branch: string) => Promise<AiCommandJob | null>;
  onOpenOrigin: (origin: AiCommandOrigin) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

export function ProjectManagementAiLogTab({
  logs,
  logDetail,
  selectedJobId = null,
  loading,
  error = null,
  lastUpdatedAt = null,
  runningJobs,
  onSelectLog,
  onCancelJob,
  onOpenOrigin,
  onRetry,
}: ProjectManagementAiLogTabProps) {
  const refreshStatusLabel = formatAutoRefreshStatus(lastUpdatedAt);
  const { loadingId: loadingJobId, startLoading, stopLoading } = useItemLoading();

  async function handleSelectLog(jobId: string, options?: { silent?: boolean }) {
    startLoading(jobId);
    try {
      await onSelectLog(jobId, options);
    } finally {
      stopLoading();
    }
  }

  const visibleLogs = useMemo(() => {
    const historicalLogs = logs.filter((log) => log.status !== "running");
    if (!runningJobs.length) {
      return historicalLogs;
    }

    const runningJobIds = new Set(runningJobs.map((job) => job.jobId));
    return historicalLogs.filter((log) => !runningJobIds.has(log.jobId));
  }, [logs, runningJobs]);

  const primaryCandidate = runningJobs[0] ?? visibleLogs[0] ?? null;

  useAiLogAutoSelect({
    loading,
    selectedJobId: selectedJobId ?? logDetail?.jobId ?? null,
    primaryCandidateJobId: primaryCandidate?.jobId ?? null,
    onSelectLog,
  });

  const detailOutputEvents = useMemo(
    () => (logDetail ? getOutputEvents(logDetail) : []),
    [logDetail],
  );

  const recentEntries = useMemo(() => visibleLogs.slice(0, 4), [visibleLogs]);

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
      <MatrixSectionIntro
        kicker="AI activity"
        title="Saved runs and live output"
        description="Inspect active work, review completed output, and jump back to where each AI run started."
        status={error ? (
          <>
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
            <span className="text-right theme-text-danger">{error}</span>
          </>
        ) : (
          <>
            {loading ? <MatrixBadge tone="warning">Loading…</MatrixBadge> : null}
            <MatrixBadge tone={runningJobs.length ? "warning" : "neutral"} compact>
              {runningJobs.length ? "Live updates on" : "Idle"}
            </MatrixBadge>
            <span className="theme-text-muted">{refreshStatusLabel}</span>
          </>
        )}
        metrics={(
          <div className="grid gap-3 md:grid-cols-3">
            <MatrixMetric label="Running jobs" value={String(runningJobs.length)} />
            <MatrixMetric label="Saved logs" value={String(visibleLogs.length)} />
            <MatrixMetric label="Selected log" value={loadingJobId ? "Loading…" : formatSelectedLabel(logDetail)} />
          </div>
        )}
      />

      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <div className="space-y-4">
          <div className="border theme-border-subtle p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Saved logs</p>
              {loading ? <MatrixBadge tone="warning" compact>loading</MatrixBadge> : null}
            </div>
            <div className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
              {visibleLogs.length ? visibleLogs.map((log) => (
                <button
                  key={log.jobId}
                  type="button"
                  className="w-full text-left"
                  disabled={loadingJobId !== null}
                  aria-busy={loadingJobId === log.jobId}
                  onClick={() => void handleSelectLog(log.jobId, { silent: true })}
                >
                  <MatrixCard
                    as="div"
                    selected={loadingJobId === log.jobId || (!loadingJobId && logDetail?.jobId === log.jobId)}
                    interactive
                    className={`p-3 ${loadingJobId === log.jobId ? "matrix-card-loading" : ""}`}
                  >
                    <LoadingOverlay
                      visible={loadingJobId === log.jobId}
                      label={`Loading log ${log.fileName}…`}
                    />
                    <MatrixCardHeader
                      eyebrow={<span className="theme-text-soft">{log.branch}</span>}
                      title={getOriginContextTitle(log.origin, log.branch)}
                      titleLines={2}
                      titleText={getOriginContextTitle(log.origin, log.branch)}
                      description={getOriginContextSubtitle(log.origin, log.branch)}
                      descriptionLines={3}
                      descriptionText={getOriginContextSubtitle(log.origin, log.branch)}
                      badges={(
                        <>
                          <MatrixBadge tone="neutral" compact>{getAiCommandLabel(log.commandId)}</MatrixBadge>
                          <MatrixBadge tone={getStatusTone(log.status)} compact>{log.status}</MatrixBadge>
                          {loadingJobId === log.jobId ? <MatrixSpinner label="Loading log…" /> : null}
                        </>
                      )}
                    />
                    <MatrixCardFooter className="mt-3 justify-between gap-x-3 gap-y-1 text-xs theme-text-muted">
                      <span>{formatTimestamp(log.timestamp)}</span>
                      <span className="truncate">{log.fileName}</span>
                    </MatrixCardFooter>
                  </MatrixCard>
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
          {loadingJobId ? (
            <div className="space-y-4">
              <div className="border theme-border-subtle p-4 theme-surface-soft">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="matrix-kicker">AI log detail</p>
                  <MatrixSpinner label="Loading log…" />
                </div>
                <div className="mt-3 h-6 w-48 matrix-skeleton" />
                <div className="mt-2 h-4 w-72 matrix-skeleton" />
              </div>
              <div className="theme-inline-panel p-3">
                <div className="h-4 w-32 matrix-skeleton" />
                <div className="mt-2 h-5 w-56 matrix-skeleton" />
                <div className="mt-1 h-3 w-64 matrix-skeleton" />
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-10 matrix-skeleton" />
                ))}
              </div>
            </div>
          ) : logDetail ? (
            <div className="space-y-4">
              <ProjectManagementAiOutputViewer
                source="worktree"
                job={toAiCommandJobFromLog({
                  ...logDetail,
                  response: {
                    ...logDetail.response,
                    events: getOutputEvents(logDetail),
                  },
                })}
                summary={getLiveDetailDescription(logDetail)}
                expanded
                onCancel={() => void onCancelJob(logDetail.branch)}
              />

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

              <MatrixAccordion summary={renderAccordionSummary("Request", "Prompt passed into the configured AI command.")} defaultOpen>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.request}</pre>
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
                  <div className="mt-4">
                    <MatrixCard as="div" interactive className="p-4">
                      <MatrixCardHeader
                        eyebrow={<span className="theme-text-soft">{primaryCandidate.branch}</span>}
                        title={getOriginContextTitle(primaryCandidate.origin, primaryCandidate.branch)}
                        titleLines={2}
                        titleText={getOriginContextTitle(primaryCandidate.origin, primaryCandidate.branch)}
                        description={getOriginContextSubtitle(primaryCandidate.origin, primaryCandidate.branch)}
                        descriptionLines={3}
                        descriptionText={getOriginContextSubtitle(primaryCandidate.origin, primaryCandidate.branch)}
                        badges={(
                          <MatrixBadge tone={"startedAt" in primaryCandidate ? "warning" : "neutral"} compact>
                            {"startedAt" in primaryCandidate ? "Live" : "Saved"}
                          </MatrixBadge>
                        )}
                        actions={(
                          <button
                            type="button"
                            className="matrix-button rounded-none px-3 py-2 text-sm"
                            disabled={loadingJobId !== null}
                            onClick={() => void handleSelectLog(primaryCandidate.jobId, { silent: true })}
                          >
                            {loadingJobId === primaryCandidate.jobId ? (
                              <span className="flex items-center gap-2">
                                <span className="matrix-spinner-sm" aria-hidden="true" />
                                Opening…
                              </span>
                            ) : "Open latest run"}
                          </button>
                        )}
                      />
                      <MatrixCardFooter className="mt-3 gap-3 text-xs theme-text-muted">
                        <span>{formatTimestamp(getCandidateStartedAt(primaryCandidate))}</span>
                      </MatrixCardFooter>
                    </MatrixCard>
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
                        key={entry.jobId}
                        type="button"
                        className="w-full text-left"
                        disabled={loadingJobId !== null}
                        aria-busy={loadingJobId === entry.jobId}
                        onClick={() => void handleSelectLog(entry.jobId, { silent: true })}
                      >
                        <MatrixCard
                          as="div"
                          interactive
                          className={`p-3 ${loadingJobId === entry.jobId ? "matrix-card-loading" : ""}`}
                        >
                          <LoadingOverlay
                            visible={loadingJobId === entry.jobId}
                            label={`Loading log ${entry.fileName}…`}
                          />
                          <MatrixCardHeader
                            eyebrow={<span className="theme-text-soft">{entry.branch}</span>}
                            title={getOriginContextTitle(entry.origin, entry.branch)}
                            titleLines={2}
                            titleText={getOriginContextTitle(entry.origin, entry.branch)}
                            description={getOriginContextSubtitle(entry.origin, entry.branch)}
                            descriptionLines={2}
                            descriptionText={getOriginContextSubtitle(entry.origin, entry.branch)}
                            badges={(
                              <>
                                <MatrixBadge tone={getStatusTone(entry.status)} compact>{entry.status}</MatrixBadge>
                                {loadingJobId === entry.jobId ? <MatrixSpinner label="Loading log…" /> : null}
                              </>
                            )}
                          />
                          <MatrixCardFooter className="mt-3 text-xs theme-text-muted">
                            <span>{formatTimestamp(entry.timestamp)}</span>
                          </MatrixCardFooter>
                        </MatrixCard>
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
