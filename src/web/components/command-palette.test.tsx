import assert from "node:assert/strict";
import test from "#test-runtime";
import { shouldResetCommandPaletteState } from "./command-palette";

test("command palette does not reset its query for same-scope rerenders while open", () => {
  assert.equal(
    shouldResetCommandPaletteState({
      open: true,
      previousOpen: true,
      initialQuery: "",
      previousInitialQuery: "",
      scopeKey: "main",
      previousScopeKey: "main",
    }),
    false,
  );
});

test("command palette resets when opening or changing scope or initial query", () => {
  assert.equal(
    shouldResetCommandPaletteState({
      open: true,
      previousOpen: false,
      initialQuery: "",
      previousInitialQuery: "",
      scopeKey: "main",
      previousScopeKey: "main",
    }),
    true,
  );

  assert.equal(
    shouldResetCommandPaletteState({
      open: true,
      previousOpen: true,
      initialQuery: ":",
      previousInitialQuery: "",
      scopeKey: "main",
      previousScopeKey: "main",
    }),
    true,
  );

  assert.equal(
    shouldResetCommandPaletteState({
      open: true,
      previousOpen: true,
      initialQuery: "",
      previousInitialQuery: "",
      scopeKey: "theme-select",
      previousScopeKey: "main",
    }),
    true,
  );
});
