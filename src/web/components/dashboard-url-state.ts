import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { WorktreeEnvironmentSubTab } from "./worktree-detail";

export type DashboardActiveTab = "environment" | "git" | "project-management";

export interface DashboardUrlState {
  selectedBranch: string | null;
  activeTab: DashboardActiveTab;
  environmentSubTab: WorktreeEnvironmentSubTab;
  gitView: "diff" | "graph";
  isTerminalVisible: boolean;
  projectManagementSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocumentViewMode: ProjectManagementDocumentViewMode;
}

export function parseProjectManagementSubTab(value: string | null): ProjectManagementSubTab {
  return value === "document"
    || value === "history"
    || value === "create"
    || value === "dependency-tree"
    || value === "ai-log"
    ? value
    : "board";
}

export function parseProjectManagementDocumentViewMode(value: string | null): ProjectManagementDocumentViewMode {
  return value === "edit" ? "edit" : "document";
}

export function parseWorktreeEnvironmentSubTab(value: string | null): WorktreeEnvironmentSubTab {
  return value === "background" ? "background" : "terminal";
}

export function readDashboardUrlState(search: string = typeof window === "undefined" ? "" : window.location.search): DashboardUrlState {
  const params = new URLSearchParams(search);
  const tab = params.get("tab");
  const activeTab: DashboardActiveTab = tab === "git"
    ? "git"
    : tab === "project-management"
      ? "project-management"
      : "environment";

  return {
    selectedBranch: params.get("env"),
    activeTab,
    environmentSubTab: tab === "background"
      ? "background"
      : tab === "shell"
        ? "terminal"
        : parseWorktreeEnvironmentSubTab(params.get("envTab")),
    gitView: params.get("git") === "diff" ? "diff" : "graph",
    isTerminalVisible: params.get("terminal") === "open",
    projectManagementSubTab: parseProjectManagementSubTab(params.get("pmTab")),
    projectManagementSelectedDocumentId: params.get("pmDoc"),
    projectManagementDocumentViewMode: parseProjectManagementDocumentViewMode(params.get("pmView")),
  };
}
