import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import Editor from "@monaco-editor/react";
import { DEFAULT_WORKTREEMAN_SETTINGS_BRANCH } from "@shared/constants";
import type { AiCommandConfig, AiCommandId, AutoSyncConfig, SystemSubTab, WorktreeRecord } from "@shared/types";
import {
  CommandPalette,
  DEFAULT_COMMAND_PALETTE_SHORTCUT,
  formatShortcutLabel,
  shortcutFromKeyboardEvent,
  type CommandPaletteItem,
  type CommandPaletteShortcutSetting,
} from "./command-palette";
import {
  DASHBOARD_NOTIFICATION_AUTO_DISMISS_MS,
  useDashboardState,
} from "../hooks/use-dashboard-state";
import type { DashboardNotification } from "../hooks/use-dashboard-state";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixModal } from "./matrix-primitives";
import { useTheme } from "./theme-provider";
import { WorktreeDetail, type WorktreeEnvironmentSubTab } from "./worktree-detail";
import { readDashboardUrlState, type DashboardActiveTab } from "./dashboard-url-state";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { ProjectManagementDocumentFormViewMode } from "./project-management-document-form";
import type { AiActivitySubTab } from "./project-management-ai-tab";
import {
  buildProjectManagementDocumentPath,
  readProjectManagementDocumentPath,
  type ProjectManagementDocumentPresentation,
} from "./project-management-document-route";
import { confirmWorktreeDeletion, type DeleteConfirmationState } from "./dashboard-delete";
import { getVisibleWorktrees } from "./dashboard-worktrees";
import { getWorktreeDeleteAiDisabledReason } from "./worktree-action-guards";
import { isPwaInstalled, type BeforeInstallPromptEvent, type PwaInstallStatus } from "../lib/pwa";
import {
  buildAiJobNotification,
  requestBrowserNotificationPermission,
  shouldNotifyAiJobCompletion,
} from "../lib/browser-notifications";

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
  autoStartRuntime: false,
};

const EMPTY_AUTO_SYNC: AutoSyncConfig = {
  remote: "origin",
};

function getNotificationToneClasses(tone: DashboardNotification["tone"]) {
  if (tone === "danger") {
    return {
      panel: "theme-inline-panel-danger",
      kicker: "theme-kicker-danger",
      text: "theme-text-danger",
      badge: "theme-badge-danger",
    };
  }

  if (tone === "warning") {
    return {
      panel: "theme-inline-panel-warning",
      kicker: "theme-kicker-warning",
      text: "theme-text-warning",
      badge: "theme-badge-warning",
    };
  }

  if (tone === "success") {
    return {
      panel: "theme-inline-panel",
      kicker: "theme-text-emphasis",
      text: "theme-text-strong",
      badge: "theme-badge-active",
    };
  }

  return {
    panel: "theme-inline-panel-emphasis",
    kicker: "theme-text-emphasis",
    text: "theme-text",
    badge: "theme-badge-neutral",
  };
}

export function DashboardNotificationStack({
  notifications,
  onDismiss,
}: {
  notifications: DashboardNotification[];
  onDismiss: (notificationId: string) => void;
}) {
  if (!notifications.length) {
    return null;
  }

  const stackBottomOffset = "calc(var(--terminal-drawer-stowed-height) + var(--terminal-drawer-page-gap) + 1rem)";

  return (
    <div
      className="pointer-events-none fixed right-4 z-[60] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-3"
      style={{ bottom: stackBottomOffset }}
    >
      {notifications.map((notification) => {
        const classes = getNotificationToneClasses(notification.tone);

        return (
          <section
            key={notification.id}
            className={`pointer-events-auto border ${classes.panel} rounded-none px-4 py-3 shadow-[0_16px_40px_rgb(var(--rgb-base00)_/_0.42)]`}
            role="status"
            aria-live={notification.tone === "danger" || notification.tone === "warning" ? "assertive" : "polite"}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${classes.badge}`}>
                    {notification.tone}
                  </span>
                  <p className={`text-xs uppercase tracking-[0.18em] ${classes.kicker}`}>{notification.title}</p>
                </div>
                <p className={`mt-2 text-sm ${classes.text}`}>{notification.message}</p>
              </div>
              <button
                type="button"
                className="matrix-button rounded-none px-2 py-1 text-xs"
                onClick={() => onDismiss(notification.id)}
                aria-label={`Dismiss ${notification.title}`}
              >
                Dismiss
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function normalizeAiCommands(aiCommands?: Partial<AiCommandConfig> | null): AiCommandConfig {
  return {
    smart: typeof aiCommands?.smart === "string" ? aiCommands.smart : "",
    simple: typeof aiCommands?.simple === "string" ? aiCommands.simple : "",
    autoStartRuntime: aiCommands?.autoStartRuntime === true,
  };
}

function normalizeAutoSync(autoSync?: Partial<AutoSyncConfig> | null): AutoSyncConfig {
  return {
    remote: typeof autoSync?.remote === "string" && autoSync.remote.trim() ? autoSync.remote.trim() : "origin",
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

const PRIMARY_NAV_ITEMS: Array<{
  id: DashboardActiveTab;
  shortLabel: string;
  label: string;
  description: string;
}> = [
  {
    id: "environment",
    shortLabel: "ENV",
    label: "Environment",
    description: "Runtime controls, shell access, and background commands.",
  },
  {
    id: "git",
    shortLabel: "GIT",
    label: "Git",
    description: "Diffs, status, merge readiness, and branch actions.",
  },
  {
    id: "project-management",
    shortLabel: "PM",
    label: "Project",
    description: "Documents, board flow, dependencies, and planning work.",
  },
  {
    id: "review",
    shortLabel: "REV",
    label: "Review",
    description: "Linked-document review timeline and worktree discussion.",
  },
  {
    id: "system",
    shortLabel: "SYS",
    label: "System",
    description: "Host health, queue activity, and durable process state.",
  },
  {
    id: "ai-log",
    shortLabel: "AI",
    label: "AI Activity",
    description: "Saved logs, active AI jobs, and origin-linked runs.",
  },
];

export function Dashboard() {
  const initialUrlState = readDashboardUrlState(
    typeof window === "undefined" ? "/" : window.location.pathname,
    typeof window === "undefined" ? "" : window.location.search,
  );
  const {
    state,
    loading,
    hasLoadedInitialState,
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
    autoSyncSettings,
    autoSyncSettingsLoading,
    aiCommandJob,
    projectManagementDocumentAiJob,
    aiCommandLogs,
    aiCommandLogDetail,
    aiCommandLogsLoading,
    aiCommandLogsError,
    aiCommandLogsLastUpdatedAt,
    runningAiCommandJobs,
    systemStatus,
    systemLoading,
    systemError,
    systemLastUpdatedAt,
    projectManagement,
    projectManagementUsers,
    projectManagementReviews,
    projectManagementDocumentReview,
    projectManagementDocument,
    projectManagementHistory,
    projectManagementLoading,
    projectManagementError,
    projectManagementLastUpdatedAt,
    projectManagementSaving,
    notifications,
    dismissNotification,
    clearLastEnvSync,
    clearBackgroundLogs,
    addProjectManagementReviewEntry,
    deleteProjectManagementReviewEntry,
    batchUpdateProjectManagementDocuments,
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
    loadProjectManagementReviews,
    loadProjectManagementUsers,
    loadConfigDocument,
    loadAiCommandSettings,
    loadAutoSyncSettings,
    loadAiCommandLog,
    loadAiCommandLogs,
    loadSystemStatus,
    loadGitComparison,
    subscribeToGitComparison,
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
    saveAutoSyncSettings,
    saveConfigDocument,
    subscribeToBackgroundLogs,
    updateProjectManagementDependencies,
    updateProjectManagementDocument,
    updateProjectManagementStatus,
    updateProjectManagementUsers,
    enableAutoSync,
    disableAutoSync,
    runAutoSyncNow,
  } = useDashboardState();
  const { theme, themes, setThemeId, setPreviewThemeId, clearPreviewTheme } = useTheme();
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialUrlState.selectedBranch);
  const [activeTab, setActiveTab] = useState<DashboardActiveTab>(initialUrlState.activeTab);
  const [aiActivitySubTab, setAiActivitySubTab] = useState<AiActivitySubTab>(initialUrlState.aiActivitySubTab);
  const [selectedAiLogJobId, setSelectedAiLogJobId] = useState<string | null>(initialUrlState.selectedAiLogJobId);
  const [environmentSubTab, setEnvironmentSubTab] = useState<WorktreeEnvironmentSubTab>(initialUrlState.environmentSubTab);
  const [systemSubTab, setSystemSubTab] = useState<SystemSubTab>(initialUrlState.systemSubTab);
  const [projectManagementSubTab, setProjectManagementSubTab] = useState<ProjectManagementSubTab>(
    initialUrlState.projectManagementSubTab,
  );
  const [projectManagementSelectedDocumentId, setProjectManagementSelectedDocumentId] = useState<string | null>(initialUrlState.projectManagementSelectedDocumentId);
  const [projectManagementDocumentPresentation, setProjectManagementDocumentPresentation] = useState<ProjectManagementDocumentPresentation>(
    initialUrlState.projectManagementDocumentPresentation,
  );
  const [projectManagementDocumentViewMode, setProjectManagementDocumentViewMode] = useState<ProjectManagementDocumentViewMode>(
    initialUrlState.projectManagementDocumentViewMode,
  );
  const [projectManagementEditFormTab, setProjectManagementEditFormTab] = useState<ProjectManagementDocumentFormViewMode>(
    initialUrlState.projectManagementEditFormTab,
  );
  const [projectManagementCreateFormTab, setProjectManagementCreateFormTab] = useState<ProjectManagementDocumentFormViewMode>(
    initialUrlState.projectManagementCreateFormTab,
  );
  const [gitView, setGitView] = useState<"graph" | "diff">(initialUrlState.gitView);
  const [isTerminalVisible, setIsTerminalVisible] = useState(initialUrlState.isTerminalVisible);
  const [deleteConfirmation, setDeleteConfirmation] = useState<DeleteConfirmationState | null>(null);
  const [deleteConfirmationError, setDeleteConfirmationError] = useState<string | null>(null);
  const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
  const [configEditorOpen, setConfigEditorOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [autoSyncSettingsOpen, setAutoSyncSettingsOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState("");
  const [aiCommandDrafts, setAiCommandDrafts] = useState<AiCommandConfig>(EMPTY_AI_COMMANDS);
  const [autoSyncDraft, setAutoSyncDraft] = useState<AutoSyncConfig>(EMPTY_AUTO_SYNC);
  const [branch, setBranch] = useState("");
  const [createWorktreeDocumentId, setCreateWorktreeDocumentId] = useState<string | null>(null);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteScope, setCommandPaletteScope] = useState<CommandPaletteScope>("main");
  const [commandPaletteInitialQuery, setCommandPaletteInitialQuery] = useState("");
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalShortcutAtRef = useRef(0);
  const hasCommittedDashboardHistoryRef = useRef(false);
  const previousAiCommandJobRef = useRef(aiCommandJob);
  const previousProjectManagementDocumentAiJobRef = useRef(projectManagementDocumentAiJob);
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
  const [pwaInstallStatus, setPwaInstallStatus] = useState<PwaInstallStatus>("manual");
  const [pwaPromptEvent, setPwaPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (!notifications.length) {
      return;
    }

    const timers = notifications.map((notification) => window.setTimeout(() => {
      dismissNotification(notification.id);
    }, DASHBOARD_NOTIFICATION_AUTO_DISMISS_MS));

    return () => {
      for (const timer of timers) {
        window.clearTimeout(timer);
      }
    };
  }, [dismissNotification, notifications]);

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

  const selectedDeleteAiDisabledReason = useMemo(
    () => getWorktreeDeleteAiDisabledReason(runningAiCommandJobs, selected?.branch),
    [runningAiCommandJobs, selected?.branch],
  );

  const deleteConfirmationAiDisabledReason = useMemo(
    () => getWorktreeDeleteAiDisabledReason(runningAiCommandJobs, deleteConfirmation?.worktree.branch),
    [deleteConfirmation?.worktree.branch, runningAiCommandJobs],
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
    if (typeof window === "undefined") {
      return;
    }

    const updateInstalledState = () => {
      if (isPwaInstalled({
        matchMedia: window.matchMedia.bind(window),
        navigator: window.navigator,
      })) {
        setPwaPromptEvent(null);
        setPwaInstallStatus("installed");
        return true;
      }

      return false;
    };

    if (!updateInstalledState()) {
      setPwaInstallStatus("manual");
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      const promptEvent = event as BeforeInstallPromptEvent;
      promptEvent.preventDefault();
      setPwaPromptEvent(promptEvent);
      setPwaInstallStatus("available");
    };

    const handleAppInstalled = () => {
      setPwaPromptEvent(null);
      setPwaInstallStatus("installed");
    };

    const standaloneMediaQuery = window.matchMedia("(display-mode: standalone)");
    const handleStandaloneChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        setPwaPromptEvent(null);
        setPwaInstallStatus("installed");
      }
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
    window.addEventListener("appinstalled", handleAppInstalled);
    standaloneMediaQuery.addEventListener("change", handleStandaloneChange);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt as EventListener);
      window.removeEventListener("appinstalled", handleAppInstalled);
      standaloneMediaQuery.removeEventListener("change", handleStandaloneChange);
    };
  }, []);

  const handleInstallPwa = useCallback(async () => {
    if (!pwaPromptEvent) {
      return;
    }

    setPwaInstallStatus("installing");

    try {
      await pwaPromptEvent.prompt();
      const choice = await pwaPromptEvent.userChoice;

      setPwaPromptEvent(null);
      setPwaInstallStatus(choice.outcome === "accepted" ? "installed" : "manual");
    } catch {
      setPwaInstallStatus("manual");
    }
  }, [pwaPromptEvent]);

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
    const currentDocumentRoute = readProjectManagementDocumentPath(window.location.pathname);
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
      if (projectManagementSubTab === "document" && projectManagementDocumentViewMode === "edit" && projectManagementSelectedDocumentId) {
        params.set("pmEditTab", projectManagementEditFormTab);
      } else {
        params.delete("pmEditTab");
      }
      if (projectManagementSubTab === "create") {
        params.set("pmCreateTab", projectManagementCreateFormTab);
      } else {
        params.delete("pmCreateTab");
      }
    } else {
      params.delete("pmTab");
      params.delete("pmDoc");
      params.delete("pmView");
      params.delete("pmEditTab");
      params.delete("pmCreateTab");
    }

    if (activeTab === "system") {
      params.set("systemTab", systemSubTab);
    } else {
      params.delete("systemTab");
    }

    if (activeTab === "ai-log") {
      params.set("aiTab", aiActivitySubTab);
      if (selectedAiLogJobId) {
        params.set("aiLog", selectedAiLogJobId);
      } else {
        params.delete("aiLog");
      }
    } else {
      params.delete("aiTab");
      params.delete("aiLog");
    }

    if (isTerminalVisible) {
      params.set("terminal", "open");
    } else {
      params.delete("terminal");
    }

    const nextPathname = activeTab === "project-management"
      && projectManagementSubTab === "document"
      && projectManagementSelectedDocumentId
      && projectManagementDocumentPresentation === "page"
      ? buildProjectManagementDocumentPath(projectManagementSelectedDocumentId)
      : currentDocumentRoute.presentation === "page"
        ? "/"
        : window.location.pathname;
    const nextUrl = `${nextPathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;

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
    aiActivitySubTab,
    selectedAiLogJobId,
    environmentSubTab,
    gitView,
    isTerminalVisible,
    projectManagementCreateFormTab,
    projectManagementDocumentPresentation,
    projectManagementDocumentViewMode,
    projectManagementEditFormTab,
    projectManagementSelectedDocumentId,
    projectManagementSubTab,
    selectedBranch,
    systemSubTab,
  ]);

  useEffect(() => {
    const handlePopState = () => {
      const nextUrlState = readDashboardUrlState(window.location.pathname, window.location.search);
      setSelectedBranch(nextUrlState.selectedBranch);
      setActiveTab(nextUrlState.activeTab);
      setAiActivitySubTab(nextUrlState.aiActivitySubTab);
      setSelectedAiLogJobId(nextUrlState.selectedAiLogJobId);
      setEnvironmentSubTab(nextUrlState.environmentSubTab);
      setGitView(nextUrlState.gitView);
      setIsTerminalVisible(nextUrlState.isTerminalVisible);
      setSystemSubTab(nextUrlState.systemSubTab);
      setProjectManagementSubTab(nextUrlState.projectManagementSubTab);
      setProjectManagementSelectedDocumentId(nextUrlState.projectManagementSelectedDocumentId);
      setProjectManagementDocumentPresentation(nextUrlState.projectManagementDocumentPresentation);
      setProjectManagementDocumentViewMode(nextUrlState.projectManagementDocumentViewMode);
      setProjectManagementEditFormTab(nextUrlState.projectManagementEditFormTab);
      setProjectManagementCreateFormTab(nextUrlState.projectManagementCreateFormTab);
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (
      !projectManagementSelectedDocumentId
      || activeTab !== "project-management"
      || (projectManagementSubTab !== "document" && projectManagementSubTab !== "history")
    ) {
      return;
    }

    void loadProjectManagementDocument(projectManagementSelectedDocumentId, { silent: true });
  }, [activeTab, loadProjectManagementDocument, projectManagementSelectedDocumentId, projectManagementSubTab]);

  useEffect(() => {
    if (!selectedAiLogJobId || activeTab !== "ai-log") {
      return;
    }

    void loadAiCommandLog(selectedAiLogJobId, { silent: true });
  }, [activeTab, loadAiCommandLog, selectedAiLogJobId]);

  useEffect(() => {
    void loadAiCommandSettings({ silent: true });
  }, [loadAiCommandSettings]);

  const maybeNotifyAiJobCompletion = useCallback((previousJob: typeof aiCommandJob, nextJob: typeof aiCommandJob) => {
    if (typeof window === "undefined" || typeof document === "undefined" || typeof window.Notification === "undefined" || !nextJob) {
      return;
    }

    if (!shouldNotifyAiJobCompletion({
      previousJob,
      nextJob,
      permission: window.Notification.permission,
      attentionState: {
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      },
    })) {
      return;
    }

    try {
      const payload = buildAiJobNotification(nextJob);
      const notification = new window.Notification(payload.title, {
        body: payload.body,
        tag: payload.tag,
      });
      notification.onclick = () => {
        window.focus();
      };
    } catch {
      // Ignore notification failures from unsupported browser states.
    }
  }, []);

  useEffect(() => {
    maybeNotifyAiJobCompletion(previousAiCommandJobRef.current, aiCommandJob);
    previousAiCommandJobRef.current = aiCommandJob;
  }, [aiCommandJob, maybeNotifyAiJobCompletion]);

  useEffect(() => {
    maybeNotifyAiJobCompletion(previousProjectManagementDocumentAiJobRef.current, projectManagementDocumentAiJob);
    previousProjectManagementDocumentAiJobRef.current = projectManagementDocumentAiJob;
  }, [maybeNotifyAiJobCompletion, projectManagementDocumentAiJob]);

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

  const openAutoSyncSettings = useCallback(async () => {
    const settings = await loadAutoSyncSettings();
    if (!settings) {
      return;
    }

    setAutoSyncDraft(normalizeAutoSync(settings.autoSync));
    setAutoSyncSettingsOpen(true);
  }, [loadAutoSyncSettings]);

  const closeAutoSyncSettings = useCallback(() => {
    setAutoSyncSettingsOpen(false);
  }, []);

  const reloadAutoSyncSettings = useCallback(async () => {
    const settings = await loadAutoSyncSettings();
    if (!settings) {
      return;
    }

    setAutoSyncDraft(normalizeAutoSync(settings.autoSync));
  }, [loadAutoSyncSettings]);

  const persistAutoSyncSettings = useCallback(async () => {
    const settings = await saveAutoSyncSettings({ autoSync: normalizeAutoSync(autoSyncDraft) });
    if (!settings) {
      return;
    }

    setAutoSyncDraft(normalizeAutoSync(settings.autoSync));
    setAutoSyncSettingsOpen(false);
  }, [autoSyncDraft, saveAutoSyncSettings]);

  const openDeleteConfirmation = useCallback((worktree: WorktreeRecord | null) => {
    const deleteAiDisabledReason = getWorktreeDeleteAiDisabledReason(runningAiCommandJobs, worktree?.branch);
    if (!worktree?.deletion?.canDelete || deleteAiDisabledReason) {
      setDeleteConfirmationError(deleteAiDisabledReason ?? null);
      return;
    }

    setDeleteConfirmationError(null);
    setDeleteConfirmation({
      worktree,
      deleteBranch: worktree.deletion?.deleteBranchByDefault ?? true,
      confirmWorktreeName: "",
    });
  }, [runningAiCommandJobs]);

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
    setProjectManagementDocumentPresentation("modal");
    if (options && "documentId" in options) {
      setProjectManagementSelectedDocumentId(options.documentId ?? null);
    }
    if (tab === "document") {
      setProjectManagementDocumentViewMode(options?.viewMode ?? "document");
    }
  }, []);

  const navigateToSystemSubTab = useCallback((tab: SystemSubTab) => {
    navigateToTab("system");
    setSystemSubTab(tab);
  }, []);

  const handleProjectManagementSubTabChange = useCallback((tab: ProjectManagementSubTab) => {
    setProjectManagementSubTab(tab);
    if (tab !== "document") {
      setProjectManagementDocumentPresentation("modal");
      setProjectManagementSelectedDocumentId(null);
    }
    if (tab !== "document") {
      setProjectManagementDocumentViewMode("document");
    }
  }, []);

  const configuredAiCommands = normalizeAiCommands(aiCommandSettings?.aiCommands);
  const configuredAutoSync = normalizeAutoSync(autoSyncSettings?.autoSync ?? state?.config.autoSync);
  const aiCommandDraftValues = normalizeAiCommands(aiCommandDrafts);
  const autoSyncDraftValues = normalizeAutoSync(autoSyncDraft);
  const handleLoadProjectManagementDocument = useCallback(async (documentId: string, options?: { silent?: boolean }) => {
    setProjectManagementSelectedDocumentId(documentId);
    setProjectManagementDocumentPresentation("modal");
    setProjectManagementSubTab("document");
    return loadProjectManagementDocument(documentId, options);
  }, [loadProjectManagementDocument]);

  const handleOpenProjectManagementDocumentPage = useCallback((
    documentId: string,
    options?: { viewMode?: ProjectManagementDocumentViewMode },
  ) => {
    navigateToTab("project-management");
    setProjectManagementSubTab("document");
    setProjectManagementSelectedDocumentId(documentId);
    setProjectManagementDocumentPresentation("page");
    setProjectManagementDocumentViewMode(options?.viewMode ?? "document");
  }, []);

  const handleCloseProjectManagementDocument = useCallback(() => {
    setProjectManagementDocumentViewMode("document");
    if (projectManagementDocumentPresentation === "page") {
      setProjectManagementDocumentPresentation("modal");
      setProjectManagementSelectedDocumentId(null);
      setProjectManagementSubTab("document");
      navigateToTab("project-management");
      return;
    }

    setProjectManagementSelectedDocumentId(null);
  }, [projectManagementDocumentPresentation]);

  const handleLoadProjectManagementAiLog = useCallback(async (jobId: string, options?: { silent?: boolean }) => {
    setSelectedAiLogJobId(jobId);
    return loadAiCommandLog(jobId, options);
  }, [loadAiCommandLog]);

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
        title: "Open GIT diff",
        subtitle: "Jump to the branch diff, status, and merge controls.",
        group: "Navigation",
        keywords: ["git", "diff", "branch", "status", "changes", "compare"],
        badgeLabel: activeTab === "git" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("git"),
      },
      {
        id: "nav-system",
        code: "ns",
        title: "Open System tab",
        subtitle: "Inspect host performance and durable pg-boss job activity.",
        group: "Navigation",
        keywords: ["system", "performance", "jobs", "pgboss", "queue"],
        badgeLabel: activeTab === "system" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("system"),
      },
      {
        id: "nav-system-performance",
        code: "nsp",
        title: "Open System performance",
        subtitle: "Review host load, memory, uptime, and worktree counts.",
        group: "Navigation",
        keywords: ["system", "performance", "htop", "cpu", "memory", "uptime"],
        badgeLabel: activeTab === "system" && systemSubTab === "performance" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToSystemSubTab("performance"),
      },
      {
        id: "nav-system-jobs",
        code: "nsj",
        title: "Open System jobs",
        subtitle: "Inspect recent pg-boss jobs, states, timings, and payload context.",
        group: "Navigation",
        keywords: ["system", "jobs", "pgboss", "queue", "worker"],
        badgeLabel: activeTab === "system" && systemSubTab === "jobs" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToSystemSubTab("jobs"),
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
        id: "nav-review",
        code: "nr",
        title: "Open Review tab",
        subtitle: selected?.linkedDocument?.title
          ? `Inspect the linked review timeline for ${selected.linkedDocument.title}.`
          : "Inspect the linked document review timeline for the selected worktree.",
        group: "Navigation",
        keywords: ["review", "timeline", "linked document", "discussion", "ai"],
        badgeLabel: activeTab === "review" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("review"),
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
        id: "nav-project-management-users",
        code: "npu",
        title: "Open project users",
        subtitle: "Jump to discovered, archived, and custom project users.",
        group: "Navigation",
        keywords: ["project", "management", "users", "people", "contributors"],
        badgeLabel: activeTab === "project-management" && projectManagementSubTab === "users" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToProjectManagementSubTab("users"),
      },
      {
        id: "nav-project-management-ai-log",
        code: "npa",
        title: "Open AI tab",
        subtitle: "Review active AI worktrees, saved output, and origin links.",
        group: "Navigation",
        keywords: ["project", "management", "ai", "logs", "jobs", "worktrees"],
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
        id: "settings-auto-sync",
        code: "sas",
        title: "Edit auto sync",
        subtitle: `Choose the remote used for document auto sync. Current remote: ${configuredAutoSync.remote}`,
        group: "Settings",
        keywords: ["auto sync", "documents", "remote", configuredAutoSync.remote],
        action: () => void openAutoSyncSettings(),
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
        : selectedDeleteAiDisabledReason
          ?? (selected.deletion?.canDelete === false
          ? selected.deletion.reason
          : null);
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
    navigateToSystemSubTab,
    openAiSettings,
    openAutoSyncSettings,
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
    systemSubTab,
    selectedDeleteAiDisabledReason,
    theme,
    runningAiCommandJobs,
    configuredAutoSync.remote,
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

  if (!hasLoadedInitialState) {
    return (
      <main className="relative min-h-screen overflow-hidden px-0 pt-0 theme-text">
        <div className="flex min-h-screen items-center justify-center px-4">
          <div className="matrix-panel w-full max-w-md rounded-none border-x-0 p-6 text-center sm:p-8">
            <p className="matrix-kicker">Loading</p>
            <h1 className="mt-2 text-xl font-semibold theme-text-strong">Loading workspace state</h1>
            <p className="mt-2 text-sm theme-text-muted">
              Waiting for the first dashboard state snapshot from the server.
            </p>
            <div className="mt-4 flex justify-center">
              <MatrixBadge tone="warning">Loading…</MatrixBadge>
            </div>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main
      className="relative min-h-screen overflow-hidden px-0 pt-0 theme-text"
      style={{ paddingBottom: "calc(var(--terminal-drawer-stowed-height) + var(--terminal-drawer-page-gap))" }}
    >
      <div className="relative z-10 grid min-h-screen gap-3 lg:grid-cols-[16rem_minmax(0,1fr)] lg:gap-0">
        <aside className="matrix-panel rounded-none border-x-0 border-t-0 p-3 lg:sticky lg:top-0 lg:h-screen lg:border-b-0 lg:border-l-0 lg:border-r">
          <div className="flex h-full flex-col gap-3">
            <div className="border theme-border-faint px-3 py-3">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <h1 className="mt-1 text-lg font-semibold tracking-tight theme-text-strong">worktreeman</h1>
              <p className="mt-1 text-xs leading-5 theme-text-muted">
                Dense control surface for branch runtimes, Git flow, and AI-assisted project work.
              </p>
            </div>

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

            <div className="grid grid-cols-2 gap-2">
              <div className="theme-border-subtle theme-surface-soft border px-3 py-2">
                <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">Worktrees</p>
                <p className="mt-1 text-base font-semibold theme-text-strong">{visibleWorktrees.length}</p>
              </div>
              <div className="theme-border-subtle theme-surface-soft border px-3 py-2">
                <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">Running</p>
                <p className="mt-1 text-base font-semibold theme-text-strong">{visibleWorktrees.filter((entry) => entry.runtime).length}</p>
              </div>
            </div>

            <nav aria-label="Primary navigation" className="flex flex-col gap-2">
              {PRIMARY_NAV_ITEMS.map((entry) => {
                const isActive = entry.id === activeTab;
                return (
                  <button
                    key={entry.id}
                    type="button"
                      className={`flex items-start gap-3 border px-3 py-2 text-left transition-colors duration-150 ${isActive
                      ? "theme-tab-active theme-border-subtle"
                      : "theme-tab-idle theme-border-faint"}`}
                    onClick={() => navigateToTab(entry.id)}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <span className="min-w-[2.75rem] font-mono text-[11px] font-semibold uppercase tracking-[0.2em] theme-text-soft">
                      {entry.shortLabel}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold theme-text-strong">{entry.label}</span>
                      <span className="mt-1 block text-xs leading-5 theme-text-muted">{entry.description}</span>
                    </span>
                  </button>
                );
              })}
            </nav>

            <div className="mt-auto flex flex-col gap-2">
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                onClick={() => setCreateWorktreeModalOpen(true)}
              >
                New worktree
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => openCommandPalette("theme-select")}
              >
                Theme: {theme.name}
              </button>
              {pwaInstallStatus === "installed" ? (
                <div className="border theme-border-faint px-3 py-2 text-xs font-mono theme-text-strong">
                  App installed
                </div>
              ) : (
                <button
                  type="button"
                  className="matrix-button rounded-none px-3 py-2 text-sm"
                  onClick={() => void handleInstallPwa()}
                  disabled={pwaInstallStatus !== "available"}
                >
                  {pwaInstallStatus === "available"
                    ? "Install app"
                    : pwaInstallStatus === "installing"
                      ? "Check browser"
                      : "Install pending"}
                </button>
              )}
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void openConfigEditor()}
              >
                Edit config
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void openAutoSyncSettings()}
              >
                Auto sync
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void openAiSettings()}
              >
                AI commands
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0">
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
            autoSyncRemote={configuredAutoSync.remote}
            onStart={() => selected ? void start(selected.branch) : undefined}
            onStop={() => selected ? void stop(selected.branch) : undefined}
            onSyncEnv={() => selected ? void syncEnv(selected.branch) : undefined}
            onDelete={() => openDeleteConfirmation(selected)}
            onEnableAutoSync={() => selected ? void enableAutoSync(selected.branch) : undefined}
            onDisableAutoSync={() => selected ? void disableAutoSync(selected.branch) : undefined}
            onRunAutoSyncNow={() => selected ? void runAutoSyncNow(selected.branch) : undefined}
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
            onSubscribeToGitComparison={subscribeToGitComparison}
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
            projectManagementUsers={projectManagementUsers}
            projectManagementReviews={projectManagementReviews?.reviews ?? []}
            projectManagementDocumentReview={projectManagementDocumentReview}
            projectManagementActiveSubTab={projectManagementSubTab}
            projectManagementSelectedDocumentId={projectManagementSelectedDocumentId}
            projectManagementDocumentPresentation={projectManagementDocumentPresentation}
            projectManagementDocumentViewMode={projectManagementDocumentViewMode}
            projectManagementEditFormTab={projectManagementEditFormTab}
            projectManagementCreateFormTab={projectManagementCreateFormTab}
            projectManagementDocument={projectManagementDocument}
            projectManagementHistory={projectManagementHistory}
            projectManagementLoading={projectManagementLoading}
            projectManagementError={projectManagementError}
            projectManagementLastUpdatedAt={projectManagementLastUpdatedAt}
            projectManagementSaving={projectManagementSaving}
            projectManagementAiLogs={aiCommandLogs}
            projectManagementAiLogDetail={aiCommandLogDetail}
            projectManagementSelectedAiLogJobId={selectedAiLogJobId}
            projectManagementAiLogsLoading={aiCommandLogsLoading}
            projectManagementAiLogsError={aiCommandLogsError}
            projectManagementAiLogsLastUpdatedAt={aiCommandLogsLastUpdatedAt}
            projectManagementRunningAiJobs={runningAiCommandJobs}
            projectManagementAiActiveSubTab={aiActivitySubTab}
            systemStatus={systemStatus}
            systemLoading={systemLoading}
            systemError={systemError}
            systemLastUpdatedAt={systemLastUpdatedAt}
            systemSubTab={systemSubTab}
            onProjectManagementSubTabChange={handleProjectManagementSubTabChange}
            onProjectManagementAiSubTabChange={setAiActivitySubTab}
            onSystemSubTabChange={setSystemSubTab}
            onProjectManagementDocumentViewModeChange={setProjectManagementDocumentViewMode}
            onProjectManagementEditFormTabChange={setProjectManagementEditFormTab}
            onProjectManagementCreateFormTabChange={setProjectManagementCreateFormTab}
            onProjectManagementOpenDocumentPage={handleOpenProjectManagementDocumentPage}
            onProjectManagementCloseDocument={handleCloseProjectManagementDocument}
            onLoadProjectManagementDocuments={loadProjectManagementDocuments}
            onLoadProjectManagementReviews={loadProjectManagementReviews}
            onLoadProjectManagementUsers={loadProjectManagementUsers}
            onLoadProjectManagementDocument={handleLoadProjectManagementDocument}
            onLoadProjectManagementAiLogs={loadAiCommandLogs}
            onLoadProjectManagementAiLog={handleLoadProjectManagementAiLog}
            onLoadSystemStatus={loadSystemStatus}
            onCreateProjectManagementDocument={createProjectManagementDocument}
            onUpdateProjectManagementDocument={updateProjectManagementDocument}
            onUpdateProjectManagementDependencies={async (documentId, dependencyIds) => {
              await updateProjectManagementDependencies(documentId, { dependencyIds });
              return null;
            }}
            onUpdateProjectManagementStatus={async (documentId, status) => {
              return updateProjectManagementStatus(documentId, { status });
            }}
            onUpdateProjectManagementUsers={updateProjectManagementUsers}
            onBatchUpdateProjectManagementDocuments={async (documentIds, overrides) => {
              return batchUpdateProjectManagementDocuments(documentIds, overrides);
            }}
            onAddProjectManagementReviewEntry={async (documentId, payload) => {
              return addProjectManagementReviewEntry(documentId, payload);
            }}
            onDeleteProjectManagementReviewEntry={async (documentId, reviewEntryId) => {
              return deleteProjectManagementReviewEntry(documentId, reviewEntryId);
            }}
            projectManagementAiCommands={configuredAiCommands}
            projectManagementAiJob={selected?.branch && aiCommandJob?.branch === selected.branch ? aiCommandJob : null}
            projectManagementDocumentAiJob={projectManagementDocumentAiJob}
            onRunProjectManagementAiCommand={async (payload) => {
              await requestBrowserNotificationPermission(typeof window === "undefined" ? null : window.Notification);

              if (!selected?.branch) {
                return null;
              }

              return runAiCommand(selected.branch, payload);
            }}
            onRunProjectManagementDocumentAi={async (payload) => {
              await requestBrowserNotificationPermission(typeof window === "undefined" ? null : window.Notification);

              return runProjectManagementDocumentAi(payload.documentId, {
                input: payload.input,
                commandId: payload.commandId,
                origin: payload.origin,
                worktreeStrategy: payload.worktreeStrategy,
                targetBranch: payload.targetBranch,
                worktreeName: payload.worktreeName,
              }).then((result) => {
                if (!result) {
                  return null;
                }

                setSelectedBranch(result.job.branch);
                return result;
              });
            }}
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
                  || Boolean(deleteConfirmationAiDisabledReason)
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

            {deleteConfirmationAiDisabledReason ? (
              <div className="border theme-border-danger theme-surface-danger px-3 py-2 text-sm theme-text-danger">
                {deleteConfirmationAiDisabledReason}
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

      <DashboardNotificationStack notifications={notifications} onDismiss={dismissNotification} />

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

      {autoSyncSettingsOpen ? (
        <MatrixModal
          kicker="Auto sync"
          title="Configure document auto sync"
          description="Choose which remote the documents branch should pull from and push to while auto sync is enabled."
          closeLabel="Cancel"
          maxWidthClass="max-w-2xl"
          onClose={closeAutoSyncSettings}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={closeAutoSyncSettings}
              >
                Cancel
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => void reloadAutoSyncSettings()}
                disabled={autoSyncSettingsLoading}
              >
                Reload
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                onClick={() => void persistAutoSyncSettings()}
                disabled={autoSyncSettingsLoading}
              >
                Save auto sync
              </button>
            </>
          )}
        >
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs theme-text-muted">
              <MatrixBadge tone="neutral">Stored in config</MatrixBadge>
              <span className="font-mono theme-text-strong">{autoSyncSettings?.filePath ?? state?.configPath ?? "worktree.yml"}</span>
              <MatrixBadge tone="active">Remote {autoSyncDraftValues.remote}</MatrixBadge>
            </div>
            <label className="block space-y-2">
              <span className="text-xs uppercase tracking-[0.18em] theme-text-soft">Auto sync remote</span>
              <input
                value={autoSyncDraftValues.remote}
                onChange={(event) => setAutoSyncDraft({ remote: event.target.value })}
                placeholder="origin"
                className="matrix-input h-11 w-full rounded-none px-3 text-sm outline-none"
                autoFocus
              />
            </label>
            <div className="border theme-border-subtle p-3 text-sm theme-text-muted">
              Auto sync uses this remote when the documents branch runs its scheduled fetch, pull, and push cycle.
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
                <label className="flex items-center gap-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={aiCommandDraftValues.autoStartRuntime}
                    onChange={(event) => setAiCommandDrafts((current) => ({ ...current, autoStartRuntime: event.target.checked }))}
                    className="h-4 w-4"
                  />
                  <span className="text-sm theme-text-soft">
                    Auto-start worktree environment when running AI
                  </span>
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
