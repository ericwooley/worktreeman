import { useMemo, useState, type FormEvent } from "react";
import type { WorktreeRecord } from "@shared/types";
import { useDashboardState } from "../hooks/use-dashboard-state";
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
    <main className="min-h-screen bg-aurora px-4 py-6 text-ink sm:px-6 lg:px-8">
      <div className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="rounded-[2rem] border border-white/60 bg-white/70 p-6 shadow-panel backdrop-blur">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <p className="text-sm uppercase tracking-[0.28em] text-pine">Local orchestration cockpit</p>
              <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Worktree Manager</h1>
              <p className="max-w-2xl text-sm leading-6 text-ink/70 sm:text-base">
                Spin up isolated git worktrees, boot branch-scoped Docker Compose stacks, and jump into tmux-backed terminals with runtime env injected in memory.
              </p>
            </div>

            <form className="flex w-full max-w-xl flex-col gap-3 sm:flex-row" onSubmit={onSubmit}>
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="feature/branch-name"
                className="h-12 flex-1 rounded-2xl border border-ink/10 bg-mist px-4 font-mono text-sm outline-none transition focus:border-ember"
              />
              <button
                type="submit"
                className="h-12 rounded-2xl bg-ink px-5 text-sm font-semibold text-white transition hover:bg-ink/90"
              >
                Create worktree
              </button>
            </form>
          </div>
        </header>

        <section className="grid gap-6 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-[2rem] border border-white/60 bg-white/75 p-5 shadow-panel backdrop-blur">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-xl font-semibold">Active worktrees</h2>
                <p className="text-sm text-ink/65">Discover, boot, and remove branches from one view.</p>
              </div>
              <button className="rounded-full border border-ink/10 px-3 py-2 text-sm" onClick={() => void refresh()}>
                Refresh
              </button>
            </div>

            {loading ? <p className="text-sm text-ink/70">Loading worktrees...</p> : null}
            {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p> : null}

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

          <aside className="space-y-6">
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
    <section className="rounded-[2rem] border border-ink/10 bg-ink p-5 text-white shadow-panel">
      <p className="text-xs uppercase tracking-[0.28em] text-white/60">Workspace</p>
      <div className="mt-4 space-y-4 text-sm text-white/75">
        <div>
          <p className="text-white/45">Repository root</p>
          <p className="break-all font-mono text-xs text-skyglass">{repoRoot ?? "Loading..."}</p>
        </div>
        <div>
          <p className="text-white/45">Config path</p>
          <p className="break-all font-mono text-xs text-skyglass">{configPath ?? "Loading..."}</p>
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
      <p className="text-xs uppercase tracking-[0.18em] text-white/45">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-mist">{value}</p>
    </div>
  );
}
