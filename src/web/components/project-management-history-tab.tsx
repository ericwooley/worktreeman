import type { ProjectManagementHistoryEntry } from "@shared/types";
import { MatrixBadge } from "./matrix-primitives";

interface ProjectManagementHistoryTabProps {
  history: ProjectManagementHistoryEntry[];
}

export function ProjectManagementHistoryTab({ history }: ProjectManagementHistoryTabProps) {
  return (
    <div className="border theme-border-subtle p-4">
      <p className="matrix-kicker">History</p>
      <h2 className="mt-2 text-2xl font-semibold theme-text-strong">Commit timeline</h2>
      <p className="mt-2 text-sm theme-text-muted">See how the document changed over time without exposing storage mechanics.</p>

      <div className="mt-4 space-y-3">
        {history.length ? history.slice().reverse().map((entry) => (
          <div key={`${entry.commitSha}:${entry.batchId}:${entry.createdAt}`} className="border theme-border-subtle p-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm font-semibold theme-text-strong">{entry.title}</p>
                <p className="mt-1 text-xs font-semibold theme-text-strong">#{entry.number}</p>
                <p className="mt-1 font-mono text-xs theme-text-muted">{entry.commitSha.slice(0, 12)} - {entry.actorId.slice(0, 12)}</p>
              </div>
              <MatrixBadge tone={entry.action === "create" ? "active" : entry.action === "archive" ? "warning" : "neutral"} compact>
                {entry.action}
              </MatrixBadge>
            </div>
            <p className="mt-2 text-xs theme-text-muted">{new Date(entry.createdAt).toLocaleString()} - {entry.changeCount} change{entry.changeCount === 1 ? "" : "s"}</p>
            <p className="mt-1 text-xs theme-text-muted">{entry.status} - {entry.assignee || "Unassigned"}</p>
            <div className="mt-2 flex flex-wrap gap-1">
              {entry.tags.map((tag) => <MatrixBadge key={`${entry.batchId}:${tag}`} tone="active" compact>{tag}</MatrixBadge>)}
              {entry.archived ? <MatrixBadge key={`${entry.batchId}:archived`} tone="warning" compact>archived</MatrixBadge> : null}
            </div>
          </div>
        )) : (
          <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
            No history entries yet.
          </div>
        )}
      </div>
    </div>
  );
}
