import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import { Gitgraph, Orientation, TemplateName, templateExtend } from "@gitgraph/react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { changeMaxLengthToIgnoreLineDiff, getLang } from "@git-diff-view/core";
import type {
  AiCommandOrigin,
  AiCommandConfig,
  AiCommandId,
  AiCommandLogEntry,
  AiCommandLogSummary,
  AiCommandJob,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  CommitGitChangesResponse,
  GitComparisonResponse,
  ProjectManagementDocument,
  ProjectManagementDocumentReview,
  ProjectManagementDocumentSummary,
  ProjectManagementDocumentSummaryResponse,
  ProjectManagementHistoryEntry,
  ProjectManagementReviewEntry,
  ProjectManagementUsersResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  SystemStatusResponse,
  SystemSubTab,
  UpdateProjectManagementUsersRequest,
  WorktreeAutoSyncState,
  WorktreeRecord,
} from "@shared/types";
import type { ProjectManagementDocumentFormViewMode } from "./project-management-document-form";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { AiActivitySubTab } from "./project-management-ai-tab";
import type { ProjectManagementDocumentPresentation } from "./project-management-document-route";
import { getTmuxSessionName } from "../lib/tmux";
import type { CommitChangesPayload } from "../hooks/use-dashboard-state";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixModal, MatrixSectionIntro, MatrixTabs } from "./matrix-primitives";
import { MatrixCard, MatrixCardFooter, MatrixCardHeader } from "./matrix-card";
import { WorktreeTerminal } from "./worktree-terminal";
import {
  BACKGROUND_COMMAND_CONTROL_DESCRIPTION,
  BACKGROUND_COMMAND_CONTROL_TITLE,
  WORKTREE_ENVIRONMENT_BACKGROUND_SUB_TAB_LABEL,
  WORKTREE_ENVIRONMENT_DESCRIPTION,
  WORKTREE_ENVIRONMENT_EMPTY_DESCRIPTION,
  WORKTREE_ENVIRONMENT_KICKER,
  WORKTREE_ENVIRONMENT_TAB_LABEL,
  WORKTREE_ENVIRONMENT_TERMINAL_SUB_TAB_LABEL,
} from "./worktree-environment-content";
import { getAiResolveButtonState, getResolvableConflictCount } from "./git-status-actions";
import { ProjectManagementAiOutputViewer } from "./project-management-ai-output-viewer";
import { ProjectManagementAiTab } from "./project-management-ai-tab";
import { ProjectManagementPanel } from "./project-management-panel";
import { SystemTab } from "./system-tab";
import { getWorktreeDeleteAiDisabledReason, getWorktreeMergeAiDisabledReason } from "./worktree-action-guards";

function getCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getReviewEventLabel(entry: ProjectManagementReviewEntry) {
  switch (entry.eventType) {
    case "ai-started":
      return "AI started";
    case "ai-completed":
      return "AI completed";
    case "merge":
      return "Merge";
    default:
      return "Comment";
  }
}

function getReviewEventTone(entry: ProjectManagementReviewEntry) {
  switch (entry.eventType) {
    case "ai-started":
      return "neutral" as const;
    case "ai-completed":
      return "active" as const;
    case "merge":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

function getReviewSourceTone(entry: ProjectManagementReviewEntry) {
  switch (entry.source) {
    case "ai":
      return "active" as const;
    case "system":
      return "warning" as const;
    default:
      return "neutral" as const;
  }
}

function getReviewSourceLabel(entry: ProjectManagementReviewEntry) {
  switch (entry.source) {
    case "ai":
      return "AI";
    case "system":
      return "System";
    default:
      return "Comment";
  }
}

function mapOriginProjectManagementSubTabToUiTab(
  subTab: AiCommandOrigin["location"]["projectManagementSubTab"] | null | undefined,
): ProjectManagementSubTab {
  if (subTab === "review") {
    return "document";
  }

  return subTab ?? "document";
}

const DIFF_RENDER_MAX_CHARS = 350_000;
const DIFF_RENDER_MAX_LINES = 8_000;
const DIFF_RENDER_MAX_FILES = 80;
const DIFF_VIEW_MAX_LINE_LENGTH = 2_000;

changeMaxLengthToIgnoreLineDiff(DIFF_VIEW_MAX_LINE_LENGTH);

type ParsedDiffSection = {
  title: string;
  files: Array<{
    key: string;
    oldFileName: string;
    newFileName: string;
    diffText: string;
    hunks: string[];
  }>;
};

type ParsedDiffEntry = ParsedDiffSection["files"][number] & {
  sectionKey: string;
  sectionTitle: string;
  displayName: string;
  fileName: string;
  pathSegments: string[];
  directoryPaths: string[];
  metrics: {
    chars: number;
    lines: number;
  };
  isTooLargeToRender: boolean;
};

type DiffTreeDirectory = {
  key: string;
  name: string;
  path: string;
  directories: DiffTreeDirectory[];
  files: ParsedDiffEntry[];
};

type DiffTreeSection = {
  key: string;
  title: string;
  root: DiffTreeDirectory;
};

export type WorktreeEnvironmentSubTab = "terminal" | "background";

function GitDiffAccordionContent({
  file,
  diffMode,
  diffTheme,
  diffWrap,
  diffHighlight,
  diffFontSize,
}: {
  file: ParsedDiffEntry;
  diffMode: DiffModeEnum;
  diffTheme: "light" | "dark";
  diffWrap: boolean;
  diffHighlight: boolean;
  diffFontSize: number;
}) {
  const primaryFileName = file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName;
  const oldLang = file.oldFileName !== "/dev/null" ? getLang(file.oldFileName) : "plaintext";
  const newLang = primaryFileName !== "/dev/null" ? getLang(primaryFileName) : "plaintext";

  return (
    <div className="max-h-[40rem] overflow-auto matrix-diff-file">
      <DiffView
        data={{
          oldFile: {
            fileName: file.oldFileName,
            fileLang: oldLang,
          },
          newFile: {
            fileName: file.newFileName,
            fileLang: newLang,
          },
          hunks: [file.diffText],
        }}
        diffViewMode={diffMode}
        diffViewTheme={diffTheme}
        diffViewWrap={diffWrap}
        diffViewHighlight={diffHighlight}
        diffViewFontSize={diffFontSize}
      />
    </div>
  );
}

function getDiffEntryMetrics(file: ParsedDiffSection["files"][number]) {
  return {
    chars: file.diffText.length,
    lines: file.diffText ? file.diffText.split("\n").length : 0,
  };
}

function isDiffEntryTooLargeToRender(file: ParsedDiffSection["files"][number]) {
  const metrics = getDiffEntryMetrics(file);
  return metrics.chars > DIFF_RENDER_MAX_CHARS || metrics.lines > DIFF_RENDER_MAX_LINES;
}

function getDiffDisplayName(file: ParsedDiffSection["files"][number]) {
  return file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName;
}

function getDiffPathSegments(file: ParsedDiffSection["files"][number]) {
  return getDiffDisplayName(file).split("/").filter(Boolean);
}

function getDiffDirectoryPaths(sectionKey: string, pathSegments: string[]) {
  const directoryPaths: string[] = [];
  let currentPath = sectionKey;

  for (const segment of pathSegments.slice(0, -1)) {
    currentPath = `${currentPath}/${segment}`;
    directoryPaths.push(currentPath);
  }

  return directoryPaths;
}

function getDiffChangeType(file: ParsedDiffSection["files"][number]) {
  if (file.oldFileName === "/dev/null") {
    return "Added";
  }

  if (file.newFileName === "/dev/null") {
    return "Deleted";
  }

  return "Modified";
}

function buildDiffTreeSections(entries: ParsedDiffEntry[]) {
  type MutableDiffTreeDirectory = DiffTreeDirectory & {
    directoryMap: Map<string, MutableDiffTreeDirectory>;
  };

  const sections = new Map<string, { title: string; root: MutableDiffTreeDirectory }>();

  for (const entry of entries) {
    let section = sections.get(entry.sectionKey);
    if (!section) {
      section = {
        title: entry.sectionTitle,
        root: {
          key: entry.sectionKey,
          name: "",
          path: entry.sectionKey,
          directories: [],
          files: [],
          directoryMap: new Map(),
        },
      };
      sections.set(entry.sectionKey, section);
    }

      let currentDirectory = section.root;
      for (let index = 0; index < entry.pathSegments.length - 1; index += 1) {
        const segment = entry.pathSegments[index];
        const nextPath = entry.directoryPaths[index];
        let nextDirectory = currentDirectory.directoryMap.get(segment);

        if (!nextDirectory) {
          nextDirectory = {
            key: nextPath,
            name: segment,
            path: nextPath,
            directories: [],
            files: [],
            directoryMap: new Map(),
          };
          currentDirectory.directoryMap.set(segment, nextDirectory);
          currentDirectory.directories.push(nextDirectory);
        }

        currentDirectory = nextDirectory;
      }

      currentDirectory.files.push(entry);
  }

  const sortDirectory = (directory: MutableDiffTreeDirectory): DiffTreeDirectory => ({
    key: directory.key,
    name: directory.name,
    path: directory.path,
    directories: directory.directories
      .map((child) => sortDirectory(child as MutableDiffTreeDirectory))
      .sort((left, right) => left.name.localeCompare(right.name)),
    files: [...directory.files].sort((left, right) => left.fileName.localeCompare(right.fileName)),
  });

  const treeSections = Array.from(sections.entries())
    .map(([key, section]) => ({
      key,
      title: section.title,
      root: sortDirectory(section.root),
    }))
    .sort((left, right) => left.title.localeCompare(right.title));

  const directoryPaths = treeSections.flatMap((section) => {
    const collectPaths = (directory: DiffTreeDirectory): string[] => [
      ...directory.directories.flatMap((child) => [child.path, ...collectPaths(child)]),
    ];

    return collectPaths(section.root);
  });

  return { treeSections, directoryPaths };
}

function GitDiffTreeDirectoryView({
  directory,
  depth,
  expandedPaths,
  selectedFileKey,
  onToggleDirectory,
  onSelectFile,
}: {
  directory: DiffTreeDirectory;
  depth: number;
  expandedPaths: Set<string>;
  selectedFileKey: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (file: ParsedDiffEntry) => void;
}) {
  const isExpanded = expandedPaths.has(directory.path);

  return (
    <div className="space-y-1">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-2 py-1 text-left text-xs theme-text-muted hover:theme-text-strong"
        style={{ paddingLeft: `${depth * 0.75 + 0.5}rem` }}
        onClick={() => onToggleDirectory(directory.path)}
      >
        <span className="w-4 text-center font-mono text-[11px] theme-text-soft">{isExpanded ? "-" : "+"}</span>
        <span className="truncate font-mono">{directory.name}</span>
      </button>

      {isExpanded ? (
        <div className="space-y-1">
          {directory.directories.map((child) => (
            <GitDiffTreeDirectoryView
              key={child.path}
              directory={child}
              depth={depth + 1}
              expandedPaths={expandedPaths}
              selectedFileKey={selectedFileKey}
              onToggleDirectory={onToggleDirectory}
              onSelectFile={onSelectFile}
            />
          ))}
          {directory.files.map((file) => (
            <button
              key={file.key}
              type="button"
              className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${selectedFileKey === file.key ? "theme-text-strong" : "theme-text-muted hover:theme-text-strong"}`}
              style={{ paddingLeft: `${(depth + 1) * 0.75 + 0.5}rem` }}
              onClick={() => onSelectFile(file)}
            >
              <span className="w-4 text-center font-mono text-[11px] theme-text-soft">*</span>
              <span className="min-w-0 flex-1 truncate font-mono">{file.fileName}</span>
              {file.isTooLargeToRender ? <MatrixBadge tone="warning" compact>Large</MatrixBadge> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function GitDiffTreeSectionView({
  section,
  expandedPaths,
  selectedFileKey,
  onToggleDirectory,
  onSelectFile,
}: {
  section: DiffTreeSection;
  expandedPaths: Set<string>;
  selectedFileKey: string | null;
  onToggleDirectory: (path: string) => void;
  onSelectFile: (file: ParsedDiffEntry) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-emphasis">{section.title}</div>
      <div className="space-y-1">
        {section.root.directories.map((directory) => (
          <GitDiffTreeDirectoryView
            key={directory.path}
            directory={directory}
            depth={0}
            expandedPaths={expandedPaths}
            selectedFileKey={selectedFileKey}
            onToggleDirectory={onToggleDirectory}
            onSelectFile={onSelectFile}
          />
        ))}
        {section.root.files.map((file) => (
          <button
            key={file.key}
            type="button"
            className={`flex w-full items-center gap-2 px-2 py-1 text-left text-xs ${selectedFileKey === file.key ? "theme-text-strong" : "theme-text-muted hover:theme-text-strong"}`}
            style={{ paddingLeft: "0.5rem" }}
            onClick={() => onSelectFile(file)}
          >
            <span className="w-4 text-center font-mono text-[11px] theme-text-soft">*</span>
            <span className="min-w-0 flex-1 truncate font-mono">{file.fileName}</span>
            {file.isTooLargeToRender ? <MatrixBadge tone="warning" compact>Large</MatrixBadge> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function getMergeActionState(worktreeBranch: string | undefined, gitComparison: GitComparisonResponse | null) {
  if (!worktreeBranch) {
    return { canMerge: false, reason: "Open a worktree branch to merge the selected base branch into it." };
  }

  if (!gitComparison) {
    return { canMerge: false, reason: "Load a git comparison to evaluate merge readiness." };
  }

  if (gitComparison.compareBranch !== worktreeBranch) {
    return { canMerge: false, reason: "Select the active worktree branch as the comparison branch." };
  }

  const mergeIntoWorktreeStatus = gitComparison.mergeIntoCompareStatus ?? gitComparison.mergeStatus;

  if (gitComparison.workingTreeSummary.dirty) {
    return { canMerge: false, reason: "Commit or stash local changes before merging." };
  }

  if (!mergeIntoWorktreeStatus.canMerge) {
    return {
      canMerge: false,
      reason: mergeIntoWorktreeStatus.reason ?? "Merge is not available for the current comparison.",
    };
  }

  return { canMerge: true, reason: null };
}

function getMergeIntoBaseActionState(worktreeBranch: string | undefined, gitComparison: GitComparisonResponse | null) {
  if (!worktreeBranch) {
    return { canMerge: false, reason: "Open a worktree branch to merge it into the selected base branch." };
  }

  if (!gitComparison) {
    return { canMerge: false, reason: "Load a git comparison to evaluate merge readiness." };
  }

  if (gitComparison.compareBranch !== worktreeBranch) {
    return { canMerge: false, reason: "Select the active worktree branch as the comparison branch." };
  }

  if (!gitComparison.mergeStatus.canMerge) {
    return {
      canMerge: false,
      reason: gitComparison.mergeStatus.reason ?? "Merge is not available for the current comparison.",
    };
  }

  return { canMerge: true, reason: null };
}

function formatConflictPreview(preview: string | null) {
  if (!preview) {
    return "Conflict preview unavailable.";
  }

  return preview;
}

function normalizeDiffPath(value: string) {
  const trimmed = value.trim().replace(/^"|"$/g, "");
  if (trimmed === "/dev/null") {
    return trimmed;
  }

  return trimmed.replace(/^[ab]\//, "");
}

function parseDiffBlock(block: string, key: string) {
  const lines = block.split("\n");
  const oldFileLine = lines.find((line) => line.startsWith("--- "));
  const newFileLine = lines.find((line) => line.startsWith("+++ "));

  if (!oldFileLine || !newFileLine) {
    return null;
  }

  const hunks: string[] = [];
  let currentHunk: string[] = [];

  for (const line of lines) {
    if (line.startsWith("@@ ")) {
      if (currentHunk.length) {
        hunks.push(currentHunk.join("\n"));
      }
      currentHunk = [line];
      continue;
    }

    if (currentHunk.length) {
      currentHunk.push(line);
    }
  }

  if (currentHunk.length) {
    hunks.push(currentHunk.join("\n"));
  }

  if (!hunks.length) {
    return null;
  }

  return {
    key,
    oldFileName: normalizeDiffPath(oldFileLine.slice(4)),
    newFileName: normalizeDiffPath(newFileLine.slice(4)),
    diffText: block.trim(),
    hunks,
  };
}

function parseDiffSections(raw: string) {
  const sections: ParsedDiffSection[] = [];
  let currentTitle = "Branch diff";
  let currentBlocks: string[] = [];
  let currentBlock: string[] = [];

  const flushBlock = () => {
    if (!currentBlock.length) {
      return;
    }
    currentBlocks.push(currentBlock.join("\n"));
    currentBlock = [];
  };

  const flushSection = () => {
    flushBlock();
    if (!currentBlocks.length) {
      return;
    }

    const files = currentBlocks
      .map((block, index) => parseDiffBlock(block, `${currentTitle}:${index}`))
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

    if (files.length) {
      sections.push({ title: currentTitle, files });
    }

    currentBlocks = [];
  };

  for (const line of raw.split("\n")) {
    if (line.startsWith("# ")) {
      flushSection();
      currentTitle = line.slice(2).trim();
      continue;
    }

    if (line.startsWith("diff --git ")) {
      flushBlock();
      currentBlock = [line];
      continue;
    }

    if (currentBlock.length) {
      currentBlock.push(line);
    }
  }

  flushSection();
  return sections;
}

interface WorktreeDetailProps {
  repoRoot: string | null;
  worktree: WorktreeRecord | null;
  autoSyncRemote: string | null;
  worktreeOptions: MatrixDropdownOption[];
  worktreeCount: number;
  runningCount: number;
  selectedStatusLabel: string;
  onSelectWorktree: (value: string) => void;
  activeTab: "environment" | "git" | "project-management" | "review" | "system" | "ai-log";
  onTabChange: (tab: "environment" | "git" | "project-management" | "review" | "system" | "ai-log") => void;
  environmentSubTab: WorktreeEnvironmentSubTab;
  onEnvironmentSubTabChange: (tab: WorktreeEnvironmentSubTab) => void;
  gitView: "graph" | "diff";
  onGitViewChange: (view: "graph" | "diff") => void;
  isTerminalVisible: boolean;
  onTerminalVisibilityChange: (visible: boolean) => void;
  commandPaletteShortcut: string;
  onCommandPaletteToggle: () => void;
  terminalShortcut: string;
  onTerminalShortcutToggle: () => void;
  isBusy: boolean;
  onStart: () => void;
  onStop: () => void;
  onSyncEnv: () => void;
  onDelete: () => void;
  onEnableAutoSync: () => void;
  onDisableAutoSync: () => void;
  onRunAutoSyncNow: () => void;
  backgroundCommands: BackgroundCommandState[];
  backgroundLogs: BackgroundCommandLogsResponse | null;
  gitComparison: GitComparisonResponse | null;
  gitComparisonLoading: boolean;
  onLoadBackgroundCommands: (branch: string) => Promise<BackgroundCommandState[]>;
  onStartBackgroundCommand: (branch: string, commandName: string) => Promise<BackgroundCommandState[]>;
  onRestartBackgroundCommand: (branch: string, commandName: string) => Promise<BackgroundCommandState[]>;
  onStopBackgroundCommand: (branch: string, commandName: string) => Promise<BackgroundCommandState[]>;
  onLoadBackgroundLogs: (branch: string, commandName: string) => Promise<BackgroundCommandLogsResponse>;
  onLoadGitComparison: (compareBranch: string, baseBranch?: string, options?: { silent?: boolean }) => Promise<GitComparisonResponse | null>;
  onSubscribeToGitComparison: (compareBranch: string, baseBranch?: string) => () => void;
  onMergeWorktreeIntoBase: (branch: string, baseBranch?: string) => Promise<GitComparisonResponse | null>;
  onMergeBaseIntoWorktree: (branch: string, baseBranch: string) => Promise<GitComparisonResponse | null>;
  onResolveGitMergeConflicts: (branch: string, baseBranch?: string, commandId?: AiCommandId) => Promise<GitComparisonResponse | null>;
  onGenerateGitCommitMessage: (branch: string, baseBranch?: string, commandId?: AiCommandId) => Promise<{ message: string } | null>;
  onCommitGitChanges: (branch: string, payload?: CommitChangesPayload) => Promise<CommitGitChangesResponse | null>;
  onSubscribeToBackgroundLogs: (branch: string, commandName: string) => () => void;
  onClearBackgroundLogs: () => void;
  projectManagementDocuments: ProjectManagementDocumentSummary[];
  projectManagementWorktrees: WorktreeRecord[];
  projectManagementAvailableTags: string[];
  projectManagementAvailableStatuses: string[];
  projectManagementUsers: ProjectManagementUsersResponse | null;
  projectManagementReviews: ProjectManagementDocumentReview[];
  projectManagementDocumentReview: ProjectManagementDocumentReview | null;
  projectManagementActiveSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocumentPresentation: ProjectManagementDocumentPresentation;
  projectManagementDocumentViewMode: ProjectManagementDocumentViewMode;
  projectManagementEditFormTab: ProjectManagementDocumentFormViewMode;
  projectManagementCreateFormTab: ProjectManagementDocumentFormViewMode;
  projectManagementDocument: ProjectManagementDocument | null;
  projectManagementHistory: ProjectManagementHistoryEntry[];
  projectManagementLoading: boolean;
  projectManagementError: string | null;
  projectManagementLastUpdatedAt: string | null;
  projectManagementSaving: boolean;
  projectManagementAiLogs: AiCommandLogSummary[];
  projectManagementAiLogDetail: AiCommandLogEntry | null;
  projectManagementSelectedAiLogJobId: string | null;
  projectManagementAiLogsLoading: boolean;
  projectManagementAiLogsError: string | null;
  projectManagementAiLogsLastUpdatedAt: string | null;
  projectManagementRunningAiJobs: AiCommandJob[];
  projectManagementAiActiveSubTab: AiActivitySubTab;
  systemStatus: SystemStatusResponse | null;
  systemLoading: boolean;
  systemError: string | null;
  systemLastUpdatedAt: string | null;
  systemSubTab: SystemSubTab;
  projectManagementAiCommands: AiCommandConfig | null;
  projectManagementAiJob: AiCommandJob | null;
  projectManagementDocumentAiJob: AiCommandJob | null;
  onProjectManagementSubTabChange: (tab: ProjectManagementSubTab) => void;
  onProjectManagementDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
  onProjectManagementEditFormTabChange: (mode: ProjectManagementDocumentFormViewMode) => void;
  onProjectManagementCreateFormTabChange: (mode: ProjectManagementDocumentFormViewMode) => void;
  onProjectManagementOpenDocumentPage: (documentId: string, options?: { viewMode?: ProjectManagementDocumentViewMode }) => void;
  onProjectManagementCloseDocument: () => void;
  onLoadProjectManagementDocuments: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementReviews: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementUsers: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onLoadProjectManagementAiLogs: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementAiLog: (jobId: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onProjectManagementAiSubTabChange: (tab: AiActivitySubTab) => void;
  onSystemSubTabChange: (tab: SystemSubTab) => void;
  onLoadSystemStatus: (options?: { silent?: boolean }) => Promise<SystemStatusResponse | null>;
  onCreateProjectManagementDocument: (payload: {
    title: string;
    summary?: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementDocument: (documentId: string, payload: {
    title: string;
    summary?: string;
    markdown: string;
    tags: string[];
    dependencies?: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocumentSummaryResponse | null>;
  onUpdateProjectManagementStatus: (documentId: string, status: string) => Promise<ProjectManagementDocumentSummaryResponse | null>;
  onUpdateProjectManagementUsers: (payload: UpdateProjectManagementUsersRequest) => Promise<ProjectManagementUsersResponse | null>;
  onBatchUpdateProjectManagementDocuments: (documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) => Promise<boolean>;
  onAddProjectManagementReviewEntry: (documentId: string, payload: { body: string }) => Promise<ProjectManagementDocumentReview | null>;
  onDeleteProjectManagementReviewEntry: (documentId: string, reviewEntryId: string) => Promise<boolean>;
  onRunProjectManagementAiCommand: (payload: RunAiCommandRequest & {
    input: string;
    documentId?: string;
    commandId: "smart" | "simple";
  }) => Promise<AiCommandJob | null>;
  onRunProjectManagementDocumentAi: (payload: {
    documentId: string;
    input?: string;
    commandId: AiCommandId;
    origin?: AiCommandOrigin | null;
    worktreeStrategy?: "new" | "continue-current";
    targetBranch?: string;
    worktreeName?: string;
  }) => Promise<RunAiCommandResponse | null>;
  onCancelProjectManagementDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onCancelProjectManagementAiCommand: () => Promise<AiCommandJob | null>;
  onCancelProjectManagementAiLogJob: (branch: string) => Promise<AiCommandJob | null>;
}

export function WorktreeDetail({
  repoRoot,
  worktree,
  autoSyncRemote,
  worktreeOptions,
  worktreeCount,
  runningCount,
  selectedStatusLabel,
  onSelectWorktree,
  activeTab,
  onTabChange,
  environmentSubTab,
  onEnvironmentSubTabChange,
  gitView,
  onGitViewChange,
  isTerminalVisible,
  onTerminalVisibilityChange,
  commandPaletteShortcut,
  onCommandPaletteToggle,
  terminalShortcut,
  onTerminalShortcutToggle,
  isBusy,
  onStart,
  onStop,
  onSyncEnv,
  onDelete,
  onEnableAutoSync,
  onDisableAutoSync,
  onRunAutoSyncNow,
  backgroundCommands,
  backgroundLogs,
  gitComparison,
  gitComparisonLoading,
  onLoadBackgroundCommands,
  onStartBackgroundCommand,
  onRestartBackgroundCommand,
  onStopBackgroundCommand,
  onLoadBackgroundLogs,
  onLoadGitComparison,
  onSubscribeToGitComparison,
  onMergeWorktreeIntoBase,
  onMergeBaseIntoWorktree,
  onResolveGitMergeConflicts,
  onGenerateGitCommitMessage,
  onCommitGitChanges,
  onSubscribeToBackgroundLogs,
  onClearBackgroundLogs,
  projectManagementDocuments,
  projectManagementWorktrees,
  projectManagementAvailableTags,
  projectManagementAvailableStatuses,
  projectManagementUsers,
  projectManagementReviews,
  projectManagementDocumentReview,
  projectManagementActiveSubTab,
  projectManagementSelectedDocumentId,
  projectManagementDocumentPresentation,
  projectManagementDocumentViewMode,
  projectManagementEditFormTab,
  projectManagementCreateFormTab,
  projectManagementDocument,
  projectManagementHistory,
  projectManagementLoading,
  projectManagementError,
  projectManagementLastUpdatedAt,
  projectManagementSaving,
  projectManagementAiLogs,
  projectManagementAiLogDetail,
  projectManagementSelectedAiLogJobId,
  projectManagementAiLogsLoading,
  projectManagementAiLogsError,
  projectManagementAiLogsLastUpdatedAt,
  projectManagementRunningAiJobs,
  projectManagementAiActiveSubTab,
  systemStatus,
  systemLoading,
  systemError,
  systemLastUpdatedAt,
  systemSubTab,
  projectManagementAiCommands,
  projectManagementAiJob,
  projectManagementDocumentAiJob,
  onProjectManagementSubTabChange,
  onProjectManagementDocumentViewModeChange,
  onProjectManagementEditFormTabChange,
  onProjectManagementCreateFormTabChange,
  onProjectManagementOpenDocumentPage,
  onProjectManagementCloseDocument,
  onLoadProjectManagementDocuments,
  onLoadProjectManagementReviews,
  onLoadProjectManagementUsers,
  onLoadProjectManagementDocument,
  onLoadProjectManagementAiLogs,
  onLoadProjectManagementAiLog,
  onProjectManagementAiSubTabChange,
  onSystemSubTabChange,
  onLoadSystemStatus,
  onCreateProjectManagementDocument,
  onUpdateProjectManagementDocument,
  onUpdateProjectManagementDependencies,
  onUpdateProjectManagementStatus,
  onUpdateProjectManagementUsers,
  onBatchUpdateProjectManagementDocuments,
  onAddProjectManagementReviewEntry,
  onDeleteProjectManagementReviewEntry,
  onRunProjectManagementAiCommand,
  onRunProjectManagementDocumentAi,
  onCancelProjectManagementDocumentAiCommand,
  onCancelProjectManagementAiCommand,
  onCancelProjectManagementAiLogJob,
}: WorktreeDetailProps) {
  const isEnvironmentTabActive = activeTab === "environment";
  const isAiLogTabActive = activeTab === "ai-log";
  const isGitTabActive = activeTab === "git";
  const isReviewTabActive = activeTab === "review";
  const isSystemTabActive = activeTab === "system";
  const isBackgroundCommandsActive = isEnvironmentTabActive && environmentSubTab === "background";
  const isRunning = Boolean(worktree?.runtime);
  const autoSyncState: WorktreeAutoSyncState | null = worktree?.autoSync ?? null;
  const isDocumentsBranch = worktree?.branch === "documents";
  const autoSyncEffectiveRemote = autoSyncState?.remote ?? autoSyncRemote ?? "origin";
  const deleteAiDisabledReason = useMemo(
    () => getWorktreeDeleteAiDisabledReason(projectManagementRunningAiJobs, worktree?.branch),
    [projectManagementRunningAiJobs, worktree?.branch],
  );
  const deleteDisabledReason = isBusy
    ? "A worktree action is already running."
    : deleteAiDisabledReason
      ? deleteAiDisabledReason
    : worktree?.deletion?.canDelete === false
      ? worktree.deletion.reason
      : null;
  const autoSyncStatusTone = useMemo(() => {
    if (!autoSyncState) {
      return "idle" as const;
    }

    switch (autoSyncState.status) {
      case "running":
        return "active" as const;
      case "paused":
        return "warning" as const;
      case "disabled":
        return "idle" as const;
      default:
        return "neutral" as const;
    }
  }, [autoSyncState]);
  const autoSyncStatusLabel = useMemo(() => {
    if (!isDocumentsBranch) {
      return "Documents only";
    }

    if (!autoSyncState) {
      return "Off";
    }

    switch (autoSyncState.status) {
      case "running":
        return "Syncing";
      case "paused":
        return "Paused";
      case "disabled":
        return "Off";
      default:
        return autoSyncState.enabled ? "Ready" : "Off";
    }
  }, [autoSyncState, isDocumentsBranch]);
  const autoSyncStatusContent = useMemo(() => {
    if (!worktree) {
      return undefined;
    }

    if (!isDocumentsBranch) {
      return (
        <div className="border theme-border-subtle theme-surface-soft px-3 py-2 text-sm theme-text-muted">
          Auto sync is only available on the documents branch.
        </div>
      );
    }

    if (!autoSyncState?.message) {
      return undefined;
    }

    const toneClass = autoSyncState.status === "paused"
      ? "border theme-border-danger theme-surface-danger theme-text-danger"
      : "border theme-border-subtle theme-surface-soft theme-text-muted";

    return (
      <div className={`${toneClass} px-3 py-2 text-sm`}>
        {autoSyncState.message}
      </div>
    );
  }, [autoSyncState, isDocumentsBranch, worktree]);
  const [copied, setCopied] = useState(false);
  const [selectedBackgroundCommandName, setSelectedBackgroundCommandName] = useState<string | null>(null);
  const [backgroundFilter, setBackgroundFilter] = useState("");
  const [selectedGitBaseBranch, setSelectedGitBaseBranch] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);
  const [diffTheme, setDiffTheme] = useState<"light" | "dark">("dark");
  const [diffWrap, setDiffWrap] = useState(false);
  const [diffHighlight, setDiffHighlight] = useState(true);
  const [diffFontSize, setDiffFontSize] = useState(13);
  const [selectedGitDiffFileKey, setSelectedGitDiffFileKey] = useState<string | null>(null);
  const [expandedGitDiffDirectories, setExpandedGitDiffDirectories] = useState<string[]>([]);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [commitMessageDraft, setCommitMessageDraft] = useState("");
  const [commitMessageLoading, setCommitMessageLoading] = useState(false);
  const [commitSubmitting, setCommitSubmitting] = useState(false);
  const [mergeConflictAiRunning, setMergeConflictAiRunning] = useState(false);
  const backgroundLogViewportRef = useRef<HTMLDivElement | null>(null);
  const linkedDocument = worktree?.linkedDocument ?? null;
  const linkedDocumentDetails = useMemo(
    () => linkedDocument
      ? projectManagementDocuments.find((entry) => entry.id === linkedDocument.id) ?? linkedDocument
      : null,
    [linkedDocument, projectManagementDocuments],
  );
  const linkedDocumentReview = useMemo(() => {
    if (!linkedDocument?.id) {
      return null;
    }

    if (projectManagementDocumentReview?.documentId === linkedDocument.id) {
      return projectManagementDocumentReview;
    }

    return projectManagementReviews.find((entry) => entry.documentId === linkedDocument.id) ?? null;
  }, [linkedDocument?.id, projectManagementDocumentReview, projectManagementReviews]);
  const linkedDocumentReviewEntries = linkedDocumentReview?.entries ?? [];
  const activeReviewAiJob = useMemo(() => {
    if (!worktree) {
      return null;
    }

    return projectManagementRunningAiJobs.find((job) => job.worktreeId === worktree.id || job.branch === worktree.branch) ?? null;
  }, [projectManagementRunningAiJobs, worktree]);
  const [reviewDraft, setReviewDraft] = useState("");
  const [reviewFollowUpDraft, setReviewFollowUpDraft] = useState("");
  const [reviewFollowUpSubmitting, setReviewFollowUpSubmitting] = useState(false);
  const [deletingReviewEntryId, setDeletingReviewEntryId] = useState<string | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef(0);
  const quickLinks = worktree?.runtime?.quickLinks ?? [];
  const tmuxSessionName = worktree?.runtime?.tmuxSession
    ?? (worktree && repoRoot ? getTmuxSessionName(repoRoot, worktree.id) : null);
  const attachCommand = tmuxSessionName
    ? `tmux attach-session -t '${tmuxSessionName.replace(/'/g, `'\\''`)}'`
    : null;
  const selectedBackgroundCommand = useMemo(
    () => backgroundCommands.find((entry) => entry.name === selectedBackgroundCommandName) ?? backgroundCommands[0] ?? null,
    [backgroundCommands, selectedBackgroundCommandName],
  );
  const backgroundCommandOptions = useMemo<MatrixDropdownOption[]>(
    () => backgroundCommands.map((command) => ({
      value: command.name,
      label: command.name,
      description: "PM2 managed",
      badgeLabel: command.running ? "Running" : "Stopped",
      badgeTone: command.running ? "active" : "idle",
    })),
    [backgroundCommands],
  );
  const gitBranchOptions = useMemo<MatrixDropdownOption[]>(
    () => (gitComparison?.branches ?? []).map((branch) => ({
      value: branch.name,
      label: branch.name,
      description: branch.default ? "Default branch" : branch.hasWorktree ? "Has worktree" : "Branch",
      badgeLabel: branch.default ? "Default" : branch.hasWorktree ? "Worktree" : undefined,
      badgeTone: branch.default ? "active" : branch.hasWorktree ? "idle" : undefined,
    })),
    [gitComparison?.branches],
  );
  const gitGraphData = useMemo(() => {
    if (!gitComparison) {
      return null;
    }

    const baseHashes = new Set(gitComparison.baseCommits.map((commit) => commit.hash));
    const compareHashes = new Set(gitComparison.compareCommits.map((commit) => commit.hash));

    return {
      baseCommits: gitComparison.baseCommits.filter((commit) => !compareHashes.has(commit.hash)),
      compareCommits: gitComparison.compareCommits.filter((commit) => !baseHashes.has(commit.hash)),
    };
  }, [gitComparison]);
  const gitGraphKey = useMemo(() => {
    if (!gitComparison) {
      return "empty";
    }

    return JSON.stringify({
      baseBranch: gitComparison.baseBranch,
      compareBranch: gitComparison.compareBranch,
      mergeBase: gitComparison.mergeBase?.hash ?? null,
      baseCommits: gitGraphData?.baseCommits.map((commit) => commit.hash) ?? [],
      compareCommits: gitGraphData?.compareCommits.map((commit) => commit.hash) ?? [],
    });
  }, [gitComparison, gitGraphData]);
  const gitGraphOptions = useMemo(
    () => ({
      orientation: Orientation.VerticalReverse,
      initCommitOffsetX: 70,
      initCommitOffsetY: 0,
      template: templateExtend(TemplateName.Metro, {
        colors: [
          getCssVariable("--base0B", "#4aff7a"),
          getCssVariable("--base0E", "#c084fc"),
          getCssVariable("--base0C", "#86efac"),
          getCssVariable("--base0A", "#facc15"),
          getCssVariable("--base0D", "#38bdf8"),
        ],
        branch: {
          spacing: 68,
          label: {
            font: '500 11px "JetBrains Mono", "IBM Plex Mono", monospace',
            bgColor: getCssVariable("--base01", "#1f1230"),
            color: getCssVariable("--base06", "#f3e8ff"),
            strokeColor: getCssVariable("--base0E", "#c084fc"),
          },
        },
        commit: {
          spacing: 42,
          dot: {
            size: 10,
            font: '600 10px "JetBrains Mono", "IBM Plex Mono", monospace',
          },
          message: {
            font: '500 11px "JetBrains Mono", "IBM Plex Mono", monospace',
            displayAuthor: false,
            displayHash: true,
          },
        },
      }),
    }),
    [gitComparison?.baseBranch, gitComparison?.compareBranch, gitView, worktree?.branch],
  );
  const parsedDiffSections = useMemo(
    () => gitComparison?.effectiveDiff ? parseDiffSections(gitComparison.effectiveDiff) : [],
    [gitComparison?.effectiveDiff],
  );
  const mergeActionState = useMemo(
    () => getMergeActionState(worktree?.branch, gitComparison),
    [gitComparison, worktree?.branch],
  );
  const mergeIntoBaseActionState = useMemo(
    () => getMergeIntoBaseActionState(worktree?.branch, gitComparison),
    [gitComparison, worktree?.branch],
  );
  const mergeAiDisabledReason = useMemo(
    () => getWorktreeMergeAiDisabledReason(projectManagementRunningAiJobs, [worktree?.branch, gitComparison?.baseBranch]),
    [gitComparison?.baseBranch, projectManagementRunningAiJobs, worktree?.branch],
  );
  const mergeIntoWorktreeStatus = gitComparison?.mergeIntoCompareStatus ?? gitComparison?.mergeStatus ?? null;
  const workingTreeConflictCount = gitComparison?.workingTreeSummary.conflictedFiles ?? gitComparison?.workingTreeConflicts.length ?? 0;
  const activeGitConflicts = gitComparison?.workingTreeConflicts.length
    ? gitComparison.workingTreeConflicts
    : mergeIntoWorktreeStatus?.hasConflicts
      ? mergeIntoWorktreeStatus.conflicts
      : [];
  const resolvableConflictCount = getResolvableConflictCount({
    workingTreeConflicts: workingTreeConflictCount,
    mergeIntoWorktreeConflicts: mergeIntoWorktreeStatus?.conflicts.length ?? 0,
  });
  const aiResolveButtonState = getAiResolveButtonState({
    hasWorktreeBranch: Boolean(worktree?.branch),
    gitComparisonLoading,
    mergeConflictAiRunning,
    resolvableConflicts: resolvableConflictCount,
  });
  const canMergeBaseIntoWorktree = mergeActionState.canMerge;
  const canMergeWorktreeIntoBase = mergeIntoBaseActionState.canMerge;
  const mergeButtonDisabledReason = gitComparisonLoading
    ? "Git comparison is updating."
    : mergeAiDisabledReason
      ? mergeAiDisabledReason
    : !canMergeBaseIntoWorktree
      ? mergeActionState.reason
      : null;
  const mergeIntoBaseButtonDisabledReason = gitComparisonLoading
    ? "Git comparison is updating."
    : mergeAiDisabledReason
      ? mergeAiDisabledReason
    : !canMergeWorktreeIntoBase
      ? mergeIntoBaseActionState.reason
      : null;
  const canCommitDiffChanges = Boolean(
    worktree?.branch
    && gitComparison
    && gitComparison.compareBranch === worktree.branch
    && gitComparison.workingTreeSummary.dirty,
  );
  const commitMessagePreview = commitMessageDraft.trim();
  const gitDiffFiles = useMemo<ParsedDiffEntry[]>(() => parsedDiffSections.flatMap((section, sectionIndex) => section.files.map((file) => {
    const displayName = getDiffDisplayName(file);
    const pathSegments = getDiffPathSegments(file);
    const sectionKey = `${section.title}:${sectionIndex}`;

    return {
      ...file,
      sectionKey,
      sectionTitle: section.title,
      displayName,
      fileName: pathSegments[pathSegments.length - 1] ?? displayName,
      pathSegments,
      directoryPaths: getDiffDirectoryPaths(sectionKey, pathSegments),
      metrics: getDiffEntryMetrics(file),
      isTooLargeToRender: isDiffEntryTooLargeToRender(file),
    };
  })), [parsedDiffSections]);
  const gitDiffTree = useMemo(() => buildDiffTreeSections(gitDiffFiles), [gitDiffFiles]);
  const selectedGitDiffFile = useMemo(
    () => gitDiffFiles.find((file) => file.key === selectedGitDiffFileKey) ?? gitDiffFiles[0] ?? null,
    [gitDiffFiles, selectedGitDiffFileKey],
  );
  const expandedGitDiffDirectorySet = useMemo(() => new Set(expandedGitDiffDirectories), [expandedGitDiffDirectories]);
  const handleGitDiffDirectoryToggle = useCallback((path: string) => {
    setExpandedGitDiffDirectories((current) => current.includes(path)
      ? current.filter((entry) => entry !== path)
      : [...current, path]);
  }, []);
  const handleGitDiffFileSelect = useCallback((file: ParsedDiffEntry) => {
    setSelectedGitDiffFileKey(file.key);
    if (!file.directoryPaths.length) {
      return;
    }

    setExpandedGitDiffDirectories((current) => {
      const next = new Set(current);
      for (const path of file.directoryPaths) {
        next.add(path);
      }
      return Array.from(next);
    });
  }, []);
  const diffModeOptions = useMemo<MatrixDropdownOption[]>(() => ([
    { value: String(DiffModeEnum.SplitGitHub), label: "Split GitHub", description: "GitHub-style split view" },
    { value: String(DiffModeEnum.SplitGitLab), label: "Split GitLab", description: "GitLab-style split view" },
    { value: String(DiffModeEnum.Split), label: "Split", description: "Plain split view" },
    { value: String(DiffModeEnum.Unified), label: "Unified", description: "Single-column unified view" },
  ]), []);
  const diffThemeOptions = useMemo<MatrixDropdownOption[]>(() => ([
    { value: "dark", label: "Dark", description: "Match the app theme" },
    { value: "light", label: "Light", description: "Use the viewer light theme" },
  ]), []);
  const diffFontSizeOptions = useMemo<MatrixDropdownOption[]>(() => ([12, 13, 14, 15, 16].map((size) => ({
    value: String(size),
    label: `${size}px`,
    description: "Diff font size",
  }))), []);
  const filteredBackgroundLogLines = useMemo(() => {
    const lines = backgroundLogs && selectedBackgroundCommand && backgroundLogs.commandName === selectedBackgroundCommand.name
      ? backgroundLogs.lines
      : [];
    if (!backgroundFilter.trim()) {
      return lines;
    }

    const query = backgroundFilter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(query));
  }, [backgroundFilter, backgroundLogs, selectedBackgroundCommand?.name]);
  const refreshProjectManagementWorkspace = useCallback(async (options?: { silent?: boolean; includeSelectedDocument?: boolean }) => {
    await onLoadProjectManagementDocuments(options);
    await onLoadProjectManagementReviews(options);
    await onLoadProjectManagementUsers(options);
    if (options?.includeSelectedDocument !== false && projectManagementSelectedDocumentId) {
      await onLoadProjectManagementDocument(projectManagementSelectedDocumentId, options);
    }
  }, [
    onLoadProjectManagementDocument,
    onLoadProjectManagementDocuments,
    onLoadProjectManagementReviews,
    onLoadProjectManagementUsers,
    projectManagementSelectedDocumentId,
  ]);
  const refreshAiLogs = useCallback(async (options?: { silent?: boolean }) => {
    await onLoadProjectManagementAiLogs(options);
  }, [onLoadProjectManagementAiLogs]);
  const refreshSystemStatus = useCallback(async (options?: { silent?: boolean }) => {
    await onLoadSystemStatus(options);
  }, [onLoadSystemStatus]);

  useEffect(() => {
    if (!selectedBackgroundCommandName && backgroundCommands[0]) {
      setSelectedBackgroundCommandName(backgroundCommands[0].name);
      return;
    }

    if (selectedBackgroundCommandName && !backgroundCommands.some((entry) => entry.name === selectedBackgroundCommandName)) {
      setSelectedBackgroundCommandName(backgroundCommands[0]?.name ?? null);
    }
  }, [backgroundCommands, selectedBackgroundCommandName]);

  useEffect(() => {
    if (activeTab !== "git" || !worktree?.branch) {
      return;
    }

    void onLoadGitComparison(worktree.branch, selectedGitBaseBranch ?? undefined, { silent: true });
    return onSubscribeToGitComparison(worktree.branch, selectedGitBaseBranch ?? undefined);
  }, [activeTab, onLoadGitComparison, onSubscribeToGitComparison, selectedGitBaseBranch, worktree?.branch]);

  useEffect(() => {
    if (!gitComparison) {
      return;
    }

    if (!selectedGitBaseBranch) {
      setSelectedGitBaseBranch(gitComparison.baseBranch);
      return;
    }

    if (!gitComparison.branches.some((branch) => branch.name === selectedGitBaseBranch)) {
      setSelectedGitBaseBranch(gitComparison.baseBranch);
    }
  }, [gitComparison, selectedGitBaseBranch]);

  useEffect(() => {
    if (!gitDiffFiles.length) {
      if (selectedGitDiffFileKey !== null) {
        setSelectedGitDiffFileKey(null);
      }
      return;
    }

    if (!selectedGitDiffFileKey || !gitDiffFiles.some((file) => file.key === selectedGitDiffFileKey)) {
      setSelectedGitDiffFileKey(gitDiffFiles[0].key);
    }
  }, [gitDiffFiles, selectedGitDiffFileKey]);

  useEffect(() => {
    if (!gitDiffTree.directoryPaths.length) {
      if (expandedGitDiffDirectories.length) {
        setExpandedGitDiffDirectories([]);
      }
      return;
    }

    setExpandedGitDiffDirectories((current) => {
      const valid = current.filter((path) => gitDiffTree.directoryPaths.includes(path));
      if (valid.length) {
        return valid;
      }
      return gitDiffTree.directoryPaths;
    });
  }, [expandedGitDiffDirectories.length, gitDiffTree.directoryPaths]);

  useEffect(() => {
    if (!isBackgroundCommandsActive || !worktree?.branch) {
      return;
    }

    void onLoadBackgroundCommands(worktree.branch);
  }, [isBackgroundCommandsActive, onLoadBackgroundCommands, worktree?.branch]);

  useEffect(() => {
    if (!isBackgroundCommandsActive || !worktree?.branch || !selectedBackgroundCommand?.name) {
      onClearBackgroundLogs();
      return;
    }

    shouldStickToBottomRef.current = true;
    previousScrollHeightRef.current = 0;

    let cancelled = false;

    const loadInitialLogs = async () => {
      await onLoadBackgroundLogs(worktree.branch, selectedBackgroundCommand.name);
      if (cancelled) {
        return;
      }

      const viewport = backgroundLogViewportRef.current;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        previousScrollHeightRef.current = viewport.scrollHeight;
      }
    };

    void loadInitialLogs();
    const unsubscribe = onSubscribeToBackgroundLogs(worktree.branch, selectedBackgroundCommand.name);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    isBackgroundCommandsActive,
    onClearBackgroundLogs,
    onLoadBackgroundLogs,
    onSubscribeToBackgroundLogs,
    selectedBackgroundCommand?.name,
    worktree?.branch,
  ]);

  useEffect(() => {
    const viewport = backgroundLogViewportRef.current;
    if (!viewport) {
      return;
    }

    const previousScrollHeight = previousScrollHeightRef.current;
    const nextScrollHeight = viewport.scrollHeight;

    if (shouldStickToBottomRef.current) {
      viewport.scrollTop = nextScrollHeight;
    } else if (previousScrollHeight > 0 && nextScrollHeight > previousScrollHeight) {
      viewport.scrollTop += nextScrollHeight - previousScrollHeight;
    }

    previousScrollHeightRef.current = nextScrollHeight;
  }, [filteredBackgroundLogLines]);

  const handleBackgroundLogScroll = () => {
    const viewport = backgroundLogViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 12;
  };

  const copyAttachCommand = async () => {
    if (!attachCommand) {
      return;
    }

    await navigator.clipboard.writeText(attachCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const openCommitModal = () => {
    if (!worktree?.branch || !gitComparison) {
      return;
    }

    setCommitModalOpen(true);
    setCommitMessageDraft("");
    setCommitMessageLoading(false);
    setCommitSubmitting(false);
  };

  const generateCommitMessage = async () => {
    if (!worktree?.branch || !gitComparison) {
      return;
    }

    setCommitMessageLoading(true);
    try {
      const result = await onGenerateGitCommitMessage(worktree.branch, gitComparison.baseBranch, "simple");
      setCommitMessageDraft(result?.message ?? "");
    } finally {
      setCommitMessageLoading(false);
    }
  };

  const submitCommit = async () => {
    if (!worktree?.branch || !gitComparison || !commitMessagePreview) {
      return;
    }

    setCommitSubmitting(true);
    try {
      const result = await onCommitGitChanges(worktree.branch, {
        baseBranch: gitComparison.baseBranch,
        commandId: "simple",
        message: commitMessageDraft,
      });

      if (result) {
        setCommitModalOpen(false);
        setCommitMessageDraft("");
      }
    } finally {
      setCommitSubmitting(false);
    }
  };

  const resolveMergeConflicts = async () => {
    if (!worktree?.branch || !gitComparison) {
      return;
    }

    if (resolvableConflictCount === 0) {
      return;
    }

    setMergeConflictAiRunning(true);
    try {
      await onResolveGitMergeConflicts(worktree.branch, gitComparison.baseBranch, "smart");
    } finally {
      setMergeConflictAiRunning(false);
    }
  };

  const openLinkedDocument = async () => {
    if (!linkedDocument?.id) {
      return;
    }

    onTabChange("project-management");
    onProjectManagementSubTabChange("document");
    onProjectManagementDocumentViewModeChange("document");
    await onLoadProjectManagementDocument(linkedDocument.id, { silent: true });
  };

  const submitReviewEntry = async () => {
    if (!linkedDocument?.id || !reviewDraft.trim()) {
      return;
    }

    const nextReview = await onAddProjectManagementReviewEntry(linkedDocument.id, { body: reviewDraft });
    if (nextReview) {
      setReviewDraft("");
    }
  };

  const submitReviewFollowUp = async () => {
    if (!linkedDocument?.id || !reviewFollowUpDraft.trim() || reviewFollowUpSubmitting) {
      return;
    }

    const trimmedDraft = reviewFollowUpDraft.trim();
    const parsedCommand = trimmedDraft.match(/^@(dowork|review)\b/i);
    const reviewAction = parsedCommand?.[1]?.toLowerCase() === "review" ? "review" : "implement";
    const requestText = trimmedDraft.replace(/^@(dowork|review)\b\s*/i, "").trim() || trimmedDraft;
    const latestAiRequest = [...linkedDocumentReviewEntries]
      .reverse()
      .find((entry) => entry.source === "ai" && entry.eventType === "ai-started");
    const originalRequest = latestAiRequest?.body.trim() || linkedDocumentDetails?.summary || linkedDocument.title;

    setReviewFollowUpSubmitting(true);
    try {
      const job = await onRunProjectManagementAiCommand({
        input: requestText,
        reviewDocumentId: linkedDocument.id,
        commandId: "smart",
        reviewAction,
        origin: {
          kind: "worktree-review",
          label: reviewAction === "review" ? "Review pass" : "Review follow-up",
          description: reviewAction === "review"
            ? `Review branch changes for ${linkedDocument.title}`
            : `Continue review activity for ${linkedDocument.title}`,
          location: {
            tab: "review",
            branch: worktree?.branch ?? null,
            worktreeId: worktree?.id ?? null,
            documentId: linkedDocument.id,
          },
        },
        reviewFollowUp: reviewAction === "review"
          ? undefined
          : {
              originalRequest,
              newRequest: requestText,
            },
      });

      if (job) {
        setReviewFollowUpDraft("");
      }
    } finally {
      setReviewFollowUpSubmitting(false);
    }
  };

  const deleteReviewEntry = async (entry: ProjectManagementReviewEntry) => {
    if (!linkedDocument?.id || deletingReviewEntryId) {
      return;
    }

    setDeletingReviewEntryId(entry.id);
    try {
      await onDeleteProjectManagementReviewEntry(linkedDocument.id, entry.id);
    } finally {
      setDeletingReviewEntryId(null);
    }
  };

  const openAiLogOrigin = async (origin: AiCommandJob["origin"] | AiCommandLogEntry["origin"] | AiCommandLogSummary["origin"]) => {
    if (!origin) {
      return;
    }

    if (origin.location.branch) {
      onSelectWorktree(origin.location.branch);
    }

    if (origin.location.tab === "project-management") {
      onTabChange("project-management");
      onProjectManagementSubTabChange(mapOriginProjectManagementSubTabToUiTab(origin.location.projectManagementSubTab));
      onProjectManagementDocumentViewModeChange(origin.location.projectManagementDocumentViewMode ?? "document");
      if (origin.location.documentId) {
        await onLoadProjectManagementDocument(origin.location.documentId, { silent: true });
      }
      return;
    }

    if (origin.location.tab === "review") {
      onTabChange("review");
      if (origin.location.documentId) {
        await onLoadProjectManagementDocument(origin.location.documentId, { silent: true });
      }
      return;
    }

    const originTab = origin.location.tab as string;
    if (originTab === "git" || originTab === "merge") {
      onTabChange("git");
      return;
    }

    onTabChange("environment");
    onEnvironmentSubTabChange(origin.location.environmentSubTab ?? "terminal");
  };

  const gitDiffView = (
    <>
      <div className="theme-inline-panel p-4">
        <MatrixTabs
          groupId="worktree-diff-view-tabs"
          ariaLabel="Git view tabs"
          activeTabId={gitView}
          onChange={onGitViewChange}
          className="theme-divider border-b pb-3"
          tabs={[
            { id: "graph", label: "Graph" },
            { id: "diff", label: "Diff" },
          ]}
        />

        <div className="mt-3">
          <MatrixSectionIntro
            kicker="Git / Diff"
            title="Branch diff"
            description="Review the diff between this worktree and the base branch, including staged, unstaged, and untracked local changes."
            actions={(
              <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto] xl:min-w-[24rem] xl:grid-cols-[minmax(16rem,1fr)_auto]">
                <MatrixDropdown
                  label="Base branch"
                  value={selectedGitBaseBranch}
                  options={gitBranchOptions}
                  placeholder="Choose base branch"
                  disabled={!gitBranchOptions.length}
                  emptyLabel="No branches available"
                  onChange={setSelectedGitBaseBranch}
                />
                <button
                  type="button"
                  className="matrix-button rounded-none px-3 py-2 text-sm"
                  disabled={!canCommitDiffChanges || gitComparisonLoading || !worktree?.branch}
                  onClick={() => {
                    if (!worktree?.branch || !gitComparison) {
                      return;
                    }
                    void openCommitModal();
                  }}
                >
                  Commit
                </button>
              </div>
            )}
          />
        </div>

        {gitComparison ? (
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
            <MatrixDetailField label="Base" value={gitComparison.baseBranch} mono />
            <MatrixDetailField label="Compare" value={gitComparison.compareBranch} mono />
            <MatrixDetailField label="Ahead" value={String(gitComparison.ahead)} mono />
            <MatrixDetailField label="Behind" value={String(gitComparison.behind)} mono />
          </div>
        ) : null}

        {gitComparison ? (
          <div className="mt-3 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
            <MatrixDetailField label="Changed files" value={String(gitComparison.workingTreeSummary.changedFiles)} mono />
            <MatrixDetailField label="Conflicted files" value={String(gitComparison.workingTreeSummary.conflictedFiles ?? 0)} mono />
            <MatrixDetailField label="Untracked files" value={String(gitComparison.workingTreeSummary.untrackedFiles)} mono />
            <MatrixDetailField
              label="Status"
              value={gitComparison.workingTreeSummary.conflicted ? "Conflicted" : gitComparison.workingTreeSummary.unstaged ? "Unstaged" : "Clean"}
              mono
            />
          </div>
        ) : null}
      </div>

      {!gitComparison && gitComparisonLoading ? (
        <div className="matrix-command rounded-none px-4 py-3 text-sm theme-empty-note">Loading git comparison…</div>
      ) : gitComparison ? gitView === "graph" ? (
        gitComparison.ahead === 0 && gitComparison.behind === 0 ? (
          <div className="theme-inline-panel p-4">
            <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
              The branches are identical.
            </div>
          </div>
        ) : (
          <div className="matrix-diff-panel p-4">
            <div className="overflow-auto">
              <div className="matrix-diff-surface px-4 pb-4 pt-6">
                <Gitgraph key={gitGraphKey} options={gitGraphOptions}>
                  {(gitgraph) => {
                    gitgraph.clear();

                    const base = gitgraph.branch(gitComparison.baseBranch);

                    if (gitComparison.mergeBase) {
                      base.commit({
                        subject: gitComparison.mergeBase.subject,
                        hash: gitComparison.mergeBase.hash,
                        author: gitComparison.mergeBase.authorName,
                      });
                    }

                    const compare = base.branch(gitComparison.compareBranch);

                    for (const commit of gitGraphData?.baseCommits ?? []) {
                      base.commit({
                        subject: commit.subject,
                        hash: commit.hash,
                        author: commit.authorName,
                      });
                    }

                    for (const commit of gitGraphData?.compareCommits ?? []) {
                      compare.commit({
                        subject: commit.subject,
                        hash: commit.hash,
                        author: commit.authorName,
                      });
                    }
                  }}
                </Gitgraph>
              </div>
            </div>
          </div>
        )
      ) : (
        <div className="theme-inline-panel p-4">
          <div className="flex flex-col gap-3">
            <div className="grid gap-2 xl:grid-cols-[minmax(15rem,18rem)_minmax(11rem,13rem)_minmax(11rem,13rem)_auto_auto]">
              <MatrixDropdown
                label="View mode"
                value={String(diffMode)}
                options={diffModeOptions}
                placeholder="Choose diff mode"
                onChange={(value) => setDiffMode(Number(value) as DiffModeEnum)}
              />
              <MatrixDropdown
                label="Theme"
                value={diffTheme}
                options={diffThemeOptions}
                placeholder="Choose theme"
                onChange={(value) => setDiffTheme(value as "light" | "dark")}
              />
              <MatrixDropdown
                label="Font size"
                value={String(diffFontSize)}
                options={diffFontSizeOptions}
                placeholder="Choose font size"
                onChange={(value) => setDiffFontSize(Number(value))}
              />
              <button
                type="button"
                className={`matrix-button rounded-none px-3 py-2 text-sm ${diffWrap ? "theme-pill-emphasis theme-text-strong" : ""}`}
                onClick={() => setDiffWrap((current) => !current)}
              >
                Wrap {diffWrap ? "on" : "off"}
              </button>
              <button
                type="button"
                className={`matrix-button rounded-none px-3 py-2 text-sm ${diffHighlight ? "theme-pill-emphasis theme-text-strong" : ""}`}
                onClick={() => setDiffHighlight((current) => !current)}
              >
                Highlight {diffHighlight ? "on" : "off"}
              </button>
            </div>

            {gitComparison.effectiveDiff ? gitDiffFiles.length ? (
              <div className="grid gap-4 xl:grid-cols-[22rem_minmax(0,1fr)]">
                <div className="border theme-border-subtle p-4">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.18em] theme-text-soft">Changed files</p>
                    <MatrixBadge tone="neutral" compact>{gitDiffFiles.length}</MatrixBadge>
                  </div>
                  <div className="mt-3 max-h-[40rem] space-y-4 overflow-y-auto pr-1">
                    {gitDiffTree.treeSections.map((section) => (
                      <GitDiffTreeSectionView
                        key={section.key}
                        section={section}
                        expandedPaths={expandedGitDiffDirectorySet}
                        selectedFileKey={selectedGitDiffFile?.key ?? null}
                        onToggleDirectory={handleGitDiffDirectoryToggle}
                        onSelectFile={handleGitDiffFileSelect}
                      />
                    ))}
                  </div>
                </div>

                <div className="border theme-border-subtle p-4">
                  {selectedGitDiffFile ? (
                    <div className="space-y-4">
                      <MatrixCard as="div" className="p-3">
                        <MatrixCardHeader
                          eyebrow={<span className="theme-text-soft">{selectedGitDiffFile.sectionTitle}</span>}
                          title={<span className="font-mono text-sm">{selectedGitDiffFile.displayName}</span>}
                          titleLines={2}
                          titleText={selectedGitDiffFile.displayName}
                          description={`${selectedGitDiffFile.hunks.length} hunk${selectedGitDiffFile.hunks.length === 1 ? "" : "s"}`}
                          descriptionLines={1}
                          descriptionText={`${selectedGitDiffFile.hunks.length} hunk${selectedGitDiffFile.hunks.length === 1 ? "" : "s"}`}
                          badges={(
                            <>
                              <MatrixBadge tone="neutral" compact>{getDiffChangeType(selectedGitDiffFile)}</MatrixBadge>
                              {selectedGitDiffFile.isTooLargeToRender ? <MatrixBadge tone="warning" compact>Too large</MatrixBadge> : null}
                            </>
                          )}
                        />
                        <MatrixCardFooter className="mt-3 justify-between gap-x-3 gap-y-1 text-xs theme-text-muted">
                          <span>{selectedGitDiffFile.metrics.lines.toLocaleString()} lines</span>
                          <span>{selectedGitDiffFile.metrics.chars.toLocaleString()} chars</span>
                        </MatrixCardFooter>
                      </MatrixCard>

                      {selectedGitDiffFile.isTooLargeToRender ? (
                        <div className="theme-inline-panel-warning px-4 py-4 text-sm theme-text-warning">
                          This file diff is too large to render safely in the browser.
                          <div className="mt-2 font-mono text-xs theme-text-warning-soft">
                            {selectedGitDiffFile.metrics.lines.toLocaleString()} lines, {selectedGitDiffFile.metrics.chars.toLocaleString()} chars
                          </div>
                        </div>
                      ) : (
                        <GitDiffAccordionContent
                          file={selectedGitDiffFile}
                          diffMode={diffMode}
                          diffTheme={diffTheme}
                          diffWrap={diffWrap}
                          diffHighlight={diffHighlight}
                          diffFontSize={diffFontSize}
                        />
                      )}
                    </div>
                  ) : (
                    <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                      Select a changed file to inspect its diff.
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="theme-inline-panel-warning px-4 py-4 text-sm theme-text-warning">
                Diff data could not be parsed into file hunks for the visual viewer.
              </div>
            ) : (
              <div className="px-4 py-4 theme-empty-note">No effective diff between these branches or in the selected worktree.</div>
            )}
          </div>
        </div>
      ) : (
        <div className="matrix-command rounded-none px-4 py-3 text-sm theme-empty-note">
          Select a worktree to load branch comparison details.
        </div>
      )}
    </>
  );

  const comparisonWorkspace = (
    <>
      <div className="theme-inline-panel p-4">
        <MatrixTabs
          groupId="worktree-merge-view-tabs"
          ariaLabel="Git view tabs"
          activeTabId={gitView}
          onChange={onGitViewChange}
          className="theme-divider border-b pb-3"
          tabs={[
            { id: "graph", label: "Graph" },
            { id: "diff", label: "Diff" },
          ]}
        />

        <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="matrix-kicker">Pull request / Changes</p>
            <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">Branch comparison</h2>
            <p className="mt-2 text-sm theme-text-muted">
              Compare the selected worktree against the base branch, including staged, unstaged, and untracked local changes in the effective diff.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto_auto_auto_auto] xl:min-w-[42rem] xl:grid-cols-[minmax(16rem,1fr)_auto_auto_auto_auto]">
            <MatrixDropdown
              label="Base branch"
              value={selectedGitBaseBranch}
              options={gitBranchOptions}
              placeholder="Choose base branch"
              disabled={!gitBranchOptions.length}
              emptyLabel="No branches available"
              onChange={setSelectedGitBaseBranch}
            />
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              disabled={!canCommitDiffChanges || gitComparisonLoading || !worktree?.branch}
              onClick={() => {
                if (!worktree?.branch || !gitComparison) {
                  return;
                }
                void openCommitModal();
              }}
            >
              Commit
            </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                disabled={!canMergeWorktreeIntoBase || gitComparisonLoading || !worktree?.branch || !gitComparison?.baseBranch}
                title={mergeIntoBaseButtonDisabledReason ?? `Merge ${worktree?.branch ?? "worktree"} into ${gitComparison?.baseBranch ?? "base"}`}
                aria-label={mergeIntoBaseButtonDisabledReason
                ? `Merge disabled: ${mergeIntoBaseButtonDisabledReason}`
                : `Merge ${worktree?.branch ?? "worktree"} into ${gitComparison?.baseBranch ?? "base"}`
              }
                onClick={() => {
                  if (!worktree?.branch) {
                    return;
                  }
                  void onMergeWorktreeIntoBase(worktree.branch, gitComparison?.baseBranch);
                }}
              >
                Merge into base
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                disabled={!canMergeBaseIntoWorktree || gitComparisonLoading || !worktree?.branch || !gitComparison?.baseBranch}
              title={mergeButtonDisabledReason ?? `Merge ${gitComparison?.baseBranch ?? "base"} into ${worktree?.branch ?? "worktree"}`}
              aria-label={mergeButtonDisabledReason
                ? `Merge disabled: ${mergeButtonDisabledReason}`
                : `Merge ${gitComparison?.baseBranch ?? "base"} into ${worktree?.branch ?? "worktree"}`
              }
                onClick={() => {
                  if (!worktree?.branch || !gitComparison?.baseBranch) {
                    return;
                  }
                  void onMergeBaseIntoWorktree(worktree.branch, gitComparison.baseBranch);
                }}
              >
                Merge base into main
              </button>
            <button
              type="button"
              className="matrix-button rounded-none px-3 py-2 text-sm"
              disabled={aiResolveButtonState.disabled}
              title={aiResolveButtonState.title}
              onClick={() => {
                void resolveMergeConflicts();
              }}
            >
              {aiResolveButtonState.label}
            </button>
          </div>
        </div>

        {gitComparison ? (
          <div className="mt-4 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
            <MatrixDetailField label="Base" value={gitComparison.baseBranch} mono />
            <MatrixDetailField label="Compare" value={gitComparison.compareBranch} mono />
            <MatrixDetailField label="Ahead" value={String(gitComparison.ahead)} mono />
            <MatrixDetailField label="Behind" value={String(gitComparison.behind)} mono />
          </div>
        ) : null}

        {!canMergeBaseIntoWorktree && mergeActionState.reason ? (
          <div className="mt-3 text-xs theme-text-danger">
            Merge base into main disabled: {mergeActionState.reason}
          </div>
        ) : null}

        {!canMergeWorktreeIntoBase && mergeIntoBaseActionState.reason ? (
          <div className="mt-3 text-xs theme-text-danger">
            Merge into base disabled: {mergeIntoBaseActionState.reason}
          </div>
        ) : null}

        {activeGitConflicts.length > 0 ? (
          <div className="mt-3 space-y-3 border theme-border-danger theme-surface-danger px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="matrix-kicker theme-kicker-danger">Merge conflicts</p>
                <p className="mt-1 text-sm theme-text-danger">
                  {gitComparison?.workingTreeSummary.conflicted
                    ? "This worktree has unresolved git conflict markers. Review the files below or let Smart AI draft resolved file contents."
                    : `Merging \`${gitComparison?.baseBranch ?? "the base branch"}\` into this worktree will conflict. Review the markers below or let Smart AI draft resolved file contents.`}
                </p>
              </div>
              <MatrixBadge tone="danger">
                {activeGitConflicts.length} conflict{activeGitConflicts.length === 1 ? "" : "s"}
              </MatrixBadge>
            </div>
            <div className="space-y-3">
              {activeGitConflicts.map((conflict) => (
                <div key={conflict.path} className="border theme-border-danger bg-black/20">
                  <div className="flex items-center justify-between gap-3 border-b theme-border-danger px-3 py-2">
                    <div className="font-mono text-xs theme-text-danger">{conflict.path}</div>
                    {conflict.truncated ? <div className="text-[11px] theme-text-danger">Preview truncated</div> : null}
                  </div>
                  <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words px-3 py-3 font-mono text-xs theme-text-danger">{formatConflictPreview(conflict.preview)}</pre>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {gitComparison ? (
          <div className="mt-3 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
            <MatrixDetailField label="Changed files" value={String(gitComparison.workingTreeSummary.changedFiles)} mono />
            <MatrixDetailField label="Conflicted files" value={String(gitComparison.workingTreeSummary.conflictedFiles ?? 0)} mono />
            <MatrixDetailField label="Untracked files" value={String(gitComparison.workingTreeSummary.untrackedFiles)} mono />
            <MatrixDetailField
              label="Staged"
              value={gitComparison.workingTreeSummary.staged ? "Yes" : "No"}
              mono
            />
            <MatrixDetailField
              label="Status"
              value={gitComparison.workingTreeSummary.conflicted ? "Conflicted" : gitComparison.workingTreeSummary.unstaged ? "Unstaged" : "Clean"}
              mono
            />
          </div>
        ) : null}
      </div>

      {gitDiffView}
    </>
  );

  return (
    <section className="min-w-0 space-y-3 xl:flex xl:min-h-[calc(100vh-1rem)] xl:flex-col xl:space-y-3">
      <div className="matrix-panel rounded-none border-x-0 border-t-0 p-4 lg:p-4">
        {isEnvironmentTabActive ? (
          <>
            <MatrixTabs
              groupId="worktree-environment-tabs"
              ariaLabel="Worktree environment tabs"
              activeTabId={environmentSubTab}
              onChange={onEnvironmentSubTabChange}
              className="theme-divider border-b pb-3"
              tabs={[
                { id: "terminal", label: WORKTREE_ENVIRONMENT_TERMINAL_SUB_TAB_LABEL },
                { id: "background", label: WORKTREE_ENVIRONMENT_BACKGROUND_SUB_TAB_LABEL },
              ]}
            />

            {environmentSubTab === "terminal" ? (
              <>
                <MatrixSectionIntro
                  className="mt-3"
                  kicker={WORKTREE_ENVIRONMENT_KICKER}
                  title={(
                    <div className="flex flex-wrap items-center gap-2">
                      <span>{worktree?.branch ?? "Select a worktree"}</span>
                      <MatrixBadge tone={worktree?.runtime ? "active" : "idle"} compact>
                        {worktree?.runtime ? "tmux attached" : "idle"}
                      </MatrixBadge>
                      {worktree ? (
                        <MatrixBadge tone={autoSyncStatusTone} compact>
                          auto sync {autoSyncStatusLabel.toLowerCase()}
                        </MatrixBadge>
                      ) : null}
                      {worktree?.runtime?.runtimeStartedAt ? (
                        <MatrixBadge tone="active" compact>
                          live since {new Date(worktree.runtime.runtimeStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </MatrixBadge>
                      ) : null}
                      {linkedDocument ? (
                        <MatrixBadge tone={linkedDocument.archived ? "warning" : "active"} compact>
                          linked doc #{linkedDocument.number}
                        </MatrixBadge>
                      ) : null}
                    </div>
                  )}
                  description={worktree ? WORKTREE_ENVIRONMENT_DESCRIPTION : WORKTREE_ENVIRONMENT_EMPTY_DESCRIPTION}
                  metrics={(
                    <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[22rem] xl:grid-cols-[repeat(3,minmax(0,1fr))]">
                      <MatrixMetric label="Worktrees" value={String(worktreeCount)} />
                      <MatrixMetric label="Running" value={String(runningCount)} />
                      <MatrixMetric label="Selected" value={selectedStatusLabel} />
                    </div>
                  )}
                  actions={worktree ? (
                    <>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || isRunning} onClick={onStart}>Start env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || !isRunning} onClick={onStop}>Stop env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onSyncEnv}>Sync .env</button>
                      {isDocumentsBranch ? (
                        autoSyncState?.enabled ? (
                          <>
                            <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onRunAutoSyncNow}>Sync now</button>
                            <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onDisableAutoSync}>Turn off auto sync</button>
                          </>
                        ) : (
                          <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onEnableAutoSync}>Turn on auto sync</button>
                        )
                      ) : null}
                      <button type="button" className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-sm" disabled={Boolean(deleteDisabledReason)} onClick={onDelete} title={deleteDisabledReason ?? undefined}>
                        Delete
                      </button>
                    </>
                  ) : undefined}
                  status={(
                    <>
                      {autoSyncStatusContent}
                      {deleteDisabledReason ? (
                        <div className="border theme-border-danger theme-surface-danger px-3 py-2 text-sm theme-text-danger">
                          {deleteDisabledReason}
                        </div>
                      ) : null}
                    </>
                  )}
                />

                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                  <MatrixDetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
                  <MatrixDetailField label="Head" value={worktree?.headSha ?? "-"} mono />
                  <MatrixDetailField label="Started" value={worktree?.runtime?.runtimeStartedAt ? new Date(worktree.runtime.runtimeStartedAt).toLocaleString() : "-"} />
                  <MatrixDetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
                  <MatrixDetailField label="Auto sync remote" value={worktree ? autoSyncEffectiveRemote : "-"} mono />
                  <MatrixDetailField label="Auto sync state" value={worktree ? autoSyncStatusLabel : "-"} />
                  <MatrixDetailField label="Last sync" value={autoSyncState?.lastSuccessAt ? new Date(autoSyncState.lastSuccessAt).toLocaleString() : "-"} />
                  <MatrixDetailField label="SSH agent" value={autoSyncState?.sshAgentStatus ?? "-"} mono />
                </div>

                {linkedDocument && linkedDocumentDetails ? (
                  <div className="mt-4 theme-inline-panel p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Linked document</p>
                          <MatrixBadge tone={linkedDocumentDetails.archived ? "warning" : "neutral"} compact>
                            #{linkedDocumentDetails.number}
                          </MatrixBadge>
                          <MatrixBadge tone={linkedDocumentDetails.archived ? "warning" : "active"} compact>
                            {linkedDocumentDetails.status}
                          </MatrixBadge>
                        </div>
                        <p className="mt-2 text-sm font-semibold theme-text-strong">{linkedDocumentDetails.title}</p>
                        {linkedDocumentDetails.summary ? (
                          <p className="mt-2 text-sm theme-text-muted">{linkedDocumentDetails.summary}</p>
                        ) : (
                          <p className="mt-2 text-sm theme-text-muted">This worktree is linked to a project document for planning and AI work logs.</p>
                        )}
                      </div>
                      <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={() => void openLinkedDocument()}>
                        Open document
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="mt-4 theme-inline-panel p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Quick links</p>
                    <span className="text-xs theme-chip-muted">{quickLinks.length}</span>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {quickLinks.length ? quickLinks.map((entry) => (
                      <a
                        key={`${entry.name}:${entry.url}`}
                        href={entry.url}
                        target="_blank"
                        rel="noreferrer"
                        className="matrix-command theme-hover-accent rounded-none px-4 py-3 text-sm theme-text transition-colors duration-150 theme-hover-text-accent"
                      >
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">{entry.name}</p>
                        <p className="mt-2 break-all font-mono text-xs">{entry.url}</p>
                      </a>
                    )) : (
                      <div className="matrix-command rounded-none px-4 py-3 text-xs theme-empty-note sm:col-span-2 xl:col-span-3">
                        Quick links appear here after the runtime resolves its ports.
                      </div>
                    )}
                  </div>
                </div>

                {attachCommand ? (
                  <div className="mt-3 theme-inline-panel p-3">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                      <div className="min-w-0">
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Attach command</p>
                        <p className="mt-2 break-all font-mono text-sm theme-text">{attachCommand}</p>
                      </div>
                      <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={() => void copyAttachCommand()}>
                        {copied ? "Copied" : "Copy"}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="mt-3 space-y-4">
                <div className="theme-inline-panel p-4">
                  <MatrixSectionIntro
                    kicker={WORKTREE_ENVIRONMENT_KICKER}
                    title={BACKGROUND_COMMAND_CONTROL_TITLE}
                    description={BACKGROUND_COMMAND_CONTROL_DESCRIPTION}
                    actions={(
                      <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto_auto_auto] xl:min-w-[48rem]">
                        <MatrixDropdown
                          label="Command"
                          value={selectedBackgroundCommand?.name ?? null}
                          options={backgroundCommandOptions}
                          placeholder="No commands"
                          disabled={!backgroundCommands.length}
                          emptyLabel="No background commands are configured yet."
                          onChange={setSelectedBackgroundCommandName}
                        />

                        <button
                          type="button"
                          className="matrix-button rounded-none px-3 py-2 text-sm"
                          disabled={!worktree?.branch || !selectedBackgroundCommand || !selectedBackgroundCommand.canStart || selectedBackgroundCommand.running || isBusy}
                          onClick={() => worktree && selectedBackgroundCommand ? void onStartBackgroundCommand(worktree.branch, selectedBackgroundCommand.name) : undefined}
                        >
                          Start
                        </button>

                        <button
                          type="button"
                          className="matrix-button rounded-none px-3 py-2 text-sm"
                          disabled={!worktree?.branch || !selectedBackgroundCommand || !selectedBackgroundCommand.running || isBusy}
                          onClick={() => worktree && selectedBackgroundCommand ? void onStopBackgroundCommand(worktree.branch, selectedBackgroundCommand.name) : undefined}
                        >
                          Stop
                        </button>

                        <button
                          type="button"
                          className="matrix-button rounded-none px-3 py-2 text-sm"
                          disabled={!worktree?.branch || !selectedBackgroundCommand || !selectedBackgroundCommand.canStart || isBusy}
                          onClick={() => worktree && selectedBackgroundCommand ? void onRestartBackgroundCommand(worktree.branch, selectedBackgroundCommand.name) : undefined}
                        >
                          Restart
                        </button>
                      </div>
                    )}
                  />

                  {selectedBackgroundCommand ? (
                    <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
                      <div className="matrix-command rounded-none px-4 py-3">
                        <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Command</p>
                        <p className="mt-2 break-all font-mono text-sm theme-text-strong">{selectedBackgroundCommand.command}</p>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <MatrixDetailField label="Manager" value="PM2" />
                        <MatrixDetailField label="Status" value={selectedBackgroundCommand.status} mono />
                        <MatrixDetailField label="PID" value={selectedBackgroundCommand.pid ? String(selectedBackgroundCommand.pid) : "-"} mono />
                        <MatrixDetailField
                          label="Started"
                          value={selectedBackgroundCommand.startedAt
                            ? new Date(selectedBackgroundCommand.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                            : "-"}
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="mt-4 matrix-command rounded-none px-4 py-3 text-sm theme-empty-note">
                      No background commands are configured yet.
                    </div>
                  )}

                  {selectedBackgroundCommand?.note ? (
                    <div className="mt-3 theme-inline-panel-warning px-3 py-2 text-sm theme-text-warning">
                      {selectedBackgroundCommand.note}
                    </div>
                  ) : null}
                </div>

                <div className="theme-inline-panel p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] theme-text-soft">Logs</p>
                      <p className="mt-2 text-sm theme-text-muted">Grep hides lines that do not contain the search text.</p>
                    </div>

                    <label className="w-full sm:max-w-xs">
                      <span className="sr-only">Filter logs</span>
                      <input
                        value={backgroundFilter}
                        onChange={(event) => setBackgroundFilter(event.target.value)}
                        placeholder="grep logs"
                        className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                      />
                    </label>
                  </div>

                  <div
                    ref={backgroundLogViewportRef}
                    onScroll={handleBackgroundLogScroll}
                    className="mt-4 max-h-[28rem] overflow-auto theme-scroll-panel font-mono text-xs"
                  >
                    {filteredBackgroundLogLines.length ? filteredBackgroundLogLines.map((line) => (
                      <div
                        key={line.id}
                        className={`border-b px-4 py-2 last:border-b-0 ${line.source === "stderr"
                          ? "theme-log-entry-error"
                          : "theme-log-entry"}`}
                      >
                        {line.timestamp ? (
                          <span className="mr-3 theme-timestamp">
                            {new Date(line.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                          </span>
                        ) : null}
                        <span>{line.text}</span>
                      </div>
                    )) : (
                      <div className="px-4 py-4 theme-empty-note">
                        {selectedBackgroundCommand
                          ? backgroundFilter.trim()
                            ? "No log lines match the current grep filter."
                            : "No log output yet."
                          : "Choose a background command to inspect logs."}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : isReviewTabActive ? (
          <div className="space-y-4">
            <div className="theme-inline-panel p-4">
              <MatrixSectionIntro
                kicker="Review"
                title={linkedDocumentDetails ? linkedDocumentDetails.title : "Linked document review"}
                description={linkedDocumentDetails
                  ? "Track comments, AI activity, and merge events for the document linked to this worktree."
                  : "Link a project document to this worktree to capture review notes and AI activity here."}
                actions={linkedDocumentDetails ? (
                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    onClick={() => void openLinkedDocument()}
                  >
                    Open document
                  </button>
                ) : undefined}
                metrics={linkedDocumentDetails ? (
                  <div className="grid w-full gap-2 text-left sm:grid-cols-3 xl:w-auto xl:min-w-[18rem]">
                    <MatrixMetric label="Document" value={`#${linkedDocumentDetails.number}`} />
                    <MatrixMetric label="Status" value={linkedDocumentDetails.status} />
                    <MatrixMetric label="Entries" value={String(linkedDocumentReviewEntries.length)} />
                  </div>
                ) : undefined}
              />

              {linkedDocumentDetails ? (
                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                  <MatrixDetailField label="Linked document" value={linkedDocumentDetails.title} />
                  <MatrixDetailField label="Document id" value={linkedDocumentDetails.id} mono />
                  <MatrixDetailField label="Status" value={linkedDocumentDetails.status} />
                  <MatrixDetailField label="Last updated" value={projectManagementLastUpdatedAt ? new Date(projectManagementLastUpdatedAt).toLocaleString() : "-"} />
                </div>
              ) : null}
            </div>

            {!linkedDocumentDetails ? (
              <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                No linked document yet. Link a project document to this worktree to keep review discussion and AI activity in one place.
              </div>
            ) : (
              <>
                {linkedDocumentReviewEntries.length ? (
                  <div className="grid gap-3">
                    {linkedDocumentReviewEntries.map((entry) => (
                      <MatrixCard key={entry.id} as="div" className="p-4">
                        <MatrixCardHeader
                          eyebrow={<span className="theme-text-soft">{new Date(entry.createdAt).toLocaleString()}</span>}
                          title={entry.authorName ?? entry.authorEmail ?? getReviewSourceLabel(entry)}
                          titleLines={1}
                          titleText={entry.authorName ?? entry.authorEmail ?? getReviewSourceLabel(entry)}
                          description={entry.authorEmail ?? undefined}
                          descriptionLines={1}
                          descriptionText={entry.authorEmail ?? undefined}
                          badges={(
                            <>
                              <MatrixBadge tone={getReviewEventTone(entry)} compact>{getReviewEventLabel(entry)}</MatrixBadge>
                              <MatrixBadge tone={getReviewSourceTone(entry)} compact>{getReviewSourceLabel(entry)}</MatrixBadge>
                            </>
                          )}
                        />
                        <div
                          className="pm-markdown mt-4 text-sm theme-text"
                          dangerouslySetInnerHTML={{ __html: marked.parse(entry.body) }}
                        />
                        <MatrixCardFooter className="mt-4 justify-between gap-3 text-xs theme-text-muted">
                          <div className="flex flex-wrap items-center gap-3">
                            <span>{entry.kind}</span>
                            {entry.updatedAt !== entry.createdAt ? <span>{`Updated ${new Date(entry.updatedAt).toLocaleString()}`}</span> : null}
                          </div>
                          <button
                            type="button"
                            className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-xs"
                            disabled={projectManagementSaving || deletingReviewEntryId === entry.id}
                            onClick={() => void deleteReviewEntry(entry)}
                          >
                            {deletingReviewEntryId === entry.id ? "Deleting..." : "Delete entry"}
                          </button>
                        </MatrixCardFooter>
                      </MatrixCard>
                    ))}
                  </div>
                ) : (
                  <div className="matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                    No review entries yet. Add the first note here or run AI work from this worktree to start the timeline.
                  </div>
                )}

                <div className="theme-inline-panel p-4">
                  <label className="block space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Add review entry</span>
                    <textarea
                      value={reviewDraft}
                      onChange={(event) => setReviewDraft(event.target.value)}
                      placeholder="Add context for this worktree, call out concerns, or leave a handoff note."
                      rows={5}
                      className="matrix-input min-h-[9rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                    />
                  </label>
                  <div className="mt-3 flex flex-wrap justify-end gap-2">
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      disabled={projectManagementSaving || !reviewDraft.trim()}
                      onClick={() => void submitReviewEntry()}
                    >
                      {projectManagementSaving ? "Saving..." : "Add review entry"}
                    </button>
                  </div>
                </div>

                {activeReviewAiJob ? (
                  <div className="space-y-3 theme-inline-panel p-4">
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">AI is active</p>
                      <p className="mt-2 text-sm theme-text-muted">
                        Follow the live output for this worktree before starting another AI follow-up.
                      </p>
                    </div>
                    <ProjectManagementAiOutputViewer
                      source="worktree"
                      job={activeReviewAiJob}
                      summary={`AI is still running in ${activeReviewAiJob.branch}. Finish or cancel this run before prompting again from Review.`}
                      expanded
                      onCancel={() => void onCancelProjectManagementAiCommand()}
                    />
                  </div>
                ) : (
                  <div className="theme-inline-panel p-4">
                    <label className="block space-y-2">
                      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Smart AI command</span>
                      <textarea
                        value={reviewFollowUpDraft}
                        onChange={(event) => setReviewFollowUpDraft(event.target.value)}
                        placeholder="Use @dowork to continue implementation or @review to review the current branch diff."
                        rows={5}
                        className="matrix-input min-h-[9rem] w-full rounded-none px-3 py-3 text-sm outline-none"
                      />
                    </label>
                    <p className="mt-3 text-sm theme-text-muted">
                      Use <code>@dowork</code> to keep implementing with the linked document and review history, or <code>@review</code> to run a review-only pass over the current branch diff.
                    </p>
                    <div className="mt-3 flex flex-wrap justify-end gap-2">
                      <button
                        type="button"
                        className="matrix-button rounded-none px-3 py-2 text-sm"
                        disabled={reviewFollowUpSubmitting || !reviewFollowUpDraft.trim()}
                        onClick={() => void submitReviewFollowUp()}
                      >
                        {reviewFollowUpSubmitting ? "Starting Smart AI..." : "Start Smart AI"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : activeTab === "project-management" ? (
          <div>
            <ProjectManagementPanel
              documents={projectManagementDocuments}
              worktrees={projectManagementWorktrees}
              availableTags={projectManagementAvailableTags}
              availableStatuses={projectManagementAvailableStatuses}
              projectManagementUsers={projectManagementUsers}
              activeSubTab={projectManagementActiveSubTab}
              selectedDocumentId={projectManagementSelectedDocumentId}
              documentPresentation={projectManagementDocumentPresentation}
              documentViewMode={projectManagementDocumentViewMode}
              editFormTab={projectManagementEditFormTab}
              createFormTab={projectManagementCreateFormTab}
              document={projectManagementDocument}
              history={projectManagementHistory}
              loading={projectManagementLoading}
              refreshError={projectManagementError}
              lastUpdatedAt={projectManagementLastUpdatedAt}
              saving={projectManagementSaving}
              aiCommands={projectManagementAiCommands}
              aiJob={projectManagementAiJob}
              documentRunJob={projectManagementDocumentAiJob}
              runningAiJobs={projectManagementRunningAiJobs}
              selectedWorktreeBranch={worktree?.branch ?? null}
              onSelectWorktree={onSelectWorktree}
              onSubTabChange={onProjectManagementSubTabChange}
              onDocumentViewModeChange={onProjectManagementDocumentViewModeChange}
              onEditFormTabChange={onProjectManagementEditFormTabChange}
              onCreateFormTabChange={onProjectManagementCreateFormTabChange}
              onSelectDocument={onLoadProjectManagementDocument}
              onCreateDocument={onCreateProjectManagementDocument}
              onUpdateDocument={onUpdateProjectManagementDocument}
              onUpdateDependencies={onUpdateProjectManagementDependencies}
              onUpdateStatus={onUpdateProjectManagementStatus}
              onUpdateUsers={onUpdateProjectManagementUsers}
              onBatchUpdateDocuments={onBatchUpdateProjectManagementDocuments}
              onRunAiCommand={onRunProjectManagementAiCommand}
              onRunDocumentAi={onRunProjectManagementDocumentAi}
              onCancelDocumentAiCommand={onCancelProjectManagementDocumentAiCommand}
              onCancelAiCommand={onCancelProjectManagementAiCommand}
              onOpenDocumentPage={onProjectManagementOpenDocumentPage}
              onCloseDocument={onProjectManagementCloseDocument}
              onRetryRefresh={() => void refreshProjectManagementWorkspace({ silent: false, includeSelectedDocument: false })}
            />
          </div>
        ) : isSystemTabActive ? (
          <div>
            <SystemTab
              activeSubTab={systemSubTab}
              status={systemStatus}
              loading={systemLoading}
              error={systemError}
              lastUpdatedAt={systemLastUpdatedAt}
              onSubTabChange={onSystemSubTabChange}
              onRetry={() => void refreshSystemStatus({ silent: false })}
            />
          </div>
        ) : isAiLogTabActive ? (
          <div>
            <ProjectManagementAiTab
              activeSubTab={projectManagementAiActiveSubTab}
              logs={projectManagementAiLogs}
              logDetail={projectManagementAiLogDetail}
              selectedLogJobId={projectManagementSelectedAiLogJobId}
              loading={projectManagementAiLogsLoading}
              error={projectManagementAiLogsError}
              lastUpdatedAt={projectManagementAiLogsLastUpdatedAt}
              runningJobs={projectManagementRunningAiJobs}
              onSubTabChange={onProjectManagementAiSubTabChange}
              onSelectLog={onLoadProjectManagementAiLog}
              onCancelJob={onCancelProjectManagementAiLogJob}
              onOpenOrigin={(origin) => void openAiLogOrigin(origin)}
              onRetry={() => void refreshAiLogs({ silent: false })}
            />
          </div>
        ) : isGitTabActive ? (
          <div className="space-y-4">{comparisonWorkspace}</div>
        ) : null}
      </div>

      {commitModalOpen ? (
        <MatrixModal
          kicker="Commit"
          title={<>Review commit message</>}
          description="Generate a draft message when you want one, edit it if needed, then commit the current changes."
          closeLabel="Close commit dialog"
          maxWidthClass="max-w-2xl"
          onClose={() => {
            if (commitMessageLoading || commitSubmitting) {
              return;
            }
            setCommitModalOpen(false);
          }}
          footer={(
            <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-end">
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => {
                  void generateCommitMessage();
                }}
                disabled={commitMessageLoading || commitSubmitting}
              >
                {commitMessageLoading ? "Generating message..." : "Generate message"}
              </button>
              <button
                type="submit"
                form="git-ai-commit-form"
                className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
                disabled={commitMessageLoading || commitSubmitting || !commitMessagePreview}
              >
                {commitSubmitting ? "Committing..." : "Commit"}
              </button>
            </div>
          )}
        >
          <form
            id="git-ai-commit-form"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void submitCommit();
            }}
          >
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <MatrixDetailField label="Branch" value={worktree?.branch ?? "-"} mono />
              <MatrixDetailField label="Base" value={gitComparison?.baseBranch ?? "-"} mono />
            </div>
            <label className="block space-y-2">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] theme-text-soft">Commit message</span>
              <textarea
                value={commitMessageDraft}
                onChange={(event) => setCommitMessageDraft(event.target.value)}
                placeholder={commitMessageLoading ? "Generating message..." : "Write the commit message"}
                disabled={commitMessageLoading || commitSubmitting}
                rows={8}
                autoFocus
                className="matrix-input min-h-[14rem] w-full rounded-none px-3 py-3 text-sm outline-none"
              />
            </label>
          </form>
        </MatrixModal>
      ) : null}

      <div className="min-w-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <WorktreeTerminal
          repoRoot={repoRoot}
          worktree={worktree}
          isTerminalVisible={isTerminalVisible}
          onTerminalVisibilityChange={onTerminalVisibilityChange}
          commandPaletteShortcut={commandPaletteShortcut}
          onCommandPaletteToggle={onCommandPaletteToggle}
          terminalShortcut={terminalShortcut}
          onTerminalShortcutToggle={onTerminalShortcutToggle}
          worktreeOptions={worktreeOptions}
          onSelectWorktree={onSelectWorktree}
          showSessionInfo={isEnvironmentTabActive}
        />
      </div>
    </section>
  );
}
