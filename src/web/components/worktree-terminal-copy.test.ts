import assert from "node:assert/strict";
import test from "#test-runtime";
import { shouldHandleTerminalCopy } from "./worktree-terminal-copy";

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
