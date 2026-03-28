import { Suspense, lazy, useMemo, type ReactNode } from "react";
import { marked } from "marked";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixTabButton } from "./matrix-primitives";

const ProjectManagementMonacoEditor = lazy(async () => {
  const module = await import("./project-management-monaco-editor");
  return { default: module.ProjectManagementMonacoEditor };
});

export type ProjectManagementDocumentFormViewMode = "write" | "preview";

interface ProjectManagementDocumentFormProps {
  mode: "create" | "edit";
  title: string;
  summary: string;
  tags: string;
  markdown: string;
  status: string;
  assignee: string;
  statuses: string[];
  saving: boolean;
  disabled?: boolean;
  showMetadataFields?: boolean;
  submitDisabled?: boolean;
  viewMode: ProjectManagementDocumentFormViewMode;
  onViewModeChange: (value: ProjectManagementDocumentFormViewMode) => void;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onMarkdownChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onAssigneeChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  sidebarFooter?: React.ReactNode;
  editorBlockedState?: React.ReactNode;
  // New prop for editing signal
  onEditingStateChange?: (editing: boolean) => void;
}

// Added isEditing prop support

interface ProjectManagementDocumentFormProps {
  mode: "create" | "edit";
  title: string;
  summary: string;
  tags: string;
  markdown: string;
  status: string;
  assignee: string;
  statuses: string[];
  saving: boolean;
  disabled?: boolean;
  showMetadataFields?: boolean;
  submitDisabled?: boolean;
  viewMode: ProjectManagementDocumentFormViewMode;
  onViewModeChange: (value: ProjectManagementDocumentFormViewMode) => void;
  onTitleChange: (value: string) => void;
  onSummaryChange: (value: string) => void;
  onTagsChange: (value: string) => void;
  onMarkdownChange: (value: string) => void;
  onStatusChange: (value: string) => void;
  onAssigneeChange: (value: string) => void;
  onSubmit: () => Promise<void>;
  sidebarFooter?: ReactNode;
  editorBlockedState?: ReactNode;
}

import { useRef } from "react";

export function ProjectManagementDocumentForm({
  mode,
  title,
  summary,
  tags,
  markdown,
  status,
  assignee,
  statuses,
  saving,
  disabled = false,
  showMetadataFields = true,
  submitDisabled = false,
  viewMode,
  onViewModeChange,
  onTitleChange,
  onSummaryChange,
  onTagsChange,
  onMarkdownChange,
  onStatusChange,
  onAssigneeChange,
  onSubmit,
  sidebarFooter,
  editorBlockedState,
  onEditingStateChange,
}: ProjectManagementDocumentFormProps) {
  const fieldDisabled = saving || disabled;
  const editorHeight = mode === "create" ? "55vh" : "68vh";
  const statusOptions = useMemo<MatrixDropdownOption[]>(
    () => (statuses.length ? statuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES]).map((entry) => ({
      value: entry,
      label: entry,
      description: "Board lane",
    })),
    [statuses],
  );

  // Editing state debounce logic
  const editingTimeout = useRef<NodeJS.Timeout | null>(null);
  function triggerEditing(editing: boolean) {
    if (!onEditingStateChange) return;
    if (editing) {
      onEditingStateChange(true);
      if (editingTimeout.current) clearTimeout(editingTimeout.current);
    } else {
      if (editingTimeout.current) clearTimeout(editingTimeout.current);
      editingTimeout.current = setTimeout(() => onEditingStateChange(false), 1500);
    }
  }

  return (
    <div className="border theme-border-subtle p-4">
      <p className="matrix-kicker">{mode === "create" ? "Create document" : "Edit document"}</p>
      <h2 className="mt-1 text-xl font-semibold theme-text-strong">
        {mode === "create" ? "New markdown document" : "Update markdown document"}
      </h2>

      <div className="mt-3 grid gap-3 xl:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="space-y-2">
<input
             value={title}
             onChange={(event) => { onTitleChange(event.target.value); triggerEditing(true); }}
             onFocus={() => triggerEditing(true)}
             onBlur={() => triggerEditing(false)}
             placeholder="Document title"
             disabled={fieldDisabled}
             className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
           />
<textarea
             value={summary}
             onChange={(event) => { onSummaryChange(event.target.value); triggerEditing(true); }}
             onFocus={() => triggerEditing(true)}
             onBlur={() => triggerEditing(false)}
             placeholder="Short summary shown in the document list"
             disabled={fieldDisabled}
             rows={3}
             className="matrix-input w-full rounded-none px-3 py-2 text-sm outline-none"
           />
<input
             value={tags}
             onChange={(event) => { onTagsChange(event.target.value); triggerEditing(true); }}
             onFocus={() => triggerEditing(true)}
             onBlur={() => triggerEditing(false)}
             placeholder="bug, feature, plan"
             disabled={fieldDisabled}
             className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
           />
          {showMetadataFields ? (
            <div className="grid gap-3 md:grid-cols-2">
              <MatrixDropdown
                label="Lane"
                value={status}
                options={statusOptions}
                placeholder="Select lane"
                onChange={onStatusChange}
                disabled={fieldDisabled}
              />
<input
                 value={assignee}
                 onChange={(event) => { onAssigneeChange(event.target.value); triggerEditing(true); }}
                 onFocus={() => triggerEditing(true)}
                 onBlur={() => triggerEditing(false)}
                 placeholder="Assignee"
                 disabled={fieldDisabled}
                 className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
               />
            </div>
          ) : null}
          <button
            type="button"
            className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
            disabled={fieldDisabled || submitDisabled}
            onClick={() => void onSubmit()}
          >
            {mode === "create" ? "Create document" : "Save document"}
          </button>
          {sidebarFooter}
        </div>

        <div className="overflow-hidden border theme-border-subtle">
          <div className="flex items-center justify-between gap-3 border-b theme-border-subtle px-3 py-2">
            <span className="text-xs uppercase tracking-[0.18em] theme-text-soft">
              {mode === "create" ? "Initial document" : "Document body"}
            </span>
            <div className="flex flex-wrap gap-2">
              <MatrixTabButton active={viewMode === "write"} label="Write" onClick={() => onViewModeChange("write")} />
              <MatrixTabButton active={viewMode === "preview"} label="Preview" onClick={() => onViewModeChange("preview")} />
            </div>
          </div>

          {editorBlockedState ?? (viewMode === "preview" ? (
            <div className={`min-h-[55vh] px-4 py-3 ${mode === "edit" ? "md:min-h-[68vh]" : ""}`}>
              <div
                className="pm-markdown text-sm theme-text"
                dangerouslySetInnerHTML={{ __html: marked.parse(markdown || "(empty markdown document)") }}
              />
            </div>
          ) : (
            <Suspense fallback={<div className="px-4 py-6 text-sm theme-empty-note">Loading editor...</div>}>
              <ProjectManagementMonacoEditor
  value={markdown}
  onChange={onMarkdownChange}
  height={editorHeight}
  readOnly={fieldDisabled}
  onFocus={() => triggerEditing(true)}
  onBlur={() => triggerEditing(false)}
/>
            </Suspense>
          ))}
        </div>
      </div>
    </div>
  );
}
