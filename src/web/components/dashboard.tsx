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

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    await create(branch.trim());
    setBranch("");
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-3 py-3 text-[#d7ffd7] sm:px-4 sm:py-4 lg:px-6 lg:py-6">
      <AmbientCanvasBackground palette={docsAmbientPalette} />
      <div className="relative z-10 mx-auto flex max-w-[1500px] flex-col gap-4">
        <header className="matrix-panel rounded-[1.8rem] p-4 sm:p-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
            <div className="max-w-3xl space-y-2">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <h1 className="text-3xl font-semibold tracking-tight text-[#ecffec] sm:text-4xl">Worktree Manager</h1>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-[#9cd99c] sm:text-base">
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

            <div className="flex w-full max-w-2xl flex-col gap-3">
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
                Pick a worktree and the terminal takes over the main stage. Management stays docked to the side.
              </p>
            </div>
          </div>
        </header>

        <section className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 order-1 xl:order-none">
            <WorktreeDetail worktree={selected} />
          </div>

          <aside className="order-2 min-w-0 space-y-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-hidden">
            <ConfigPanel repoRoot={state?.repoRoot} configPath={state?.configPath} worktrees={state?.worktrees ?? []} />

            <section className="matrix-panel rounded-[1.8rem] p-4 xl:flex xl:max-h-[calc(100vh-17rem)] xl:flex-col">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <p className="matrix-kicker">Switchboard</p>
                  <h2 className="text-lg font-semibold text-[#ecffec]">Active worktrees</h2>
                  <p className="text-sm text-[#9cd99c]">Start, stop, and jump between shells.</p>
                </div>
              </div>

              {loading ? <p className="text-sm text-[#9cd99c]">Loading worktrees...</p> : null}
              {error ? <p className="rounded-2xl border border-[rgba(255,109,109,0.22)] bg-[rgba(76,10,10,0.55)] px-4 py-3 text-sm text-[#ffb4b4]">{error}</p> : null}

              <div className="grid gap-3 xl:min-h-0 xl:flex-1 xl:overflow-y-auto xl:pr-1">
                {state?.worktrees.map((worktree) => (
                  <WorktreeCard
                    key={worktree.worktreePath}
                    worktree={worktree}
                    isBusy={busyBranch === worktree.branch}
                    isSelected={selected?.branch === worktree.branch}
                    onSelect={() => setSelectedBranch(worktree.branch)}
                    onStart={() => void start(worktree.branch)}
                    onStop={() => void stop(worktree.branch)}
                    onDelete={() => void remove(worktree.branch)}
                  />
                ))}
              </div>
            </section>
          </aside>
        </section>
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
    <section className="matrix-panel rounded-[1.8rem] p-4 text-white">
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
    <div className="rounded-[1.1rem] border border-white/10 bg-white/5 px-3 py-2.5">
      <p className="text-[0.65rem] uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#ecffec] sm:text-xl">{value}</p>
    </div>
  );
}
