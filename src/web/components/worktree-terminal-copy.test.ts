import assert from "node:assert/strict";
import test from "#test-runtime";
import {
  getTerminalCopyDecision,
  logTerminalCopyEvent,
  shouldHandleTerminalCopy,
  writeTerminalTextToClipboard,
} from "./worktree-terminal-copy";

test("terminal copy stays active for xterm selections even when focus sits outside the host", () => {
  assert.equal(
    shouldHandleTerminalCopy({
      hasTerminalFocus: false,
      terminalSelection: "npm test",
      domSelection: "npm test",
    }),
    true,
  );

  assert.equal(
    shouldHandleTerminalCopy({
      hasTerminalFocus: false,
      terminalSelection: "npm test",
      domSelection: "Copied from another panel",
    }),
    false,
  );

  assert.equal(
    shouldHandleTerminalCopy({
      hasTerminalFocus: true,
      terminalSelection: "npm test",
      domSelection: "",
    }),
    true,
  );
});

test("terminal copy decision exposes the reason for handled and skipped copies", () => {
  assert.deepEqual(
    getTerminalCopyDecision({
      hasTerminalFocus: false,
      terminalSelection: "",
      domSelection: "",
    }),
    { shouldHandle: false, reason: "no-terminal-selection" },
  );

  assert.deepEqual(
    getTerminalCopyDecision({
      hasTerminalFocus: true,
      terminalSelection: "npm test",
      domSelection: "Copied from another panel",
    }),
    { shouldHandle: true, reason: "terminal-focused" },
  );

  assert.deepEqual(
    getTerminalCopyDecision({
      hasTerminalFocus: false,
      terminalSelection: "npm test",
      domSelection: "Copied from another panel",
    }),
    { shouldHandle: false, reason: "dom-selection-mismatch" },
  );
});

test("terminal copy logger emits structured browser logs", () => {
  const originalConsole = globalThis.console;
  const calls: unknown[][] = [];
  globalThis.console = {
    ...originalConsole,
    info: (...args: unknown[]) => {
      calls.push(args);
    },
  } as Console;

  try {
    logTerminalCopyEvent("document-copy", { reason: "terminal-focused", textLength: 8 });
  } finally {
    globalThis.console = originalConsole;
  }

  assert.deepEqual(calls, [["[terminal-copy]", "document-copy", { reason: "terminal-focused", textLength: 8 }]]);
});

test("terminal clipboard writer falls back to execCommand when async clipboard is unavailable", async () => {
  const originalNavigator = globalThis.navigator;
  const originalDocument = globalThis.document;
  const focusCalls: string[] = [];
  const fakeTextarea = {
    value: "",
    style: {},
    setAttribute: () => undefined,
    focus: () => {
      focusCalls.push("textarea-focus");
    },
    select: () => {
      focusCalls.push("textarea-select");
    },
    remove: () => {
      focusCalls.push("textarea-remove");
    },
  };
  const fakeActiveElement = {
    focus: () => {
      focusCalls.push("active-focus");
    },
  };

  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {},
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      activeElement: fakeActiveElement,
      body: {
        append: () => {
          focusCalls.push("body-append");
        },
      },
      createElement: () => fakeTextarea,
      execCommand: (command: string) => {
        focusCalls.push(`exec:${command}`);
        return true;
      },
    },
  });

  try {
    const method = await writeTerminalTextToClipboard("npm test");
    assert.equal(method, "exec-command");
  } finally {
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: originalNavigator,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  }

  assert.deepEqual(focusCalls, [
    "body-append",
    "textarea-focus",
    "textarea-select",
    "exec:copy",
    "textarea-remove",
    "active-focus",
  ]);
});
