import assert from "node:assert/strict";
import test from "node:test";
import type { AiCommandJob } from "@shared/types";
import {
  buildAiJobNotification,
  requestBrowserNotificationPermission,
  shouldNotifyAiJobCompletion,
} from "./browser-notifications";

function createAiJob(overrides: Partial<AiCommandJob> = {}): AiCommandJob {
  return {
    jobId: "job-1",
    fileName: "job-1.json",
    branch: "feature/notifications",
    documentId: "doc-1",
    commandId: "smart",
    command: "runner --prompt $WTM_AI_INPUT",
    input: "Add notifications",
    status: "running",
    startedAt: "2026-03-27T12:00:00.000Z",
    stdout: "",
    stderr: "",
    origin: {
      kind: "project-management-document-run",
      label: "Document work",
      location: {
        tab: "project-management",
        branch: "feature/notifications",
        documentId: "doc-1",
        projectManagementSubTab: "document",
      },
    },
    ...overrides,
  };
}

test("shouldNotifyAiJobCompletion returns true for hidden running-to-completed transitions", () => {
  const previousJob = createAiJob();
  const nextJob = createAiJob({
    status: "completed",
    completedAt: "2026-03-27T12:01:00.000Z",
  });

  assert.equal(
    shouldNotifyAiJobCompletion({
      previousJob,
      nextJob,
      permission: "granted",
      attentionState: {
        visibilityState: "hidden",
        hasFocus: false,
      },
    }),
    true,
  );
});

test("shouldNotifyAiJobCompletion skips focused windows and unrelated updates", () => {
  const previousJob = createAiJob();
  const completedJob = createAiJob({
    status: "completed",
    completedAt: "2026-03-27T12:01:00.000Z",
  });

  assert.equal(
    shouldNotifyAiJobCompletion({
      previousJob,
      nextJob: completedJob,
      permission: "granted",
      attentionState: {
        visibilityState: "visible",
        hasFocus: true,
      },
    }),
    false,
  );

  assert.equal(
    shouldNotifyAiJobCompletion({
      previousJob,
      nextJob: createAiJob({ jobId: "job-2", status: "completed" }),
      permission: "granted",
      attentionState: {
        visibilityState: "hidden",
        hasFocus: false,
      },
    }),
    false,
  );

  assert.equal(
    shouldNotifyAiJobCompletion({
      previousJob,
      nextJob: completedJob,
      permission: "default",
      attentionState: {
        visibilityState: "hidden",
        hasFocus: false,
      },
    }),
    false,
  );
});

test("buildAiJobNotification formats completion and failure messages", () => {
  assert.deepEqual(
    buildAiJobNotification(createAiJob({ status: "completed", completedAt: "2026-03-27T12:01:00.000Z" })),
    {
      title: "Smart AI finished",
      body: "Worktree task finished in feature/notifications.",
      tag: "ai-job-job-1",
    },
  );

  const failureNotification = buildAiJobNotification(createAiJob({
    status: "failed",
    error: "The command exited after validation failed because the generated file did not compile.",
  }));

  assert.equal(failureNotification.title, "Smart AI failed");
  assert.match(failureNotification.body, /^Worktree task failed in feature\/notifications: /);
  assert.ok(failureNotification.body.length < 220);
});

test("requestBrowserNotificationPermission reuses existing permission and requests default permission", async () => {
  assert.equal(await requestBrowserNotificationPermission(null), "unsupported");

  let requests = 0;
  assert.equal(
    await requestBrowserNotificationPermission({
      permission: "granted",
      requestPermission: async () => {
        requests += 1;
        return "granted";
      },
    }),
    "granted",
  );
  assert.equal(requests, 0);

  assert.equal(
    await requestBrowserNotificationPermission({
      permission: "default",
      requestPermission: async () => {
        requests += 1;
        return "denied";
      },
    }),
    "denied",
  );
  assert.equal(requests, 1);
});
