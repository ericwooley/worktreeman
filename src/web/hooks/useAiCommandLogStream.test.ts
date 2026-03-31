import assert from "node:assert/strict";
import test from "node:test";
import type { AiCommandLogEntry, AiCommandLogStreamEvent } from "@shared/types";
import {
  AiCommandLogLoadCancelledError,
  createAiCommandLogStreamController,
} from "./useAiCommandLogStream";

function createLog(fileName: string, timestamp = "2026-03-31T12:00:00.000Z"): AiCommandLogEntry {
  return {
    jobId: `${fileName}-job`,
    fileName,
    timestamp,
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
    subscribe(fileName, onEvent) {
      subscribeCalls += 1;
      listeners.set(fileName, onEvent);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(fileName);
      };
    },
    applyEvent(event) {
      currentDetail = event.log;
    },
    getCurrentDetail: () => currentDetail,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => undefined,
  });

  const firstLoad = controller.load("log-1.json");
  const secondLoad = controller.load("log-1.json");

  assert.equal(subscribeCalls, 1);
  assert.strictEqual(firstLoad, secondLoad);

  listeners.get("log-1.json")?.({
    type: "snapshot",
    log: createLog("log-1.json"),
  });

  const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);
  assert.equal(firstResult?.fileName, "log-1.json");
  assert.equal(secondResult?.fileName, "log-1.json");

  const thirdResult = await controller.load("log-1.json");
  assert.equal(thirdResult?.fileName, "log-1.json");
  assert.equal(subscribeCalls, 1);
  assert.equal(unsubscribeCalls, 0);
});

test("AI log stream controller cancels the previous pending load when switching files", async () => {
  const listeners = new Map<string, (event: AiCommandLogStreamEvent) => void>();
  let unsubscribeCalls = 0;
  let currentDetail: AiCommandLogEntry | null = null;

  const controller = createAiCommandLogStreamController({
    subscribe(fileName, onEvent) {
      listeners.set(fileName, onEvent);
      return () => {
        unsubscribeCalls += 1;
        listeners.delete(fileName);
      };
    },
    applyEvent(event) {
      currentDetail = event.log;
    },
    getCurrentDetail: () => currentDetail,
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => undefined,
  });

  const firstLoad = controller.load("log-1.json");
  const secondLoad = controller.load("log-2.json");

  await assert.rejects(firstLoad, AiCommandLogLoadCancelledError);
  assert.equal(unsubscribeCalls, 1);

  listeners.get("log-2.json")?.({
    type: "snapshot",
    log: createLog("log-2.json"),
  });

  const secondResult = await secondLoad;
  assert.equal(secondResult?.fileName, "log-2.json");
  assert.equal(controller.getTrackedFileName(), "log-2.json");
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

  const pendingLoad = controller.load("log-1.json");
  const triggerTimeout: () => void = timeoutCallback ?? (() => {
    throw new Error("Expected timeout callback to be registered.");
  });
  triggerTimeout();

  await assert.rejects(pendingLoad, /Timed out waiting for the AI log stream/);
  assert.equal(controller.getTrackedFileName(), null);
});
