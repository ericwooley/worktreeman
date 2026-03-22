import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import type {
  AppendProjectManagementBatchRequest,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
} from "@shared/types";
import { PROJECT_MANAGEMENT_DOCUMENT_STATUSES } from "@shared/constants";
import { marked } from "marked";
import { MatrixBadge, MatrixDetailField } from "./matrix-primitives";
import { useTheme } from "./theme-provider";

interface ProjectManagementPanelProps {
  documents: ProjectManagementDocumentSummary[];
  availableTags: string[];
  availableStatuses: string[];
  document: ProjectManagementDocument | null;
  history: ProjectManagementHistoryEntry[];
  loading: boolean;
  saving: boolean;
  onRefresh: (options?: { silent?: boolean }) => Promise<unknown>;
  onSelectDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateDocument: (payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateDocument: (documentId: string, payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onAppendBatch: (payload: AppendProjectManagementBatchRequest) => Promise<unknown>;
}

interface BatchEntryDraft {
  key: string;
  documentId: string;
  title: string;
  markdown: string;
  tags: string;
  status: string;
  assignee: string;
  archived: boolean;
}

function parseTags(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function createBatchEntryDraft(): BatchEntryDraft {
  return {
    key: crypto.randomUUID(),
    documentId: "",
    title: "",
    markdown: "# Batch document\n",
    tags: "",
    status: PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0],
    assignee: "",
    archived: false,
  };
}

export function ProjectManagementPanel({
  documents,
  availableTags,
  availableStatuses,
  document,
  history,
  loading,
  saving,
  onRefresh,
  onSelectDocument,
  onCreateDocument,
  onUpdateDocument,
  onAppendBatch,
}: ProjectManagementPanelProps) {
  const { theme } = useTheme();
  const statuses = availableStatuses.length ? availableStatuses : [...PROJECT_MANAGEMENT_DOCUMENT_STATUSES];
  const [selectedTag, setSelectedTag] = useState<string>("");
  const [draftTitle, setDraftTitle] = useState("");
  const [draftMarkdown, setDraftMarkdown] = useState("");
  const [draftTags, setDraftTags] = useState("");
  const [draftStatus, setDraftStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [draftAssignee, setDraftAssignee] = useState("");
  const [newTitle, setNewTitle] = useState("Project Outline");
  const [newTags, setNewTags] = useState("plan");
  const [newMarkdown, setNewMarkdown] = useState("# Project Outline\n");
  const [newStatus, setNewStatus] = useState<string>(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
  const [newAssignee, setNewAssignee] = useState("");
  const [batchEntries, setBatchEntries] = useState<BatchEntryDraft[]>([createBatchEntryDraft()]);

  useEffect(() => {
    if (!document) {
      setDraftTitle("");
      setDraftMarkdown("");
      setDraftTags("");
      setDraftStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
      setDraftAssignee("");
      return;
    }

    setDraftTitle(document.title);
    setDraftMarkdown(document.markdown);
    setDraftTags(document.tags.join(", "));
    setDraftStatus(document.status);
    setDraftAssignee(document.assignee);
  }, [document]);

  const filteredDocuments = useMemo(
    () => selectedTag
      ? documents.filter((entry) => entry.tags.includes(selectedTag))
      : documents,
    [documents, selectedTag],
  );

  const renderedMarkdown = useMemo(
    () => marked.parse(draftMarkdown || document?.markdown || ""),
    [document?.markdown, draftMarkdown],
  );

  useEffect(() => {
    if (documents.length === 0 || document) {
      return;
    }

    void onSelectDocument(documents[0].id, { silent: true });
  }, [document, documents, onSelectDocument]);

  return (
    <div className="mt-4 grid gap-4 xl:grid-cols-[18rem_minmax(0,1fr)_22rem]">
      <div className="theme-inline-panel p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="matrix-kicker">Project management</p>
            <h2 className="mt-2 text-2xl font-semibold theme-text-strong">Documents</h2>
          </div>
          <button
            type="button"
            className="matrix-button rounded-none px-3 py-2 text-sm"
            onClick={() => void onRefresh()}
            disabled={loading || saving}
          >
            Refresh
          </button>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className={`matrix-button rounded-none px-3 py-1.5 text-xs ${selectedTag === "" ? "theme-pill-emphasis theme-text-strong" : ""}`}
            onClick={() => setSelectedTag("")}
          >
            All tags
          </button>
          {availableTags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={`matrix-button rounded-none px-3 py-1.5 text-xs ${selectedTag === tag ? "theme-pill-emphasis theme-text-strong" : ""}`}
              onClick={() => setSelectedTag(tag)}
            >
              {tag}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-2">
          {filteredDocuments.length ? filteredDocuments.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`w-full border px-3 py-3 text-left transition-colors ${document?.id === entry.id ? "theme-pill-emphasis" : "theme-border-subtle theme-surface-soft"}`}
              onClick={() => void onSelectDocument(entry.id)}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold theme-text-strong">{entry.title}</p>
                  <p className="mt-1 text-xs theme-text-muted">{new Date(entry.updatedAt).toLocaleString()}</p>
                  <p className="mt-1 text-xs theme-text-muted">{entry.status} - {entry.assignee || "Unassigned"}</p>
                </div>
                <MatrixBadge tone={entry.archived ? "warning" : "neutral"} compact>
                  {entry.archived ? "archived" : entry.historyCount}
                </MatrixBadge>
              </div>
              <div className="mt-2 flex flex-wrap gap-1">
                {entry.tags.map((tag) => <MatrixBadge key={tag} tone="active" compact>{tag}</MatrixBadge>)}
              </div>
            </button>
          )) : (
            <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              No documents match the current tag filter.
            </div>
          )}
        </div>

        <div className="mt-5 border theme-border-subtle p-3">
          <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Create document</p>
          <div className="mt-3 space-y-2">
            <input
              value={newTitle}
              onChange={(event) => setNewTitle(event.target.value)}
              placeholder="Document title"
              className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
            />
            <input
              value={newTags}
              onChange={(event) => setNewTags(event.target.value)}
              placeholder="bug, feature, plan"
              className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
            />
            <div className="grid gap-2 md:grid-cols-2">
              <select
                value={newStatus}
                onChange={(event) => setNewStatus(event.target.value)}
                className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
              >
                {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
              </select>
              <input
                value={newAssignee}
                onChange={(event) => setNewAssignee(event.target.value)}
                placeholder="Assignee"
                className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
              />
            </div>
            <textarea
              value={newMarkdown}
              onChange={(event) => setNewMarkdown(event.target.value)}
              placeholder="# New document"
              rows={8}
              className="matrix-input w-full rounded-none px-3 py-2 text-sm outline-none"
            />
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={saving || !newTitle.trim()}
              onClick={async () => {
                const created = await onCreateDocument({
                  title: newTitle,
                  markdown: newMarkdown,
                  tags: parseTags(newTags),
                  status: newStatus,
                  assignee: newAssignee,
                });
                if (!created) {
                  return;
                }

                setNewTitle("");
                setNewTags("");
                setNewMarkdown("# New document\n");
                setNewStatus(PROJECT_MANAGEMENT_DOCUMENT_STATUSES[0]);
                setNewAssignee("");
              }}
            >
              Create
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="theme-inline-panel p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div>
              <p className="matrix-kicker">Markdown document</p>
              <h2 className="mt-2 text-2xl font-semibold theme-text-strong">{document?.title ?? "Select a document"}</h2>
              <p className="mt-2 text-sm theme-text-muted">
                Automerge changes are committed onto the project-management branch while this view shows the reduced markdown snapshot.
              </p>
            </div>
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={!document || saving}
              onClick={() => document ? void onUpdateDocument(document.id, {
                title: draftTitle,
                markdown: draftMarkdown,
                tags: parseTags(draftTags),
                status: draftStatus,
                assignee: draftAssignee,
                archived: document.archived,
              }) : undefined}
            >
              Save document
            </button>
          </div>

          {document ? (
            <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
              <MatrixDetailField label="Document ID" value={document.id} mono />
              <MatrixDetailField label="Status" value={document.status} />
              <MatrixDetailField label="Assignee" value={document.assignee || "Unassigned"} />
              <MatrixDetailField label="Archived" value={document.archived ? "Yes" : "No"} />
              <MatrixDetailField label="Created" value={new Date(document.createdAt).toLocaleString()} />
              <MatrixDetailField label="Updated" value={new Date(document.updatedAt).toLocaleString()} />
            </div>
          ) : null}

          {document ? (
            <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
              <div className="space-y-3">
                <input
                  value={draftTitle}
                  onChange={(event) => setDraftTitle(event.target.value)}
                  placeholder="Document title"
                  className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                />
                <input
                  value={draftTags}
                  onChange={(event) => setDraftTags(event.target.value)}
                  placeholder="bug, feature, plan"
                  className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                />
                <div className="grid gap-3 md:grid-cols-2">
                  <select
                    value={draftStatus}
                    onChange={(event) => setDraftStatus(event.target.value)}
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  >
                    {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                  </select>
                  <input
                    value={draftAssignee}
                    onChange={(event) => setDraftAssignee(event.target.value)}
                    placeholder="Assignee"
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    disabled={saving}
                    onClick={() => void onUpdateDocument(document.id, {
                      title: draftTitle,
                      markdown: draftMarkdown,
                      tags: parseTags(draftTags),
                      status: draftStatus,
                      assignee: draftAssignee,
                      archived: !document.archived,
                    })}
                  >
                    {document.archived ? "Restore" : "Archive"}
                  </button>
                  {document.archived ? <MatrixBadge tone="warning">Archived</MatrixBadge> : null}
                </div>
                <div className="overflow-hidden border theme-border-subtle">
                  <Editor
                    height="65vh"
                    defaultLanguage="markdown"
                    language="markdown"
                    value={draftMarkdown}
                    onChange={(value) => setDraftMarkdown(value ?? "")}
                    options={{
                      minimap: { enabled: false },
                      fontSize: 13,
                      wordWrap: "on",
                      scrollBeyondLastLine: false,
                      automaticLayout: true,
                    }}
                    theme={theme.variant === "light" ? "vs" : "vs-dark"}
                  />
                </div>
              </div>
              <div className="border theme-border-subtle p-4">
                <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Preview</p>
                <div
                  className="prose prose-invert mt-4 max-w-none text-sm theme-text"
                  dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                />
              </div>
            </div>
          ) : (
            <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              Select a document from the left rail to inspect its markdown, tags, and history.
            </div>
          )}
        </div>
      </div>

      <div className="theme-inline-panel p-4">
        <p className="matrix-kicker">History</p>
        <h2 className="mt-2 text-2xl font-semibold theme-text-strong">Commit timeline</h2>
        <p className="mt-2 text-sm theme-text-muted">Each entry reflects a committed Automerge batch reduced into the latest view.</p>

        <div className="mt-5 border theme-border-subtle p-3">
          <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Batch editor</p>
          <p className="mt-2 text-sm theme-text-muted">Stage multiple document updates and commit them together.</p>
          <div className="mt-3 space-y-3">
            {batchEntries.map((entry, index) => (
              <div key={entry.key} className="border theme-border-subtle p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold theme-text-strong">Entry {index + 1}</p>
                  <button
                    type="button"
                    className="matrix-button rounded-none px-2 py-1 text-xs"
                    disabled={batchEntries.length === 1 || saving}
                    onClick={() => setBatchEntries((current) => current.filter((candidate) => candidate.key !== entry.key))}
                  >
                    Remove
                  </button>
                </div>
                <div className="mt-3 space-y-2">
                  <select
                    value={entry.documentId}
                    onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, documentId: event.target.value } : candidate))}
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  >
                    <option value="">Create new document</option>
                    {documents.map((documentOption) => <option key={documentOption.id} value={documentOption.id}>{documentOption.title}</option>)}
                  </select>
                  <input
                    value={entry.title}
                    onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, title: event.target.value } : candidate))}
                    placeholder="Document title"
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                  <input
                    value={entry.tags}
                    onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, tags: event.target.value } : candidate))}
                    placeholder="bug, feature, plan"
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                  <div className="grid gap-2 md:grid-cols-2">
                    <select
                      value={entry.status}
                      onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, status: event.target.value } : candidate))}
                      className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                    >
                      {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
                    </select>
                    <input
                      value={entry.assignee}
                      onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, assignee: event.target.value } : candidate))}
                      placeholder="Assignee"
                      className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                    />
                  </div>
                  <label className="flex items-center gap-2 text-xs theme-text-muted">
                    <input
                      type="checkbox"
                      checked={entry.archived}
                      onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, archived: event.target.checked } : candidate))}
                    />
                    Archive after commit
                  </label>
                  <textarea
                    value={entry.markdown}
                    onChange={(event) => setBatchEntries((current) => current.map((candidate) => candidate.key === entry.key ? { ...candidate, markdown: event.target.value } : candidate))}
                    rows={6}
                    className="matrix-input w-full rounded-none px-3 py-2 text-sm outline-none"
                  />
                </div>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              disabled={saving}
              onClick={() => setBatchEntries((current) => [...current, createBatchEntryDraft()])}
            >
              Add batch row
            </button>
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={saving || batchEntries.every((entry) => !entry.title.trim())}
              onClick={async () => {
                await onAppendBatch({
                  entries: batchEntries
                    .filter((entry) => entry.title.trim())
                    .map((entry) => ({
                      documentId: entry.documentId || undefined,
                      title: entry.title,
                      markdown: entry.markdown,
                      tags: parseTags(entry.tags),
                      status: entry.status,
                      assignee: entry.assignee,
                      archived: entry.archived,
                    })),
                });
                setBatchEntries([createBatchEntryDraft()]);
              }}
            >
              Commit batch
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-3">
          {history.length ? history.slice().reverse().map((entry) => (
            <div key={`${entry.commitSha}:${entry.batchId}:${entry.createdAt}`} className="border theme-border-subtle p-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold theme-text-strong">{entry.title}</p>
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
    </div>
  );
}
