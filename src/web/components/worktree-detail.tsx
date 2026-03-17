import { useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeRecord } from "@shared/types";
import { WorktreeTerminal } from "./worktree-terminal";

interface WorktreeDetailProps {
  worktree: WorktreeRecord | null;
  worktrees: WorktreeRecord[];
  onSelectWorktree: (branch: string) => void;
  worktreeCount: number;
  runningCount: number;
  selectedStatusLabel: string;
  activeTab: "shell" | "git";
  onTabChange: (tab: "shell" | "git") => void;
  isTerminalVisible: boolean;
  onTerminalVisibilityChange: (visible: boolean) => void;
  isBusy: boolean;
  onStart: () => void;
  onStop: () => void;
  onSyncEnv: () => void;
  onDelete: () => void;
}

export function WorktreeDetail({
  worktree,
  worktrees,
  onSelectWorktree,
  worktreeCount,
  runningCount,
  selectedStatusLabel,
  activeTab,
  onTabChange,
  isTerminalVisible,
  onTerminalVisibilityChange,
  isBusy,
  onStart,
  onStop,
  onSyncEnv,
  onDelete,
}: WorktreeDetailProps) {
  const isRunning = Boolean(worktree?.runtime);
  const [copied, setCopied] = useState(false);
  const [worktreeMenuOpen, setWorktreeMenuOpen] = useState(false);
  const worktreeMenuRef = useRef<HTMLDivElement | null>(null);
  const quickLinks = worktree?.runtime ? Object.entries(worktree.runtime.quickLinks ?? {}) : [];
  const selectedWorktree = useMemo(
    () => worktrees.find((entry) => entry.branch === worktree?.branch) ?? null,
    [worktree?.branch, worktrees],
  );
  const attachCommand = worktree?.runtime
    ? `tmux attach-session -t '${worktree.runtime.tmuxSession.replace(/'/g, `'\\''`)}'`
    : null;

  useEffect(() => {
    if (!worktreeMenuOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!worktreeMenuRef.current?.contains(event.target as Node)) {
        setWorktreeMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorktreeMenuOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [worktreeMenuOpen]);

  const copyAttachCommand = async () => {
    if (!attachCommand) {
      return;
    }

    await navigator.clipboard.writeText(attachCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="min-w-0 space-y-4 xl:flex xl:min-h-[calc(100vh-2rem)] xl:flex-col xl:space-y-4">
      <div className="matrix-panel rounded-none border-x-0 p-4 sm:p-5">
        <div className="flex items-center gap-2 border-b border-[rgba(74,255,122,0.14)] pb-4">
          <button
            type="button"
            className={`px-4 py-2 text-sm uppercase tracking-[0.18em] transition-colors ${
              activeTab === "shell"
                ? "border border-[rgba(74,255,122,0.2)] bg-[rgba(9,30,12,0.72)] text-[#ecffec]"
                : "border border-transparent bg-[rgba(0,0,0,0.18)] text-[#75bb75] hover:border-[rgba(74,255,122,0.12)] hover:text-[#b9ffb9]"
            }`}
            onClick={() => onTabChange("shell")}
          >
            Shell
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm uppercase tracking-[0.18em] transition-colors ${
              activeTab === "git"
                ? "border border-[rgba(74,255,122,0.2)] bg-[rgba(9,30,12,0.72)] text-[#ecffec]"
                : "border border-transparent bg-[rgba(0,0,0,0.18)] text-[#75bb75] hover:border-[rgba(74,255,122,0.12)] hover:text-[#b9ffb9]"
            }`}
            onClick={() => onTabChange("git")}
          >
            Git status
          </button>
        </div>

        {activeTab === "shell" ? (
          <>
            <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 flex-1">
                <p className="matrix-kicker">Terminal focus</p>
                <h2 className="mt-1 text-2xl font-semibold text-[#ecffec] sm:text-3xl">
                  {worktree?.branch ?? "Select a worktree"}
                </h2>
                <p className="mt-1 text-sm text-[#9cd99c]">
                  {worktree
                    ? "The shell is the primary surface. Runtime details stay visible, but the terminal owns the layout."
                    : "Choose a worktree from the side rail to open its terminal session."}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-2 xl:max-w-[52rem] xl:items-end">
                <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[34rem] xl:grid-cols-[minmax(14rem,1.2fr)_repeat(3,minmax(0,1fr))]">
                  <div ref={worktreeMenuRef} className="relative">
                    <button
                      type="button"
                      className="flex h-full min-h-[100%] w-full items-center justify-between gap-3 border border-[rgba(74,255,122,0.12)] bg-[linear-gradient(180deg,rgba(8,28,12,0.9),rgba(0,0,0,0.72))] px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(181,255,196,0.04)] transition-colors duration-150 hover:border-[rgba(74,255,122,0.32)] hover:bg-[linear-gradient(180deg,rgba(10,34,14,0.94),rgba(1,10,3,0.82))]"
                      aria-haspopup="listbox"
                      aria-expanded={worktreeMenuOpen}
                      onClick={() => setWorktreeMenuOpen((open) => !open)}
                    >
                      <div className="min-w-0">
                        <p className="text-[0.6rem] uppercase tracking-[0.18em] text-[#6cb96c]">Environment</p>
                        <div className="mt-1 flex items-center gap-2">
                          <span className="truncate font-mono text-sm text-[#ecffec]">
                            {selectedWorktree?.branch ?? "Select worktree"}
                          </span>
                          {selectedWorktree?.runtime ? (
                            <span className="border border-[rgba(74,255,122,0.16)] bg-[rgba(7,24,10,0.76)] px-1.5 py-0.5 text-[10px] uppercase tracking-[0.14em] text-[#7fe19e]">
                              Active
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <span className={`font-mono text-sm text-[#7fe19e] transition-transform duration-150 ${worktreeMenuOpen ? "rotate-180" : ""}`}>
                        v
                      </span>
                    </button>

                    {worktreeMenuOpen ? (
                      <div
                        className="absolute left-0 right-0 z-20 mt-2 max-h-[18rem] overflow-auto border border-[rgba(74,255,122,0.18)] bg-[rgba(2,10,4,0.96)] shadow-[0_18px_48px_rgba(0,0,0,0.5)] backdrop-blur-md"
                        role="listbox"
                        aria-label="Worktree selector"
                      >
                        {worktrees.map((entry) => {
                          const isSelected = entry.branch === worktree?.branch;

                          return (
                            <button
                              key={entry.worktreePath}
                              type="button"
                              className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left transition-colors duration-150 last:border-b-0 ${isSelected
                                ? "border-[rgba(74,255,122,0.16)] bg-[rgba(9,30,12,0.74)] text-[#ecffec]"
                                : "border-[rgba(74,255,122,0.08)] text-[#b9ffb9] hover:bg-[rgba(9,30,12,0.58)] hover:text-[#ecffec]"}`}
                              role="option"
                              aria-selected={isSelected}
                              onClick={() => {
                                onSelectWorktree(entry.branch);
                                setWorktreeMenuOpen(false);
                              }}
                            >
                              <div className="min-w-0">
                                <p className="truncate font-mono text-sm">{entry.branch}</p>
                                <p className="mt-1 truncate text-[10px] uppercase tracking-[0.16em] text-[#6cb96c]">
                                  {entry.runtime ? "Runtime active" : "Idle"}
                                </p>
                              </div>
                              <span className={`border px-2 py-0.5 text-[10px] uppercase tracking-[0.16em] ${entry.runtime
                                ? "border-[rgba(74,255,122,0.16)] bg-[rgba(7,24,10,0.76)] text-[#7fe19e]"
                                : "border-[rgba(74,255,122,0.1)] bg-[rgba(0,0,0,0.2)] text-[#75bb75]"}`}>
                                {entry.runtime ? "Active" : "Idle"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                  <Metric label="Worktrees" value={String(worktreeCount)} />
                  <Metric label="Running" value={String(runningCount)} />
                  <Metric label="Selected" value={selectedStatusLabel} />
                </div>
                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <div className="border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] px-3 py-1 font-mono text-xs text-[#b9ffb9]">
                    {worktree?.runtime ? "tmux attached" : "idle"}
                  </div>
                  {worktree?.runtime?.dockerStartedAt ? (
                    <div className="border border-[rgba(74,255,122,0.12)] bg-[rgba(7,24,10,0.7)] px-3 py-1 font-mono text-xs text-[#7fe19e]">
                      live since {new Date(worktree.runtime.dockerStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  ) : null}
                  {worktree ? (
                    <>
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-1.5 text-sm"
                        disabled={isBusy || isRunning}
                        onClick={onStart}
                      >
                        Start env
                      </button>
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-1.5 text-sm"
                        disabled={isBusy || !isRunning}
                        onClick={onStop}
                      >
                        Stop env
                      </button>
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-1.5 text-sm"
                        disabled={isBusy}
                        onClick={onSyncEnv}
                      >
                        Sync .env
                      </button>
                      <button
                        type="button"
                        className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-sm"
                        disabled={isBusy}
                        onClick={onDelete}
                      >
                        Delete
                      </button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
              <DetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
              <DetailField label="Head" value={worktree?.headSha ?? "-"} mono />
              <DetailField label="Compose project" value={worktree?.runtime?.composeProject ?? "-"} mono />
              <DetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
            </div>

            <div className="mt-4 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Quick links</p>
                <span className="text-xs text-[#7fe19e]">{quickLinks.length}</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {quickLinks.length ? quickLinks.map(([label, href]) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="matrix-command rounded-none px-4 py-3 text-sm text-[#d7ffd7] transition-colors duration-150 hover:border-[rgba(74,255,122,0.24)] hover:text-[#4aff7a]"
                  >
                    <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
                    <p className="mt-2 break-all font-mono text-xs">{href}</p>
                  </a>
                )) : (
                  <div className="matrix-command rounded-none px-4 py-3 text-xs text-[#8fd18f] sm:col-span-2 xl:col-span-3">
                    Quick links appear here after the runtime resolves its ports.
                  </div>
                )}
              </div>
            </div>

            {attachCommand ? (
              <div className="mt-3 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Attach command</p>
                    <p className="mt-2 break-all font-mono text-sm text-[#d7ffd7]">{attachCommand}</p>
                  </div>
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    onClick={() => void copyAttachCommand()}
                  >
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="mt-4 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-4">
            <p className="matrix-kicker">Git status</p>
            <h2 className="mt-2 text-2xl font-semibold text-[#ecffec] sm:text-3xl">Planned</h2>
            <p className="mt-2 text-sm text-[#9cd99c]">
              This section is a todo placeholder for the richer git workflow ideas you want to add next.
            </p>
            <div className="mt-4 matrix-command rounded-none px-4 py-3 text-sm text-[#8fd18f]">
              TODO: build out git status, actions, review flow, and branch insights here.
            </div>
          </div>
        )}
      </div>

      {activeTab === "shell" ? (
        <div className="min-w-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
          <WorktreeTerminal
            worktree={worktree}
            isTerminalVisible={isTerminalVisible}
            onTerminalVisibilityChange={onTerminalVisibilityChange}
          />
        </div>
      ) : null}
    </section>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="matrix-command rounded-none px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className={`mt-2 break-all text-sm text-[#ecffec] ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.18)] px-3 py-2">
      <p className="text-[0.6rem] uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className="mt-1 text-base font-semibold text-[#ecffec]">{value}</p>
    </div>
  );
}
