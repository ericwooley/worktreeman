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
          ? "matrix-panel-strong"
          : "matrix-panel hover:border-[rgba(74,255,122,0.3)] hover:bg-[rgba(9,30,12,0.72)]"
      }`}
    >
      <div className="flex flex-col gap-4">
        <button className="text-left" onClick={onSelect}>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] px-3 py-1 font-mono text-xs text-[#b9ffb9]">{worktree.branch}</span>
            <span className={`rounded-full px-2.5 py-1 text-xs ${isRunning ? "bg-[rgba(74,255,122,0.12)] text-[#4aff7a]" : "bg-[rgba(255,255,255,0.03)] text-[#8ab88a]"}`}>
              {isRunning ? "Runtime active" : "Stopped"}
            </span>
          </div>
          <p className="mt-3 break-all font-mono text-xs text-[#8fd18f]">{worktree.worktreePath}</p>
          {worktree.runtime ? (
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {worktree.runtime.ports.map((binding) => (
                <div
                  key={`${binding.service}-${binding.hostPort}`}
                  className="matrix-command px-3 py-2 text-xs"
                >
                  <p className="font-semibold text-[#ecffec]">{binding.envName}</p>
                  <p className="font-mono text-[#8fd18f]">localhost:{binding.hostPort}</p>
                </div>
              ))}
            </div>
          ) : null}
        </button>

        <div className="grid shrink-0 grid-cols-3 gap-2">
          <button
            className="matrix-button rounded-full px-3 py-2 text-sm"
            disabled={isBusy || isRunning}
            onClick={onStart}
          >
            Start env
          </button>
          <button
            className="matrix-button rounded-full px-3 py-2 text-sm"
            disabled={isBusy || !isRunning}
            onClick={onStop}
          >
            Stop env
          </button>
          <button
            className="matrix-button matrix-button-danger rounded-full px-3 py-2 text-sm"
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
