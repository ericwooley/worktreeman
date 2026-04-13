import assert from "node:assert/strict";
import process from "node:process";
import test from "#test-runtime";
import {
  getAiDiagnosticsThresholdsForTest,
  noteAiJobSnapshotGrowth,
  noteAiSsePayloadSize,
  resetAiDiagnosticsForTest,
} from "./ai-command-diagnostics-service.js";

function collectWrites(target: string[]) {
  return ((chunk: string | Uint8Array) => {
    target.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
}

test("AI job diagnostics log when job snapshot growth crosses threshold", () => {
  resetAiDiagnosticsForTest();
  const stdoutLines: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = collectWrites(stdoutLines);

  try {
    const warnBytes = getAiDiagnosticsThresholdsForTest().jobOutputWarnBytes;
    noteAiJobSnapshotGrowth({
      jobId: "job-large-snapshot",
      branch: "feature-ai-log",
      processName: "wtm:ai:job-large-snapshot",
      stdout: "x".repeat(warnBytes + 1024),
      stderr: "",
      outputEvents: [],
    });

    const output = stdoutLines.join("");
    assert.match(output, /\[ai-command-diagnostics\] job-snapshot-growth/);
    assert.match(output, /jobId=job-large-snapshot/);
    assert.match(output, /branch=feature-ai-log/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    resetAiDiagnosticsForTest();
  }
});

test("AI diagnostics log when SSE payload crosses threshold", () => {
  resetAiDiagnosticsForTest();
  const stdoutLines: string[] = [];
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = collectWrites(stdoutLines);

  try {
    const warnBytes = getAiDiagnosticsThresholdsForTest().ssePayloadWarnBytes;
    noteAiSsePayloadSize({
      stream: "ai-log-detail",
      identifier: "job-123",
      eventType: "update",
      payloadBytes: warnBytes + 1024,
    });

    const output = stdoutLines.join("");
    assert.match(output, /\[ai-command-diagnostics\] sse-payload-large/);
    assert.match(output, /stream=ai-log-detail/);
    assert.match(output, /identifier=job-123/);
  } finally {
    process.stdout.write = originalStdoutWrite;
    resetAiDiagnosticsForTest();
  }
});
