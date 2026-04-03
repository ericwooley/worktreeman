import assert from "node:assert/strict";
import test from "#test-runtime";
import type { AiCommandLogEntry, AiCommandLogStreamEvent } from "@shared/types";
import {
  AiCommandLogLoadCancelledError,
  createAiCommandLogStreamController,
} from "./useAiCommandLogStream";

const WORKTREE_ID = "99999999999999999999999999999999" as AiCommandLogEntry["worktreeId"];

function createLog(jobId: string, timestamp = "2026-03-31T12:00:00.000Z"): AiCommandLogEntry {
  return {
    jobId,
    fileName: `${jobId}.json`,
    timestamp,
    worktreeId: WORKTREE_ID,
    branch: "feature-ai-log",
    documentId: null,
    commandId: "smart",
    origin: null,
    worktreePath: "/repo/feature-ai-log",
    command: "runner --prompt",
    request: "Summarize the work.",
    response: {
      stdout: "",
      stderr: "",
      events: [],
    },
    status: "running",
    pid: 1234,
    exitCode: null,
    processName: "wtm:ai:test",
    completedAt: undefined,
    error: null,
  };
}

test("AI log stream controller reuses the same subscription while the initial snapshot is pending", async () => {
  const listeners = new Map<string, (event: AiCommandLogStreamEvent) => void>();
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  let currentDetail: AiCommandLogEntry | null = null;

  const controller = createAiCommandLogStreamController({
    subscribe(jobId, onEvent) {
      subscribeCalls += 1;
      listeners.set(jobId, onEvent);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(jobId);
      };
    },
    applyEvent(event) {
      currentDetail = event.log;
    },
    getCurrentDetail: () => currentDetail,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => undefined,
  });

  const firstLoad = controller.load("job-1");
  const secondLoad = controller.load("job-1");

  assert.equal(subscribeCalls, 1);
  assert.strictEqual(firstLoad, secondLoad);

  listeners.get("job-1")?.({
    type: "snapshot",
    log: createLog("job-1"),
  });

  const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);
  assert.equal(firstResult?.jobId, "job-1");
  assert.equal(secondResult?.jobId, "job-1");

  const thirdResult = await controller.load("job-1");
  assert.equal(thirdResult?.jobId, "job-1");
  assert.equal(subscribeCalls, 1);
  assert.equal(unsubscribeCalls, 0);
});

test("AI log stream controller cancels the previous pending load when switching files", async () => {
  const listeners = new Map<string, (event: AiCommandLogStreamEvent) => void>();
  let unsubscribeCalls = 0;
  let currentDetail: AiCommandLogEntry | null = null;

  const controller = createAiCommandLogStreamController({
    subscribe(jobId, onEvent) {
      listeners.set(jobId, onEvent);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(jobId);
      };
    },
    applyEvent(event) {
      currentDetail = event.log;
    },
    getCurrentDetail: () => currentDetail,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => undefined,
  });

  const firstLoad = controller.load("job-1");
  const secondLoad = controller.load("job-2");

  await assert.rejects(firstLoad, AiCommandLogLoadCancelledError);
  assert.equal(unsubscribeCalls, 1);

  listeners.get("job-2")?.({
    type: "snapshot",
    log: createLog("job-2"),
  });

  const secondResult = await secondLoad;
  assert.equal(secondResult?.jobId, "job-2");
  assert.equal(controller.getTrackedJobId(), "job-2");
});

test("AI log stream controller times out and clears the tracked file when the snapshot never arrives", async () => {
  let timeoutCallback: (() => void) | null = null;
  let currentDetail: AiCommandLogEntry | null = null;

  const controller = createAiCommandLogStreamController({
    subscribe() {
      return () => undefined;
    },
    applyEvent(event) {
      currentDetail = event.log;
    },
    getCurrentDetail: () => currentDetail,
    setTimeoutFn: (callback) => {
      timeoutCallback = callback;
      return 1;
    },
    clearTimeoutFn: () => undefined,
  });

  const pendingLoad = controller.load("job-1");
  const triggerTimeout: () => void = timeoutCallback ?? (() => {
    throw new Error("Expected timeout callback to be registered.");
  });
  triggerTimeout();

  await assert.rejects(pendingLoad, /Timed out waiting for the AI log stream/);
  assert.equal(controller.getTrackedJobId(), null);
});
