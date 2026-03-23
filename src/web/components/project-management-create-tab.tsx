import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";

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
  return (
    <div className="border theme-border-subtle p-4">
      <p className="matrix-kicker">Create document</p>
      <h2 className="mt-2 text-2xl font-semibold theme-text-strong">New markdown document</h2>
      <p className="mt-2 text-sm theme-text-muted">Create a new project document without crowding the main reading workspace.</p>

      <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <div className="space-y-3">
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

        <div className="border theme-border-subtle p-4">
          <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Initial markdown</p>
          <textarea
            value={newMarkdown}
            onChange={(event) => onNewMarkdownChange(event.target.value)}
            placeholder="# New document"
            rows={18}
            className="matrix-input mt-4 w-full rounded-none px-3 py-2 text-sm outline-none"
          />
        </div>
      </div>
    </div>
  );
}
