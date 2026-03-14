import type { WorktreeRecord } from "@shared/types";

interface WorktreeCardProps {
  worktree: WorktreeRecord;
  isBusy: boolean;
  isSelected: boolean;
  onSelect: () => void;
  onStart: () => void;
  onStop: () => void;
  onDelete: () => void;
}

export function WorktreeCard({
  worktree,
  isBusy,
  isSelected,
  onSelect,
  onStart,
  onStop,
  onDelete,
}: WorktreeCardProps) {
  const isRunning = Boolean(worktree.runtime);

  return (
    <article
      className={`rounded-[1.6rem] border p-4 transition ${
        isSelected
          ? "border-ember/60 bg-[rgba(255,247,240,0.74)] backdrop-blur-sm"
          : "border-white/40 bg-[rgba(255,255,255,0.54)] backdrop-blur-sm hover:bg-[rgba(255,255,255,0.68)]"
      }`}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <button className="text-left" onClick={onSelect}>
          <div className="flex items-center gap-3">
            <span className="rounded-full bg-ink px-3 py-1 font-mono text-xs text-white">{worktree.branch}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs ${isRunning ? "bg-pine/10 text-pine" : "bg-ink/5 text-ink/60"}`}>
              {isRunning ? "Runtime active" : "Stopped"}
            </span>
          </div>
          <p className="mt-3 break-all font-mono text-xs text-ink/60">{worktree.worktreePath}</p>
          {worktree.runtime ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {worktree.runtime.ports.map((binding) => (
                <div
                  key={`${binding.service}-${binding.hostPort}`}
                  className="rounded-2xl border border-white/55 bg-[rgba(255,255,255,0.72)] px-3 py-2 text-xs shadow-sm"
                >
                  <p className="font-semibold text-ink">{binding.envName}</p>
                  <p className="font-mono text-ink/60">localhost:{binding.hostPort}</p>
                </div>
              ))}
            </div>
          ) : null}
        </button>

        <div className="flex shrink-0 gap-2">
          <button
            className="rounded-full border border-ink/10 px-3 py-2 text-sm"
            disabled={isBusy || isRunning}
            onClick={onStart}
          >
            Start env
          </button>
          <button
            className="rounded-full border border-ink/10 px-3 py-2 text-sm"
            disabled={isBusy || !isRunning}
            onClick={onStop}
          >
            Stop env
          </button>
          <button
            className="rounded-full border border-red-200 px-3 py-2 text-sm text-red-700"
            disabled={isBusy}
            onClick={onDelete}
          >
            Delete
          </button>
        </div>
      </div>
    </article>
  );
}
