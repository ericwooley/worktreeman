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
  const linkedDocument = worktree.linkedDocument;

  return (
    <article
      className={`rounded-none border p-2 transition ${
        isSelected
          ? "matrix-panel-strong"
          : "matrix-panel theme-hover-accent theme-row-idle"
      }`}
    >
      <button className="flex w-full items-start justify-between gap-2 text-left" onClick={onSelect}>
        <span className="min-w-0 flex-1">
          <span className="theme-border inline-flex min-w-0 max-w-full truncate border theme-surface px-2 py-0.5 font-mono text-[11px] theme-text">
            {worktree.branch}
          </span>
          {linkedDocument ? (
            <span className="mt-2 block truncate text-[11px] theme-text-muted">
              Linked to #{linkedDocument.number} {linkedDocument.title}
            </span>
          ) : null}
        </span>
        <span className={`shrink-0 px-2 py-0.5 text-[11px] ${isRunning ? "theme-status-running theme-text-accent" : "theme-status-idle theme-text-soft"}`}>
          {isRunning ? "Active" : "Idle"}
        </span>
      </button>
    </article>
  );
}
