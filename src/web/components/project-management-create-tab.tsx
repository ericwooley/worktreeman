import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { Suspense, lazy, useState } from "react";
import { MatrixTabButton } from "./matrix-primitives";

const ProjectManagementWysiwyg = lazy(async () => {
  const module = await import("./project-management-wysiwyg");
  return { default: module.ProjectManagementWysiwyg };
});

interface ProjectManagementCreateTabProps {
  statuses: string[];
  saving: boolean;
  newTitle: string;
  newTags: string;
  newMarkdown: string;
  newStatus: string;
  newAssignee: string;
  onNewTitleChange: (value: string) => void;
  onNewTagsChange: (value: string) => void;
  onNewMarkdownChange: (value: string) => void;
  onNewStatusChange: (value: string) => void;
  onNewAssigneeChange: (value: string) => void;
  onCreate: () => Promise<void>;
}

export function ProjectManagementCreateTab({
  statuses,
  saving,
  newTitle,
  newTags,
  newMarkdown,
  newStatus,
  newAssignee,
  onNewTitleChange,
  onNewTagsChange,
  onNewMarkdownChange,
  onNewStatusChange,
  onNewAssigneeChange,
  onCreate,
}: ProjectManagementCreateTabProps) {
  const [editorMode, setEditorMode] = useState<"markdown" | "wysiwyg">("markdown");

  return (
    <div className="border theme-border-subtle p-4">
      <p className="matrix-kicker">Create document</p>
      <h2 className="mt-1 text-xl font-semibold theme-text-strong">New markdown document</h2>

      <div className="mt-3 grid gap-3 xl:grid-cols-[20rem_minmax(0,1fr)]">
        <div className="space-y-2">
          <input
            value={newTitle}
            onChange={(event) => onNewTitleChange(event.target.value)}
            placeholder="Document title"
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          />
          <input
            value={newTags}
            onChange={(event) => onNewTagsChange(event.target.value)}
            placeholder="bug, feature, plan"
            className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
          />
          <div className="grid gap-2 md:grid-cols-2">
            <select
              value={newStatus}
              onChange={(event) => onNewStatusChange(event.target.value)}
              className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
            >
              {(statuses.length ? statuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES]).map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
            <input
              value={newAssignee}
              onChange={(event) => onNewAssigneeChange(event.target.value)}
              placeholder="Assignee"
              className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
            />
          </div>
          <button
            type="button"
            className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
            disabled={saving || !newTitle.trim()}
            onClick={() => void onCreate()}
          >
            Create document
          </button>
        </div>

        <div className="overflow-hidden border theme-border-subtle">
          <div className="flex items-center justify-between gap-3 border-b theme-border-subtle px-3 py-2">
            <span className="text-xs uppercase tracking-[0.18em] theme-text-soft">Initial document</span>
            <div className="flex flex-wrap gap-2">
              <MatrixTabButton active={editorMode === "markdown"} label="Markdown" onClick={() => setEditorMode("markdown")} />
              <MatrixTabButton active={editorMode === "wysiwyg"} label="WYSIWYG" onClick={() => setEditorMode("wysiwyg")} />
            </div>
          </div>
          {editorMode === "markdown" ? (
            <textarea
              value={newMarkdown}
              onChange={(event) => onNewMarkdownChange(event.target.value)}
              placeholder="# New document"
              rows={20}
              className="matrix-input min-h-[55vh] w-full rounded-none border-0 px-4 py-3 font-mono text-sm outline-none"
            />
          ) : (
            <Suspense fallback={<div className="px-4 py-6 text-sm theme-empty-note">Loading editor...</div>}>
              <ProjectManagementWysiwyg value={newMarkdown} onChange={onNewMarkdownChange} height="55vh" />
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}
