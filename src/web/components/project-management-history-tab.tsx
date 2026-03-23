import type { ProjectManagementHistoryEntry } from "@shared/types";
import { MatrixAccordion, MatrixBadge } from "./matrix-primitives";

interface ProjectManagementHistoryTabProps {
  history: ProjectManagementHistoryEntry[];
}

export function ProjectManagementHistoryTab({ history }: ProjectManagementHistoryTabProps) {
  const entries = history.slice().reverse();

  function getDiffLines(entry: ProjectManagementHistoryEntry): string[] {
    const diffText = (entry.diff?.trim() || (entry.action === "create"
      ? "@@\n+Initial document state"
      : "@@\n No diff available for this history entry."));

    return diffText.split("\n");
  }

  return (
    <div className="border theme-border-subtle p-4">
      <p className="matrix-kicker">History</p>
      <h2 className="mt-2 text-2xl font-semibold theme-text-strong">Commit timeline</h2>
      <p className="mt-2 text-sm theme-text-muted">See how the document changed over time without exposing storage mechanics.</p>

      <div className="mt-4 space-y-3">
        {entries.length ? entries.map((entry) => (
          <MatrixAccordion
            key={`${entry.commitSha}:${entry.batchId}:${entry.createdAt}`}
            summary={(
              <div className="flex items-start justify-between gap-3 pr-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                  <p className="mt-1 text-xs font-semibold theme-text-strong">#{entry.number}</p>
                  <p className="mt-1 font-mono text-xs theme-text-muted">{entry.commitSha.slice(0, 12)} - {entry.actorId.slice(0, 12)}</p>
                  <p className="mt-2 text-xs theme-text-muted">{new Date(entry.createdAt).toLocaleString()} - {entry.changeCount} change{entry.changeCount === 1 ? "" : "s"}</p>
                </div>
                <div className="flex flex-col items-end gap-2">
                  <MatrixBadge tone={entry.action === "create" ? "active" : entry.action === "archive" ? "warning" : "neutral"} compact>
                    {entry.action}
                  </MatrixBadge>
                  <span className="text-[11px] theme-text-muted">{entry.status} - {entry.assignee || "Unassigned"}</span>
                </div>
              </div>
            )}
          >
            <div className="flex flex-wrap gap-1">
              {entry.tags.map((tag) => <MatrixBadge key={`${entry.batchId}:${tag}`} tone="active" compact>{tag}</MatrixBadge>)}
              {entry.archived ? <MatrixBadge key={`${entry.batchId}:archived`} tone="warning" compact>archived</MatrixBadge> : null}
            </div>
            <div className="matrix-diff-text mt-3 overflow-auto p-3">
              {getDiffLines(entry).map((line, lineIndex) => {
                const lineTone = line.startsWith("+++") || line.startsWith("---") || line.startsWith("@@")
                  ? " theme-text-emphasis"
                  : line.startsWith("+")
                    ? " theme-text-accent"
                    : line.startsWith("-")
                      ? " theme-text-warning"
                      : " theme-text-muted";

                return (
                  <div key={`${entry.batchId}:${lineIndex}`} className={`font-mono text-xs whitespace-pre-wrap break-words${lineTone}`}>
                    {line || " "}
                  </div>
                );
              })}
            </div>
          </MatrixAccordion>
        )) : (
          <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
            No history entries yet.
          </div>
        )}
      </div>
    </div>
  );
}
