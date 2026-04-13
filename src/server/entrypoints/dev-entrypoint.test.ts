import assert from "node:assert/strict";
import test from "#test-runtime";
import { classifyChangedPath } from "./dev-entrypoint.js";

test("classifyChangedPath restarts both roles for database entrypoint changes", () => {
  assert.equal(
    classifyChangedPath("/tmp/repo", "/tmp/repo/src/server/entrypoints/database-entrypoint.ts"),
    "both",
  );
});

test("classifyChangedPath restarts both roles for database socket changes", () => {
  assert.equal(
    classifyChangedPath("/tmp/repo", "/tmp/repo/src/server/services/database-socket-service.ts"),
    "both",
  );
});
