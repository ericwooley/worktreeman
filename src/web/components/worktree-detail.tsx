import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Gitgraph, Orientation, TemplateName, templateExtend } from "@gitgraph/react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { DiffFile, changeMaxLengthToIgnoreLineDiff, getLang } from "@git-diff-view/core";
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
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  ProjectManagementUsersResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  UpdateProjectManagementUsersRequest,
  WorktreeRecord,
} from "@shared/types";
import type { ProjectManagementDocumentViewMode, ProjectManagementSubTab } from "./project-management-panel";
import type { AiActivitySubTab } from "./project-management-ai-tab";
import { getTmuxSessionName } from "../lib/tmux";
import { startSequentialPoll } from "../lib/sequential-poll";
import type { CommitChangesPayload } from "../hooks/use-dashboard-state";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixAccordion, MatrixBadge, MatrixDetailField, MatrixMetric, MatrixModal, MatrixTabButton } from "./matrix-primitives";
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
import { getAiResolveButtonState } from "./git-status-actions";
import { GitPullRequestPanel } from "./git-pull-request-panel";

const ProjectManagementPanel = lazy(async () => {
  const module = await import("./project-management-panel");
  return { default: module.ProjectManagementPanel };
});

const ProjectManagementAiTab = lazy(async () => {
  const module = await import("./project-management-ai-tab");
  return { default: module.ProjectManagementAiTab };
});

function getCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const GIT_COMPARISON_POLL_INTERVAL_MS = 3000;
const PROJECT_MANAGEMENT_POLL_INTERVAL_MS = 5000;
const AI_LOG_POLL_INTERVAL_MS = 3000;
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

export type WorktreeEnvironmentSubTab = "terminal" | "background";
export type WorktreeGitSubTab = "status" | "pull-request";

type PullRequestMutationPayload = {
  title: string;
  summary?: string;
  markdown: string;
  status?: string;
  assignee?: string;
  baseBranch: string;
  compareBranch: string;
  draft: boolean;
  state?: "open" | "closed" | "merged";
};

function GitDiffAccordionContent({
  file,
  diffMode,
  diffTheme,
  diffWrap,
  diffHighlight,
  diffFontSize,
}: {
  file: ParsedDiffSection["files"][number];
  diffMode: DiffModeEnum;
  diffTheme: "light" | "dark";
  diffWrap: boolean;
  diffHighlight: boolean;
  diffFontSize: number;
}) {
  const diffFile = useMemo(() => {
    const primaryFileName = file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName;
    const oldLang = file.oldFileName !== "/dev/null" ? getLang(file.oldFileName) : "plaintext";
    const newLang = primaryFileName !== "/dev/null" ? getLang(primaryFileName) : "plaintext";
    const { oldContent, newContent } = buildDiffContents(file.hunks);
    const nextDiffFile = new DiffFile(
      file.oldFileName,
      oldContent,
      file.newFileName,
      newContent,
      [file.diffText],
      oldLang,
      newLang,
    );

    nextDiffFile.initTheme(diffTheme);
    if (diffHighlight) {
      nextDiffFile.init();
    } else {
      nextDiffFile.initRaw();
    }
    nextDiffFile.buildSplitDiffLines();
    nextDiffFile.buildUnifiedDiffLines();
    return nextDiffFile;
  }, [diffHighlight, diffTheme, file, diffMode, diffWrap, diffFontSize]);

  return (
    <div className="max-h-[40rem] overflow-auto matrix-diff-file">
      <DiffView
        diffFile={diffFile}
        diffViewMode={diffMode}
        diffViewTheme={diffTheme}
        diffViewWrap={diffWrap}
        diffViewHighlight={diffHighlight}
        diffViewFontSize={diffFontSize}
      />
    </div>
  );
}

function buildDiffContents(hunks: string[]) {
  const oldLines: string[] = [];
  const newLines: string[] = [];

  for (const hunk of hunks) {
    for (const line of hunk.split("\n").slice(1)) {
      if (!line || line.startsWith("@@ ") || line.startsWith("\\ No newline at end of file")) {
        continue;
      }

      const prefix = line[0];
      const content = line.slice(1);

      if (prefix === " " || prefix === "-") {
        oldLines.push(content);
      }

      if (prefix === " " || prefix === "+") {
        newLines.push(content);
      }
    }
  }

  return {
    oldContent: oldLines.join("\n"),
    newContent: newLines.join("\n"),
  };
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
  worktreeOptions: MatrixDropdownOption[];
  worktreeCount: number;
  runningCount: number;
  selectedStatusLabel: string;
  onSelectWorktree: (value: string) => void;
  activeTab: "environment" | "git" | "project-management" | "ai-log";
  onTabChange: (tab: "environment" | "git" | "project-management" | "ai-log") => void;
  environmentSubTab: WorktreeEnvironmentSubTab;
  onEnvironmentSubTabChange: (tab: WorktreeEnvironmentSubTab) => void;
  gitSubTab: WorktreeGitSubTab;
  onGitSubTabChange: (tab: WorktreeGitSubTab) => void;
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
  gitPullRequestDocumentId: string | null;
  onGitPullRequestDocumentChange: (documentId: string | null) => void;
  projectManagementActiveSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocumentViewMode: ProjectManagementDocumentViewMode;
  projectManagementDocument: ProjectManagementDocument | null;
  projectManagementHistory: ProjectManagementHistoryEntry[];
  projectManagementLoading: boolean;
  projectManagementError: string | null;
  projectManagementLastUpdatedAt: string | null;
  projectManagementSaving: boolean;
  projectManagementAiLogs: AiCommandLogSummary[];
  projectManagementAiLogDetail: AiCommandLogEntry | null;
  projectManagementAiLogsLoading: boolean;
  projectManagementAiLogsError: string | null;
  projectManagementAiLogsLastUpdatedAt: string | null;
  projectManagementRunningAiJobs: AiCommandJob[];
  projectManagementAiActiveSubTab: AiActivitySubTab;
  projectManagementAiCommands: AiCommandConfig | null;
  projectManagementAiJob: AiCommandJob | null;
  projectManagementDocumentAiJob: AiCommandJob | null;
  onProjectManagementSubTabChange: (tab: ProjectManagementSubTab) => void;
  onProjectManagementDocumentViewModeChange: (mode: ProjectManagementDocumentViewMode) => void;
  onLoadProjectManagementDocuments: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementUsers: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onLoadProjectManagementAiLogs: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementAiLog: (fileName: string, options?: { silent?: boolean }) => Promise<AiCommandLogEntry | null>;
  onProjectManagementAiSubTabChange: (tab: AiActivitySubTab) => void;
  onCreateProjectManagementDocument: (payload: {
    title: string;
    summary?: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    kind?: "document" | "pull-request";
    pullRequest?: {
      baseBranch: string;
      compareBranch: string;
      state: "open" | "closed" | "merged";
      draft: boolean;
    } | null;
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
    kind?: "document" | "pull-request";
    pullRequest?: {
      baseBranch: string;
      compareBranch: string;
      state: "open" | "closed" | "merged";
      draft: boolean;
    } | null;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementDependencies: (documentId: string, dependencyIds: string[]) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementStatus: (documentId: string, status: string) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementUsers: (payload: UpdateProjectManagementUsersRequest) => Promise<ProjectManagementUsersResponse | null>;
  onBatchUpdateProjectManagementDocuments: (documentIds: string[], overrides: {
    status?: string;
    archived?: boolean;
  }) => Promise<boolean>;
  onAddProjectManagementComment: (documentId: string, payload: { body: string }) => Promise<ProjectManagementDocument | null>;
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
  }) => Promise<RunAiCommandResponse | null>;
  onCancelProjectManagementDocumentAiCommand: (branch: string) => Promise<AiCommandJob | null>;
  onCancelProjectManagementAiCommand: () => Promise<AiCommandJob | null>;
  onCancelProjectManagementAiLogJob: (branch: string) => Promise<AiCommandJob | null>;
}

export function WorktreeDetail({
  repoRoot,
  worktree,
  worktreeOptions,
  worktreeCount,
  runningCount,
  selectedStatusLabel,
  onSelectWorktree,
  activeTab,
  onTabChange,
  environmentSubTab,
  onEnvironmentSubTabChange,
  gitSubTab: _gitSubTab,
  onGitSubTabChange: _onGitSubTabChange,
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
  gitPullRequestDocumentId,
  onGitPullRequestDocumentChange,
  projectManagementActiveSubTab,
  projectManagementSelectedDocumentId,
  projectManagementDocumentViewMode,
  projectManagementDocument,
  projectManagementHistory,
  projectManagementLoading,
  projectManagementError,
  projectManagementLastUpdatedAt,
  projectManagementSaving,
  projectManagementAiLogs,
  projectManagementAiLogDetail,
  projectManagementAiLogsLoading,
  projectManagementAiLogsError,
  projectManagementAiLogsLastUpdatedAt,
  projectManagementRunningAiJobs,
  projectManagementAiActiveSubTab,
  projectManagementAiCommands,
  projectManagementAiJob,
  projectManagementDocumentAiJob,
  onProjectManagementSubTabChange,
  onProjectManagementDocumentViewModeChange,
  onLoadProjectManagementDocuments,
  onLoadProjectManagementUsers,
  onLoadProjectManagementDocument,
  onLoadProjectManagementAiLogs,
  onLoadProjectManagementAiLog,
  onProjectManagementAiSubTabChange,
  onCreateProjectManagementDocument,
  onUpdateProjectManagementDocument,
  onUpdateProjectManagementDependencies,
  onUpdateProjectManagementStatus,
  onUpdateProjectManagementUsers,
  onBatchUpdateProjectManagementDocuments,
  onAddProjectManagementComment,
  onRunProjectManagementAiCommand,
  onRunProjectManagementDocumentAi,
  onCancelProjectManagementDocumentAiCommand,
  onCancelProjectManagementAiCommand,
  onCancelProjectManagementAiLogJob,
}: WorktreeDetailProps) {
  const isEnvironmentTabActive = activeTab === "environment";
  const isAiLogTabActive = activeTab === "ai-log";
  const isGitTabActive = activeTab === "git";
  const pullRequestDocuments = useMemo(
    () => projectManagementDocuments.filter((entry) => entry.kind === "pull-request"),
    [projectManagementDocuments],
  );
  const standardProjectManagementDocuments = useMemo(
    () => projectManagementDocuments.filter((entry) => entry.kind !== "pull-request"),
    [projectManagementDocuments],
  );
  const isBackgroundCommandsActive = isEnvironmentTabActive && environmentSubTab === "background";
  const isRunning = Boolean(worktree?.runtime);
  const deleteDisabledReason = isBusy
    ? "A worktree action is already running."
    : worktree?.deletion?.canDelete === false
      ? worktree.deletion.reason
      : null;
  const [copied, setCopied] = useState(false);
  const [selectedBackgroundCommandName, setSelectedBackgroundCommandName] = useState<string | null>(null);
  const [backgroundFilter, setBackgroundFilter] = useState("");
  const [selectedGitBaseBranch, setSelectedGitBaseBranch] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);
  const [diffTheme, setDiffTheme] = useState<"light" | "dark">("dark");
  const [diffWrap, setDiffWrap] = useState(false);
  const [diffHighlight, setDiffHighlight] = useState(false);
  const [diffFontSize, setDiffFontSize] = useState(13);
  const [commitModalOpen, setCommitModalOpen] = useState(false);
  const [commitMessageDraft, setCommitMessageDraft] = useState("");
  const [commitMessageLoading, setCommitMessageLoading] = useState(false);
  const [mergeConflictAiRunning, setMergeConflictAiRunning] = useState(false);
  const backgroundLogViewportRef = useRef<HTMLDivElement | null>(null);
  const linkedDocument = worktree?.linkedDocument ?? null;
  const linkedDocumentDetails = useMemo(
    () => linkedDocument
      ? projectManagementDocuments.find((entry) => entry.id === linkedDocument.id) ?? linkedDocument
      : null,
    [linkedDocument, projectManagementDocuments],
  );
  const selectedPullRequestDocument = projectManagementDocument?.kind === "pull-request"
    ? projectManagementDocument
    : null;
  const selectedPullRequestDocumentId = gitPullRequestDocumentId && pullRequestDocuments.some((entry) => entry.id === gitPullRequestDocumentId)
    ? gitPullRequestDocumentId
    : pullRequestDocuments[0]?.id ?? null;
  const shouldStickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef(0);
  const quickLinks = worktree?.runtime?.quickLinks ?? [];
  const tmuxSessionName = worktree?.runtime?.tmuxSession
    ?? (worktree?.branch && repoRoot ? getTmuxSessionName(repoRoot, worktree.branch) : null);
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
  const gitDiffMetrics = useMemo(() => {
    const raw = gitComparison?.effectiveDiff ?? "";
    return {
      chars: raw.length,
      lines: raw ? raw.split("\n").length : 0,
    };
  }, [gitComparison?.effectiveDiff]);
  const parsedDiffSections = useMemo(
    () => gitComparison?.effectiveDiff ? parseDiffSections(gitComparison.effectiveDiff) : [],
    [gitComparison?.effectiveDiff],
  );
  const parsedDiffFileCount = useMemo(
    () => parsedDiffSections.reduce((count, section) => count + section.files.length, 0),
    [parsedDiffSections],
  );
  const isDiffTooLargeToRender = gitDiffMetrics.chars > DIFF_RENDER_MAX_CHARS
    || gitDiffMetrics.lines > DIFF_RENDER_MAX_LINES
    || parsedDiffFileCount > DIFF_RENDER_MAX_FILES;
  const mergeActionState = useMemo(
    () => getMergeActionState(worktree?.branch, gitComparison),
    [gitComparison, worktree?.branch],
  );
  const mergeIntoBaseActionState = useMemo(
    () => getMergeIntoBaseActionState(worktree?.branch, gitComparison),
    [gitComparison, worktree?.branch],
  );
  const mergeIntoWorktreeStatus = gitComparison?.mergeIntoCompareStatus ?? gitComparison?.mergeStatus ?? null;
  const workingTreeConflictCount = gitComparison?.workingTreeSummary.conflictedFiles ?? gitComparison?.workingTreeConflicts.length ?? 0;
  const activeGitConflicts = gitComparison?.workingTreeConflicts.length
    ? gitComparison.workingTreeConflicts
    : mergeIntoWorktreeStatus?.hasConflicts
      ? mergeIntoWorktreeStatus.conflicts
      : [];
  const aiResolveButtonState = getAiResolveButtonState({
    hasWorktreeBranch: Boolean(worktree?.branch),
    gitComparisonLoading,
    mergeConflictAiRunning,
    workingTreeConflicts: workingTreeConflictCount,
  });
  const canMergeBaseIntoWorktree = mergeActionState.canMerge;
  const canMergeWorktreeIntoBase = mergeIntoBaseActionState.canMerge;
  const mergeButtonDisabledReason = gitComparisonLoading
    ? "Git comparison is updating."
    : !canMergeBaseIntoWorktree
      ? mergeActionState.reason
      : null;
  const mergeIntoBaseButtonDisabledReason = gitComparisonLoading
    ? "Git comparison is updating."
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
  const gitDiffFiles = useMemo(() => {
    if (isDiffTooLargeToRender) {
      return [];
    }

    return parsedDiffSections.map((section) => ({
      title: section.title,
      files: section.files.map((file) => ({
        key: file.key,
        file,
        displayName: file.newFileName !== "/dev/null" ? file.newFileName : file.oldFileName,
        hunkCount: file.hunks.length,
      })),
    }));
  }, [isDiffTooLargeToRender, parsedDiffSections]);
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
  const refreshProjectManagementWorkspace = useCallback(async (options?: { silent?: boolean }) => {
    await onLoadProjectManagementDocuments(options);
    await onLoadProjectManagementUsers(options);
    if (projectManagementSelectedDocumentId) {
      await onLoadProjectManagementDocument(projectManagementSelectedDocumentId, options);
    }
  }, [onLoadProjectManagementDocument, onLoadProjectManagementDocuments, onLoadProjectManagementUsers, projectManagementSelectedDocumentId]);
  const refreshAiLogs = useCallback(async (options?: { silent?: boolean }) => {
    await onLoadProjectManagementAiLogs(options);
    if (projectManagementAiLogDetail?.fileName) {
      await onLoadProjectManagementAiLog(projectManagementAiLogDetail.fileName, options);
    }
  }, [onLoadProjectManagementAiLog, onLoadProjectManagementAiLogs, projectManagementAiLogDetail?.fileName]);

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

    let cancelled = false;

    const loadComparison = async () => {
      const comparison = await onLoadGitComparison(worktree.branch, selectedGitBaseBranch ?? undefined, {
        silent: true,
      });
      if (cancelled || !comparison) {
        return;
      }
    };

    const pollController = startSequentialPoll(loadComparison, {
      intervalMs: GIT_COMPARISON_POLL_INTERVAL_MS,
      runImmediately: document.visibilityState === "visible",
    });

    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      pollController.trigger();
    };

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);

    return () => {
      cancelled = true;
      pollController.stop();
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
  }, [activeTab, onLoadGitComparison, selectedGitBaseBranch, worktree?.branch]);

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
    if (activeTab !== "project-management") {
      return;
    }

    let cancelled = false;

    const loadWorkspace = async () => {
      await refreshProjectManagementWorkspace({ silent: true });
      if (cancelled) {
        return;
      }
    };

    const pollController = startSequentialPoll(loadWorkspace, {
      intervalMs: PROJECT_MANAGEMENT_POLL_INTERVAL_MS,
      runImmediately: document.visibilityState === "visible",
    });

    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      pollController.trigger();
    };

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);

    return () => {
      cancelled = true;
      pollController.stop();
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
  }, [activeTab, refreshProjectManagementWorkspace]);

  useEffect(() => {
    if (activeTab !== "ai-log") {
      return;
    }

    let cancelled = false;

    const loadAiLogState = async () => {
      await refreshAiLogs({ silent: true });
      if (cancelled) {
        return;
      }
    };

    const pollController = startSequentialPoll(loadAiLogState, {
      intervalMs: AI_LOG_POLL_INTERVAL_MS,
      runImmediately: document.visibilityState === "visible",
    });

    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      pollController.trigger();
    };

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);

    return () => {
      cancelled = true;
      pollController.stop();
      window.removeEventListener("focus", handleVisibilityRefresh);
      document.removeEventListener("visibilitychange", handleVisibilityRefresh);
    };
  }, [activeTab, refreshAiLogs]);

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

  const openCommitModal = async () => {
    if (!worktree?.branch || !gitComparison) {
      return;
    }

    setCommitModalOpen(true);
    setCommitMessageDraft("");
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

    const result = await onCommitGitChanges(worktree.branch, {
      baseBranch: gitComparison.baseBranch,
      commandId: "simple",
      message: commitMessageDraft,
    });

    if (result) {
      setCommitModalOpen(false);
      setCommitMessageDraft("");
    }
  };

  const resolveMergeConflicts = async () => {
    if (!worktree?.branch || !gitComparison) {
      return;
    }

    if ((gitComparison.workingTreeSummary.conflictedFiles ?? gitComparison.workingTreeConflicts.length ?? 0) === 0) {
      return;
    }

    setMergeConflictAiRunning(true);
    try {
      await onResolveGitMergeConflicts(worktree.branch, gitComparison.baseBranch, "smart");
    } finally {
      setMergeConflictAiRunning(false);
    }
  };

  const createPullRequestDocument = async (payload: PullRequestMutationPayload) => {
    const nextDocument = await onCreateProjectManagementDocument({
      title: payload.title,
      summary: payload.summary,
      markdown: payload.markdown,
      tags: ["pull-request"],
      status: payload.status,
      assignee: payload.assignee,
      kind: "pull-request",
      pullRequest: {
        baseBranch: payload.baseBranch,
        compareBranch: payload.compareBranch,
        state: payload.state ?? "open",
        draft: payload.draft,
      },
    });

    if (nextDocument) {
      onGitPullRequestDocumentChange(nextDocument.id);
      await onLoadProjectManagementDocument(nextDocument.id, { silent: true });
    }

    return nextDocument;
  };

  const updatePullRequestDocument = async (documentId: string, payload: PullRequestMutationPayload) => {
    const currentDocument = selectedPullRequestDocument?.id === documentId
      ? selectedPullRequestDocument
      : await onLoadProjectManagementDocument(documentId, { silent: true });

    if (!currentDocument) {
      return null;
    }

    return onUpdateProjectManagementDocument(documentId, {
      title: payload.title,
      summary: payload.summary,
      markdown: payload.markdown,
      tags: currentDocument.tags,
      dependencies: currentDocument.dependencies,
      status: payload.status,
      assignee: payload.assignee,
      archived: currentDocument.archived,
      kind: "pull-request",
      pullRequest: {
        baseBranch: payload.baseBranch,
        compareBranch: payload.compareBranch,
        state: payload.state ?? "open",
        draft: payload.draft,
      },
    });
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

  const openAiLogOrigin = async (origin: AiCommandJob["origin"] | AiCommandLogEntry["origin"] | AiCommandLogSummary["origin"]) => {
    if (!origin) {
      return;
    }

    if (origin.location.branch) {
      onSelectWorktree(origin.location.branch);
    }

    if (origin.location.tab === "project-management") {
      onTabChange("project-management");
      onProjectManagementSubTabChange(origin.location.projectManagementSubTab ?? "document");
      onProjectManagementDocumentViewModeChange(origin.location.projectManagementDocumentViewMode ?? "document");
      if (origin.location.documentId) {
        await onLoadProjectManagementDocument(origin.location.documentId, { silent: true });
      }
      return;
    }

    if (origin.location.tab === "git") {
      onTabChange("git");
      if (origin.location.documentId) {
        onGitPullRequestDocumentChange(origin.location.documentId);
        await onLoadProjectManagementDocument(origin.location.documentId, { silent: true });
      }
      return;
    }

    onTabChange("environment");
    onEnvironmentSubTabChange(origin.location.environmentSubTab ?? "terminal");
  };

  const activePullRequestReviewJob = selectedPullRequestDocument?.id
    && projectManagementAiJob?.origin?.kind === "git-pull-request-review"
    && projectManagementAiJob.origin.location.documentId === selectedPullRequestDocument.id
      ? projectManagementAiJob
      : null;

  const comparisonWorkspace = (
    <>
      <div className="theme-inline-panel p-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
          <div>
            <p className="matrix-kicker">Pull request / Changes</p>
            <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">Branch comparison</h2>
            <p className="mt-2 text-sm theme-text-muted">
              Compare the selected worktree against the base branch, including staged, unstaged, and untracked local changes in the effective diff.
            </p>
          </div>

          <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto_auto] xl:min-w-[42rem] xl:grid-cols-[minmax(16rem,1fr)_auto_auto_auto_auto]">
            <MatrixDropdown
              label="Base branch"
              value={selectedGitBaseBranch}
              options={gitBranchOptions}
              placeholder="Choose base branch"
              disabled={!gitBranchOptions.length}
              emptyLabel="No branches available"
              onChange={setSelectedGitBaseBranch}
            />
            <MatrixTabButton active={gitView === "graph"} label="Graph" onClick={() => onGitViewChange("graph")} />
            <MatrixTabButton active={gitView === "diff"} label="Diff" onClick={() => onGitViewChange("diff")} />
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
              AI commit
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
              Merge worktree into base
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
              Merge base into worktree
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
            Merge into worktree disabled: {mergeActionState.reason}
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

      {gitComparisonLoading ? (
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

            {gitComparison.effectiveDiff ? isDiffTooLargeToRender ? (
              <div className="theme-inline-panel-warning px-4 py-4 text-sm theme-text-warning">
                Diff is too large to render safely in the browser.
                <div className="mt-2 font-mono text-xs theme-text-warning-soft">
                  {parsedDiffFileCount} files, {gitDiffMetrics.lines.toLocaleString()} lines, {gitDiffMetrics.chars.toLocaleString()} chars
                </div>
              </div>
            ) : gitDiffFiles.length ? (
              <div className="space-y-4">
                {gitDiffFiles.map((section) => (
                  <div key={section.title} className="space-y-3">
                    <div className="text-xs uppercase tracking-[0.18em] theme-text-emphasis">{section.title}</div>
                    {section.files.map((file) => (
                      <MatrixAccordion
                        key={file.key}
                        summary={(
                          <div className="flex items-center justify-between gap-3 pr-3">
                            <div className="min-w-0 font-mono text-xs theme-text-strong">{file.displayName}</div>
                            <div className="text-[11px] theme-text-muted">{file.hunkCount} hunk{file.hunkCount === 1 ? "" : "s"}</div>
                          </div>
                        )}
                      >
                        <GitDiffAccordionContent
                          file={file.file}
                          diffMode={diffMode}
                          diffTheme={diffTheme}
                          diffWrap={diffWrap}
                          diffHighlight={diffHighlight}
                          diffFontSize={diffFontSize}
                        />
                      </MatrixAccordion>
                    ))}
                  </div>
                ))}
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

  const reviewPullRequestByAi = async (payload: {
    documentId: string;
    baseBranch: string;
    compareBranch: string;
  }) => {
    if (!worktree?.branch) {
      return null;
    }

    return onRunProjectManagementAiCommand({
      commandId: "smart",
      commentDocumentId: payload.documentId,
      origin: {
        kind: "git-pull-request-review",
        label: "Git pull request review",
        location: {
          tab: "git",
          branch: worktree.branch,
          gitBaseBranch: payload.baseBranch,
          documentId: payload.documentId,
        },
      },
      input: [
        `Review the pull request changes from ${payload.compareBranch} into ${payload.baseBranch}.`,
        "Focus on correctness risks, merge readiness, missing tests, and any reviewer follow-up.",
        "Return concise review notes suitable for a pull request comment.",
      ].join(" "),
    });
  };

  return (
    <section className="min-w-0 space-y-4 xl:flex xl:min-h-[calc(100vh-2rem)] xl:flex-col xl:space-y-4">
      <div className="matrix-panel rounded-none border-x-0 p-4 sm:p-5">
        <div className="flex items-center gap-2 theme-divider border-b pb-4">
          <MatrixTabButton active={isEnvironmentTabActive} label={WORKTREE_ENVIRONMENT_TAB_LABEL} onClick={() => onTabChange("environment")} />
          <MatrixTabButton active={isGitTabActive} label="GIT" onClick={() => onTabChange("git")} />
          <MatrixTabButton active={activeTab === "project-management"} label="Project management" onClick={() => onTabChange("project-management")} />
          <MatrixTabButton active={isAiLogTabActive} label="AI" onClick={() => onTabChange("ai-log")} />
        </div>

        {isEnvironmentTabActive ? (
          <>
            <div className="mt-4 flex items-center gap-2 theme-divider border-b pb-4">
              <MatrixTabButton active={environmentSubTab === "terminal"} label={WORKTREE_ENVIRONMENT_TERMINAL_SUB_TAB_LABEL} onClick={() => onEnvironmentSubTabChange("terminal")} />
              <MatrixTabButton active={environmentSubTab === "background"} label={WORKTREE_ENVIRONMENT_BACKGROUND_SUB_TAB_LABEL} onClick={() => onEnvironmentSubTabChange("background")} />
            </div>

            {environmentSubTab === "terminal" ? (
              <>
                <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="matrix-kicker">{WORKTREE_ENVIRONMENT_KICKER}</p>
                    <h2 className="mt-1 text-2xl font-semibold theme-text-strong sm:text-3xl">
                      {worktree?.branch ?? "Select a worktree"}
                    </h2>
                    <p className="mt-1 text-sm theme-text-muted">
                      {worktree ? WORKTREE_ENVIRONMENT_DESCRIPTION : WORKTREE_ENVIRONMENT_EMPTY_DESCRIPTION}
                    </p>
                  </div>

                  <div className="flex min-w-0 flex-col gap-2 xl:max-w-[52rem] xl:items-end">
                    <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[24rem] xl:grid-cols-[repeat(3,minmax(0,1fr))]">
                      <MatrixMetric label="Worktrees" value={String(worktreeCount)} />
                      <MatrixMetric label="Running" value={String(runningCount)} />
                      <MatrixMetric label="Selected" value={selectedStatusLabel} />
                    </div>

                    <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                      <MatrixBadge tone="neutral">{worktree?.runtime ? "tmux attached" : "idle"}</MatrixBadge>
                      {worktree?.runtime?.runtimeStartedAt ? (
                        <MatrixBadge tone="active">live since {new Date(worktree.runtime.runtimeStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</MatrixBadge>
                      ) : null}
                      {linkedDocument ? (
                        <MatrixBadge tone={linkedDocument.archived ? "warning" : "active"}>
                          linked doc #{linkedDocument.number}
                        </MatrixBadge>
                      ) : null}
                      {worktree ? (
                        <>
                          <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || isRunning} onClick={onStart}>Start env</button>
                          <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || !isRunning} onClick={onStop}>Stop env</button>
                          <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onSyncEnv}>Sync .env</button>
                          <button type="button" className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-sm" disabled={Boolean(deleteDisabledReason)} onClick={onDelete} title={deleteDisabledReason ?? undefined}>
                            Delete
                          </button>
                        </>
                      ) : null}
                    </div>
                    {deleteDisabledReason ? (
                      <div className="border theme-border-danger theme-surface-danger px-3 py-2 text-sm theme-text-danger">
                        {deleteDisabledReason}
                      </div>
                    ) : null}
                  </div>
                </div>

                <div className="mt-5 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                  <MatrixDetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
                  <MatrixDetailField label="Head" value={worktree?.headSha ?? "-"} mono />
                  <MatrixDetailField label="Started" value={worktree?.runtime?.runtimeStartedAt ? new Date(worktree.runtime.runtimeStartedAt).toLocaleString() : "-"} />
                  <MatrixDetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
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
              <div className="mt-4 space-y-4">
                <div className="theme-inline-panel p-4">
                  <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                    <div>
                      <p className="matrix-kicker">{WORKTREE_ENVIRONMENT_KICKER}</p>
                      <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">{BACKGROUND_COMMAND_CONTROL_TITLE}</h2>
                      <p className="mt-2 text-sm theme-text-muted">
                        {BACKGROUND_COMMAND_CONTROL_DESCRIPTION}
                      </p>
                    </div>

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
                  </div>

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
        ) : activeTab === "project-management" ? (
          <Suspense
            fallback={(
              <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                Loading project management workspace...
              </div>
            )}
          >
            <ProjectManagementPanel
              documents={standardProjectManagementDocuments}
              worktrees={projectManagementWorktrees}
              availableTags={projectManagementAvailableTags}
              availableStatuses={projectManagementAvailableStatuses}
              projectManagementUsers={projectManagementUsers}
              activeSubTab={projectManagementActiveSubTab}
              selectedDocumentId={projectManagementSelectedDocumentId}
              documentViewMode={projectManagementDocumentViewMode}
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
              onSelectDocument={onLoadProjectManagementDocument}
              onCreateDocument={onCreateProjectManagementDocument}
              onUpdateDocument={onUpdateProjectManagementDocument}
              onUpdateDependencies={onUpdateProjectManagementDependencies}
              onUpdateStatus={onUpdateProjectManagementStatus}
              onUpdateUsers={onUpdateProjectManagementUsers}
              onBatchUpdateDocuments={onBatchUpdateProjectManagementDocuments}
              onAddComment={onAddProjectManagementComment}
              onRunAiCommand={onRunProjectManagementAiCommand}
              onRunDocumentAi={onRunProjectManagementDocumentAi}
              onCancelDocumentAiCommand={onCancelProjectManagementDocumentAiCommand}
              onCancelAiCommand={onCancelProjectManagementAiCommand}
              onRetryRefresh={() => void refreshProjectManagementWorkspace({ silent: false })}
            />
          </Suspense>
        ) : isAiLogTabActive ? (
          <Suspense
            fallback={(
              <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                Loading AI activity...
              </div>
            )}
          >
            <div className="mt-4">
              <ProjectManagementAiTab
                activeSubTab={projectManagementAiActiveSubTab}
                logs={projectManagementAiLogs}
                logDetail={projectManagementAiLogDetail}
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
          </Suspense>
        ) : (
          <div className="mt-4 space-y-4">
            <GitPullRequestPanel
              worktree={worktree}
              documents={pullRequestDocuments}
              document={selectedPullRequestDocument}
              history={selectedPullRequestDocument ? projectManagementHistory : []}
              loading={projectManagementLoading}
              saving={projectManagementSaving}
              availableStatuses={projectManagementAvailableStatuses}
              selectedDocumentId={selectedPullRequestDocumentId}
              branchOptions={gitBranchOptions}
              defaultBaseBranch={selectedGitBaseBranch ?? gitComparison?.baseBranch ?? gitBranchOptions[0]?.value ?? null}
              comparisonWorkspace={comparisonWorkspace}
              aiReviewJob={activePullRequestReviewJob}
              onSelectDocument={async (documentId, options) => {
                onGitPullRequestDocumentChange(documentId);
                return onLoadProjectManagementDocument(documentId, options);
              }}
              onCreatePullRequest={createPullRequestDocument}
              onUpdatePullRequest={updatePullRequestDocument}
              onAddComment={onAddProjectManagementComment}
              onReviewByAi={reviewPullRequestByAi}
            />
          </div>
        )}
      </div>

      {commitModalOpen ? (
        <MatrixModal
          kicker="AI commit"
          title={<>Review commit message</>}
          description="Generate a draft commit message with Simple AI, edit it if needed, then commit from the diff tab."
          closeLabel="Close commit dialog"
          maxWidthClass="max-w-2xl"
          onClose={() => {
            if (commitMessageLoading || gitComparisonLoading) {
              return;
            }
            setCommitModalOpen(false);
          }}
          footer={(
            <button
              type="submit"
              form="git-ai-commit-form"
              className="matrix-button rounded-none px-3 py-2 text-sm font-semibold"
              disabled={commitMessageLoading || gitComparisonLoading || !commitMessagePreview}
            >
              {gitComparisonLoading ? "Committing..." : "Commit"}
            </button>
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
                placeholder={commitMessageLoading ? "Generating commit message..." : "Write the commit message"}
                disabled={commitMessageLoading || gitComparisonLoading}
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
