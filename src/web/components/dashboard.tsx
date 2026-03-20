import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
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
import { WorktreeDetail } from "./worktree-detail";

const CREATE_WORKTREE_OPTION_VALUE = "__create_worktree__";
const COMMAND_PALETTE_SHORTCUT_STORAGE_KEY = "worktreemanager.commandPaletteShortcut";
const TERMINAL_SHORTCUT_STORAGE_KEY = "worktreemanager.terminalShortcut";
const LEGACY_COMMAND_PALETTE_SHORTCUTS = new Set(["Shift+Space", "Meta+P"]);
const DEFAULT_TERMINAL_SHORTCUT = "Ctrl+Shift+;";
type CommandPaletteScope = "main" | "worktree-select" | "theme-select";

function normalizeCommandPaletteShortcut(shortcut: string | null): string {
  if (!shortcut || LEGACY_COMMAND_PALETTE_SHORTCUTS.has(shortcut)) {
    return DEFAULT_COMMAND_PALETTE_SHORTCUT;
  }

  return shortcut;
}

function normalizeTerminalShortcut(shortcut: string | null): string {
  if (!shortcut) {
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
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
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
    clearLastEnvSync,
    clearBackgroundLogs,
    create,
    remove,
    start,
    stop,
    syncEnv,
    loadBackgroundCommands,
    startBackgroundCommand,
    stopBackgroundCommand,
    loadBackgroundLogs,
    loadGitComparison,
    subscribeToBackgroundLogs,
    refresh,
  } = useDashboardState();
  const { theme, themes, setThemeId } = useTheme();
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialParams.get("env"));
  const [activeTab, setActiveTab] = useState<"shell" | "background" | "git">(
    initialParams.get("tab") === "git"
      ? "git"
      : initialParams.get("tab") === "background"
        ? "background"
        : "shell",
  );
  const [gitView, setGitView] = useState<"graph" | "diff">(initialParams.get("git") === "diff" ? "diff" : "graph");
  const [isTerminalVisible, setIsTerminalVisible] = useState(initialParams.get("terminal") === "open");
  const [deleteConfirmBranch, setDeleteConfirmBranch] = useState<string | null>(null);
  const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteScope, setCommandPaletteScope] = useState<CommandPaletteScope>("main");
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalFocusedElementRef = useRef<HTMLElement | null>(null);
  const lastTerminalShortcutAtRef = useRef(0);
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

  const openCommandPalette = useCallback((scope: CommandPaletteScope = "main") => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      lastFocusedElementRef.current = document.activeElement;
    }

    setCommandPaletteScope(scope);
    setCommandPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setCommandPaletteOpen(false);
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

  const selected = useMemo(
    () => {
      if (!state?.worktrees.length) {
        return null;
      }

      return state.worktrees.find((entry) => entry.branch === selectedBranch)
        ?? state.worktrees.find((entry) => entry.runtime)
        ?? state.worktrees[0]
        ?? null;
    },
    [selectedBranch, state?.worktrees],
  );

  const worktreeOptions = useMemo<MatrixDropdownOption[]>(
    () => [
      ...((state?.worktrees ?? []).map((entry): MatrixDropdownOption => ({
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
    [state?.worktrees],
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
    params.set("git", gitView);

    if (isTerminalVisible) {
      params.set("terminal", "open");
    } else {
      params.delete("terminal");
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, [activeTab, gitView, isTerminalVisible, selectedBranch]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    const nextBranch = branch.trim();
    await create(nextBranch);
    setSelectedBranch(nextBranch);
    setBranch("");
    setCreateWorktreeModalOpen(false);
  };

  const confirmDelete = async () => {
    if (!deleteConfirmBranch) {
      return;
    }

    await remove(deleteConfirmBranch);
    setDeleteConfirmBranch(null);
  };

  const navigateToTab = (tab: "shell" | "background" | "git") => {
    setActiveTab(tab);
    if (tab !== "shell") {
      setIsTerminalVisible(false);
    }
  };

  const mainCommandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [
      {
        id: "nav-shell",
        code: "ns",
        title: "Open Shell tab",
        subtitle: "Jump to the terminal-focused shell view.",
        group: "Navigation",
        keywords: ["terminal", "shell", "tab"],
        badgeLabel: activeTab === "shell" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("shell"),
      },
      {
        id: "nav-background",
        code: "nb",
        title: "Open Background commands tab",
        subtitle: "Inspect long-running background commands and their logs.",
        group: "Navigation",
        keywords: ["pm2", "logs", "background", "processes"],
        badgeLabel: activeTab === "background" ? "Active" : undefined,
        badgeTone: "active",
        action: () => navigateToTab("background"),
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
        id: "refresh-state",
        code: "wr",
        title: "Refresh worktree state",
        subtitle: "Reload worktrees, runtimes, and current UI state.",
        group: "Worktree",
        keywords: ["reload", "refresh", "state"],
        action: () => void refresh(),
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
          subtitle: "Open a confirmation modal before deleting the worktree.",
          group: "Worktree",
          keywords: [selected.branch, "delete", "remove"],
          badgeLabel: "Danger",
          badgeTone: "danger",
          disabled: busyBranch === selected.branch,
          action: () => setDeleteConfirmBranch(selected.branch),
        },
      );
    }

    return items.sort(comparePaletteItems);
  }, [activeTab, busyBranch, commandPaletteShortcut, isTerminalVisible, refresh, selected, start, state?.worktrees, stop, syncEnv, theme]);

  const worktreeSelectionPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    return (state?.worktrees ?? []).map((entry, index) => ({
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
  }, [state?.worktrees]);

  const themeSelectionPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    return themes.map((entry, index) => ({
      id: `select-theme-${entry.id}`,
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
                  <h1 className="text-2xl font-semibold tracking-tight theme-text-strong sm:text-3xl">Worktree Manager</h1>
                  <p className="mt-1 text-sm leading-5 theme-text-muted sm:text-base">
                    Terminal-first control surface for jumping between branch runtimes without losing the shell.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-2 pt-12 xl:max-w-[40rem] xl:items-end">
              <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[34rem] xl:grid-cols-[minmax(14rem,1fr)_minmax(14rem,1fr)_auto]">
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
                <button className="matrix-button h-full min-h-[100%] rounded-none px-3 py-2 text-sm" onClick={() => void refresh()} type="button">
                  Refresh
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
            worktree={selected}
            worktreeOptions={worktreeOptions}
            worktreeCount={state?.worktrees.length ?? 0}
            runningCount={(state?.worktrees ?? []).filter((entry) => entry.runtime).length}
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
            onDelete={() => setDeleteConfirmBranch(selected?.branch ?? null)}
            backgroundCommands={backgroundCommands}
            backgroundLogs={backgroundLogs}
            gitComparison={gitComparison}
            gitComparisonLoading={gitComparisonLoading}
            onLoadBackgroundCommands={loadBackgroundCommands}
            onStartBackgroundCommand={startBackgroundCommand}
            onStopBackgroundCommand={stopBackgroundCommand}
            onLoadBackgroundLogs={loadBackgroundLogs}
            onLoadGitComparison={loadGitComparison}
            onSubscribeToBackgroundLogs={subscribeToBackgroundLogs}
            onClearBackgroundLogs={clearBackgroundLogs}
          />
        </section>
      </div>

      {deleteConfirmBranch ? (
        <MatrixModal
          kicker="Confirm delete"
          title={<>Delete worktree `{deleteConfirmBranch}`?</>}
          description="This removes the worktree, stops any running background commands for it, and clears its persisted tmux session."
          tone="danger"
          closeLabel="Cancel"
          maxWidthClass="max-w-xl"
          onClose={() => setDeleteConfirmBranch(null)}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => setDeleteConfirmBranch(null)}
              >
                Keep worktree
              </button>
              <button
                type="button"
                className="matrix-button matrix-button-danger rounded-none px-3 py-2 text-sm"
                onClick={() => void confirmDelete()}
              >
                Delete worktree
              </button>
            </>
          )}
        >
          <div className="border theme-inline-panel-danger p-3 font-mono text-sm theme-text-danger">
            This action cannot be undone from the UI.
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
          }}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => {
                  setCreateWorktreeModalOpen(false);
                  setBranch("");
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

      <CommandPalette
        open={commandPaletteOpen}
        commands={paletteCommands}
        shortcut={commandPaletteShortcut}
        onClose={closeCommandPalette}
        onShortcutChange={setCommandPaletteShortcut}
        onShortcutReset={() => setCommandPaletteShortcut(DEFAULT_COMMAND_PALETTE_SHORTCUT)}
        shortcutSettings={shortcutSettings}
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
