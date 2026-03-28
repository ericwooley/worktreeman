import assert from "node:assert/strict";
import test from "node:test";
import { readDashboardUrlState } from "./dashboard-url-state";

test("readDashboardUrlState maps legacy shell and background tabs into Worktree Environment sub tabs", () => {
  assert.deepEqual(readDashboardUrlState("?tab=shell&env=feature-one"), {
    selectedBranch: "feature-one",
    activeTab: "environment",
    aiActivitySubTab: "log",
    environmentSubTab: "terminal",
    gitSubTab: "pull-request",
    gitView: "graph",
    gitPullRequestDocumentId: null,
    isTerminalVisible: false,
    projectManagementSubTab: "board",
    projectManagementSelectedDocumentId: null,
    projectManagementDocumentViewMode: "document",
  });

  assert.deepEqual(readDashboardUrlState("?tab=background&terminal=open"), {
    selectedBranch: null,
    activeTab: "environment",
    aiActivitySubTab: "log",
    environmentSubTab: "background",
    gitSubTab: "pull-request",
    gitView: "graph",
    gitPullRequestDocumentId: null,
    isTerminalVisible: true,
    projectManagementSubTab: "board",
    projectManagementSelectedDocumentId: null,
    projectManagementDocumentViewMode: "document",
  });
});

test("readDashboardUrlState reads nested environment and project management state from current params", () => {
  assert.deepEqual(
    readDashboardUrlState("?tab=environment&envTab=background&gitTab=pull-request&git=diff&gitPr=doc-pr-7&pmTab=document&pmDoc=doc-7&pmView=edit"),
    {
      selectedBranch: null,
      activeTab: "environment",
      aiActivitySubTab: "log",
      environmentSubTab: "background",
      gitSubTab: "pull-request",
      gitView: "diff",
      gitPullRequestDocumentId: "doc-pr-7",
      isTerminalVisible: false,
      projectManagementSubTab: "document",
      projectManagementSelectedDocumentId: "doc-7",
      projectManagementDocumentViewMode: "edit",
    },
  );
});

test("readDashboardUrlState reads the top-level AI tab and active-worktrees sub tab while preserving nested project management context", () => {
  assert.deepEqual(
    readDashboardUrlState("?tab=ai-log&aiTab=active-worktrees&pmTab=history&pmDoc=doc-9&pmView=edit"),
    {
      selectedBranch: null,
      activeTab: "ai-log",
      aiActivitySubTab: "active-worktrees",
      environmentSubTab: "terminal",
      gitSubTab: "pull-request",
      gitView: "graph",
      gitPullRequestDocumentId: null,
      isTerminalVisible: false,
      projectManagementSubTab: "history",
      projectManagementSelectedDocumentId: "doc-9",
      projectManagementDocumentViewMode: "edit",
    },
  );
});

test("readDashboardUrlState defaults AI sub tab to log", () => {
  assert.equal(readDashboardUrlState("?tab=ai-log").aiActivitySubTab, "log");
});
