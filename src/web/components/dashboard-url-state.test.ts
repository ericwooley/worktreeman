import assert from "node:assert/strict";
import test from "#test-runtime";
import { readDashboardUrlState } from "./dashboard-url-state";

test("readDashboardUrlState maps legacy shell and background tabs into Worktree Environment sub tabs", () => {
  assert.deepEqual(readDashboardUrlState("?tab=shell&env=feature-one"), {
    selectedBranch: "feature-one",
    activeTab: "environment",
    aiActivitySubTab: "log",
    selectedAiLogJobId: null,
    environmentSubTab: "terminal",
    gitSubTab: "pull-request",
    gitView: "graph",
    gitPullRequestDocumentId: null,
    isTerminalVisible: false,
    systemSubTab: "performance",
    projectManagementSubTab: "board",
    projectManagementSelectedDocumentId: null,
    projectManagementDocumentViewMode: "document",
    projectManagementEditFormTab: "write",
    projectManagementCreateFormTab: "write",
  });

  assert.deepEqual(readDashboardUrlState("?tab=background&terminal=open"), {
    selectedBranch: null,
    activeTab: "environment",
    aiActivitySubTab: "log",
    selectedAiLogJobId: null,
    environmentSubTab: "background",
    gitSubTab: "pull-request",
    gitView: "graph",
    gitPullRequestDocumentId: null,
    isTerminalVisible: true,
    systemSubTab: "performance",
    projectManagementSubTab: "board",
    projectManagementSelectedDocumentId: null,
    projectManagementDocumentViewMode: "document",
    projectManagementEditFormTab: "write",
    projectManagementCreateFormTab: "write",
  });
});

test("readDashboardUrlState reads nested environment and project management state from current params", () => {
  assert.deepEqual(
    readDashboardUrlState("?tab=environment&envTab=background&gitTab=pull-request&git=diff&gitPr=doc-pr-7&pmTab=document&pmDoc=doc-7&pmView=edit"),
    {
      selectedBranch: null,
      activeTab: "environment",
      aiActivitySubTab: "log",
      selectedAiLogJobId: null,
      environmentSubTab: "background",
      gitSubTab: "pull-request",
      gitView: "diff",
      gitPullRequestDocumentId: "doc-pr-7",
      isTerminalVisible: false,
      systemSubTab: "performance",
      projectManagementSubTab: "document",
      projectManagementSelectedDocumentId: "doc-7",
      projectManagementDocumentViewMode: "edit",
      projectManagementEditFormTab: "write",
      projectManagementCreateFormTab: "write",
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
      selectedAiLogJobId: null,
      environmentSubTab: "terminal",
      gitSubTab: "pull-request",
      gitView: "graph",
      gitPullRequestDocumentId: null,
      isTerminalVisible: false,
      systemSubTab: "performance",
      projectManagementSubTab: "history",
      projectManagementSelectedDocumentId: "doc-9",
      projectManagementDocumentViewMode: "edit",
      projectManagementEditFormTab: "write",
      projectManagementCreateFormTab: "write",
    },
  );
});

test("readDashboardUrlState defaults AI sub tab to log", () => {
  assert.equal(readDashboardUrlState("?tab=ai-log").aiActivitySubTab, "log");
});

test("readDashboardUrlState reads project management editor tab params", () => {
  assert.deepEqual(
    readDashboardUrlState("?tab=project-management&pmTab=document&pmDoc=doc-7&pmView=edit&pmEditTab=preview&pmCreateTab=preview&aiLog=job-1"),
    {
      selectedBranch: null,
      activeTab: "project-management",
      aiActivitySubTab: "log",
      selectedAiLogJobId: "job-1",
      environmentSubTab: "terminal",
      gitSubTab: "pull-request",
      gitView: "graph",
      gitPullRequestDocumentId: null,
      isTerminalVisible: false,
      systemSubTab: "performance",
      projectManagementSubTab: "document",
      projectManagementSelectedDocumentId: "doc-7",
      projectManagementDocumentViewMode: "edit",
      projectManagementEditFormTab: "preview",
      projectManagementCreateFormTab: "preview",
    },
  );
});

test("readDashboardUrlState reads the top-level System tab and jobs sub tab", () => {
  assert.deepEqual(readDashboardUrlState("?tab=system&systemTab=jobs"), {
    selectedBranch: null,
    activeTab: "system",
    aiActivitySubTab: "log",
    selectedAiLogJobId: null,
    environmentSubTab: "terminal",
    gitSubTab: "pull-request",
    gitView: "graph",
    gitPullRequestDocumentId: null,
    isTerminalVisible: false,
    systemSubTab: "jobs",
    projectManagementSubTab: "board",
    projectManagementSelectedDocumentId: null,
    projectManagementDocumentViewMode: "document",
    projectManagementEditFormTab: "write",
    projectManagementCreateFormTab: "write",
  });
});
