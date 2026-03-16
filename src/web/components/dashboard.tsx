import { useMemo, useState, type FormEvent } from "react";
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
    () => state?.worktrees.find((entry) => entry.branch === selectedBranch) ?? null,
    [selectedBranch, state?.worktrees],
  );

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    await create(branch.trim());
    setBranch("");
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-4 py-6 text-[#d7ffd7] sm:px-6 lg:px-8">
      <AmbientCanvasBackground palette={docsAmbientPalette} />
      <div className="relative z-10 mx-auto flex max-w-7xl flex-col gap-6">
        <header className="matrix-panel rounded-[2rem] p-6">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <h1 className="text-4xl font-semibold tracking-tight text-[#ecffec] sm:text-5xl">Worktree Manager</h1>
              <p className="max-w-2xl text-sm leading-6 text-[#9cd99c] sm:text-base">
                Spin up isolated git worktrees, boot branch-scoped Docker Compose stacks, and jump into tmux-backed terminals with runtime env injected in memory.
              </p>
            </div>

            <div className="flex w-full max-w-xl flex-col gap-3">
              <form className="flex w-full flex-col gap-3 sm:flex-row" onSubmit={onSubmit}>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="feature/branch-name"
                  className="matrix-input h-12 flex-1 rounded-2xl px-4 text-sm outline-none"
                />
                <button
                  type="submit"
                  className="matrix-button h-12 rounded-2xl px-5 text-sm font-semibold"
                >
                  Create worktree
                </button>
              </form>
            </div>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="matrix-panel rounded-[2rem] p-5">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold text-[#ecffec]">Active worktrees</h2>
                <p className="text-sm text-[#9cd99c]">Discover, boot, and remove branches from one view.</p>
              </div>
              <button className="matrix-button rounded-full px-3 py-2 text-sm" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>

            {loading ? <p className="text-sm text-[#9cd99c]">Loading worktrees...</p> : null}
            {error ? <p className="rounded-2xl border border-[rgba(255,109,109,0.22)] bg-[rgba(76,10,10,0.55)] px-4 py-3 text-sm text-[#ffb4b4]">{error}</p> : null}

            <div className="grid gap-4">
              {state?.worktrees.map((worktree) => (
                <WorktreeCard
                  key={worktree.worktreePath}
                  worktree={worktree}
                  isBusy={busyBranch === worktree.branch}
                  isSelected={selectedBranch === worktree.branch}
                  onSelect={() => setSelectedBranch(worktree.branch)}
                  onStart={() => void start(worktree.branch)}
                  onStop={() => void stop(worktree.branch)}
                  onDelete={() => void remove(worktree.branch)}
                />
              ))}
            </div>
          </div>

          <aside className="min-w-0 space-y-6">
            <ConfigPanel repoRoot={state?.repoRoot} configPath={state?.configPath} worktrees={state?.worktrees ?? []} />
            <WorktreeDetail worktree={selected} />
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
    <section className="matrix-panel rounded-[2rem] p-5 text-white">
      <p className="matrix-kicker">Workspace</p>
      <div className="mt-4 space-y-4 text-sm text-[#9cd99c]">
        <div>
          <p className="text-[#6cb96c]">Repository root</p>
          <p className="break-all font-mono text-xs text-[#b9ffb9]">{repoRoot ?? "Loading..."}</p>
        </div>
        <div>
          <p className="text-[#6cb96c]">Config path</p>
          <p className="break-all font-mono text-xs text-[#b9ffb9]">{configPath ?? "Loading..."}</p>
        </div>
        <div className="grid grid-cols-2 gap-3 pt-2">
          <Metric label="Worktrees" value={String(worktrees.length)} />
          <Metric label="Running envs" value={String(runningCount)} />
        </div>
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[#ecffec]">{value}</p>
    </div>
  );
}
