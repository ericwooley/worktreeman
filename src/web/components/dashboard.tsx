import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { CommandPalette, DEFAULT_COMMAND_PALETTE_SHORTCUT, formatShortcutLabel, shortcutFromKeyboardEvent, type CommandPaletteItem } from "./command-palette";
import { useDashboardState } from "../hooks/use-dashboard-state";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixModal } from "./matrix-primitives";
import { WorktreeDetail } from "./worktree-detail";

const CREATE_WORKTREE_OPTION_VALUE = "__create_worktree__";
const COMMAND_PALETTE_SHORTCUT_STORAGE_KEY = "worktreemanager.commandPaletteShortcut";

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
    subscribeToBackgroundLogs,
    refresh,
  } = useDashboardState();
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialParams.get("env"));
  const [activeTab, setActiveTab] = useState<"shell" | "background" | "git">(
    initialParams.get("tab") === "git"
      ? "git"
      : initialParams.get("tab") === "background"
        ? "background"
        : "shell",
  );
  const [isTerminalVisible, setIsTerminalVisible] = useState(initialParams.get("terminal") === "open");
  const [deleteConfirmBranch, setDeleteConfirmBranch] = useState<string | null>(null);
  const [createWorktreeModalOpen, setCreateWorktreeModalOpen] = useState(false);
  const [branch, setBranch] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const lastFocusedElementRef = useRef<HTMLElement | null>(null);
  const [commandPaletteShortcut, setCommandPaletteShortcut] = useState(() => {
    if (typeof window === "undefined") {
      return DEFAULT_COMMAND_PALETTE_SHORTCUT;
    }

    return window.localStorage.getItem(COMMAND_PALETTE_SHORTCUT_STORAGE_KEY) ?? DEFAULT_COMMAND_PALETTE_SHORTCUT;
  });

  const openCommandPalette = useCallback(() => {
    if (typeof document !== "undefined" && document.activeElement instanceof HTMLElement) {
      lastFocusedElementRef.current = document.activeElement;
    }

    setCommandPaletteOpen(true);
  }, []);

  const closeCommandPalette = useCallback((options?: { restoreFocus?: boolean }) => {
    setCommandPaletteOpen(false);

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
    window.localStorage.setItem(COMMAND_PALETTE_SHORTCUT_STORAGE_KEY, commandPaletteShortcut);
  }, [commandPaletteShortcut]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const tagName = (event.target as HTMLElement | null)?.tagName;
      const isTypingContext = Boolean(
        (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable='true']")
        || tagName === "INPUT"
        || tagName === "TEXTAREA"
        || tagName === "SELECT",
      );

      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut || shortcut !== commandPaletteShortcut) {
        return;
      }

      if (isTypingContext && !commandPaletteOpen) {
        return;
      }

        event.preventDefault();
        if (commandPaletteOpen) {
          closeCommandPalette({ restoreFocus: true });
        } else {
          openCommandPalette();
        }
      };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [closeCommandPalette, commandPaletteOpen, commandPaletteShortcut, openCommandPalette]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (selectedBranch) {
      params.set("env", selectedBranch);
    } else {
      params.delete("env");
    }

    params.set("tab", activeTab);

    if (isTerminalVisible) {
      params.set("terminal", "open");
    } else {
      params.delete("terminal");
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, [activeTab, isTerminalVisible, selectedBranch]);

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

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
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
        action: () => setActiveTab("shell"),
      },
      {
        id: "nav-background",
        code: "nb",
        title: "Open Background commands tab",
        subtitle: "Inspect long-running runtime and PM2 commands.",
        group: "Navigation",
        keywords: ["pm2", "logs", "background", "processes"],
        badgeLabel: activeTab === "background" ? "Active" : undefined,
        badgeTone: "active",
        action: () => setActiveTab("background"),
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
        action: () => setActiveTab("git"),
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
          subtitle: "Bring up docker/runtime services for the selected worktree.",
          group: "Worktree",
          keywords: [selected.branch, "start", "runtime", "docker"],
          disabled: Boolean(selected.runtime) || busyBranch === selected.branch,
          badgeLabel: selected.runtime ? "Running" : "Idle",
          badgeTone: selected.runtime ? "active" : "idle",
          action: () => void start(selected.branch),
        },
        {
          id: `worktree-stop-${selected.branch}`,
          code: "wsp",
          title: `Stop worktree runtime: ${selected.branch}`,
          subtitle: "Stop docker/runtime services for the selected worktree.",
          group: "Worktree",
          keywords: [selected.branch, "stop", "runtime", "docker"],
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

    for (const entry of state?.worktrees ?? []) {
      items.push({
        id: `switch-${entry.branch}`,
        code: getWorktreeCommandCode(entry.branch),
        title: `Switch to worktree: ${entry.branch}`,
        subtitle: entry.runtime ? "Runtime active" : "Idle",
        group: "Worktree",
        keywords: [entry.branch, entry.worktreePath, entry.runtime ? "active" : "idle"],
        badgeLabel: entry.runtime ? "Active" : undefined,
        badgeTone: "active",
        action: () => setSelectedBranch(entry.branch),
      });
    }

    return items.sort(comparePaletteItems);
  }, [activeTab, busyBranch, commandPaletteShortcut, isTerminalVisible, refresh, selected, start, state?.worktrees, stop, syncEnv]);

  return (
    <main
      className="relative min-h-screen overflow-hidden px-0 pt-0 text-[#d7ffd7]"
      style={{ paddingBottom: "calc(var(--terminal-drawer-stowed-height) + var(--terminal-drawer-page-gap))" }}
    >
      <div className="relative z-10 flex w-full flex-col gap-3">
        <header className="matrix-panel relative z-30 rounded-none border-x-0 p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-semibold tracking-tight text-[#ecffec] sm:text-3xl">Worktree Manager</h1>
                  <p className="mt-1 text-sm leading-5 text-[#9cd99c] sm:text-base">
                    Terminal-first control surface for jumping between branch runtimes without losing the shell.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-2 pt-12 xl:max-w-[32rem] xl:items-end">
              <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[26rem] xl:grid-cols-[minmax(16rem,1fr)_auto]">
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
                <button className="matrix-button h-full min-h-[100%] rounded-none px-3 py-2 text-sm" onClick={() => void refresh()} type="button">
                  Refresh
                </button>
              </div>
              <div className="flex items-center gap-2 text-xs text-[#8fd18f]">
                <MatrixBadge tone="neutral">Command palette</MatrixBadge>
                <span className="font-mono text-[#ecffec]">{formatShortcutLabel(commandPaletteShortcut)}</span>
              </div>
            </div>
          </div>
        </header>

        <section className="relative z-10 min-w-0">
          {shutdownStatus?.active || shutdownStatus?.completed || shutdownStatus?.failed ? (
            <div className="matrix-panel mb-4 rounded-none border-x-0 border-[rgba(255,196,87,0.24)] bg-[rgba(27,16,1,0.9)] p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="matrix-kicker text-[#ffcf76]">Server shutdown</p>
                  <h2 className="mt-2 text-lg font-semibold text-[#fff3d6]">
                    {shutdownStatus.active
                      ? "Server is shutting down"
                      : shutdownStatus.failed
                        ? "Shutdown failed"
                        : "Shutdown complete"}
                  </h2>
                  <p className="mt-2 text-sm text-[#ffd892]">
                    {shutdownStatus.active
                      ? "The server is cleaning up runtimes and active connections."
                      : "These are the latest shutdown logs reported by the server."}
                  </p>
                </div>
                <div className="border border-[rgba(255,207,118,0.24)] bg-[rgba(0,0,0,0.24)] px-3 py-1 font-mono text-xs text-[#ffe1a8]">
                  {shutdownStatus.logs.length} log{shutdownStatus.logs.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="mt-4 max-h-[16rem] overflow-auto border border-[rgba(255,207,118,0.18)] bg-[rgba(0,0,0,0.32)]">
                {shutdownStatus.logs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`border-b px-4 py-2 font-mono text-xs last:border-b-0 ${entry.level === "error"
                      ? "border-[rgba(255,120,120,0.16)] text-[#ffb4b4]"
                      : "border-[rgba(255,207,118,0.12)] text-[#ffe1a8]"}`}
                  >
                    <span className="mr-3 text-[rgba(255,225,168,0.6)]">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
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
            isBusy={busyBranch === selected?.branch}
            onStart={() => selected ? void start(selected.branch) : undefined}
            onStop={() => selected ? void stop(selected.branch) : undefined}
            onSyncEnv={() => selected ? void syncEnv(selected.branch) : undefined}
            onDelete={() => setDeleteConfirmBranch(selected?.branch ?? null)}
            backgroundCommands={backgroundCommands}
            backgroundLogs={backgroundLogs}
            onLoadBackgroundCommands={loadBackgroundCommands}
            onStartBackgroundCommand={startBackgroundCommand}
            onStopBackgroundCommand={stopBackgroundCommand}
            onLoadBackgroundLogs={loadBackgroundLogs}
            onSubscribeToBackgroundLogs={subscribeToBackgroundLogs}
            onClearBackgroundLogs={clearBackgroundLogs}
          />
        </section>
      </div>

      {deleteConfirmBranch ? (
        <MatrixModal
          kicker="Confirm delete"
          title={<>Delete worktree `{deleteConfirmBranch}`?</>}
          description="This removes the worktree, stops any running worktree runtime for it, and clears its persisted tmux session."
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
          <div className="border border-[rgba(255,109,109,0.18)] bg-[rgba(0,0,0,0.28)] p-3 font-mono text-sm text-[#ffd0d0]">
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
              <span className="mb-2 block text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Branch name</span>
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
          <div className="border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] p-3">
            {lastEnvSync.copiedFiles.length > 0 ? (
              <div className="max-h-[50vh] overflow-auto font-mono text-sm text-[#d7ffd7]">
                {lastEnvSync.copiedFiles.map((filePath) => (
                  <div key={filePath} className="border-b border-[rgba(74,255,122,0.08)] py-2 last:border-b-0">
                    {filePath}
                  </div>
                ))}
              </div>
            ) : (
              <p className="font-mono text-sm text-[#7fe19e]">No matching `.env*` files found.</p>
            )}
          </div>
        </MatrixModal>
      ) : null}

      <CommandPalette
        open={commandPaletteOpen}
        commands={commandPaletteItems}
        shortcut={commandPaletteShortcut}
        onClose={closeCommandPalette}
        onShortcutChange={setCommandPaletteShortcut}
        onShortcutReset={() => setCommandPaletteShortcut(DEFAULT_COMMAND_PALETTE_SHORTCUT)}
      />
    </main>
  );
}
