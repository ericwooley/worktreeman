import type { AiCommandJob, AiCommandLogEntry, AiCommandLogSummary } from "@shared/types";
import { MatrixAccordion, MatrixBadge, MatrixDetailField, MatrixMetric } from "./matrix-primitives";

function getAiCommandLabel(commandId: "smart" | "simple") {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

interface ProjectManagementAiLogTabProps {
  logs: AiCommandLogSummary[];
  logDetail: AiCommandLogEntry | null;
  loading: boolean;
  runningJobs: AiCommandJob[];
  onRefresh: (options?: { silent?: boolean }) => Promise<unknown>;
  onSelectLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onCancelJob: (branch: string) => Promise<AiCommandJob | null>;
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

export function ProjectManagementAiLogTab({
  logs,
  logDetail,
  loading,
  runningJobs,
  onRefresh,
  onSelectLog,
  onCancelJob,
}: ProjectManagementAiLogTabProps) {
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
          <h3 className="mt-2 text-lg font-semibold theme-text-strong">Running jobs</h3>
          <p className="mt-1 text-sm theme-text-muted">Monitor active AI requests and inspect saved request and response logs.</p>
        </div>
        <button
          type="button"
          className="matrix-button rounded-none px-3 py-2 text-sm"
          onClick={() => void onRefresh()}
          disabled={loading}
        >
          Refresh logs
        </button>
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
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold theme-text-strong">{job.branch}</span>
                        <div className="flex items-center gap-2">
                          <MatrixBadge tone="neutral" compact>{getAiCommandLabel(job.commandId)}</MatrixBadge>
                          <MatrixBadge tone={getStatusTone(job.status)} compact>{job.status}</MatrixBadge>
                        </div>
                      </div>
                      <p className="mt-2 text-xs theme-text-muted">Started {new Date(job.startedAt).toLocaleString()}</p>
                      {job.pid ? <p className="mt-1 text-xs theme-text-muted">PID {job.pid}</p> : null}
                      <p className="mt-2 break-all font-mono text-xs theme-text-muted">{job.command}</p>
                    </button>
                    <button
                      type="button"
                      className="matrix-button rounded-none px-2 py-1 text-xs"
                      onClick={() => void onCancelJob(job.branch)}
                    >
                      Cancel
                    </button>
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

              <div className="grid gap-3 md:grid-cols-2">
                <MatrixDetailField label="Branch" value={logDetail.branch} mono />
                <MatrixDetailField label="Timestamp" value={new Date(logDetail.timestamp).toLocaleString()} />
                <MatrixDetailField label="PID" value={logDetail.pid ? String(logDetail.pid) : "Unavailable"} />
                <MatrixDetailField label="Exit code" value={typeof logDetail.exitCode === "number" ? String(logDetail.exitCode) : "Pending"} />
                <MatrixDetailField label="AI command" value={getAiCommandLabel(logDetail.commandId)} />
                <MatrixDetailField label="Worktree path" value={logDetail.worktreePath} mono />
                <MatrixDetailField label="Command" value={logDetail.command} mono />
              </div>

              <MatrixAccordion summary={renderAccordionSummary("Request", "Prompt passed into the configured AI command.")} defaultOpen>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.request}</pre>
              </MatrixAccordion>

              <MatrixAccordion summary={renderAccordionSummary("Response stdout", "The AI command output captured from stdout.")}>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.response.stdout || "(empty)"}</pre>
              </MatrixAccordion>

              <MatrixAccordion summary={renderAccordionSummary("Response stderr", "The AI command output captured from stderr.")}>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-muted">{logDetail.response.stderr || "(empty)"}</pre>
              </MatrixAccordion>

              {logDetail.error ? (
                <MatrixAccordion summary={renderAccordionSummary("Error", "Normalized error details captured for failed runs.")}>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words border theme-border-subtle p-3 text-xs theme-text-danger">{JSON.stringify(logDetail.error, null, 2)}</pre>
                </MatrixAccordion>
              ) : null}
            </div>
          ) : (
            <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              Select an AI log to inspect its request, output, and any captured failure details.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
