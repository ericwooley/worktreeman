import assert from "node:assert/strict";
import test from "#test-runtime";
import type { ChildProcess } from "node:child_process";
import { restartManagedRuntimeProcess, type ManagedRuntimeProcess } from "./process-supervisor-service.js";

function createManagedProcess(role: "server" | "worker", events: string[], name: string): ManagedRuntimeProcess {
  return {
    role,
    process: {} as ChildProcess,
    ready: Promise.resolve({ role }),
    stop: async () => {
      events.push(`stop:${name}`);
    },
  };
}

test("restartManagedRuntimeProcess overlap starts replacement before stopping current process", async () => {
  const events: string[] = [];
  const current = createManagedProcess("worker", events, "current");
  const replacement = createManagedProcess("worker", events, "replacement");

  const next = await restartManagedRuntimeProcess({
    mode: "overlap",
    current,
    start: async () => {
      events.push("start:replacement");
      return replacement;
    },
    onReplaced: async () => {
      events.push("activate:replacement");
    },
  });

  assert.equal(next, replacement);
  assert.deepEqual(events, [
    "start:replacement",
    "activate:replacement",
    "stop:current",
  ]);
});

test("restartManagedRuntimeProcess overlap leaves current process running when replacement fails to start", async () => {
  const events: string[] = [];
  const current = createManagedProcess("worker", events, "current");

  await assert.rejects(
    restartManagedRuntimeProcess({
      mode: "overlap",
      current,
      start: async () => {
        events.push("start:replacement");
        throw new Error("replacement failed");
      },
    }),
    /replacement failed/,
  );

  assert.deepEqual(events, ["start:replacement"]);
});

test("restartManagedRuntimeProcess serial stops current process before starting replacement", async () => {
  const events: string[] = [];
  const current = createManagedProcess("server", events, "current");
  const replacement = createManagedProcess("server", events, "replacement");

  const next = await restartManagedRuntimeProcess({
    mode: "serial",
    current,
    start: async () => {
      events.push("start:replacement");
      return replacement;
    },
    onReplaced: async () => {
      events.push("activate:replacement");
    },
  });

  assert.equal(next, replacement);
  assert.deepEqual(events, [
    "stop:current",
    "start:replacement",
    "activate:replacement",
  ]);
});
