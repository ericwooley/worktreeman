import { useMemo, useState, type ReactNode } from "react";
import type { ProjectManagementDocumentSummary } from "@shared/types";
import { MatrixBadge } from "./matrix-primitives";

export type ProjectManagementDocumentArchiveFilter = "active" | "archived" | "all";

export interface ProjectManagementDocumentBrowserState {
  selectedTag: string;
  setSelectedTag: (value: string) => void;
  selectedStatusFilter: string;
  setSelectedStatusFilter: (value: string) => void;
  selectedAssigneeFilter: string;
  setSelectedAssigneeFilter: (value: string) => void;
  archiveFilter: ProjectManagementDocumentArchiveFilter;
  setArchiveFilter: (value: ProjectManagementDocumentArchiveFilter) => void;
  documentSearch: string;
  setDocumentSearch: (value: string) => void;
  availableAssignees: string[];
  filteredDocuments: ProjectManagementDocumentSummary[];
  archivedDocumentCount: number;
  documentGroups: Array<{
    status: string;
    documents: ProjectManagementDocumentSummary[];
  }>;
}

export function formatDocumentTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return "Updated recently";
  }

  const elapsedMinutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
  if (elapsedMinutes < 1) {
    return "Updated just now";
  }

  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours}h ago`;
  }

  const elapsedDays = Math.round(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `Updated ${elapsedDays}d ago`;
  }

  return `Updated ${new Date(timestamp).toLocaleDateString()}`;
}

function getDocumentSearchValue(entry: ProjectManagementDocumentSummary): string {
  return [
    String(entry.number),
    entry.title,
    entry.status,
    entry.assignee,
    entry.archived ? "archived" : "active",
    ...entry.tags,
  ].join(" ").toLowerCase();
}

export function useProjectManagementDocumentBrowserState(
  documents: ProjectManagementDocumentSummary[],
  statuses: string[],
  options?: { initialArchiveFilter?: ProjectManagementDocumentArchiveFilter },
): ProjectManagementDocumentBrowserState {
  const [selectedTag, setSelectedTag] = useState("");
  const [selectedStatusFilter, setSelectedStatusFilter] = useState("");
  const [selectedAssigneeFilter, setSelectedAssigneeFilter] = useState("");
  const [archiveFilter, setArchiveFilter] = useState<ProjectManagementDocumentArchiveFilter>(options?.initialArchiveFilter ?? "active");
  const [documentSearch, setDocumentSearch] = useState("");

  const availableAssignees = useMemo(
    () => Array.from(new Set(documents.map((entry) => entry.assignee).filter(Boolean))).sort((left, right) => left.localeCompare(right)),
    [documents],
  );

  const sortedDocuments = useMemo(
    () => [...documents].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    [documents],
  );

  const filteredDocuments = useMemo(
    () => sortedDocuments.filter((entry) => {
      if (documentSearch.trim()) {
        const searchValue = documentSearch.trim().toLowerCase();
        if (!getDocumentSearchValue(entry).includes(searchValue)) {
          return false;
        }
      }

      if (selectedTag && !entry.tags.includes(selectedTag)) {
        return false;
      }

      if (selectedStatusFilter && entry.status !== selectedStatusFilter) {
        return false;
      }

      if (selectedAssigneeFilter && entry.assignee !== selectedAssigneeFilter) {
        return false;
      }

      if (archiveFilter === "active" && entry.archived) {
        return false;
      }

      if (archiveFilter === "archived" && !entry.archived) {
        return false;
      }

      return true;
    }),
    [archiveFilter, documentSearch, selectedAssigneeFilter, selectedStatusFilter, selectedTag, sortedDocuments],
  );

  const archivedDocumentCount = useMemo(
    () => documents.filter((entry) => entry.archived).length,
    [documents],
  );

  const documentGroups = useMemo(
    () => statuses
      .map((status) => ({
        status,
        documents: filteredDocuments.filter((entry) => entry.status === status),
      }))
      .filter((group) => group.documents.length > 0),
    [filteredDocuments, statuses],
  );

  return {
    selectedTag,
    setSelectedTag,
    selectedStatusFilter,
    setSelectedStatusFilter,
    selectedAssigneeFilter,
    setSelectedAssigneeFilter,
    archiveFilter,
    setArchiveFilter,
    documentSearch,
    setDocumentSearch,
    availableAssignees,
    filteredDocuments,
    archivedDocumentCount,
    documentGroups,
  };
}

interface ProjectManagementDocumentBrowserProps {
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  statuses: string[];
  state: ProjectManagementDocumentBrowserState;
  emptyMessage: ReactNode;
  searchPlaceholder?: string;
  listMaxHeightClass?: string;
  renderDocument: (entry: ProjectManagementDocumentSummary) => ReactNode;
  /** Optional slot rendered instead of the empty-message when there are no document groups. */
  skeletonSlot?: ReactNode;
}

export function ProjectManagementDocumentBrowser({
  documents,
  availableTags,
  statuses,
  state,
  emptyMessage,
  searchPlaceholder = "Search title, number, tag, assignee",
  listMaxHeightClass = "max-h-[min(70vh,48rem)]",
  renderDocument,
  skeletonSlot,
}: ProjectManagementDocumentBrowserProps) {
  return (
    <>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
        <div className="matrix-command rounded-none px-3 py-3">
          <p className="text-[10px] uppercase tracking-[0.18em] theme-text-soft">Visible now</p>
          <p className="mt-1 text-lg font-semibold theme-text-strong">{state.filteredDocuments.length}</p>
        </div>
        <div className="matrix-command rounded-none px-3 py-3">
          <p className="text-[10px] uppercase tracking-[0.18em] theme-text-soft">Total docs</p>
          <p className="mt-1 text-lg font-semibold theme-text-strong">{documents.length}</p>
        </div>
      </div>

      <label className="mt-4 block space-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Search documents</span>
        <input
          type="search"
          value={state.documentSearch}
          onChange={(event) => state.setDocumentSearch(event.target.value)}
          placeholder={searchPlaceholder}
          className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
        />
      </label>

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          className={`matrix-button rounded-none px-3 py-1.5 text-xs ${state.selectedTag === "" ? "theme-pill-emphasis theme-text-strong" : ""}`}
          onClick={() => state.setSelectedTag("")}
        >
          All tags
        </button>
        {availableTags.map((tag) => (
          <button
            key={tag}
            type="button"
            className={`matrix-button rounded-none px-3 py-1.5 text-xs ${state.selectedTag === tag ? "theme-pill-emphasis theme-text-strong" : ""}`}
            onClick={() => state.setSelectedTag(tag)}
          >
            {tag}
          </button>
        ))}
      </div>

      <div className="mt-3 grid gap-2">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-1">
          <select
            value={state.selectedStatusFilter}
            onChange={(event) => state.setSelectedStatusFilter(event.target.value)}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          >
            <option value="">All statuses</option>
            {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
          </select>
          <select
            value={state.selectedAssigneeFilter}
            onChange={(event) => state.setSelectedAssigneeFilter(event.target.value)}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          >
            <option value="">All assignees</option>
            {state.availableAssignees.map((assignee) => <option key={assignee} value={assignee}>{assignee}</option>)}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          {(["active", "archived", "all"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`matrix-button rounded-none px-3 py-1.5 text-xs ${state.archiveFilter === value ? "theme-pill-emphasis theme-text-strong" : ""}`}
              onClick={() => state.setArchiveFilter(value)}
            >
              {value}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <MatrixBadge tone="neutral" compact>{`${documents.length - state.archivedDocumentCount} active`}</MatrixBadge>
          <MatrixBadge tone="neutral" compact>{`${state.archivedDocumentCount} archived`}</MatrixBadge>
          {state.documentSearch.trim() ? <MatrixBadge tone="active" compact>{`search: ${state.documentSearch.trim()}`}</MatrixBadge> : null}
        </div>
      </div>

      <div className="mt-4 border theme-border-subtle p-2">
        {state.documentGroups.length ? (
          <div className={`${listMaxHeightClass} space-y-4 overflow-y-auto pr-1`}>
            {state.documentGroups.map((group) => (
              <section key={group.status} className="space-y-2">
                <div className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b theme-border-subtle bg-[rgb(var(--rgb-base01)/0.96)] px-1 py-2 backdrop-blur-sm">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">{group.status}</p>
                  <MatrixBadge tone="neutral" compact>{group.documents.length}</MatrixBadge>
                </div>
                <div className="space-y-2">
                  {group.documents.map((entry) => renderDocument(entry))}
                </div>
              </section>
            ))}
          </div>
        ) : skeletonSlot ? skeletonSlot : (
          <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
            {emptyMessage}
          </div>
        )}
      </div>
    </>
  );
}
