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
          : "matrix-panel theme-hover-accent theme-row-idle"
      }`}
    >
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={onSelect}>
        <span className="theme-border min-w-0 truncate border theme-surface px-2 py-0.5 font-mono text-[11px] theme-text">
          {worktree.branch}
        </span>
        <span className={`shrink-0 px-2 py-0.5 text-[11px] ${isRunning ? "theme-status-running theme-text-accent" : "theme-status-idle theme-text-soft"}`}>
          {isRunning ? "Active" : "Idle"}
        </span>
      </button>
    </article>
  );
}
