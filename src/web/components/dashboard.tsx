import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Editor from "@monaco-editor/react";
import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "@shared/constants";
import type { AiCommandConfig, AiCommandId, WorktreeRecord } from "@shared/types";
import {
  CommandPalette,
  DEFAULT_COMMAND_PALETTE_SHORTCUT,
  formatShortcutLabel,
  shortcutFromKeyboardEvent,
  type CommandPaletteItem,
  type CommandPaletteShortcutSetting,
} from "./command-palette";
import { useDashboardState } from "../hooks/use-dashboard-state";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixModal } from "./matrix-primitives";
import { useTheme } from "./theme-provider";
import { WorktreeDetail, type WorktreeEnvironmentSubTab } from "./worktree-detail";
import { readDashboardUrlState, type DashboardActiveTab } from "./dashboard-url-state";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import { confirmWorktreeDeletion, type DeleteConfirmationState } from "./dashboard-delete";
import { getVisibleWorktrees } from "./dashboard-worktrees";

const CREATE_WORKTREE_OPTION_VALUE = "__create_worktree__";
const COMMAND_PALETTE_SHORTCUT_STORAGE_KEY = "worktreeman.commandPaletteShortcut";
const TERMINAL_SHORTCUT_STORAGE_KEY = "worktreeman.terminalShortcut";
const LEGACY_COMMAND_PALETTE_SHORTCUTS = new Set(["Shift+Space", "Meta+P"]);
const LEGACY_TERMINAL_SHORTCUTS = new Set(["Ctrl+Shift+;"]);
const DEFAULT_TERMINAL_SHORTCUT = "Ctrl+Shift+'";
const COMMAND_PALETTE_CODE_MODE_SHORTCUT = "Ctrl+Shift+:";
type CommandPaletteScope = "main" | "worktree-select" | "theme-select";

const EMPTY_AI_COMMANDS: AiCommandConfig = {
  smart: "",
  simple: "",
};

function normalizeAiCommands(aiCommands?: Partial<AiCommandConfig> | null): AiCommandConfig {
  return {
    smart: typeof aiCommands?.smart === "string" ? aiCommands.smart : "",
    simple: typeof aiCommands?.simple === "string" ? aiCommands.simple : "",
  };
}

function isAiCommandTemplateReady(template: string): boolean {
  return template.includes("$WTM_AI_INPUT");
}

function getAiCommandLabel(commandId: AiCommandId): string {
  return commandId === "simple" ? "Simple AI" : "Smart AI";
}

function isCommandPaletteCodeModeShortcut(event: KeyboardEvent): boolean {
  if (event.altKey || event.metaKey || !event.ctrlKey || !event.shiftKey) {
    return false;
  }

  return event.code === "Semicolon" || event.key === ":" || event.key === ";";
}

function normalizeCommandPaletteShortcut(shortcut: string | null): string {
  if (!shortcut || LEGACY_COMMAND_PALETTE_SHORTCUTS.has(shortcut)) {
    return DEFAULT_COMMAND_PALETTE_SHORTCUT;
  }

  return shortcut;
}

function normalizeTerminalShortcut(shortcut: string | null): string {
  if (!shortcut || LEGACY_TERMINAL_SHORTCUTS.has(shortcut)) {
    return DEFAULT_TERMINAL_SHORTCUT;
  }

  return shortcut;
}

function getWorktreeCommandCode(branch: string): string {
  const cleaned = branch.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const suffix = cleaned.slice(0, 2) || "wt";
  return `w${suffix}`.slice(0, 3);
}

function comparePaletteItems(left: CommandPaletteItem, right: CommandPaletteItem): number {
  const groupOrder: Record<string, number> = {
    Navigation: 0,
    Terminal: 1,
    Worktree: 2,
    Settings: 3,
  };

  const leftOrder = groupOrder[left.group ?? ""] ?? 99;
  const rightOrder = groupOrder[right.group ?? ""] ?? 99;

  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }

  return left.title.localeCompare(right.title);
}

export function Dashboard() {
  const initialUrlState = readDashboardUrlState();
  const {
    state,
    error,
    loading,
    busyBranch,
    lastEnvSync,
    shutdownStatus,
    backgroundCommands,
    backgroundLogs,
    gitComparison,
    gitComparisonLoading,
    configDocument,
    configDocumentLoading,
    aiCommandSettings,
    aiCommandSettingsLoading,
    aiCommandJob,
    projectManagementDocumentAiJob,
    aiCommandLogs,
    aiCommandLogDetail,
    aiCommandLogsLoading,
    runningAiCommandJobs,
    projectManagement,
    projectManagementDocument,
    projectManagementHistory,
    projectManagementLoading,
    projectManagementSaving,
    clearLastEnvSync,
    clearBackgroundLogs,
    refresh,
    addProjectManagementComment,
    create,
    createProjectManagementDocument,
    remove,
    start,
    stop,
    syncEnv,
    loadBackgroundCommands,
    startBackgroundCommand,
    restartBackgroundCommand,
    stopBackgroundCommand,
    loadBackgroundLogs,
    loadProjectManagementDocument,
    loadProjectManagementDocuments,
    loadConfigDocument,
    loadAiCommandSettings,
    loadAiCommandLog,
    loadAiCommandLogs,
    loadGitComparison,
    mergeGitBranch,
    mergeBaseBranchIntoWorktree,
    resolveGitMergeConflicts,
    generateGitCommitMessage,
    commitGitChanges,
    runAiCommand,
    runProjectManagementDocumentAi,
    cancelAiCommand,
    cancelProjectManagementDocumentAi,
    saveAiCommandSettings,
    saveConfigDocument,
    subscribeToBackgroundLogs,
    updateProjectManagementDependencies,
    updateProjectManagementDocument,
    updateProjectManagementStatus,
  } = useDashboardState();
  const { theme, themes, setThemeId, setPreviewThemeId, clearPreviewTheme } = useTheme();
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialUrlState.selectedBranch);
  const [activeTab, setActiveTab] = useState<DashboardActiveTab>(initialUrlState.activeTab);
  const [environmentSubTab, setEnvironmentSubTab] = useState<WorktreeEnvironmentSubTab>(initialUrlState.environmentSubTab);
  const [projectManagementSubTab, setProjectManagementSubTab] = useState<ProjectManagementSubTab>(
    initialUrlState.projectManagementSubTab,
  );
  const [projectManagementSelectedDocumentId, setProjectManagementSelectedDocumentId] = useState<string | null>(initialUrlState.projectManagementSelectedDocumentId);
  const [projectManagementDocumentViewMode, setProjectManagementDocumentViewMode] = useState<ProjectManagementDocumentViewMode>(
    initialUrlState.projectManagementDocumentViewMode,
  );
  const [gitView, setGitView] = useState<"graph" | "diff">(initialUrlState.gitView);
  const [isTerminalVisible, setIsTerminalVisible] = useState(initialUrlState.isTerminalVisible);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationState | null>(null);
  const [deleteConfirmationError, setDeleteConfirmationError] = useState<string | null>(null);
  const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState("");
  const [aiCommandDrafts, setAiCommandDrafts] = useState<AiCommandConfig>(EMPTY_AI_COMMANDS);
  const [branch, setBranch] = useState("");
  const [createWorktreeDocumentId, setCreateWorktreeDocumentId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteScope, setCommandPaletteScope] = useState<CommandPaletteScope>("main");
  const [commandPaletteInitialQuery, setCommandPaletteInitialQuery] = useState("");
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalShortcutAtRef = useRef(0);
  const hasCommittedDashboardHistoryRef = useRef(false);
  const [commandPaletteShortcut, setCommandPaletteShortcut] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_COMMAND_PALETTE_SHORTCUT;
    }

    return normalizeCommandPaletteShortcut(window.localStorage.getItem(COMMAND_PALETTE_SHORTCUT_STORAGE_KEY));
  });
  const [terminalShortcut, setTerminalShortcut] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_TERMINAL_SHORTCUT;
    }

    return normalizeTerminalShortcut(window.localStorage.getItem(TERMINAL_SHORTCUT_STORAGE_KEY));
  });

  const openCommandPalette = useCallback((scope: CommandPaletteScope = "main", initialQuery = "") => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      lastFocusedElementRef.current = document.activeElement;
    }

    setCommandPaletteInitialQuery(initialQuery);
    setCommandPaletteScope(scope);
    setCommandPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setCommandPaletteOpen(false);
    setCommandPaletteInitialQuery("");
    setCommandPaletteScope("main");

    if (!options?.restoreFocus) {
      return;
    }

    const previousFocusTarget = lastFocusedElementRef.current;
    window.requestAnimationFrame(() => {
      if (previousFocusTarget?.isConnected) {
        previousFocusTarget.focus();
      }
    });
  }, []);

  const handleCommandPaletteClose = useCallback((options?: { restoreFocus?: boolean }) => {
    clearPreviewTheme();
    closeCommandPalette(options);
  }, [clearPreviewTheme, closeCommandPalette]);

  const handleCommandPaletteActiveItemChange = useCallback((command: CommandPaletteItem | null, source: "initial" | "keyboard" | "mouse" | "query") => {
    if (commandPaletteScope !== "theme-select") {
      clearPreviewTheme();
      return;
    }

    if (source !== "keyboard" || !command?.value) {
      clearPreviewTheme();
      return;
    }

    setPreviewThemeId(command.value);
  }, [clearPreviewTheme, commandPaletteScope, setPreviewThemeId]);

  const toggleTerminalVisibility = useCallback((restoreFocus = false) => {
    const now = Date.now();
    if (now - lastTerminalShortcutAtRef.current < 150) {
      return;
    }

    lastTerminalShortcutAtRef.current = now;

    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      lastTerminalFocusedElementRef.current = document.activeElement;
    }

    setIsTerminalVisible((current) => {
      const next = !current;

      if (!next && restoreFocus) {
        const previousFocusTarget = lastTerminalFocusedElementRef.current;
        window.requestAnimationFrame(() => {
          if (previousFocusTarget?.isConnected) {
            previousFocusTarget.focus();
          }
        });
      }

      return next;
    });
  }, []);

  const visibleWorktrees = useMemo(() => getVisibleWorktrees(state?.worktrees), [state?.worktrees]);

  const selected = useMemo(
    () => {
      if (!visibleWorktrees.length) {
        return null;
      }

      return visibleWorktrees.find((entry) => entry.branch === selectedBranch)
        ?? visibleWorktrees.find((entry) => entry.runtime)
        ?? visibleWorktrees[0]
        ?? null;
    },
    [selectedBranch, visibleWorktrees],
  );

  const worktreeOptions = useMemo<MatrixDropdownOption[]>(
    () => [
      ...(visibleWorktrees.map((entry): MatrixDropdownOption => ({
        value: entry.branch,
        label: entry.branch,
        description: entry.runtime ? "Runtime active" : "Idle",
        badgeLabel: entry.runtime ? "Active" : "Idle",
        badgeTone: entry.runtime ? "active" : "idle",
      }))),
      {
        value: CREATE_WORKTREE_OPTION_VALUE,
        label: "+new worktree",
        description: "Create a new branch worktree",
      },
    ],
    [visibleWorktrees],
  );
  const projectDocumentOptions = useMemo<MatrixDropdownOption[]>(
    () => (projectManagement?.documents ?? []).map((entry) => ({
      value: entry.id,
      label: `#${entry.number} ${entry.title}`,
      description: entry.archived ? "Archived document" : entry.status || "Project document",
      badgeLabel: entry.archived ? "Archived" : undefined,
      badgeTone: "idle",
    })),
    [projectManagement?.documents],
  );
  useEffect(() => {
    if (!selected?.branch || selected.branch === selectedBranch) {
      return;
    }

    setSelectedBranch(selected.branch);
  }, [selected?.branch, selectedBranch]);

  useEffect(() => {
    window.localStorage.setItem(
      COMMAND_PALETTE_SHORTCUT_STORAGE_KEY,
      normalizeCommandPaletteShortcut(commandPaletteShortcut),
    );
  }, [commandPaletteShortcut]);

  useEffect(() => {
    window.localStorage.setItem(
      TERMINAL_SHORTCUT_STORAGE_KEY,
      normalizeTerminalShortcut(terminalShortcut),
    );
  }, [terminalShortcut]);

  useEffect(() => {
    if (commandPaletteOpen && commandPaletteScope === "theme-select") {
      return;
    }

    clearPreviewTheme();
  }, [clearPreviewTheme, commandPaletteOpen, commandPaletteScope]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;
      const tagName = (event.target as HTMLElement | null)?.tagName;
      const isTypingContext = Boolean(
        (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")
        || tagName === "INPUT"
        || tagName === "TEXTAREA"
        || tagName === "SELECT",
      );
      const isInsideTerminal = Boolean(target?.closest(".xterm"));

      if (isCommandPaletteCodeModeShortcut(event)) {
        if (isInsideTerminal) {
          return;
        }

        if (isTypingContext && !commandPaletteOpen) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        openCommandPalette("main", ":");
        return;
      }

      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut) {
        return;
      }

      if (shortcut === terminalShortcut) {
        if (isInsideTerminal) {
          return;
        }

        if (commandPaletteOpen && !isTypingContext) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        toggleTerminalVisibility(true);
        return;
      }

      if (shortcut !== commandPaletteShortcut) {
        return;
      }

      if (isInsideTerminal) {
        return;
      }

      if (isTypingContext && !commandPaletteOpen) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      if (commandPaletteOpen) {
        closeCommandPalette({ restoreFocus: true });
      } else {
          openCommandPalette();
        }
      };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeCommandPalette, commandPaletteOpen, commandPaletteShortcut, openCommandPalette, terminalShortcut, toggleTerminalVisibility]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (selectedBranch) {
      params.set("env", selectedBranch);
    } else {
      params.delete("env");
    }

    params.set("tab", activeTab);
    if (activeTab === "environment") {
      params.set("envTab", environmentSubTab);
    } else {
      params.delete("envTab");
    }
    params.set("git", gitView);

    if (activeTab === "project-management") {
      params.set("pmTab", projectManagementSubTab);
      if (projectManagementSelectedDocumentId) {
        params.set("pmDoc", projectManagementSelectedDocumentId);
      } else {
        params.delete("pmDoc");
      }
      if (projectManagementSubTab === "document" && projectManagementSelectedDocumentId) {
        params.set("pmView", projectManagementDocumentViewMode);
      } else {
        params.delete("pmView");
      }
    } else {
      params.delete("pmTab");
      params.delete("pmDoc");
      params.delete("pmView");
    }

    if (isTerminalVisible) {
      params.set("terminal", "open");
    } else {
      params.delete("terminal");
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;

    const currentUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (nextUrl === currentUrl) {
      hasCommittedDashboardHistoryRef.current = true;
      return;
    }

    if (!hasCommittedDashboardHistoryRef.current) {
      window.history.replaceState(null, "", nextUrl);
      hasCommittedDashboardHistoryRef.current = true;
      return;
    }

    window.history.pushState(null, "", nextUrl);
  }, [
    activeTab,
    environmentSubTab,
    gitView,
    isTerminalVisible,
    projectManagementDocumentViewMode,
    projectManagementSelectedDocumentId,
    projectManagementSubTab,
    selectedBranch,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      const nextUrlState = readDashboardUrlState();
      setSelectedBranch(nextUrlState.selectedBranch);
      setActiveTab(nextUrlState.activeTab);
      setEnvironmentSubTab(nextUrlState.environmentSubTab);
      setGitView(nextUrlState.gitView);
      setIsTerminalVisible(nextUrlState.isTerminalVisible);
      setProjectManagementSubTab(nextUrlState.projectManagementSubTab);
      setProjectManagementSelectedDocumentId(nextUrlState.projectManagementSelectedDocumentId);
      setProjectManagementDocumentViewMode(nextUrlState.projectManagementDocumentViewMode);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (!projectManagementSelectedDocumentId || activeTab !== "project-management") {
      return;
    }

    void loadProjectManagementDocument(projectManagementSelectedDocumentId, { silent: true });
  }, [activeTab, loadProjectManagementDocument, projectManagementSelectedDocumentId]);

  useEffect(() => {
    void loadAiCommandSettings({ silent: true });
  }, [loadAiCommandSettings]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    const nextBranch = branch.trim();
    await create(nextBranch, createWorktreeDocumentId);
    setSelectedBranch(nextBranch);
    setBranch("");
    setCreateWorktreeDocumentId(null);
    setCreateWorktreeModalOpen(false);
  };

  const openConfigEditor = useCallback(async () => {
    const document = await loadConfigDocument();
    if (!document) {
      return;
    }

    setConfigDraft(document.contents);
    setConfigEditorOpen(true);
  }, [loadConfigDocument]);

  const closeConfigEditor = useCallback(() => {
    setConfigEditorOpen(false);
    setConfigDraft("");
  }, []);

  const reloadConfigEditor = useCallback(async () => {
    const document = await loadConfigDocument();
    if (!document) {
      return;
    }

    setConfigDraft(document.contents);
  }, [loadConfigDocument]);

  const saveConfigEditor = useCallback(async () => {
    const document = await saveConfigDocument(configDraft);
    if (!document) {
      return;
    }

    setConfigDraft(document.contents);
    setConfigEditorOpen(false);
  }, [configDraft, saveConfigDocument]);

  const openAiSettings = useCallback(async () => {
    const settings = await loadAiCommandSettings();
    if (!settings) {
      return;
    }

    setAiCommandDrafts(normalizeAiCommands(settings.aiCommands));
    setAiSettingsOpen(true);
  }, [loadAiCommandSettings]);

  const closeAiSettings = useCallback(() => {
    setAiSettingsOpen(false);
  }, []);

  const reloadAiSettings = useCallback(async () => {
    const settings = await loadAiCommandSettings();
    if (!settings) {
      return;
    }

    setAiCommandDrafts(normalizeAiCommands(settings.aiCommands));
  }, [loadAiCommandSettings]);

  const persistAiSettings = useCallback(async () => {
    const settings = await saveAiCommandSettings({ aiCommands: normalizeAiCommands(aiCommandDrafts) });
    if (!settings) {
      return;
    }

    setAiCommandDrafts(normalizeAiCommands(settings.aiCommands));
    setAiSettingsOpen(false);
  }, [aiCommandDrafts, saveAiCommandSettings]);

  const openDeleteConfirmation = useCallback((worktree: WorktreeRecord | null) => {
    if (!worktree?.deletion?.canDelete) {
      return;
    }

    setDeleteConfirmationError(null);
    setDeleteConfirmation({
      worktree,
      deleteBranch: worktree.deletion?.deleteBranchByDefault ?? true,
      confirmWorktreeName: "",
    });
  }, []);

  const confirmDelete = async () => {
    if (!deleteConfirmation) {
      return;
    }

    setDeleteConfirmationError(null);
    const result = await confirmWorktreeDeletion(deleteConfirmation, remove);
    if (result.success) {
      setDeleteConfirmation(null);
      return;
    }

    setDeleteConfirmationError(result.message);
  };

  const navigateToTab = (tab: DashboardActiveTab) => {
    setActiveTab(tab);
    if (tab !== "environment") {
      setIsTerminalVisible(false);
    }
  };

  const navigateToEnvironmentSubTab = useCallback((tab: WorktreeEnvironmentSubTab) => {
    navigateToTab("environment");
    setEnvironmentSubTab(tab);
  }, []);

  const navigateToProjectManagementSubTab = useCallback((
    tab: ProjectManagementSubTab,
    options?: { documentId?: string | null; viewMode?: ProjectManagementDocumentViewMode },
  ) => {
    navigateToTab("project-management");
    setProjectManagementSubTab(tab);
    if (options && "documentId" in options) {
      setProjectManagementSelectedDocumentId(options.documentId ?? null);
    }
    if (tab === "document") {
      setProjectManagementDocumentViewMode(options?.viewMode ?? "document");
    }
  }, []);

  const handleProjectManagementSubTabChange = useCallback((tab: ProjectManagementSubTab) => {
    setProjectManagementSubTab(tab);
    if (tab !== "document") {
      setProjectManagementDocumentViewMode("document");
    }
  }, []);

  const configuredAiCommands = normalizeAiCommands(aiCommandSettings?.aiCommands);
  const aiCommandDraftValues = normalizeAiCommands(aiCommandDrafts);
  const aiCommandStatusBadges = (["smart", "simple"] as const).map((commandId) => ({
    commandId,
    label: getAiCommandLabel(commandId),
    ready: isAiCommandTemplateReady(configuredAiCommands[commandId]),
  }));

  const handleLoadProjectManagementDocument = useCallback(async (documentId: string, options?: { silent?: boolean }) => {
    setProjectManagementSelectedDocumentId(documentId);
    return loadProjectManagementDocument(documentId, options);
  }, [loadProjectManagementDocument]);

  const mainCommandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "nav-environment",
        code: "ne",
        title: "Open Worktree Environment tab",
        subtitle: "Jump to the runtime, terminal, and environment controls.",
        group: "Navigation",
        keywords: ["terminal", "shell", "environment", "tab"],
        badgeLabel: activeTab === "environment" && environmentSubTab === "terminal" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToEnvironmentSubTab("terminal"),
      },
      {
        id: "nav-background",
        code: "nb",
        title: "Open Background commands sub tab",
        subtitle: "Inspect long-running background commands and their logs inside Worktree Environment.",
        group: "Navigation",
        keywords: ["pm2", "logs", "background", "processes", "environment"],
        badgeLabel: activeTab === "environment" && environmentSubTab === "background" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToEnvironmentSubTab("background"),
      },
      {
        id: "nav-git",
        code: "ng",
        title: "Open Git status tab",
        subtitle: "Jump to the planned git workflow area.",
        group: "Navigation",
        keywords: ["git", "status", "changes"],
        badgeLabel: activeTab === "git" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("git"),
      },
      {
        id: "nav-project-management",
        code: "np",
        title: "Open Project management tab",
        subtitle: "Jump to the project management area.",
        group: "Navigation",
        keywords: ["project", "management", "planning", "todo"],
        badgeLabel: activeTab === "project-management" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("project-management"),
      },
      {
        id: "nav-project-management-document",
        code: "npd",
        title: "Open project document view",
        subtitle: projectManagementSelectedDocumentId
          ? "Jump to the selected project document."
          : "Jump to the project document workspace.",
        group: "Navigation",
        keywords: ["project", "management", "document", "view", "markdown"],
        badgeLabel: activeTab === "project-management"
          && projectManagementSubTab === "document"
          && projectManagementDocumentViewMode === "document"
          ? "Active"
          : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("document", { viewMode: "document" }),
      },
      {
        id: "nav-project-management-edit",
        code: "npe",
        title: "Edit selected project document",
        subtitle: projectManagementSelectedDocumentId
          ? `Open the document editor for ${projectManagementDocument?.title ?? "the selected document"}.`
          : "Select a project document first.",
        group: "Navigation",
        keywords: ["project", "management", "document", "edit", "editor"],
        disabled: !projectManagementSelectedDocumentId,
        badgeLabel: activeTab === "project-management"
          && projectManagementSubTab === "document"
          && projectManagementDocumentViewMode === "edit"
          ? "Active"
          : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("document", { viewMode: "edit" }),
      },
      {
        id: "nav-project-management-board",
        code: "npb",
        title: "Open project board",
        subtitle: "Jump to the swimlane board.",
        group: "Navigation",
        keywords: ["project", "management", "board", "lane", "status"],
        badgeLabel: activeTab === "project-management" && projectManagementSubTab === "board" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("board"),
      },
      {
        id: "nav-project-management-tree",
        code: "npt",
        title: "Open dependency tree",
        subtitle: "Jump to the project dependency graph.",
        group: "Navigation",
        keywords: ["project", "management", "dependency", "tree", "graph"],
        badgeLabel: activeTab === "project-management" && projectManagementSubTab === "dependency-tree" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("dependency-tree"),
      },
      {
        id: "nav-project-management-history",
        code: "nph",
        title: "Open document history",
        subtitle: "Jump to the project document timeline.",
        group: "Navigation",
        keywords: ["project", "management", "history", "timeline", "document"],
        badgeLabel: activeTab === "project-management" && projectManagementSubTab === "history" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("history"),
      },
      {
        id: "nav-project-management-ai-log",
        code: "npa",
        title: "Open AI log tab",
        subtitle: "Review live AI runs, saved output, and origin links.",
        group: "Navigation",
        keywords: ["project", "management", "ai", "logs", "jobs"],
        badgeLabel: activeTab === "ai-log" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("ai-log"),
      },
      {
        id: "nav-project-management-create",
        code: "npc",
        title: "Create project document",
        subtitle: "Jump to the shared create-document form.",
        group: "Navigation",
        keywords: ["project", "management", "create", "new", "document"],
        badgeLabel: activeTab === "project-management" && projectManagementSubTab === "create" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("create"),
      },
      {
        id: "terminal-toggle",
        code: "tt",
        title: isTerminalVisible ? "Stow terminal drawer" : "Open terminal drawer",
        subtitle: "Toggle the global tmux-backed terminal drawer.",
        group: "Terminal",
        keywords: ["drawer", "terminal", "toggle"],
        action: () => setIsTerminalVisible((current) => !current),
      },
      {
        id: "worktree-select",
        code: "ww",
        title: "Select worktree",
        subtitle: "Open a dedicated picker with fuzzy search and numeric jump codes.",
        group: "Worktree",
        keywords: ["worktree", "switch", "select", "picker"],
        closeOnSelect: false,
        action: () => setCommandPaletteScope("worktree-select"),
      },
      {
        id: "create-worktree",
        code: "wn",
        title: "Create new worktree",
        subtitle: "Open the create-worktree modal.",
        group: "Worktree",
        keywords: ["new", "branch", "create", "worktree"],
        action: () => setCreateWorktreeModalOpen(true),
      },
      {
        id: "theme-select",
        code: "st",
        title: "Change theme",
        subtitle: `Open the searchable theme picker. Current theme: ${theme.name}`,
        group: "Settings",
        keywords: [theme.name, theme.author, theme.variant, "theme", "base16", "colors"],
        closeOnSelect: false,
        action: () => setCommandPaletteScope("theme-select"),
      },
      {
        id: "settings-ai-command",
        code: "sai",
        title: "Edit AI command",
        subtitle: "Configure the reusable AI command template used by UI Magic.",
        group: "Settings",
        keywords: ["ai", "command", "ui magic", "$WTM_AI_INPUT"],
        action: () => void openAiSettings(),
      },
      {
        id: "settings-config-editor",
        code: "wcfg",
        title: "Edit worktree config",
        subtitle: `Open ${DEFAULT_WORKTREEMAN_SETTINGS_BRANCH}/worktree.yml in the built-in editor.`,
        group: "Settings",
        keywords: ["config", "settings", "yaml", "worktree.yml", DEFAULT_WORKTREEMAN_SETTINGS_BRANCH],
        action: () => void openConfigEditor(),
      },
      {
        id: "shortcut-settings",
        code: "sc",
        title: "Change command palette shortcut",
        subtitle: `Current shortcut: ${formatShortcutLabel(commandPaletteShortcut)}`,
        group: "Settings",
        keywords: ["shortcut", "keyboard", "command palette"],
        action: () => setCommandPaletteOpen(true),
      },
    ];

    if (selected) {
      const deleteDisabledReason = busyBranch === selected.branch
        ? "A worktree action is already running."
        : selected.deletion?.canDelete === false
          ? selected.deletion.reason
          : null;
      const deleteSubtitle = deleteDisabledReason
        ?? "Open a confirmation modal before deleting the worktree.";

      items.push(
        {
          id: `worktree-start-${selected.branch}`,
          code: "wst",
          title: `Start worktree runtime: ${selected.branch}`,
          subtitle: "Prepare the runtime, terminal session, startup commands, and background commands.",
          group: "Worktree",
          keywords: [selected.branch, "start", "runtime", "background"],
          disabled: Boolean(selected.runtime) || busyBranch === selected.branch,
          badgeLabel: selected.runtime ? "Running" : "Idle",
          badgeTone: selected.runtime ? "active" : "idle",
          action: () => void start(selected.branch),
        },
        {
          id: `worktree-stop-${selected.branch}`,
          code: "wsp",
          title: `Stop worktree runtime: ${selected.branch}`,
          subtitle: "Stop background commands and close the tmux runtime session.",
          group: "Worktree",
          keywords: [selected.branch, "stop", "runtime", "background"],
          disabled: !selected.runtime || busyBranch === selected.branch,
          badgeLabel: selected.runtime ? "Running" : "Idle",
          badgeTone: selected.runtime ? "active" : "idle",
          action: () => void stop(selected.branch),
        },
        {
          id: `worktree-sync-${selected.branch}`,
          code: "wen",
          title: `Sync .env files: ${selected.branch}`,
          subtitle: "Copy shared env files into the selected worktree.",
          group: "Worktree",
          keywords: [selected.branch, ".env", "sync"],
          disabled: busyBranch === selected.branch,
          action: () => void syncEnv(selected.branch),
        },
        {
          id: `worktree-delete-${selected.branch}`,
          code: "wdel",
          title: `Delete worktree: ${selected.branch}`,
          subtitle: deleteSubtitle,
          group: "Worktree",
          keywords: [selected.branch, "delete", "remove"],
          badgeLabel: deleteDisabledReason ? "Locked" : "Danger",
          badgeTone: deleteDisabledReason ? "warning" : "danger",
          disabled: Boolean(deleteDisabledReason),
          action: () => openDeleteConfirmation(selected),
        },
      );
    }

    return items.sort(comparePaletteItems);
  }, [
    activeTab,
    busyBranch,
    commandPaletteShortcut,
    environmentSubTab,
    isTerminalVisible,
    navigateToEnvironmentSubTab,
    navigateToProjectManagementSubTab,
    openAiSettings,
    openDeleteConfirmation,
    openConfigEditor,
    projectManagementDocument?.title,
    projectManagementDocumentViewMode,
    projectManagementSelectedDocumentId,
    projectManagementSubTab,
    selected,
    start,
    stop,
    syncEnv,
    theme,
  ]);

  const worktreeSelectionPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    return visibleWorktrees.map((entry, index) => ({
      id: `select-worktree-${entry.branch}`,
      code: String(index + 1),
      title: `${index + 1}. ${entry.branch}`,
      subtitle: entry.runtime ? `Runtime active - ${entry.worktreePath}` : `Idle - ${entry.worktreePath}`,
      group: "Worktree",
      keywords: [entry.branch, entry.worktreePath, entry.runtime ? "active" : "idle", String(index + 1)],
      badgeLabel: entry.runtime ? "Active" : "Idle",
      badgeTone: entry.runtime ? "active" : "idle",
      closeOnSelect: true,
      action: () => setSelectedBranch(entry.branch),
    }));
  }, [visibleWorktrees]);

  const themeSelectionPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    return themes.map((entry, index) => ({
      id: `select-theme-${entry.id}`,
      value: entry.id,
      code: String(index + 1),
      title: entry.name,
      subtitle: `${entry.author} - ${entry.variant} - ${entry.fileName}`,
      group: "Settings",
      keywords: [entry.id, entry.name, entry.author, entry.variant, entry.fileName, "theme", "base16"],
      badgeLabel: entry.id === theme.id ? "Active" : undefined,
      badgeTone: entry.id === theme.id ? "active" : undefined,
      closeOnSelect: true,
      action: () => setThemeId(entry.id),
    }));
  }, [setThemeId, theme.id, themes]);

  const paletteCommands = commandPaletteScope === "worktree-select"
    ? worktreeSelectionPaletteItems
    : commandPaletteScope === "theme-select"
      ? themeSelectionPaletteItems
      : mainCommandPaletteItems;

  const shortcutSettings = useMemo<CommandPaletteShortcutSetting[]>(() => [
    {
      id: "command-palette",
      label: "Command palette shortcut",
      shortcut: commandPaletteShortcut,
      defaultShortcut: DEFAULT_COMMAND_PALETTE_SHORTCUT,
      onChange: setCommandPaletteShortcut,
      onReset: () => setCommandPaletteShortcut(DEFAULT_COMMAND_PALETTE_SHORTCUT),
    },
    {
      id: "terminal-toggle",
      label: "Terminal toggle shortcut",
      shortcut: terminalShortcut,
      defaultShortcut: DEFAULT_TERMINAL_SHORTCUT,
      onChange: setTerminalShortcut,
      onReset: () => setTerminalShortcut(DEFAULT_TERMINAL_SHORTCUT),
    },
  ], [commandPaletteShortcut, terminalShortcut]);

  return (
    <main
      className="relative min-h-screen overflow-hidden px-0 pt-0 theme-text"
      style={{ paddingBottom: "calc(var(--terminal-drawer-stowed-height) + var(--terminal-drawer-page-gap))" }}
    >
      <div className="relative z-10 flex w-full flex-col gap-3">
        <header className="matrix-panel relative z-30 rounded-none border-x-0 p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-semibold tracking-tight theme-text-strong sm:text-3xl">worktreeman</h1>
                  <p className="mt-1 text-sm leading-5 theme-text-muted sm:text-base">
                    Worktree-first control surface for jumping between branch runtimes without losing the terminal context.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-2 pt-12 xl:max-w-[40rem] xl:items-end">
              <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[34rem] xl:grid-cols-[minmax(14rem,1fr)_minmax(14rem,1fr)]">
                <MatrixDropdown
                  label="Worktree"
                  value={selected?.branch ?? null}
                  options={worktreeOptions}
                  placeholder="Select worktree"
                  onChange={(value) => {
                    if (value === CREATE_WORKTREE_OPTION_VALUE) {
                      setCreateWorktreeModalOpen(true);
                      return;
                    }

                    setSelectedBranch(value);
                  }}
                />
                <button
                  type="button"
                  className="theme-border-subtle theme-dropdown-trigger flex h-full min-h-[100%] w-full items-center justify-between gap-3 border px-3 py-2 text-left transition-colors duration-150"
                  onClick={() => openCommandPalette("theme-select")}
                >
                  <div className="min-w-0">
                    <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">Theme</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="theme-text-strong truncate font-mono text-sm">{theme.name}</span>
                      <MatrixBadge tone="active" compact>{theme.variant}</MatrixBadge>
                    </div>
                  </div>
                  <span className="theme-text-accent-soft font-mono text-sm">/</span>
                </button>
                <button
                  type="button"
                  className="theme-border-subtle theme-dropdown-trigger flex h-full min-h-[100%] w-full items-center justify-between gap-3 border px-3 py-2 text-left transition-colors duration-150 xl:col-span-2"
                  onClick={() => void openConfigEditor()}
                >
                  <div className="min-w-0">
                    <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">Config</p>
                    <div className="mt-1 flex items-center gap-2">
                      <span className="theme-text-strong truncate font-mono text-sm">{state?.configSourceRef ?? DEFAULT_WORKTREEMAN_SETTINGS_BRANCH}</span>
                      <MatrixBadge tone="neutral" compact>{state?.configFile ?? "worktree.yml"}</MatrixBadge>
                    </div>
                  </div>
                  <span className="theme-text-accent-soft font-mono text-sm">edit</span>
                </button>
                <button
                  type="button"
                  className="theme-border-subtle theme-dropdown-trigger flex h-full min-h-[100%] w-full items-center justify-between gap-3 border px-3 py-2 text-left transition-colors duration-150 xl:col-span-2"
                  onClick={() => void openAiSettings()}
                >
                  <div className="min-w-0">
                    <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">AI commands</p>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      {aiCommandStatusBadges.map((entry) => (
                        <MatrixBadge key={entry.commandId} tone={entry.ready ? "active" : "warning"} compact>
                          {entry.label} {entry.ready ? "ready" : "missing"}
                        </MatrixBadge>
                      ))}
                    </div>
                  </div>
                  <span className="theme-text-accent-soft font-mono text-sm">magic</span>
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs theme-text-muted">
                <MatrixBadge tone="neutral">Command palette</MatrixBadge>
                <span className="font-mono theme-text-strong">{formatShortcutLabel(commandPaletteShortcut)}</span>
                <MatrixBadge tone="active">{theme.name}</MatrixBadge>
                <span>{themes.length} Base16 themes loaded</span>
              </div>
            </div>
          </div>
        </header>

        <section className="relative z-10 min-w-0">
          {shutdownStatus?.active || shutdownStatus?.completed || shutdownStatus?.failed ? (
            <div className="matrix-panel mb-4 rounded-none border-x-0 theme-inline-panel-warning p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="matrix-kicker theme-kicker-warning">Server shutdown</p>
                  <h2 className="mt-2 text-lg font-semibold theme-text-strong">
                    {shutdownStatus.active
                      ? "Server is shutting down"
                      : shutdownStatus.failed
                        ? "Shutdown failed"
                        : "Shutdown complete"}
                  </h2>
                  <p className="mt-2 text-sm theme-text-warning">
                    {shutdownStatus.active
                      ? "The server is cleaning up runtimes and active connections."
                      : "These are the latest shutdown logs reported by the server."}
                  </p>
                </div>
                <div className="border theme-count-chip px-3 py-1 font-mono text-xs theme-text-warning-soft">
                  {shutdownStatus.logs.length} log{shutdownStatus.logs.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="mt-4 max-h-[16rem] overflow-auto border theme-inline-panel-warning">
                {shutdownStatus.logs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`border-b px-4 py-2 font-mono text-xs last:border-b-0 ${entry.level === "error"
                      ? "theme-log-entry-error"
                      : "theme-border-warning theme-text-warning-soft"}`}
                  >
                    <span className="mr-3 theme-timestamp">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="matrix-panel mb-4 rounded-none border-x-0 theme-inline-panel-danger p-4 sm:p-5">
              <p className="matrix-kicker theme-kicker-danger">Request error</p>
              <p className="mt-2 text-sm theme-text-danger">{error}</p>
            </div>
          ) : null}

          <WorktreeDetail
            repoRoot={state?.repoRoot ?? null}
            worktree={selected}
            worktreeOptions={worktreeOptions}
            worktreeCount={visibleWorktrees.length}
            runningCount={visibleWorktrees.filter((entry) => entry.runtime).length}
            selectedStatusLabel={selected?.branch ? "Live" : "None"}
            onSelectWorktree={(value) => {
              if (value === CREATE_WORKTREE_OPTION_VALUE) {
                setCreateWorktreeModalOpen(true);
                return;
              }

              setSelectedBranch(value);
            }}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            environmentSubTab={environmentSubTab}
            onEnvironmentSubTabChange={setEnvironmentSubTab}
            gitView={gitView}
            onGitViewChange={setGitView}
            isTerminalVisible={isTerminalVisible}
            onTerminalVisibilityChange={setIsTerminalVisible}
            commandPaletteShortcut={commandPaletteShortcut}
            onCommandPaletteToggle={() => {
              if (commandPaletteOpen) {
                closeCommandPalette({ restoreFocus: true });
                return;
              }

              openCommandPalette();
            }}
            terminalShortcut={terminalShortcut}
            onTerminalShortcutToggle={() => toggleTerminalVisibility(true)}
            isBusy={busyBranch === selected?.branch}
            onStart={() => selected ? void start(selected.branch) : undefined}
            onStop={() => selected ? void stop(selected.branch) : undefined}
            onSyncEnv={() => selected ? void syncEnv(selected.branch) : undefined}
            onDelete={() => openDeleteConfirmation(selected)}
            backgroundCommands={backgroundCommands}
            backgroundLogs={backgroundLogs}
            gitComparison={gitComparison}
            gitComparisonLoading={gitComparisonLoading}
            onLoadBackgroundCommands={loadBackgroundCommands}
            onStartBackgroundCommand={startBackgroundCommand}
            onRestartBackgroundCommand={restartBackgroundCommand}
            onStopBackgroundCommand={stopBackgroundCommand}
            onLoadBackgroundLogs={loadBackgroundLogs}
            onLoadGitComparison={loadGitComparison}
            onMergeWorktreeIntoBase={mergeGitBranch}
            onMergeBaseIntoWorktree={mergeBaseBranchIntoWorktree}
            onResolveGitMergeConflicts={resolveGitMergeConflicts}
            onGenerateGitCommitMessage={generateGitCommitMessage}
            onCommitGitChanges={commitGitChanges}
            onSubscribeToBackgroundLogs={subscribeToBackgroundLogs}
            onClearBackgroundLogs={clearBackgroundLogs}
            projectManagementDocuments={projectManagement?.documents ?? []}
            projectManagementWorktrees={visibleWorktrees}
            projectManagementAvailableTags={projectManagement?.availableTags ?? []}
            projectManagementAvailableStatuses={projectManagement?.availableStatuses ?? []}
            projectManagementActiveSubTab={projectManagementSubTab}
            projectManagementSelectedDocumentId={projectManagementSelectedDocumentId}
            projectManagementDocumentViewMode={projectManagementDocumentViewMode}
            projectManagementDocument={projectManagementDocument}
            projectManagementHistory={projectManagementHistory}
            projectManagementLoading={projectManagementLoading}
            projectManagementSaving={projectManagementSaving}
            projectManagementAiLogs={aiCommandLogs}
            projectManagementAiLogDetail={aiCommandLogDetail}
            projectManagementAiLogsLoading={aiCommandLogsLoading}
            projectManagementRunningAiJobs={runningAiCommandJobs}
            onProjectManagementSubTabChange={handleProjectManagementSubTabChange}
            onProjectManagementDocumentViewModeChange={setProjectManagementDocumentViewMode}
            onLoadProjectManagementDocuments={loadProjectManagementDocuments}
            onLoadProjectManagementDocument={handleLoadProjectManagementDocument}
            onLoadProjectManagementAiLogs={loadAiCommandLogs}
            onLoadProjectManagementAiLog={loadAiCommandLog}
            onCreateProjectManagementDocument={createProjectManagementDocument}
            onUpdateProjectManagementDocument={updateProjectManagementDocument}
            onUpdateProjectManagementDependencies={async (documentId, dependencyIds) => {
              setProjectManagementSelectedDocumentId(documentId);
              return updateProjectManagementDependencies(documentId, { dependencyIds });
            }}
            onUpdateProjectManagementStatus={async (documentId, status) => {
              setProjectManagementSelectedDocumentId(documentId);
              return updateProjectManagementStatus(documentId, { status });
            }}
            onAddProjectManagementComment={addProjectManagementComment}
            projectManagementAiCommands={configuredAiCommands}
            projectManagementAiJob={selected?.branch && aiCommandJob?.branch === selected.branch ? aiCommandJob : null}
            projectManagementDocumentAiJob={projectManagementDocumentAiJob}
            onRunProjectManagementAiCommand={async (payload) => {
              if (!selected?.branch) {
                return null;
              }

              return runAiCommand(selected.branch, payload);
            }}
            onRunProjectManagementDocumentAi={async (payload) => runProjectManagementDocumentAi(payload.documentId, {
              input: payload.input,
              commandId: payload.commandId,
            }).then(async (result) => {
              if (!result) {
                return null;
              }

              setSelectedBranch(result.job.branch);
              await refresh({ silent: true });
              return result;
            })}
            onCancelProjectManagementDocumentAiCommand={async (branch) => cancelProjectManagementDocumentAi(branch)}
            onCancelProjectManagementAiCommand={async () => {
              if (!selected?.branch) {
                return null;
              }

              return cancelAiCommand(selected.branch);
            }}
            onCancelProjectManagementAiLogJob={async (branch) => cancelAiCommand(branch)}
          />
        </section>
      </div>

      {deleteConfirmation ? (
        <MatrixModal
          kicker="Confirm delete"
          title={<>Delete worktree `{deleteConfirmation.worktree.branch}`?</>}
          description="This removes the worktree, stops any running background commands for it, clears its persisted tmux session, and can also delete the branch."
          tone="danger"
          closeLabel="Cancel"
          maxWidthClass="max-w-xl"
          onClose={() => {
            setDeleteConfirmation(null);
            setDeleteConfirmationError(null);
          }}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => {
                  setDeleteConfirmation(null);
                  setDeleteConfirmationError(null);
                }}
              >
                Keep worktree
              </button>
              <button
                type="button"
                className="matrix-button matrix-button-danger rounded-none px-3 py-2 text-sm"
                disabled={
                  busyBranch === deleteConfirmation.worktree.branch
                  || (
                    deleteConfirmation.worktree.deletion?.requiresConfirmation === true
                    && deleteConfirmation.confirmWorktreeName !== deleteConfirmation.worktree.branch
                  )
                }
                onClick={() => void confirmDelete()}
              >
                {deleteConfirmation.deleteBranch ? "Delete worktree and branch" : "Delete worktree only"}
              </button>
            </>
          )}
        >
          <div className="space-y-4">
            <div className="border theme-inline-panel-danger p-3 text-sm theme-text-danger">
              <p className="font-mono">This action cannot be undone from the UI.</p>
              {deleteConfirmation.worktree.deletion?.hasLocalChanges || deleteConfirmation.worktree.deletion?.hasUnmergedCommits ? (
                <p className="mt-2">
                  {deleteConfirmation.worktree.deletion?.hasLocalChanges && deleteConfirmation.worktree.deletion?.hasUnmergedCommits
                    ? "This worktree has local changes and unmerged commits."
                    : deleteConfirmation.worktree.deletion?.hasLocalChanges
                      ? "This worktree has local changes."
                      : "This worktree has unmerged commits."}
                </p>
              ) : null}
            </div>

            {deleteConfirmationError ? (
              <div className="border theme-border-danger theme-surface-danger px-3 py-2 text-sm theme-text-danger">
                {deleteConfirmationError}
              </div>
            ) : null}

            <label className="flex items-start gap-3 text-sm theme-text">
              <input
                type="checkbox"
                className="mt-1"
                checked={deleteConfirmation.deleteBranch}
                onChange={(event) => setDeleteConfirmation((current) => current ? {
                  ...current,
                  deleteBranch: event.target.checked,
                } : current)}
              />
              <span>
                <span className="block font-medium theme-text-strong">Delete branch after removing the worktree</span>
                <span className="mt-1 block text-xs theme-text-muted">
                  Leave this unchecked to keep the branch available in the repository.
                </span>
              </span>
            </label>

            {deleteConfirmation.worktree.deletion?.requiresConfirmation ? (
              <label className="block">
                <span className="mb-2 block text-xs uppercase tracking-[0.18em] theme-text-soft">
                  Type {deleteConfirmation.worktree.branch} to confirm
                </span>
                <input
                  value={deleteConfirmation.confirmWorktreeName}
                  onChange={(event) => setDeleteConfirmation((current) => current ? {
                    ...current,
                    confirmWorktreeName: event.target.value,
                  } : current)}
                  className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                  autoFocus
                />
              </label>
            ) : null}
          </div>
        </MatrixModal>
      ) : null}

      {createWorktreeModalOpen ? (
        <MatrixModal
          kicker="New worktree"
          title="Create a worktree"
          description="Create a new branch worktree and switch the worktree picker to it."
          closeLabel="Cancel"
          maxWidthClass="max-w-lg"
           onClose={() => {
             setCreateWorktreeModalOpen(false);
             setBranch("");
             setCreateWorktreeDocumentId(null);
           }}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => {
                  setCreateWorktreeModalOpen(false);
                  setBranch("");
                  setCreateWorktreeDocumentId(null);
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                form="create-worktree-form"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              >
                Create worktree
              </button>
            </>
          )}
        >
          <form id="create-worktree-form" className="space-y-3" onSubmit={onSubmit}>
            <label className="block">
              <span className="mb-2 block text-xs uppercase tracking-[0.18em] theme-text-soft">Branch name</span>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature/branch-name"
                className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                autoFocus
              />
            </label>
            <div className="block">
              <MatrixDropdown
                label="Linked document"
                value={createWorktreeDocumentId}
                options={projectDocumentOptions}
                placeholder="Optional project document"
                emptyLabel="Create a project document first to link one here."
                onChange={setCreateWorktreeDocumentId}
              />
              <div className="mt-2 flex items-center justify-between gap-3 text-xs theme-text-muted">
                <span>Linking a document lets the worktree show its source plan and log AI work back to that document.</span>
                {createWorktreeDocumentId ? (
                  <button
                    type="button"
                    className="matrix-button rounded-none px-2 py-1 text-xs"
                    onClick={() => setCreateWorktreeDocumentId(null)}
                  >
                    Clear link
                  </button>
                ) : null}
              </div>
            </div>
          </form>
        </MatrixModal>
      ) : null}

      {lastEnvSync ? (
        <MatrixModal
          kicker="Env sync output"
          title={<>Synced env files for {lastEnvSync.branch}</>}
          description={lastEnvSync.copiedFiles.length > 0
            ? "These files were copied from the shared config source into the selected worktree."
            : "No .env files were found to copy from the shared config source."}
          onClose={clearLastEnvSync}
        >
          <div className="border theme-inline-panel p-3">
            {lastEnvSync.copiedFiles.length > 0 ? (
              <div className="max-h-[50vh] overflow-auto font-mono text-sm theme-text">
                {lastEnvSync.copiedFiles.map((filePath) => (
                  <div key={filePath} className="border-b theme-border-faint py-2 last:border-b-0">
                    {filePath}
                  </div>
                ))}
              </div>
            ) : (
              <p className="font-mono text-sm theme-chip-muted">No matching `.env*` files found.</p>
            )}
          </div>
        </MatrixModal>
      ) : null}

      {configEditorOpen ? (
        <MatrixModal
          kicker="Settings config"
          title={<>Edit `{configDocument?.filePath ?? state?.configPath ?? "worktree.yml"}`</>}
          description={configDocument?.editable === false
            ? "This config is currently available read-only. Open the settings worktree locally to edit it from the app."
            : "Update the shared worktree config stored in the settings worktree."}
          closeLabel="Cancel"
          maxWidthClass="max-w-6xl"
          onClose={closeConfigEditor}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={closeConfigEditor}
              >
                Cancel
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void reloadConfigEditor()}
                disabled={configDocumentLoading}
              >
                Reload
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                onClick={() => void saveConfigEditor()}
                disabled={configDocumentLoading || configDocument?.editable === false}
              >
                Save config
              </button>
            </>
          )}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs theme-text-muted">
              <MatrixBadge tone="neutral">Branch</MatrixBadge>
              <span className="font-mono theme-text-strong">{configDocument?.branch ?? state?.configSourceRef ?? DEFAULT_WORKTREEMAN_SETTINGS_BRANCH}</span>
              <MatrixBadge tone={configDocument?.editable === false ? "warning" : "active"}>
                {configDocument?.editable === false ? "Read only" : "Editable"}
              </MatrixBadge>
            </div>
            <div className="overflow-hidden border theme-border-subtle">
              <Editor
                height="65vh"
                defaultLanguage="yaml"
                language="yaml"
                value={configDraft}
                onChange={(value) => setConfigDraft(value ?? "")}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  wordWrap: "on",
                  scrollBeyondLastLine: false,
                  automaticLayout: true,
                  readOnly: configDocument?.editable === false,
                  tabSize: 2,
                  insertSpaces: true,
                }}
                theme={theme.variant === "light" ? "vs" : "vs-dark"}
              />
            </div>
          </div>
        </MatrixModal>
      ) : null}

      {aiSettingsOpen ? (
        <MatrixModal
          kicker="AI command"
          title="Configure UI Magic"
          description="Set the reusable Smart AI and Simple AI command templates run inside the selected worktree. Include $WTM_AI_INPUT where the generated prompt should be inserted."
          closeLabel="Cancel"
          maxWidthClass="max-w-3xl"
          onClose={closeAiSettings}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={closeAiSettings}
              >
                Cancel
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void reloadAiSettings()}
                disabled={aiCommandSettingsLoading}
              >
                Reload
              </button>
                <button
                  type="button"
                  className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                  onClick={() => void persistAiSettings()}
                  disabled={aiCommandSettingsLoading}
                >
                  Save AI commands
                </button>
            </>
          )}
        >
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-xs theme-text-muted">
                <MatrixBadge tone="neutral">Stored in config</MatrixBadge>
                <span className="font-mono theme-text-strong">{aiCommandSettings?.filePath ?? state?.configPath ?? "worktree.yml"}</span>
                {(["smart", "simple"] as const).map((commandId) => (
                  <MatrixBadge key={commandId} tone={isAiCommandTemplateReady(aiCommandDraftValues[commandId]) ? "active" : "warning"}>
                    {getAiCommandLabel(commandId)} {isAiCommandTemplateReady(aiCommandDraftValues[commandId]) ? "ready" : "missing $WTM_AI_INPUT"}
                  </MatrixBadge>
                ))}
              </div>
              <div className="grid gap-3">
                <label className="block space-y-2">
                  <span className="text-xs uppercase tracking-[0.18em] theme-text-soft">Smart AI command template</span>
                  <input
                    value={aiCommandDraftValues.smart}
                    onChange={(event) => setAiCommandDrafts((current) => ({ ...current, smart: event.target.value }))}
                    placeholder="opencode run $WTM_AI_INPUT"
                    className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                    autoFocus
                  />
                </label>
                <label className="block space-y-2">
                  <span className="text-xs uppercase tracking-[0.18em] theme-text-soft">Simple AI command template</span>
                  <input
                    value={aiCommandDraftValues.simple}
                    onChange={(event) => setAiCommandDrafts((current) => ({ ...current, simple: event.target.value }))}
                    placeholder="opencode run --model gpt-5-mini $WTM_AI_INPUT"
                    className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                  />
                </label>
              </div>
              <div className="border theme-border-subtle p-3 text-sm theme-text-muted">
                Use `$WTM_AI_INPUT` in each command you want to run. The generated document-editing prompt will be shell-quoted before execution.
              </div>
            </div>
        </MatrixModal>
      ) : null}


      <CommandPalette
        open={commandPaletteOpen}
        commands={paletteCommands}
        shortcut={commandPaletteShortcut}
        initialQuery={commandPaletteInitialQuery}
        onClose={handleCommandPaletteClose}
        onActiveItemChange={handleCommandPaletteActiveItemChange}
        onShortcutChange={setCommandPaletteShortcut}
        onShortcutReset={() => setCommandPaletteShortcut(DEFAULT_COMMAND_PALETTE_SHORTCUT)}
        shortcutSettings={shortcutSettings}
        initialActiveItemId={commandPaletteScope === "theme-select" ? `select-theme-${theme.id}` : undefined}
        title={commandPaletteScope === "worktree-select"
          ? "Select worktree"
          : commandPaletteScope === "theme-select"
            ? "Select theme"
            : "Command palette"}
        placeholder={commandPaletteScope === "worktree-select"
          ? "Type a worktree name, path, or :number"
          : commandPaletteScope === "theme-select"
            ? "Type a theme name, author, variant, or :number"
            : "Type a command or worktree name, or :code"}
        emptyState={commandPaletteScope === "worktree-select"
          ? "No worktrees match the current search."
          : commandPaletteScope === "theme-select"
            ? "No themes match the current search."
            : "No commands match the current search."}
        fuzzyModeLabel={commandPaletteScope === "worktree-select"
          ? "Fuzzy mode: search worktrees by branch or path"
          : commandPaletteScope === "theme-select"
            ? "Fuzzy mode: search themes by name, author, or variant"
            : "Fuzzy mode: search commands by name"}
        codeModeLabel={commandPaletteScope === "worktree-select" || commandPaletteScope === "theme-select"
          ? "Number mode: exact selection number"
          : "Code mode: exact command codes"}
        codeModeHint={commandPaletteScope === "worktree-select" || commandPaletteScope === "theme-select"
          ? "Prefix with `:` then a number"
          : "Prefix with `:`"}
        autoExecuteExactCode={commandPaletteScope === "main"}
        scopeKey={commandPaletteScope}
      />
    </main>
  );
}
