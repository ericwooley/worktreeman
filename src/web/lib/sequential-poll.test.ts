import assert from "node:assert/strict";
import test from "node:test";
import { startSequentialPoll } from "./sequential-poll";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  let reject!: Deferred<T>["reject"];
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

function flushMicrotasks() {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

test("sequential poll waits for a request to settle before scheduling the next one", async () => {
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 1;
  const originalWindow = globalThis.window;

  globalThis.window = {
    setTimeout: ((callback: TimerHandler) => {
      const id = nextTimerId++;
      scheduled.set(id, () => {
        scheduled.delete(id);
        (callback as () => void)();
      });
      return id;
    }) as typeof window.setTimeout,
    clearTimeout: ((id: number) => {
      scheduled.delete(id);
    }) as typeof window.clearTimeout,
  } as Window & typeof globalThis;

  try {
    const firstRun = createDeferred<void>();
    let calls = 0;

    const poll = startSequentialPoll(async () => {
      calls += 1;
      await firstRun.promise;
    }, {
      intervalMs: 50,
      runImmediately: true,
    });

    assert.equal(calls, 1);
    assert.equal(scheduled.size, 0);

    firstRun.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(scheduled.size, 1);

    const [timerCallback] = scheduled.values();
    timerCallback();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(calls, 2);
    poll.stop();
  } finally {
    globalThis.window = originalWindow;
  }
});

test("sequential poll coalesces manual triggers while a request is already in flight", async () => {
  const scheduled = new Map<number, () => void>();
  let nextTimerId = 1;
  const originalWindow = globalThis.window;

  globalThis.window = {
    setTimeout: ((callback: TimerHandler) => {
      const id = nextTimerId++;
      scheduled.set(id, () => {
        scheduled.delete(id);
        (callback as () => void)();
      });
      return id;
    }) as typeof window.setTimeout,
    clearTimeout: ((id: number) => {
      scheduled.delete(id);
    }) as typeof window.clearTimeout,
  } as Window & typeof globalThis;

  try {
    const firstRun = createDeferred<void>();
    const secondRun = createDeferred<void>();
    const pendingRuns = [firstRun, secondRun];
    let calls = 0;

    const poll = startSequentialPoll(async () => {
      const currentRun = pendingRuns[calls];
      calls += 1;
      await currentRun.promise;
    }, {
      intervalMs: 50,
      runImmediately: true,
    });

    poll.trigger();
    poll.trigger();
    await flushMicrotasks();

    assert.equal(calls, 1);
    assert.equal(scheduled.size, 0);

    firstRun.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(calls, 2);
    assert.equal(scheduled.size, 0);

    secondRun.resolve();
    await flushMicrotasks();
    await flushMicrotasks();

    assert.equal(scheduled.size, 1);
    poll.stop();
  } finally {
    globalThis.window = originalWindow;
  }
});
