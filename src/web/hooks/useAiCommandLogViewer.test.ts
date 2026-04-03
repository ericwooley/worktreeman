import assert from "node:assert/strict";
import test from "#test-runtime";
import type { AiCommandLogEntry, AiCommandLogStreamEvent } from "@shared/types";

import { createAiCommandLogViewerSubscriptionController } from "./useAiCommandLogViewer";

const WORKTREE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as AiCommandLogEntry["worktreeId"];

function createLog(jobId: string): AiCommandLogEntry {
  return {
    jobId,
    fileName: `${jobId}.json`,
    timestamp: "2026-03-31T18:00:00.000Z",
    worktreeId: WORKTREE_ID,
    branch: "feature-ai-log",
    documentId: null,
    commandId: "smart",
    worktreePath: "/repo/.worktrees/feature-ai-log",
    command: "opencode run",
    request: "Do the thing",
    response: {
      stdout: "",
      stderr: "",
      events: [],
    },
    status: "running",
    pid: null,
    exitCode: null,
    processName: null,
    completedAt: undefined,
    error: null,
    origin: null,
  };
}

test("AI log viewer subscription controller replaces the previous worker stream when switching job ids", () => {
  const listeners = new Map<string, (event: AiCommandLogStreamEvent) => void>();
  const closed: string[] = [];
  const seen: string[] = [];

  const controller = createAiCommandLogViewerSubscriptionController({
    subscribe: (jobId, onEvent) => {
      listeners.set(jobId, onEvent);
      return () => {
        closed.push(jobId);
        listeners.delete(jobId);
      };
    },
  });

  controller.select("job-1", (event) => {
    if (event.log) {
      seen.push(`job-1:${event.log.jobId}`);
    }
  });
  assert.equal(controller.getTrackedJobId(), "job-1");
  assert.equal(listeners.has("job-1"), true);

  controller.select("job-2", (event) => {
    if (event.log) {
      seen.push(`job-2:${event.log.jobId}`);
    }
  });

  assert.equal(controller.getTrackedJobId(), "job-2");
  assert.deepEqual(closed, ["job-1"]);
  assert.equal(listeners.has("job-1"), false);
  assert.equal(listeners.has("job-2"), true);

  listeners.get("job-2")?.({ type: "snapshot", log: createLog("job-2") });
  assert.deepEqual(seen, ["job-2:job-2"]);
});

test("AI log viewer subscription controller reuses the current stream for the same job id", () => {
  let subscribeCount = 0;
  const controller = createAiCommandLogViewerSubscriptionController({
    subscribe: () => {
      subscribeCount += 1;
      return () => undefined;
    },
  });

  controller.select("job-1", () => undefined);
  controller.select("job-1", () => undefined);

  assert.equal(subscribeCount, 1);
  assert.equal(controller.getTrackedJobId(), "job-1");
});

test("AI log viewer subscription controller clears the current stream", () => {
  let closed = 0;
  const controller = createAiCommandLogViewerSubscriptionController({
    subscribe: () => () => {
      closed += 1;
    },
  });

  controller.select("job-1", () => undefined);
  controller.clear();

  assert.equal(closed, 1);
  assert.equal(controller.getTrackedJobId(), null);
});
