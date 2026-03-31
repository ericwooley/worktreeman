import type { SystemSubTab } from "@shared/types";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { AiActivitySubTab } from "./project-management-ai-tab";
import type { ProjectManagementDocumentFormViewMode } from "./project-management-document-form";
import type { WorktreeEnvironmentSubTab, WorktreeGitSubTab } from "./worktree-detail";

export type DashboardActiveTab = "environment" | "git" | "merge" | "project-management" | "system" | "ai-log";

export interface DashboardUrlState {
  selectedBranch: string | null;
  activeTab: DashboardActiveTab;
  aiActivitySubTab: AiActivitySubTab;
  selectedAiLogJobId: string | null;
  environmentSubTab: WorktreeEnvironmentSubTab;
  gitSubTab: WorktreeGitSubTab;
  gitView: "diff" | "graph";
  gitPullRequestDocumentId: string | null;
  isTerminalVisible: boolean;
  systemSubTab: SystemSubTab;
  projectManagementSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocumentViewMode: ProjectManagementDocumentViewMode;
  projectManagementEditFormTab: ProjectManagementDocumentFormViewMode;
  projectManagementCreateFormTab: ProjectManagementDocumentFormViewMode;
}

export function parseWorktreeGitSubTab(value: string | null): WorktreeGitSubTab {
  return "pull-request";
}

export function parseProjectManagementSubTab(value: string | null): ProjectManagementSubTab {
  return value === "document"
    || value === "history"
    || value === "create"
    || value === "dependency-tree"
    || value === "users"
    ? value
    : "board";
}

export function parseProjectManagementDocumentViewMode(value: string | null): ProjectManagementDocumentViewMode {
  return value === "edit" ? "edit" : "document";
}

export function parseProjectManagementDocumentFormViewMode(value: string | null): ProjectManagementDocumentFormViewMode {
  return value === "preview" ? "preview" : "write";
}

export function parseWorktreeEnvironmentSubTab(value: string | null): WorktreeEnvironmentSubTab {
  return value === "background" ? "background" : "terminal";
}

export function parseAiActivitySubTab(value: string | null): AiActivitySubTab {
  return value === "active-worktrees" ? "active-worktrees" : "log";
}

export function parseSystemSubTab(value: string | null): SystemSubTab {
  return value === "jobs" ? "jobs" : "performance";
}

export function readDashboardUrlState(search: string = typeof window === "undefined" ? "" : window.location.search): DashboardUrlState {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const activeTab: DashboardActiveTab = tab === "git"
    ? "git"
    : tab === "merge"
      ? "merge"
      : tab === "system"
        ? "system"
      : tab === "ai-log"
        ? "ai-log"
      : tab === "project-management"
        ? "project-management"
        : "environment";

  return {
    selectedBranch: params.get("env"),
    activeTab,
    aiActivitySubTab: parseAiActivitySubTab(params.get("aiTab")),
    selectedAiLogJobId: params.get("aiLog"),
    environmentSubTab: tab === "background"
      ? "background"
      : tab === "shell"
        ? "terminal"
        : parseWorktreeEnvironmentSubTab(params.get("envTab")),
    gitSubTab: parseWorktreeGitSubTab(params.get("gitTab")),
    gitView: params.get("git") === "diff" ? "diff" : "graph",
    gitPullRequestDocumentId: params.get("gitPr"),
    isTerminalVisible: params.get("terminal") === "open",
    systemSubTab: parseSystemSubTab(params.get("systemTab")),
    projectManagementSubTab: parseProjectManagementSubTab(params.get("pmTab")),
    projectManagementSelectedDocumentId: params.get("pmDoc"),
    projectManagementDocumentViewMode: parseProjectManagementDocumentViewMode(params.get("pmView")),
    projectManagementEditFormTab: parseProjectManagementDocumentFormViewMode(params.get("pmEditTab")),
    projectManagementCreateFormTab: parseProjectManagementDocumentFormViewMode(params.get("pmCreateTab")),
  };
}
