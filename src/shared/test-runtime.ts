import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  test as vitestTest,
} from "vitest";

type TestCallable = (...args: any[]) => unknown;

interface TestRuntime extends TestCallable {
  skip: TestCallable;
  only: TestCallable;
  todo: TestCallable;
  runIf: (condition: unknown) => TestCallable;
  if: (condition: unknown) => TestCallable;
  skipIf: (condition: unknown) => TestCallable;
  onlyIf: (condition: unknown) => TestCallable;
  sequential: TestCallable;
  serial: TestCallable;
  before: TestCallable;
  after: TestCallable;
  beforeEach: TestCallable;
  afterEach: TestCallable;
}

function callWithArgs(method: unknown, args: any[]): unknown {
  return (method as TestCallable)(...args);
}

function normalizeVitestTestCall(
  primaryMethod: TestCallable,
  sequentialMethod: TestCallable,
  args: any[],
): { method: TestCallable; args: any[] } {
  if (args.length < 3 || typeof args[1] === "function" || typeof args[1] !== "object" || args[1] === null) {
    return { method: primaryMethod, args };
  }

  const [name, rawOptions, fn] = args;
  if (typeof fn !== "function") {
    return { method: primaryMethod, args };
  }

  const options = { ...(rawOptions as Record<string, unknown>) };
  const concurrency = options.concurrency;
  delete options.concurrency;

  const method = concurrency === false ? sequentialMethod : primaryMethod;
  const optionEntries = Object.entries(options).filter(([, value]) => value !== undefined);
  if (optionEntries.length === 0) {
    return { method, args: [name, fn] };
  }

  return { method, args: [name, Object.fromEntries(optionEntries), fn] };
}

function normalizeVitestHookCall(args: any[]): any[] {
  if (args.length < 2 || typeof args[0] !== "function" || typeof args[1] !== "object" || args[1] === null) {
    return args;
  }

  const [fn, rawOptions] = args;
  const optionEntries = Object.entries(rawOptions as Record<string, unknown>).filter(([, value]) => value !== undefined);
  if (optionEntries.length === 0) {
    return [fn];
  }

  if (optionEntries.length === 1 && optionEntries[0]?.[0] === "timeout" && typeof optionEntries[0][1] === "number") {
    return [fn, optionEntries[0][1]];
  }

  return [fn];
}

const test = ((...args: any[]) => {
  const normalized = normalizeVitestTestCall(vitestTest, vitestTest.sequential ?? vitestTest, args);
  return callWithArgs(normalized.method, normalized.args);
}) as TestRuntime;

test.skip = (...args: any[]) => callWithArgs(vitestTest.skip, args);
test.only = (...args: any[]) => callWithArgs(vitestTest.only, args);
test.todo = (...args: any[]) => callWithArgs(vitestTest.todo, args);
test.runIf = (condition: unknown) => vitestTest.runIf(Boolean(condition));
test.if = test.runIf;
test.skipIf = (condition: unknown) => vitestTest.skipIf(Boolean(condition));
test.onlyIf = (condition: unknown) => (Boolean(condition) ? vitestTest.only : vitestTest.skip);
test.sequential = (...args: any[]) => {
  const normalized = normalizeVitestTestCall(vitestTest.sequential ?? vitestTest, vitestTest.sequential ?? vitestTest, args);
  return callWithArgs(normalized.method, normalized.args);
};
test.serial = (...args: any[]) => test.sequential(...args);
test.before = (...args: any[]) => callWithArgs(beforeAll, normalizeVitestHookCall(args));
test.after = (...args: any[]) => callWithArgs(afterAll, normalizeVitestHookCall(args));
test.beforeEach = (...args: any[]) => callWithArgs(beforeEach, normalizeVitestHookCall(args));
test.afterEach = (...args: any[]) => callWithArgs(afterEach, normalizeVitestHookCall(args));

export default test;
