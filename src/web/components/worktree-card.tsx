import type { WorktreeRecord } from "@shared/types";

interface WorktreeCardProps {
  worktree: WorktreeRecord;
  isSelected: boolean;
  onSelect: () => void;
}

export function WorktreeCard({
  worktree,
  isSelected,
  onSelect,
}: WorktreeCardProps) {
  const isRunning = Boolean(worktree.runtime);

  return (
    <article
      className={`rounded-none border p-2 transition ${
        isSelected
          ? "matrix-panel-strong"
          : "matrix-panel hover:border-[rgba(74,255,122,0.3)] hover:bg-[rgba(9,30,12,0.72)]"
      }`}
    >
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={onSelect}>
        <span className="min-w-0 truncate border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] px-2 py-0.5 font-mono text-[11px] text-[#b9ffb9]">
          {worktree.branch}
        </span>
        <span className={`shrink-0 px-2 py-0.5 text-[11px] ${isRunning ? "bg-[rgba(74,255,122,0.12)] text-[#4aff7a]" : "bg-[rgba(255,255,255,0.03)] text-[#8ab88a]"}`}>
          {isRunning ? "Active" : "Idle"}
        </span>
      </button>
    </article>
  );
}
