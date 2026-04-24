import type { SystemSubTab } from "@shared/types";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { AiActivitySubTab } from "./project-management-ai-tab";
import type { ProjectManagementDocumentFormViewMode } from "./project-management-document-form";
import { readProjectManagementDocumentPath, type ProjectManagementDocumentPresentation } from "./project-management-document-route";
import type { WorktreeEnvironmentSubTab } from "./worktree-detail";

export type DashboardActiveTab = "environment" | "git" | "project-management" | "review" | "system" | "ai-log";

export interface DashboardUrlState {
  selectedBranch: string | null;
  activeTab: DashboardActiveTab;
  aiActivitySubTab: AiActivitySubTab;
  selectedAiLogJobId: string | null;
  environmentSubTab: WorktreeEnvironmentSubTab;
  gitView: "diff" | "graph";
  isTerminalVisible: boolean;
  systemSubTab: SystemSubTab;
  projectManagementSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocumentPresentation: ProjectManagementDocumentPresentation;
  projectManagementDocumentViewMode: ProjectManagementDocumentViewMode;
  projectManagementEditFormTab: ProjectManagementDocumentFormViewMode;
  projectManagementCreateFormTab: ProjectManagementDocumentFormViewMode;
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

export function readDashboardUrlState(
  pathnameOrSearch: string = typeof window === "undefined" ? "" : window.location.search,
  searchMaybe?: string,
): DashboardUrlState {
  const pathname = searchMaybe === undefined
    ? (pathnameOrSearch.startsWith("/")
      ? pathnameOrSearch
      : (typeof window === "undefined" ? "/" : window.location.pathname))
    : pathnameOrSearch;
  const search = searchMaybe ?? (pathnameOrSearch.startsWith("?") ? pathnameOrSearch : "");
  const params = new URLSearchParams(search);
  const projectManagementDocumentRoute = readProjectManagementDocumentPath(pathname);
  const tab = params.get("tab");
  const activeTab: DashboardActiveTab = projectManagementDocumentRoute.presentation === "page"
    ? "project-management"
    : tab === "git" || tab === "merge"
    ? "git"
    : tab === "review"
      ? "review"
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
    gitView: params.get("git") === "diff" ? "diff" : "graph",
    isTerminalVisible: params.get("terminal") === "open",
    systemSubTab: parseSystemSubTab(params.get("systemTab")),
    projectManagementSubTab: projectManagementDocumentRoute.presentation === "page"
      ? "document"
      : parseProjectManagementSubTab(params.get("pmTab")),
    projectManagementSelectedDocumentId: projectManagementDocumentRoute.documentId ?? params.get("pmDoc"),
    projectManagementDocumentPresentation: projectManagementDocumentRoute.presentation,
    projectManagementDocumentViewMode: parseProjectManagementDocumentViewMode(params.get("pmView")),
    projectManagementEditFormTab: parseProjectManagementDocumentFormViewMode(params.get("pmEditTab")),
    projectManagementCreateFormTab: parseProjectManagementDocumentFormViewMode(params.get("pmCreateTab")),
  };
}
