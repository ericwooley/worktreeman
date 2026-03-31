import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoSelectAiLog } from "./useAiLogAutoSelect";

test("AI log auto-select starts with the primary candidate when nothing is selected", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedFileName: null,
    primaryCandidateFileName: "log-1.json",
    lastAutoSelectedFileName: null,
  }), true);
});

test("AI log auto-select does not fire while the tab is still loading", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: true,
    selectedFileName: null,
    primaryCandidateFileName: "log-1.json",
    lastAutoSelectedFileName: null,
  }), false);
});

test("AI log auto-select does not reselect when a file is already selected", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedFileName: "log-1.json",
    primaryCandidateFileName: "log-1.json",
    lastAutoSelectedFileName: null,
  }), false);
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedFileName: "log-2.json",
    primaryCandidateFileName: "log-1.json",
    lastAutoSelectedFileName: null,
  }), false);
});

test("AI log auto-select does not retry the same candidate after a transient empty render", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedFileName: null,
    primaryCandidateFileName: "log-1.json",
    lastAutoSelectedFileName: "log-1.json",
  }), false);
});
