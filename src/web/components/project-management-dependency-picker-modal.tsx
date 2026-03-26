import { useMemo } from "react";
import type { ProjectManagementDocument, ProjectManagementDocumentSummary } from "@shared/types";
import { MatrixBadge, MatrixModal } from "./matrix-primitives";
import {
  ProjectManagementDocumentBrowser,
  formatDocumentTimestamp,
  useProjectManagementDocumentBrowserState,
} from "./project-management-document-browser";

interface ProjectManagementDependencyPickerModalProps {
  document: ProjectManagementDocument;
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  statuses: string[];
  dependencyIds: string[];
  disabled?: boolean;
  onClose: () => void;
  onOpenGraph: () => void;
  onToggleDependency: (dependencyId: string) => void;
}

export function ProjectManagementDependencyPickerModal({
  document,
  documents,
  availableTags,
  statuses,
  dependencyIds,
  disabled = false,
  onClose,
  onOpenGraph,
  onToggleDependency,
}: ProjectManagementDependencyPickerModalProps) {
  const dependencyOptions = useMemo(
    () => documents.filter((entry) => entry.id !== document.id),
    [document.id, documents],
  );
  const dependencyBrowser = useProjectManagementDocumentBrowserState(dependencyOptions, statuses, { initialArchiveFilter: "all" });
  const dependencyDocumentMap = useMemo(
    () => new Map(documents.map((entry) => [entry.id, entry])),
    [documents],
  );
  const currentDependencies = useMemo(
    () => dependencyIds.map((dependencyId) => dependencyDocumentMap.get(dependencyId)).filter((entry): entry is ProjectManagementDocumentSummary => Boolean(entry)),
    [dependencyDocumentMap, dependencyIds],
  );

  return (
    <MatrixModal
      kicker="Dependencies"
      title={<>Manage prerequisites for `{document.title}`</>}
      description="Search the same document index used in the rail, keep current dependencies in view, and toggle prerequisites without opening the graph. Changes save immediately."
      closeLabel="Close dependency picker"
      maxWidthClass="max-w-6xl"
      onClose={onClose}
      footer={(
        <button
          type="button"
          className="matrix-button rounded-none px-3 py-2 text-sm"
          onClick={onOpenGraph}
        >
          Open graph
        </button>
      )}
    >
      <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
        <section className="border theme-border-subtle p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Current dependencies</p>
              <p className="mt-1 text-sm theme-text-muted">Remove stale prerequisites here while you search for new ones.</p>
            </div>
            <MatrixBadge tone="neutral" compact>
              {currentDependencies.length}
            </MatrixBadge>
          </div>

          <div className="mt-3 space-y-2">
            {currentDependencies.length ? currentDependencies.map((entry) => (
              <div key={entry.id} className="border theme-pill-emphasis px-3 py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] theme-text-soft">#{entry.number}</p>
                      {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                    </div>
                    <p className="mt-2 text-sm font-semibold theme-text-strong">{entry.title}</p>
                    <p className="mt-1 text-[11px] theme-text-muted">{entry.status} - {entry.assignee || "Unassigned"}</p>
                    <p className="mt-1 text-[11px] theme-text-muted">{formatDocumentTimestamp(entry.updatedAt)}</p>
                  </div>
                  <button
                    type="button"
                    className="matrix-button rounded-none px-2 py-1 text-xs"
                    onClick={() => onToggleDependency(entry.id)}
                    disabled={disabled}
                  >
                    Remove
                  </button>
                </div>
              </div>
            )) : (
              <div className="matrix-command rounded-none px-3 py-3 text-sm theme-empty-note">
                No prerequisites yet. Use the document browser to add them.
              </div>
            )}
          </div>
        </section>

        <section>
          <ProjectManagementDocumentBrowser
            documents={dependencyOptions}
            availableTags={availableTags}
            statuses={statuses}
            state={dependencyBrowser}
            searchPlaceholder="Search title, number, tag, assignee"
            listMaxHeightClass="max-h-[min(62vh,44rem)]"
            emptyMessage="No documents match the current filters."
            renderDocument={(entry) => {
              const checked = dependencyIds.includes(entry.id);

              return (
                <label
                  key={entry.id}
                  className={`flex cursor-pointer items-start gap-3 border px-3 py-3 text-left ${checked ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
                >
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={checked}
                    disabled={disabled}
                    onChange={() => onToggleDependency(entry.id)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.16em] theme-text-soft">#{entry.number}</span>
                      <MatrixBadge tone={checked ? "active" : "neutral"} compact>{checked ? "selected" : entry.status}</MatrixBadge>
                      {entry.archived ? <MatrixBadge tone="warning" compact>archived</MatrixBadge> : null}
                    </span>
                    <span className="mt-2 block text-sm font-semibold theme-text-strong">{entry.title}</span>
                    <span className="mt-1 block text-[11px] theme-text-muted">{entry.assignee || "Unassigned"}</span>
                    <span className="mt-1 block text-[11px] theme-text-muted">{formatDocumentTimestamp(entry.updatedAt)}</span>
                  </span>
                </label>
              );
            }}
          />
        </section>
      </div>
    </MatrixModal>
  );
}
