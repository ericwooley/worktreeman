import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { WorktreeRecord } from "@shared/types";
import { useDashboardState } from "../hooks/use-dashboard-state";
import { AmbientCanvasBackground, docsAmbientPalette } from "./ambient-canvas-background";
import { WorktreeCard } from "./worktree-card";
import { WorktreeDetail } from "./worktree-detail";

export function Dashboard() {
  const { state, error, loading, busyBranch, create, remove, start, stop, refresh } = useDashboardState();
  const [branch, setBranch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

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

  useEffect(() => {
    if (!selected?.branch || selected.branch === selectedBranch) {
      return;
    }

    setSelectedBranch(selected.branch);
  }, [selected?.branch, selectedBranch]);

  useEffect(() => {
    if (!sidebarOpen) {
      return;
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [sidebarOpen]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    await create(branch.trim());
    setBranch("");
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-0 pt-0 pb-3 text-[#d7ffd7] sm:pb-4 lg:pb-6">
      <AmbientCanvasBackground palette={docsAmbientPalette} />
      <div className="relative z-10 flex w-full flex-col gap-4">
        <header className="matrix-panel rounded-none border-x-0 p-4 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1 space-y-2">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 flex-1">
                  <h1 className="text-3xl font-semibold tracking-tight text-[#ecffec] sm:text-4xl">Worktree Manager</h1>
                  <p className="mt-2 text-sm leading-6 text-[#9cd99c] sm:text-base">
                    Terminal-first control surface for jumping between branch runtimes without losing the shell.
                  </p>
                </div>
                <div className="grid grid-cols-3 gap-2 self-start text-left sm:min-w-[18rem]">
                  <Metric label="Worktrees" value={String(state?.worktrees.length ?? 0)} />
                  <Metric label="Running" value={String((state?.worktrees ?? []).filter((entry) => entry.runtime).length)} />
                  <Metric label="Selected" value={selected?.branch ? "Live" : "None"} />
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-3 pt-12 xl:max-w-[44rem]">
              <form className="flex w-full flex-col gap-2 sm:flex-row" onSubmit={onSubmit}>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="feature/branch-name"
                  className="matrix-input h-11 flex-1 rounded-2xl px-4 text-sm outline-none"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="matrix-button h-11 flex-1 rounded-2xl px-4 text-sm font-semibold sm:flex-none"
                  >
                    Create
                  </button>
                  <button className="matrix-button h-11 rounded-2xl px-4 text-sm" onClick={() => void refresh()} type="button">
                    Refresh
                  </button>
                </div>
              </form>
              <p className="text-xs text-[#75bb75]">
                Pick a worktree and the terminal owns the full width. Open the sidebar when you need workspace and switchboard controls.
              </p>
            </div>
          </div>
        </header>

        <section className="min-w-0">
          <WorktreeDetail
            worktree={selected}
            isBusy={busyBranch === selected?.branch}
            onStart={() => selected ? void start(selected.branch) : undefined}
            onStop={() => selected ? void stop(selected.branch) : undefined}
            onDelete={() => selected ? void remove(selected.branch) : undefined}
          />
        </section>
      </div>

      <button
        type="button"
        aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
        className="matrix-button fixed right-0 top-0 z-30 flex h-10 w-10 items-center justify-center rounded-none p-0"
        onClick={() => setSidebarOpen((open) => !open)}
      >
        <span className="flex h-4 w-4 flex-col justify-between">
          <span className="block h-[2px] w-full bg-current" />
          <span className="block h-[2px] w-full bg-current" />
          <span className="block h-[2px] w-full bg-current" />
        </span>
      </button>

      <div className={`fixed inset-0 z-20 transition ${sidebarOpen ? "pointer-events-auto" : "pointer-events-none"}`}>
        <button
          type="button"
          aria-label="Close sidebar"
          className={`absolute inset-0 bg-[rgba(1,7,3,0.68)] backdrop-blur-sm transition-opacity ${sidebarOpen ? "opacity-100" : "opacity-0"}`}
          onClick={() => setSidebarOpen(false)}
        />

        <aside className={`absolute right-0 top-0 flex h-full w-full max-w-[28rem] flex-col gap-4 overflow-y-auto border-l border-[rgba(74,255,122,0.18)] bg-[rgba(2,7,3,0.94)] p-0 shadow-[-24px_0_64px_rgba(0,0,0,0.5)] transition-transform ${sidebarOpen ? "translate-x-0" : "translate-x-full"}`}>
          <div className="matrix-panel rounded-none border-x-0 border-t-0 p-4 sm:p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="matrix-kicker">Sidebar</p>
                <h2 className="text-xl font-semibold text-[#ecffec]">Workspace controls</h2>
                <p className="mt-2 text-sm text-[#9cd99c]">
                  Switch worktrees, inspect config, and jump back to the shell.
                </p>
              </div>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => setSidebarOpen(false)}
              >
                Close
              </button>
            </div>
          </div>

          <ConfigPanel repoRoot={state?.repoRoot} configPath={state?.configPath} worktrees={state?.worktrees ?? []} />

          <section className="matrix-panel rounded-none border-x-0 p-4">
            <div className="mb-4 flex items-center justify-between gap-3">
              <div>
                <p className="matrix-kicker">Switchboard</p>
                <h2 className="text-lg font-semibold text-[#ecffec]">Worktrees</h2>
                <p className="text-sm text-[#9cd99c]">Choose the shell you want to focus.</p>
              </div>
            </div>

            {loading ? <p className="text-sm text-[#9cd99c]">Loading worktrees...</p> : null}
            {error ? <p className="rounded-2xl border border-[rgba(255,109,109,0.22)] bg-[rgba(76,10,10,0.55)] px-4 py-3 text-sm text-[#ffb4b4]">{error}</p> : null}

            <div className="grid gap-3">
              {state?.worktrees.map((worktree) => (
                <WorktreeCard
                  key={worktree.worktreePath}
                  worktree={worktree}
                  isSelected={selected?.branch === worktree.branch}
                  onSelect={() => {
                    setSelectedBranch(worktree.branch);
                    setSidebarOpen(false);
                  }}
                />
              ))}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}

function ConfigPanel({
  repoRoot,
  configPath,
  worktrees,
}: {
  repoRoot?: string;
  configPath?: string;
  worktrees: WorktreeRecord[];
}) {
  const runningCount = worktrees.filter((entry) => entry.runtime).length;

  return (
    <section className="matrix-panel rounded-none border-x-0 p-4 text-white">
      <p className="matrix-kicker">Workspace</p>
      <div className="mt-3 space-y-3 text-sm text-[#9cd99c]">
        <div>
          <p className="text-[#6cb96c]">Repository root</p>
          <p className="break-all font-mono text-xs text-[#b9ffb9]">{repoRoot ?? "Loading..."}</p>
        </div>
        <div>
          <p className="text-[#6cb96c]">Config path</p>
          <p className="break-all font-mono text-xs text-[#b9ffb9]">{configPath ?? "Loading..."}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Metric label="Worktrees" value={String(worktrees.length)} />
          <Metric label="Running" value={String(runningCount)} />
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-none border border-white/10 bg-white/5 px-3 py-2.5">
      <p className="text-[0.65rem] uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#ecffec] sm:text-xl">{value}</p>
    </div>
  );
}
