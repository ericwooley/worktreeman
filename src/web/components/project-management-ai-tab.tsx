import { useEffect, useMemo, useState } from "react";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";
import { ProjectManagementAiOutputViewer } from "./project-management-panel";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixTabButton } from "./matrix-primitives";

export type AiActivitySubTab = "log" | "active-worktrees";

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
    return "Select an AI log to inspect its request, output, and any captured failure details.";
  }

  if (logDetail.status === "running") {
    return "Live output is streaming while this job is still running.";
  }

  return "Captured request, output, and any failure details for this completed run.";
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

function getOriginTitle(origin: AiCommandOrigin | null | undefined) {
  return origin?.label ?? "Origin unavailable";
}

function getOriginDescription(origin: AiCommandOrigin | null | undefined) {
  return origin?.description ?? "This run does not include a saved start location.";
}

function formatRuntimeDuration(startedAt: string, now: number) {
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) {
    return "Unknown";
  }

  const elapsedMs = Math.max(0, now - started);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }

  return `${seconds}s`;
}

interface ProjectManagementAiTabProps {
  activeSubTab: AiActivitySubTab;
  logs: AiCommandLogSummary[];
  logDetail: AiCommandLogEntry | null;
  loading: boolean;
  runningJobs: AiCommandJob[];
  onSubTabChange: (tab: AiActivitySubTab) => void;
  onSelectLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onCancelJob: (branch: string) => Promise<AiCommandJob | null>;
  onOpenOrigin: (origin: AiCommandOrigin) => void | Promise<void>;
}

export function ProjectManagementAiTab({
  activeSubTab,
  logs,
  logDetail,
  loading,
  runningJobs,
  onSubTabChange,
  onSelectLog,
  onCancelJob,
  onOpenOrigin,
}: ProjectManagementAiTabProps) {
  const [selectedRunningJobId, setSelectedRunningJobId] = useState<string | null>(runningJobs[0]?.jobId ?? null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (activeSubTab !== "active-worktrees") {
      return;
    }

    setNow(Date.now());
    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      setNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [activeSubTab]);

  useEffect(() => {
    if (!runningJobs.length) {
      setSelectedRunningJobId(null);
      return;
    }

    if (!selectedRunningJobId || !runningJobs.some((job) => job.jobId === selectedRunningJobId)) {
      setSelectedRunningJobId(runningJobs[0].jobId);
    }
  }, [runningJobs, selectedRunningJobId]);

  const selectedRunningJob = useMemo(
    () => runningJobs.find((job) => job.jobId === selectedRunningJobId) ?? null,
    [runningJobs, selectedRunningJobId],
  );

  const activeWorktreeCount = useMemo(() => new Set(runningJobs.map((job) => job.branch)).size, [runningJobs]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 theme-divider border-b pb-4">
        <MatrixTabButton active={activeSubTab === "log"} label="AI log" onClick={() => onSubTabChange("log")} />
        <MatrixTabButton active={activeSubTab === "active-worktrees"} label="Active AI Worktrees" onClick={() => onSubTabChange("active-worktrees")} />
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <MatrixMetric label="Running jobs" value={String(runningJobs.length)} />
        <MatrixMetric label="Active worktrees" value={String(activeWorktreeCount)} />
        <MatrixMetric label="Saved logs" value={String(logs.length)} />
      </div>

      <div className="flex items-start justify-between gap-3 border theme-border-subtle p-4">
        <div>
          <p className="matrix-kicker">AI</p>
          <h3 className="mt-2 text-lg font-semibold theme-text-strong">Live work and saved runs</h3>
          <p className="mt-1 text-sm theme-text-muted">
            Track which worktrees are actively running AI, then switch to the AI log to inspect saved requests, output, and origin links.
          </p>
        </div>
        {loading ? <MatrixBadge tone="warning">Loading</MatrixBadge> : null}
      </div>

      {activeSubTab === "active-worktrees" ? (
        <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
          <div className="border theme-border-subtle p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Active AI worktrees</p>
              <MatrixBadge tone={runningJobs.length ? "warning" : "neutral"} compact>
                {runningJobs.length}
              </MatrixBadge>
            </div>
            <div className="mt-3 space-y-2">
              {runningJobs.length ? runningJobs.map((job) => {
                const isSelected = selectedRunningJob?.jobId === job.jobId;
                return (
                  <button
                    key={job.jobId}
                    type="button"
                    className={`w-full border px-3 py-3 text-left transition ${isSelected ? "theme-pill-emphasis theme-text-strong" : "theme-border-subtle theme-surface-soft hover:theme-surface-soft"}`}
                    onClick={() => setSelectedRunningJobId(job.jobId)}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{job.branch}</span>
                      <MatrixBadge tone="warning" compact>running</MatrixBadge>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
                      <MatrixBadge tone="neutral" compact>{`Running for ${formatRuntimeDuration(job.startedAt, now)}`}</MatrixBadge>
                    </div>
                    <p className="mt-2 text-xs theme-text-muted">Started {new Date(job.startedAt).toLocaleString()}</p>
                    <p className="mt-1 text-xs theme-text-muted">{getOriginTitle(job.origin)}</p>
                  </button>
                );
              }) : (
                <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                  No worktrees are actively running AI right now.
                </div>
              )}
            </div>
          </div>

          <div className="border theme-border-subtle p-4">
            {selectedRunningJob ? (
              <div className="space-y-4">
                <ProjectManagementAiOutputViewer
                  source="worktree"
                  job={selectedRunningJob}
                  summary={`AI has been running in ${selectedRunningJob.branch} for ${formatRuntimeDuration(selectedRunningJob.startedAt, now)}.`}
                  expanded
                  onCancel={() => void onCancelJob(selectedRunningJob.branch)}
                />

                <div className="theme-inline-panel p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Started from</p>
                      <p className="mt-2 text-sm font-semibold theme-text-strong">{getOriginTitle(selectedRunningJob.origin)}</p>
                      <p className="mt-1 text-xs theme-text-muted">{getOriginDescription(selectedRunningJob.origin)}</p>
                    </div>
                    {selectedRunningJob.origin ? (
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-2 text-sm"
                        onClick={() => void onOpenOrigin(selectedRunningJob.origin!)}
                      >
                        Open origin
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <MatrixDetailField label="Branch" value={selectedRunningJob.branch} mono />
                  <MatrixDetailField label="Started" value={new Date(selectedRunningJob.startedAt).toLocaleString()} />
                  <MatrixDetailField label="Running for" value={formatRuntimeDuration(selectedRunningJob.startedAt, now)} />
                  <MatrixDetailField label="PID" value={selectedRunningJob.pid ? String(selectedRunningJob.pid) : "Unavailable"} />
                  <MatrixDetailField label="AI command" value={getAiCommandLabel(selectedRunningJob.commandId)} />
                  <MatrixDetailField label="Command" value={selectedRunningJob.command} mono />
                </div>
              </div>
            ) : (
              <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                Select an active AI worktree to inspect its live output.
              </div>
            )}
          </div>
        </div>
      ) : (
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
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-sm font-semibold theme-text-strong">{job.branch}</span>
                          <div className="flex items-center gap-2">
                            <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
                            <MatrixBadge tone={getStatusTone(job.status)} compact>{job.status}</MatrixBadge>
                          </div>
                        </div>
                        <p className="mt-2 text-xs theme-text-muted">Started {new Date(job.startedAt).toLocaleString()}</p>
                        <p className="mt-1 text-xs theme-text-muted">{getOriginTitle(job.origin)}</p>
                        {job.pid ? <p className="mt-1 text-xs theme-text-muted">PID {job.pid}</p> : null}
                        <p className="mt-2 break-all font-mono text-xs theme-text-muted">{job.command}</p>
                      </button>
                      <div className="flex flex-col gap-2">
                        {job.origin ? (
                          <button
                            type="button"
                            className="matrix-button rounded-none px-2 py-1 text-xs"
                            onClick={() => void onOpenOrigin(job.origin!)}
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
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{log.branch}</span>
                      <div className="flex items-center gap-2">
                        <MatrixBadge tone="neutral" compact>{getAiCommandLabel(log.commandId)}</MatrixBadge>
                        <MatrixBadge tone={getStatusTone(log.status)} compact>{log.status}</MatrixBadge>
                      </div>
                    </div>
                    <p className="mt-1 text-xs theme-text-muted">{new Date(log.timestamp).toLocaleString()}</p>
                    <p className="mt-1 text-xs theme-text-muted">{getOriginTitle(log.origin)}</p>
                    <p className="mt-2 line-clamp-3 text-xs theme-text-muted">{log.requestPreview}</p>
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
            <div className="mb-4 grid gap-3 md:grid-cols-3">
              <MatrixMetric label="Running jobs" value={String(runningJobs.length)} />
              <MatrixMetric label="Saved logs" value={String(logs.length)} />
              <MatrixMetric label="Selected log" value={formatSelectedLabel(logDetail)} />
            </div>

            {logDetail ? (
              <div className="space-y-4">
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
                <p className="text-sm theme-text-muted">{getLiveDetailDescription(logDetail)}</p>

                <div className="theme-inline-panel p-3">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Started from</p>
                      <p className="mt-2 text-sm font-semibold theme-text-strong">{getOriginTitle(logDetail.origin)}</p>
                      <p className="mt-1 text-xs theme-text-muted">{getOriginDescription(logDetail.origin)}</p>
                    </div>
                    {logDetail.origin ? (
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-2 text-sm"
                        onClick={() => void onOpenOrigin(logDetail.origin!)}
                      >
                        Open origin
                      </button>
                    ) : null}
                  </div>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <MatrixDetailField label="Branch" value={logDetail.branch} mono />
                  <MatrixDetailField label="Timestamp" value={new Date(logDetail.timestamp).toLocaleString()} />
                  <MatrixDetailField label="PID" value={logDetail.pid ? String(logDetail.pid) : "Unavailable"} />
                  <MatrixDetailField label="Exit code" value={typeof logDetail.exitCode === "number" ? String(logDetail.exitCode) : "Pending"} />
                  <MatrixDetailField label="AI command" value={getAiCommandLabel(logDetail.commandId)} />
                  <MatrixDetailField label="Worktree path" value={logDetail.worktreePath} mono />
                  <MatrixDetailField label="Command" value={logDetail.command} mono />
                </div>

                <details className="matrix-accordion" open>
                  <summary>
                    <div>
                      <p className="text-sm font-semibold theme-text-strong">Request</p>
                      <p className="mt-1 text-xs theme-text-muted">Prompt passed into the configured AI command.</p>
                    </div>
                  </summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.request}</pre>
                </details>

                <details className="matrix-accordion">
                  <summary>
                    <div>
                      <p className="text-sm font-semibold theme-text-strong">Response stdout</p>
                      <p className="mt-1 text-xs theme-text-muted">The AI command output captured from stdout.</p>
                    </div>
                  </summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.response.stdout || "(empty)"}</pre>
                </details>

                <details className="matrix-accordion">
                  <summary>
                    <div>
                      <p className="text-sm font-semibold theme-text-strong">Response stderr</p>
                      <p className="mt-1 text-xs theme-text-muted">The AI command output captured from stderr.</p>
                    </div>
                  </summary>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.response.stderr || "(empty)"}</pre>
                </details>

                {logDetail.error ? (
                  <details className="matrix-accordion">
                    <summary>
                      <div>
                        <p className="text-sm font-semibold theme-text-strong">Error</p>
                        <p className="mt-1 text-xs theme-text-muted">Normalized error details captured for failed runs.</p>
                      </div>
                    </summary>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-danger">{JSON.stringify(logDetail.error, null, 2)}</pre>
                  </details>
                ) : null}
              </div>
            ) : (
              <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                Select an AI log to inspect its request, output, and any captured failure details.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
