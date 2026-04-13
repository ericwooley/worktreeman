import { useEffect, useMemo, useState } from "react";
import type { SystemJobRecord, SystemStatusResponse, SystemSubTab } from "@shared/types";

import { MatrixCard, MatrixCardFooter, MatrixCardHeader } from "./matrix-card";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixSectionIntro, MatrixTabs, getMatrixTabPanelId } from "./matrix-primitives";
import { formatAutoRefreshStatus } from "../lib/auto-refresh-status";

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`;
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function formatTimestamp(value: string | null) {
  if (!value) {
    return "Unavailable";
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? value : new Date(parsed).toLocaleString();
}

function formatDurationSeconds(value: number | null) {
  if (value === null || !Number.isFinite(value)) {
    return "Unavailable";
  }

  const totalSeconds = Math.max(0, Math.round(value));
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

function formatUptime(value: number) {
  const totalSeconds = Math.max(0, Math.round(value));
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function getJobStatusTone(state: string) {
  if (state === "failed") {
    return "danger" as const;
  }

  if (state === "active" || state === "created" || state === "retry") {
    return "warning" as const;
  }

  return "active" as const;
}

function getJobTitle(job: SystemJobRecord) {
  return job.payloadSummary.originLabel
    ?? job.payloadSummary.branch
    ?? job.queue;
}

function getJobDescription(job: SystemJobRecord) {
  return job.payloadSummary.renderedCommandPreview
    ?? job.payloadSummary.inputPreview
    ?? "No payload preview was captured for this pg-boss job.";
}

interface SystemTabProps {
  activeSubTab: SystemSubTab;
  status: SystemStatusResponse | null;
  loading: boolean;
  error?: string | null;
  lastUpdatedAt?: string | null;
  onSubTabChange: (tab: SystemSubTab) => void;
  onRetry?: () => void | Promise<void>;
}

export function SystemTab({
  activeSubTab,
  status,
  loading,
  error = null,
  lastUpdatedAt = null,
  onSubTabChange,
  onRetry,
}: SystemTabProps) {
  const [selectedJobId, setSelectedJobId] = useState<string | null>(status?.jobs.items[0]?.id ?? null);

  useEffect(() => {
    const items = status?.jobs.items ?? [];
    if (!items.length) {
      setSelectedJobId(null);
      return;
    }

    if (!selectedJobId || !items.some((entry) => entry.id === selectedJobId)) {
      setSelectedJobId(items[0].id);
    }
  }, [selectedJobId, status?.jobs.items]);

  const selectedJob = useMemo(
    () => status?.jobs.items.find((entry) => entry.id === selectedJobId) ?? null,
    [selectedJobId, status?.jobs.items],
  );

  const refreshStatusLabel = formatAutoRefreshStatus(lastUpdatedAt);
  const performance = status?.performance ?? null;
  const jobs = status?.jobs ?? null;
  const activeJobCount = jobs?.countsByState.active ?? 0;
  const completedJobCount = jobs?.countsByState.completed ?? 0;
  const failedJobCount = jobs?.countsByState.failed ?? 0;

  return (
    <div className="space-y-4">
      <MatrixTabs
        groupId="system-tab"
        ariaLabel="System tabs"
        activeTabId={activeSubTab}
        onChange={onSubTabChange}
        className="theme-divider border-b pb-4"
        tabs={[
          { id: "performance", label: "Performance", panelId: getMatrixTabPanelId("system-tab", "performance") },
          { id: "jobs", label: "Jobs", panelId: getMatrixTabPanelId("system-tab", "jobs") },
        ]}
      />

      <MatrixSectionIntro
        kicker="System"
        title="Host performance and queue activity"
        description="Watch runtime health, inspect recent pg-boss jobs, and keep durable background work in view."
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
            <MatrixBadge tone={activeSubTab === "jobs" && activeJobCount > 0 ? "warning" : "neutral"} compact>
              {activeSubTab === "jobs" && activeJobCount > 0 ? "Live updates on" : "Idle"}
            </MatrixBadge>
            <span className="theme-text-muted">{refreshStatusLabel}</span>
          </>
        )}
      />

      {activeSubTab === "performance" ? (
        <div
          id={getMatrixTabPanelId("system-tab", "performance")}
          role="tabpanel"
          aria-labelledby="system-tab-performance-tab"
          className="space-y-4"
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MatrixMetric label="CPU cores" value={performance ? String(performance.cpu.coreCount) : "0"} />
            <MatrixMetric label="Load avg (1m)" value={performance ? performance.cpu.loadAverage[0].toFixed(2) : "0.00"} />
            <MatrixMetric label="Memory used" value={performance ? formatPercent(performance.memory.usageRatio) : "0%"} />
            <MatrixMetric label="Worktrees" value={performance ? String(performance.worktrees.total) : "0"} />
          </div>

          {performance ? (
            <div className="grid gap-4 xl:grid-cols-2">
              <div className="border theme-border-subtle p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Host</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <MatrixDetailField label="Hostname" value={performance.hostname} mono />
                  <MatrixDetailField label="Platform" value={`${performance.platform} / ${performance.arch}`} mono />
                  <MatrixDetailField label="Node" value={performance.nodeVersion} mono />
                  <MatrixDetailField label="Uptime" value={formatUptime(performance.uptimeSeconds)} />
                  <MatrixDetailField label="CPU model" value={performance.cpu.model || "Unavailable"} />
                  <MatrixDetailField label="CPU speed" value={performance.cpu.speedMhz ? `${performance.cpu.speedMhz} MHz` : "Unavailable"} />
                </div>
              </div>

              <div className="border theme-border-subtle p-4">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Capacity</p>
                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <MatrixDetailField label="Memory total" value={formatBytes(performance.memory.totalBytes)} mono />
                  <MatrixDetailField label="Memory used" value={formatBytes(performance.memory.usedBytes)} mono />
                  <MatrixDetailField label="Memory free" value={formatBytes(performance.memory.freeBytes)} mono />
                  <MatrixDetailField label="Usage" value={formatPercent(performance.memory.usageRatio)} />
                  <MatrixDetailField label="Load avg / core" value={performance.cpu.loadAveragePerCore.map((value) => value.toFixed(2)).join(" / ")} mono />
                  <MatrixDetailField label="Load avg" value={performance.cpu.loadAverage.map((value) => value.toFixed(2)).join(" / ")} mono />
                </div>
              </div>

              <div className="border theme-border-subtle p-4 xl:col-span-2">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Workspace footprint</p>
                <div className="mt-4 grid gap-3 md:grid-cols-3">
                  <MatrixDetailField label="Known worktrees" value={String(performance.worktrees.total)} mono />
                  <MatrixDetailField label="Running runtimes" value={String(performance.worktrees.runtimeCount)} mono />
                  <MatrixDetailField label="Linked documents" value={String(performance.worktrees.linkedDocumentCount)} mono />
                </div>
              </div>
            </div>
          ) : (
            <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              System metrics will appear here after the first automatic status snapshot arrives.
            </div>
          )}
        </div>
      ) : (
        <div
          id={getMatrixTabPanelId("system-tab", "jobs")}
          role="tabpanel"
          aria-labelledby="system-tab-jobs-tab"
          className="space-y-4"
        >
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MatrixMetric label="Recent jobs" value={jobs ? String(jobs.total) : "0"} />
            <MatrixMetric label="Active" value={String(activeJobCount)} />
            <MatrixMetric label="Completed" value={String(completedJobCount)} />
            <MatrixMetric label="Failed" value={String(failedJobCount)} />
          </div>

          {!jobs?.available ? (
            <div className="border theme-border-subtle p-4 text-sm theme-empty-note">
              {jobs?.unavailableReason ?? "The pg-boss job table is not available yet."}
            </div>
          ) : (
            <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
              <div className="border theme-border-subtle p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Recent pg-boss jobs</p>
                  <MatrixBadge tone={jobs.items.length ? "warning" : "neutral"} compact>
                    {jobs.items.length}
                  </MatrixBadge>
                </div>
                <div className="mt-3 max-h-[32rem] space-y-2 overflow-y-auto pr-1">
                  {jobs.items.length ? jobs.items.map((job) => (
                    <button
                      key={job.id}
                      type="button"
                      className="w-full text-left"
                      onClick={() => setSelectedJobId(job.id)}
                    >
                      <MatrixCard as="div" selected={selectedJob?.id === job.id} interactive className="p-3">
                        <MatrixCardHeader
                          eyebrow={<span className="theme-text-soft">{job.queue}</span>}
                          title={getJobTitle(job)}
                          titleLines={2}
                          titleText={getJobTitle(job)}
                          description={getJobDescription(job)}
                          descriptionLines={3}
                          descriptionText={getJobDescription(job)}
                          badges={(
                            <>
                              <MatrixBadge tone={getJobStatusTone(job.state)} compact>{job.state}</MatrixBadge>
                              {job.payloadSummary.commandId ? <MatrixBadge tone="neutral" compact>{job.payloadSummary.commandId}</MatrixBadge> : null}
                            </>
                          )}
                        />
                        <MatrixCardFooter className="mt-3 justify-between gap-x-3 gap-y-1 text-xs theme-text-muted">
                          <span>{formatTimestamp(job.createdAt)}</span>
                          <span>{formatDurationSeconds(job.runtimeSeconds)}</span>
                        </MatrixCardFooter>
                      </MatrixCard>
                    </button>
                  )) : (
                    <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                      No pg-boss jobs have been recorded yet.
                    </div>
                  )}
                </div>
              </div>

              <div className="border theme-border-subtle p-4">
                {selectedJob ? (
                  <div className="space-y-4">
                    <div className="theme-inline-panel p-3">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Selected job</p>
                          <p className="mt-2 text-sm font-semibold theme-text-strong">{getJobTitle(selectedJob)}</p>
                          <p className="mt-1 text-xs theme-text-muted">{getJobDescription(selectedJob)}</p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <MatrixBadge tone={getJobStatusTone(selectedJob.state)} compact>{selectedJob.state}</MatrixBadge>
                          <MatrixBadge tone="neutral" compact>{selectedJob.queue}</MatrixBadge>
                        </div>
                      </div>
                    </div>

                    <div className="grid gap-3 md:grid-cols-2">
                      <MatrixDetailField label="Job id" value={selectedJob.id} mono />
                      <MatrixDetailField label="Priority" value={String(selectedJob.priority)} mono />
                      <MatrixDetailField label="Created" value={formatTimestamp(selectedJob.createdAt)} />
                      <MatrixDetailField label="Started" value={formatTimestamp(selectedJob.startedAt)} />
                      <MatrixDetailField label="Completed" value={formatTimestamp(selectedJob.completedAt)} />
                      <MatrixDetailField label="Runtime" value={formatDurationSeconds(selectedJob.runtimeSeconds)} />
                      <MatrixDetailField label="Retry count" value={`${selectedJob.retryCount} / ${selectedJob.retryLimit}`} mono />
                      <MatrixDetailField label="Heartbeat" value={selectedJob.heartbeatAt ? `${formatTimestamp(selectedJob.heartbeatAt)} (${selectedJob.heartbeatSeconds ?? 0}s)` : "Unavailable"} />
                      <MatrixDetailField label="Policy" value={selectedJob.policy ?? "Unavailable"} mono />
                      <MatrixDetailField label="Dead letter" value={selectedJob.deadLetter ?? "None"} mono />
                      <MatrixDetailField label="Start after" value={formatTimestamp(selectedJob.startAfter)} />
                      <MatrixDetailField label="Keep until" value={formatTimestamp(selectedJob.keepUntil)} />
                    </div>

                    <div className="border theme-border-subtle p-4">
                      <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Payload summary</p>
                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <MatrixDetailField label="Branch" value={selectedJob.payloadSummary.branch ?? "Unavailable"} mono />
                        <MatrixDetailField label="Document id" value={selectedJob.payloadSummary.documentId ?? "Unavailable"} mono />
                        <MatrixDetailField label="AI command" value={selectedJob.payloadSummary.commandId ?? "Unavailable"} />
                        <MatrixDetailField label="Origin" value={selectedJob.payloadSummary.originLabel ?? selectedJob.payloadSummary.originKind ?? "Unavailable"} />
                        <MatrixDetailField label="Worktree path" value={selectedJob.payloadSummary.worktreePath ?? "Unavailable"} mono />
                        <MatrixDetailField label="Auto-commit" value={selectedJob.payloadSummary.autoCommitDirtyWorktree ? "Enabled" : "Disabled"} />
                      </div>
                      {selectedJob.payloadSummary.renderedCommandPreview ? (
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Rendered command</p>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{selectedJob.payloadSummary.renderedCommandPreview}</pre>
                        </div>
                      ) : null}
                      {selectedJob.payloadSummary.inputPreview ? (
                        <div className="mt-4">
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Input preview</p>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{selectedJob.payloadSummary.inputPreview}</pre>
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                    Select a pg-boss job to inspect its state, timestamps, and summarized payload details.
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
