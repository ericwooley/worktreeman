type TestCallable = (...args: any[]) => unknown;

interface TestRuntime extends TestCallable {
  skip: TestCallable;
  only: TestCallable;
  todo: TestCallable;
  if: (condition: unknown) => TestCallable;
  skipIf: (condition: unknown) => TestCallable;
  onlyIf: (condition: unknown) => TestCallable;
  serial: TestCallable;
  before: TestCallable;
  after: TestCallable;
  beforeEach: TestCallable;
  afterEach: TestCallable;
}

interface BunLikeTestModule {
  test: TestRuntime;
  beforeAll?: TestCallable;
  afterAll?: TestCallable;
  beforeEach?: TestCallable;
  afterEach?: TestCallable;
}

function normalizeBunTestCall(
  primaryMethod: TestCallable,
  serialMethod: TestCallable | undefined,
  args: unknown[],
): { method: TestCallable; args: unknown[] } {
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

  const method = concurrency === false && serialMethod ? serialMethod : primaryMethod;
  const optionEntries = Object.entries(options).filter(([, value]) => value !== undefined);

  if (optionEntries.length === 0) {
    return { method, args: [name, fn] };
  }

  if (optionEntries.length === 1 && optionEntries[0]?.[0] === "timeout" && typeof optionEntries[0][1] === "number") {
    return { method, args: [name, fn, optionEntries[0][1]] };
  }

  return { method, args: [name, Object.fromEntries(optionEntries), fn] };
}

function normalizeBunHookCall(method: TestCallable, args: unknown[]): unknown[] {
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

  return [fn, Object.fromEntries(optionEntries)];
}

function createBunCompatibleTest(module: BunLikeTestModule): TestRuntime {
  const bunTest = module.test;
  const compatibleTest = ((...args: unknown[]) => {
    const normalized = normalizeBunTestCall(bunTest, bunTest.serial, args);
    return normalized.method(...normalized.args);
  }) as TestRuntime;

  compatibleTest.skip = (...args: unknown[]) => bunTest.skip?.(...args);
  compatibleTest.only = (...args: unknown[]) => bunTest.only?.(...args);
  compatibleTest.todo = (...args: unknown[]) => bunTest.todo?.(...args);
  compatibleTest.if = (condition: unknown) => bunTest.if?.(condition) ?? (() => undefined);
  compatibleTest.skipIf = (condition: unknown) => bunTest.skipIf?.(condition) ?? (() => undefined);
  compatibleTest.onlyIf = (condition: unknown) => bunTest.onlyIf?.(condition) ?? (() => undefined);
  compatibleTest.serial = (...args: unknown[]) => {
    const normalized = normalizeBunTestCall(bunTest.serial ?? bunTest, bunTest.serial, args);
    return normalized.method(...normalized.args);
  };
  compatibleTest.before = (...args: unknown[]) => module.beforeAll?.(...normalizeBunHookCall(module.beforeAll, args));
  compatibleTest.after = (...args: unknown[]) => module.afterAll?.(...normalizeBunHookCall(module.afterAll, args));
  compatibleTest.beforeEach = (...args: unknown[]) => module.beforeEach?.(...normalizeBunHookCall(module.beforeEach, args));
  compatibleTest.afterEach = (...args: unknown[]) => module.afterEach?.(...normalizeBunHookCall(module.afterEach, args));

  return compatibleTest;
}

async function loadTestRuntime(): Promise<TestRuntime> {
  if (!("Bun" in globalThis)) {
    const nodeTestModule = await import("node:test");
    return ((nodeTestModule as unknown as { default?: TestRuntime }).default ?? (nodeTestModule as unknown as TestRuntime));
  }

  const bunTestModuleName: string = "bun:test";
  const bunTestModule = await import(bunTestModuleName) as BunLikeTestModule;
  return createBunCompatibleTest(bunTestModule);
}

const test = await loadTestRuntime();

export default test;
