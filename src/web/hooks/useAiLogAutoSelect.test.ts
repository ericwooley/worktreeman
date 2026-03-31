import assert from "node:assert/strict";
import test from "node:test";
import { shouldAutoSelectAiLog } from "./useAiLogAutoSelect";

test("AI log auto-select starts with the primary candidate when nothing is selected", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedJobId: null,
    primaryCandidateJobId: "job-1",
    lastAutoSelectedJobId: null,
  }), true);
});

test("AI log auto-select does not fire while the tab is still loading", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: true,
    selectedJobId: null,
    primaryCandidateJobId: "job-1",
    lastAutoSelectedJobId: null,
  }), false);
});

test("AI log auto-select does not reselect when a file is already selected", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedJobId: "job-1",
    primaryCandidateJobId: "job-1",
    lastAutoSelectedJobId: null,
  }), false);
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedJobId: "job-2",
    primaryCandidateJobId: "job-1",
    lastAutoSelectedJobId: null,
  }), false);
});

test("AI log auto-select does not retry the same candidate after a transient empty render", () => {
  assert.equal(shouldAutoSelectAiLog({
    loading: false,
    selectedJobId: null,
    primaryCandidateJobId: "job-1",
    lastAutoSelectedJobId: "job-1",
  }), false);
});
