import { useEffect, useMemo, useState } from "react";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";
import { ProjectManagementAiOutputViewer } from "./project-management-panel";
import { ProjectManagementAiLogTab } from "./project-management-ai-log-tab";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixTabButton } from "./matrix-primitives";

export type AiActivitySubTab = "log" | "active-worktrees";

function getAiCommandLabel(commandId: "smart" | "simple") {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
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

      {activeSubTab === "active-worktrees" ? (
        <>
          <div className="grid gap-3 md:grid-cols-3">
            <MatrixMetric label="Running jobs" value={String(runningJobs.length)} />
            <MatrixMetric label="Active worktrees" value={String(activeWorktreeCount)} />
            <MatrixMetric label="Saved logs" value={String(logs.length)} />
          </div>

          <div className="flex items-start justify-between gap-3 border theme-border-subtle p-4">
            <div>
              <p className="matrix-kicker">AI</p>
              <h3 className="mt-2 text-lg font-semibold theme-text-strong">Live work across worktrees</h3>
              <p className="mt-1 text-sm theme-text-muted">
                Track long-running AI work, inspect live mixed output, and jump back to where each run started.
              </p>
            </div>
            {loading ? <MatrixBadge tone="warning">Loading</MatrixBadge> : null}
          </div>

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
        </>
      ) : (
        <ProjectManagementAiLogTab
          logs={logs}
          logDetail={logDetail}
          loading={loading}
          runningJobs={runningJobs}
          onSelectLog={onSelectLog}
          onCancelJob={onCancelJob}
          onOpenOrigin={onOpenOrigin}
        />
      )}
    </div>
  );
}
