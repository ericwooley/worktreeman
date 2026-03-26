import { Suspense, lazy, useMemo, type ReactNode } from "react";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixTabButton } from "./matrix-primitives";

const ProjectManagementWysiwyg = lazy(async () => {
  const module = await import("./project-management-wysiwyg");
  return { default: module.ProjectManagementWysiwyg };
});

const ProjectManagementMonacoEditor = lazy(async () => {
  const module = await import("./project-management-monaco-editor");
  return { default: module.ProjectManagementMonacoEditor };
});

export type ProjectManagementDocumentFormEditorMode = "markdown" | "wysiwyg" | "monaco";

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
  submitDisabled?: boolean;
  editorMode: ProjectManagementDocumentFormEditorMode;
  editorOptions: Array<{
    value: ProjectManagementDocumentFormEditorMode;
    label: string;
  }>;
  onEditorModeChange: (value: ProjectManagementDocumentFormEditorMode) => void;
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
  submitDisabled = false,
  editorMode,
  editorOptions,
  onEditorModeChange,
  onTitleChange,
  onSummaryChange,
  onTagsChange,
  onMarkdownChange,
  onStatusChange,
  onAssigneeChange,
  onSubmit,
  sidebarFooter,
  editorBlockedState,
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
            onChange={(event) => onTitleChange(event.target.value)}
            placeholder="Document title"
            disabled={fieldDisabled}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          />
          <textarea
            value={summary}
            onChange={(event) => onSummaryChange(event.target.value)}
            placeholder="Short summary shown in the document list"
            disabled={fieldDisabled}
            rows={3}
            className="matrix-input w-full rounded-none px-3 py-2 text-sm outline-none"
          />
          <input
            value={tags}
            onChange={(event) => onTagsChange(event.target.value)}
            placeholder="bug, feature, plan"
            disabled={fieldDisabled}
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          />
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
              onChange={(event) => onAssigneeChange(event.target.value)}
              placeholder="Assignee"
              disabled={fieldDisabled}
              className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
            />
          </div>
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
              {editorOptions.map((option) => (
                <MatrixTabButton
                  key={option.value}
                  active={editorMode === option.value}
                  label={option.label}
                  onClick={() => onEditorModeChange(option.value)}
                />
              ))}
            </div>
          </div>

          {editorBlockedState ?? (editorMode === "markdown" ? (
            <textarea
              value={markdown}
              onChange={(event) => onMarkdownChange(event.target.value)}
              placeholder={mode === "create" ? "# New document" : "# Document"}
              rows={20}
              disabled={fieldDisabled}
              className={`matrix-input w-full rounded-none border-0 px-4 py-3 font-mono text-sm outline-none ${mode === "create" ? "min-h-[55vh]" : "min-h-[68vh]"}`}
            />
          ) : (
            <Suspense fallback={<div className="px-4 py-6 text-sm theme-empty-note">Loading editor...</div>}>
              {editorMode === "monaco" ? (
                <ProjectManagementMonacoEditor value={markdown} onChange={onMarkdownChange} height={editorHeight} readOnly={fieldDisabled} />
              ) : (
                <ProjectManagementWysiwyg value={markdown} onChange={onMarkdownChange} height={editorHeight} readOnly={fieldDisabled} />
              )}
            </Suspense>
          ))}
        </div>
      </div>
    </div>
  );
}
