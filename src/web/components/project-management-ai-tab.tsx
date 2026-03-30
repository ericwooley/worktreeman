import { useEffect, useMemo, useState } from "react";
import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary, AiCommandOrigin } from "@shared/types";

import { ProjectManagementAiLogTab } from "./project-management-ai-log-tab";
import { MatrixCard, MatrixCardDescription, MatrixCardFooter, MatrixCardTitle } from "./matrix-card";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixTabs, getMatrixTabPanelId } from "./matrix-primitives";
import { CardLoadingBadge } from "./loading";

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

function getStatusTone(status: AiCommandJob["status"]) {
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
  error?: string | null;
  lastUpdatedAt?: string | null;
  runningJobs: AiCommandJob[];
  onSubTabChange: (tab: AiActivitySubTab) => void;
  onSelectLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onCancelJob: (branch: string) => Promise<AiCommandJob | null>;
  onOpenOrigin: (origin: AiCommandOrigin) => void | Promise<void>;
  onRetry?: () => void | Promise<void>;
}

// Define the props for ProjectManagementAiOutputViewer above its definition
interface ProjectManagementAiOutputViewerProps {
  source: string;
  job: AiCommandJob;
  summary: string;
  expanded?: boolean;
  onCancel: () => void;
  onOpenModal?: () => void;
}

function ProjectManagementAiOutputViewer({
  source,
  job,
  summary,
  expanded = false,
  onCancel,
  onOpenModal,
}: ProjectManagementAiOutputViewerProps) {
  const running = job.status === "running";
  const title = source === "worktree" ? "Worktree AI" : "Document AI";
  const description = source === "worktree"
    ? running
      ? `Streaming live output from ${job.branch} while the worktree run is active.`
      : summary
    : running
      ? `Updating the saved document in ${job.branch}.`
      : summary;

  return (
    <div className={`pm-ai-output-shell border theme-border-subtle ${running ? "pm-ai-output-shell-running" : ""} ${expanded ? "p-5" : "p-4"}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`pm-ai-live-orb ${running ? "pm-ai-live-orb-running" : ""}`} aria-hidden="true" />
            <p className="matrix-kicker">{title}</p>
            <MatrixBadge tone={getStatusTone(job.status)} compact>{running ? "live" : job.status}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
            <MatrixBadge tone="neutral" compact>{job.branch}</MatrixBadge>
            {job.pid ? <MatrixBadge tone="neutral" compact>{`PID ${job.pid}`}</MatrixBadge> : null}
          </div>
          <h3 className={`mt-2 font-semibold theme-text-strong ${expanded ? "text-xl" : "text-lg"}`}>
            {running ? `${title} is working` : `${title} output`}
          </h3>
          {description ? <p className="mt-1 text-sm theme-text-muted">{description}</p> : null}
          {summary ? <p className="mt-2 text-xs theme-text-soft">{summary}</p> : null}
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

      <pre className={`pm-ai-output-pre mt-4 overflow-auto px-4 py-4 font-mono text-xs leading-6 ${expanded ? "max-h-[65vh]" : "max-h-[24rem]"}`}>
        {getAiOutputText(job)}
      </pre>
    </div>
  );
}

export function ProjectManagementAiTab({
  activeSubTab,
  logs,
  logDetail,
  loading,
  error = null,
  lastUpdatedAt = null,
  runningJobs,
  onSubTabChange,
  onSelectLog,
  onCancelJob,
  onOpenOrigin,
  onRetry,
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
      <MatrixTabs
        groupId="project-management-ai-activity"
        ariaLabel="Project management AI activity tabs"
        activeTabId={activeSubTab}
        onChange={onSubTabChange}
        className="theme-divider border-b pb-4"
        tabs={[
          { id: "log", label: "AI log", panelId: getMatrixTabPanelId("project-management-ai-activity", "log") },
          { id: "active-worktrees", label: "Active AI Worktrees", panelId: getMatrixTabPanelId("project-management-ai-activity", "active-worktrees") },
        ]}
      />

      {activeSubTab === "active-worktrees" ? (
        <div
          id={getMatrixTabPanelId("project-management-ai-activity", "active-worktrees")}
          role="tabpanel"
          aria-labelledby="project-management-ai-activity-active-worktrees-tab"
        >
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
            {loading ? <CardLoadingBadge label="Loading" compact /> : null}
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
                      className="w-full text-left"
                      onClick={() => setSelectedRunningJobId(job.jobId)}
                    >
                      <MatrixCard as="div" selected={isSelected} interactive className="p-3">
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <MatrixCardTitle lines={2} title={job.branch}>{job.branch}</MatrixCardTitle>
                            <MatrixCardDescription className="mt-1" lines={2} title={getOriginTitle(job.origin)}>
                              {getOriginTitle(job.origin)}
                            </MatrixCardDescription>
                          </div>
                          <MatrixBadge tone="warning" compact>running</MatrixBadge>
                        </div>
                        <MatrixCardFooter className="mt-2 gap-2">
                          <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
                          <MatrixBadge tone="neutral" compact>{`Running for ${formatRuntimeDuration(job.startedAt, now)}`}</MatrixBadge>
                        </MatrixCardFooter>
                        <MatrixCardFooter className="mt-3 justify-between gap-x-3 gap-y-1 text-xs theme-text-muted">
                          <span className="shrink-0">Started {new Date(job.startedAt).toLocaleString()}</span>
                          {job.pid ? <span className="shrink-0">PID {job.pid}</span> : null}
                        </MatrixCardFooter>
                      </MatrixCard>
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
        </div>
      ) : (
        <div
          id={getMatrixTabPanelId("project-management-ai-activity", "log")}
          role="tabpanel"
          aria-labelledby="project-management-ai-activity-log-tab"
        >
          <ProjectManagementAiLogTab
            logs={logs}
            logDetail={logDetail}
            loading={loading}
            error={error}
            lastUpdatedAt={lastUpdatedAt}
            runningJobs={runningJobs}
            onSelectLog={onSelectLog}
            onCancelJob={onCancelJob}
            onOpenOrigin={onOpenOrigin}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  );
}
