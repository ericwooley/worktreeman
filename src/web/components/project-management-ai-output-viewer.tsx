import { useEffect, useMemo, useRef, useState } from "react";
import type { AiCommandId, AiCommandJob, AiCommandOutputEvent } from "@shared/types";

import { MatrixBadge } from "./matrix-primitives";

const AI_OUTPUT_FOLLOW_THRESHOLD_PX = 12;

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

export function getAiOutputEvents(job: AiCommandJob): AiCommandOutputEvent[] {
  if (job.outputEvents?.length) {
    return job.outputEvents;
  }

  const fallbackEvents: AiCommandOutputEvent[] = [];
  if (job.stdout) {
    fallbackEvents.push({
      id: `${job.jobId}:stdout`,
      source: "stdout",
      text: job.stdout,
      timestamp: job.startedAt,
    });
  }

  if (job.stderr) {
    fallbackEvents.push({
      id: `${job.jobId}:stderr`,
      source: "stderr",
      text: job.stderr,
      timestamp: job.completedAt ?? job.startedAt,
    });
  }

  return fallbackEvents;
}

function formatOutputTimestamp(value: string) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }

  return new Date(parsed).toLocaleString();
}

function formatElapsedLabel(previousTimestamp: string | null, currentTimestamp: string) {
  if (!previousTimestamp) {
    return "start";
  }

  const previous = Date.parse(previousTimestamp);
  const current = Date.parse(currentTimestamp);
  if (Number.isNaN(previous) || Number.isNaN(current)) {
    return "start";
  }

  const diffMs = Math.max(0, current - previous);
  const diffSeconds = Math.floor(diffMs / 1000);
  if (diffSeconds < 60) {
    return `+${diffSeconds} ${diffSeconds === 1 ? "second" : "seconds"}`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) {
    return `+${diffMinutes} ${diffMinutes === 1 ? "minute" : "minutes"}`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `+${diffHours} ${diffHours === 1 ? "hour" : "hours"}`;
  }

  const diffDays = Math.floor(diffHours / 24);
  return `+${diffDays} ${diffDays === 1 ? "day" : "days"}`;
}

function getEmptyOutputMessage(status: AiCommandJob["status"]) {
  return status === "running" ? "Waiting for live output..." : "No output captured.";
}

export function shouldStickAiOutputToBottom(metrics: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}, threshold = AI_OUTPUT_FOLLOW_THRESHOLD_PX) {
  return metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= threshold;
}

export function getNextAiOutputScrollTop(options: {
  shouldStickToBottom: boolean;
  previousScrollHeight: number;
  nextScrollHeight: number;
  currentScrollTop: number;
}) {
  if (options.shouldStickToBottom) {
    return options.nextScrollHeight;
  }

  if (options.previousScrollHeight > 0 && options.nextScrollHeight > options.previousScrollHeight) {
    return options.currentScrollTop + (options.nextScrollHeight - options.previousScrollHeight);
  }

  return options.currentScrollTop;
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
  const [showElapsedTime, setShowElapsedTime] = useState(false);
  const outputViewportRef = useRef<HTMLDivElement | null>(null);
  const previousScrollHeightRef = useRef(0);
  const shouldStickToBottomRef = useRef(true);
  const lastLoadedJobIdRef = useRef<string | null>(null);
  const running = job.status === "running";
  const title = source === "worktree" ? "Worktree AI" : "Document AI";
  const outputEvents = useMemo(() => getAiOutputEvents(job)
    .map((event, index) => ({ event, index }))
    .sort((left, right) => {
      const leftTimestamp = Date.parse(left.event.timestamp);
      const rightTimestamp = Date.parse(right.event.timestamp);

      if (Number.isNaN(leftTimestamp) && Number.isNaN(rightTimestamp)) {
        return left.index - right.index;
      }

      if (Number.isNaN(leftTimestamp)) {
        return 1;
      }

      if (Number.isNaN(rightTimestamp)) {
        return -1;
      }

      return leftTimestamp - rightTimestamp || left.index - right.index;
    })
    .map(({ event }) => event), [job]);
  const description = source === "worktree"
    ? running
      ? `Streaming the combined AI log from ${job.branch} while the worktree run is active.`
      : summary ?? `Captured output from ${job.branch}.`
    : running
      ? `Streaming the combined AI log while the saved document updates in ${job.branch}.`
      : summary ?? `Captured output from ${job.branch}.`;
  const supplementalSummary = summary && summary !== description ? summary : null;

  useEffect(() => {
    const viewport = outputViewportRef.current;
    if (!viewport) {
      return;
    }

    if (lastLoadedJobIdRef.current !== job.jobId) {
      viewport.scrollTop = viewport.scrollHeight;
      previousScrollHeightRef.current = viewport.scrollHeight;
      shouldStickToBottomRef.current = true;
      lastLoadedJobIdRef.current = job.jobId;
    }
  }, [job.jobId]);

  useEffect(() => {
    const viewport = outputViewportRef.current;
    if (!viewport || !outputEvents.length) {
      return;
    }

    const nextScrollHeight = viewport.scrollHeight;
    viewport.scrollTop = getNextAiOutputScrollTop({
      shouldStickToBottom: shouldStickToBottomRef.current,
      previousScrollHeight: previousScrollHeightRef.current,
      nextScrollHeight,
      currentScrollTop: viewport.scrollTop,
    });
    previousScrollHeightRef.current = nextScrollHeight;
  }, [outputEvents]);

  const handleOutputScroll = () => {
    const viewport = outputViewportRef.current;
    if (!viewport) {
      return;
    }

    shouldStickToBottomRef.current = shouldStickAiOutputToBottom({
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
      clientHeight: viewport.clientHeight,
    });
  };

  return (
    <div className={`border theme-border-subtle theme-surface-soft ${expanded ? "p-5" : "p-4"}`}>
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
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

      <div className="mt-4 border theme-scroll-panel">
        <div className="flex flex-col gap-2 border-b theme-border-subtle px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="text-sm font-semibold theme-text-strong">Mixed output timeline</p>
            <p className="mt-1 text-xs theme-text-muted">Combined stdout and stderr in arrival order.</p>
          </div>
          <label className="flex items-center gap-2 text-xs theme-text-muted">
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded-none border theme-border-subtle bg-transparent"
              checked={showElapsedTime}
              onChange={(event) => setShowElapsedTime(event.currentTarget.checked)}
            />
            Show elapsed time
          </label>
        </div>

        {outputEvents.length ? (
          <div
            ref={outputViewportRef}
            className={`overflow-auto ${expanded ? "max-h-[65vh]" : "max-h-[24rem]"}`}
            onScroll={handleOutputScroll}
          >
            {outputEvents.map((event, index) => {
              const absoluteTimestamp = formatOutputTimestamp(event.timestamp);
              const timestampLabel = showElapsedTime
                ? formatElapsedLabel(index > 0 ? outputEvents[index - 1]?.timestamp ?? null : null, event.timestamp)
                : absoluteTimestamp;
              const eventToneClass = event.source === "stderr"
                ? "theme-ai-output-entry-secondary"
                : "theme-ai-output-entry";

              return (
                <div
                  key={event.id}
                  className={`grid gap-x-3 gap-y-1.5 border-b px-3 py-2.5 last:border-b-0 md:grid-cols-[10rem_minmax(0,1fr)] ${eventToneClass}`}
                >
                  <div className="flex items-center gap-2 md:block">
                    <span className="font-mono text-xs theme-timestamp" title={absoluteTimestamp}>{timestampLabel}</span>
                    <div className="md:mt-1.5">
                      <MatrixBadge tone="neutral" compact>{event.source}</MatrixBadge>
                    </div>
                  </div>
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{event.text}</pre>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={`px-3 py-4 text-sm theme-empty-note ${expanded ? "min-h-[12rem]" : ""}`}>
            {getEmptyOutputMessage(job.status)}
          </div>
        )}
      </div>
    </div>
  );
}
