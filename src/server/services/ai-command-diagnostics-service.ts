import { formatBytes, logServerEvent, snapshotProcessMemoryUsage, type ProcessMemoryUsageSnapshot } from "../utils/server-logger.js";

const PROCESS_OUTPUT_WARN_BYTES = 16 * 1024 * 1024;
const PROCESS_OUTPUT_ERROR_BYTES = 64 * 1024 * 1024;
const JOB_OUTPUT_WARN_BYTES = 16 * 1024 * 1024;
const JOB_OUTPUT_ERROR_BYTES = 64 * 1024 * 1024;
const OUTPUT_EVENTS_WARN_COUNT = 2_000;
const OUTPUT_EVENTS_ERROR_COUNT = 10_000;
const SSE_PAYLOAD_WARN_BYTES = 4 * 1024 * 1024;
const SSE_PAYLOAD_ERROR_BYTES = 16 * 1024 * 1024;
const HEAP_WARN_BYTES = 1_500 * 1024 * 1024;
const HEAP_ERROR_BYTES = 3_000 * 1024 * 1024;
const HEAP_WARN_RATIO = 0.7;
const HEAP_ERROR_RATIO = 0.9;

type DiagnosticSeverity = "warn" | "error";

const emittedProcessOutputThresholds = new Map<string, Set<string>>();
const emittedJobSnapshotThresholds = new Map<string, Set<string>>();
const emittedSsePayloadThresholds = new Map<string, Set<string>>();
const emittedHeapThresholds = new Set<string>();

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function getThresholdKey(label: string, severity: DiagnosticSeverity): string {
  return `${label}:${severity}`;
}

function recordThreshold(map: Map<string, Set<string>>, id: string, label: string, severity: DiagnosticSeverity): boolean {
  const key = getThresholdKey(label, severity);
  let emitted = map.get(id);
  if (!emitted) {
    emitted = new Set<string>();
    map.set(id, emitted);
  }
  if (emitted.has(key)) {
    return false;
  }
  emitted.add(key);
  return true;
}

function formatMemoryFields(snapshot: ProcessMemoryUsageSnapshot) {
  return {
    rssBytes: snapshot.rssBytes,
    rss: formatBytes(snapshot.rssBytes),
    heapTotalBytes: snapshot.heapTotalBytes,
    heapTotal: formatBytes(snapshot.heapTotalBytes),
    heapUsedBytes: snapshot.heapUsedBytes,
    heapUsed: formatBytes(snapshot.heapUsedBytes),
    heapUsedRatio: snapshot.heapUsedRatio,
    externalBytes: snapshot.externalBytes,
    external: formatBytes(snapshot.externalBytes),
    arrayBuffersBytes: snapshot.arrayBuffersBytes,
    arrayBuffers: formatBytes(snapshot.arrayBuffersBytes),
  };
}

function maybeLogHeapPressure(label: string, details: Record<string, unknown>) {
  const snapshot = snapshotProcessMemoryUsage();
  const severity = snapshot.heapUsedBytes >= HEAP_ERROR_BYTES
    || (snapshot.heapUsedRatio ?? 0) >= HEAP_ERROR_RATIO
    ? "error"
    : snapshot.heapUsedBytes >= HEAP_WARN_BYTES || (snapshot.heapUsedRatio ?? 0) >= HEAP_WARN_RATIO
      ? "warn"
      : null;
  if (!severity) {
    return;
  }

  const thresholdId = severity === "error" ? "heap:error" : "heap:warn";
  if (emittedHeapThresholds.has(thresholdId)) {
    return;
  }
  emittedHeapThresholds.add(thresholdId);

  logServerEvent("ai-command-diagnostics", "heap-pressure", {
    label,
    ...details,
    ...formatMemoryFields(snapshot),
  }, severity);
}

export function noteAiProcessOutputRetention(details: {
  processName: string;
  stdout: string;
  stderr: string;
  status?: string;
  pid?: number;
}) {
  const stdoutBytes = byteLength(details.stdout);
  const stderrBytes = byteLength(details.stderr);
  const totalBytes = stdoutBytes + stderrBytes;
  const severity = totalBytes >= PROCESS_OUTPUT_ERROR_BYTES
    ? "error"
    : totalBytes >= PROCESS_OUTPUT_WARN_BYTES
      ? "warn"
      : null;
  if (!severity) {
    return;
  }
  if (!recordThreshold(emittedProcessOutputThresholds, details.processName, "process-output", severity)) {
    return;
  }

  logServerEvent("ai-command-diagnostics", "process-output-retained", {
    processName: details.processName,
    pid: details.pid,
    status: details.status,
    stdoutBytes,
    stdout: formatBytes(stdoutBytes),
    stderrBytes,
    stderr: formatBytes(stderrBytes),
    totalBytes,
    total: formatBytes(totalBytes),
  }, severity);
  maybeLogHeapPressure("process-output-retained", {
    processName: details.processName,
    totalBytes,
  });
}

export function noteAiJobSnapshotGrowth(details: {
  jobId: string;
  branch?: string;
  processName?: string | null;
  stdout: string;
  stderr: string;
  outputEvents?: Array<{ text: string }> | undefined;
}) {
  const stdoutBytes = byteLength(details.stdout);
  const stderrBytes = byteLength(details.stderr);
  const outputEvents = details.outputEvents ?? [];
  const outputEventBytes = outputEvents.reduce((total, event) => total + byteLength(event.text), 0);
  const totalBytes = stdoutBytes + stderrBytes + outputEventBytes;
  const eventCount = outputEvents.length;
  const severity = totalBytes >= JOB_OUTPUT_ERROR_BYTES || eventCount >= OUTPUT_EVENTS_ERROR_COUNT
    ? "error"
    : totalBytes >= JOB_OUTPUT_WARN_BYTES || eventCount >= OUTPUT_EVENTS_WARN_COUNT
      ? "warn"
      : null;
  if (!severity) {
    return;
  }
  if (!recordThreshold(emittedJobSnapshotThresholds, details.jobId, "job-snapshot", severity)) {
    return;
  }

  logServerEvent("ai-command-diagnostics", "job-snapshot-growth", {
    jobId: details.jobId,
    branch: details.branch,
    processName: details.processName ?? null,
    stdoutBytes,
    stdout: formatBytes(stdoutBytes),
    stderrBytes,
    stderr: formatBytes(stderrBytes),
    outputEventBytes,
    outputEventsBytes: formatBytes(outputEventBytes),
    outputEventCount: eventCount,
    totalBytes,
    total: formatBytes(totalBytes),
  }, severity);
  maybeLogHeapPressure("job-snapshot-growth", {
    jobId: details.jobId,
    totalBytes,
    outputEventCount: eventCount,
  });
}

export function noteAiSsePayloadSize(details: {
  stream: string;
  identifier: string;
  payloadBytes: number;
  eventType: string;
}) {
  const severity = details.payloadBytes >= SSE_PAYLOAD_ERROR_BYTES
    ? "error"
    : details.payloadBytes >= SSE_PAYLOAD_WARN_BYTES
      ? "warn"
      : null;
  if (!severity) {
    return;
  }
  if (!recordThreshold(emittedSsePayloadThresholds, `${details.stream}:${details.identifier}`, "sse-payload", severity)) {
    return;
  }

  logServerEvent("ai-command-diagnostics", "sse-payload-large", {
    stream: details.stream,
    identifier: details.identifier,
    eventType: details.eventType,
    payloadBytes: details.payloadBytes,
    payload: formatBytes(details.payloadBytes),
  }, severity);
  maybeLogHeapPressure("sse-payload-large", {
    stream: details.stream,
    identifier: details.identifier,
    payloadBytes: details.payloadBytes,
  });
}

export function getAiDiagnosticsThresholdsForTest() {
  return {
    processOutputWarnBytes: PROCESS_OUTPUT_WARN_BYTES,
    jobOutputWarnBytes: JOB_OUTPUT_WARN_BYTES,
    outputEventsWarnCount: OUTPUT_EVENTS_WARN_COUNT,
    ssePayloadWarnBytes: SSE_PAYLOAD_WARN_BYTES,
  };
}

export function resetAiDiagnosticsForTest() {
  emittedProcessOutputThresholds.clear();
  emittedJobSnapshotThresholds.clear();
  emittedSsePayloadThresholds.clear();
  emittedHeapThresholds.clear();
}
