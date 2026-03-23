import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Gitgraph, Orientation, TemplateName, templateExtend } from "@gitgraph/react";
import { DiffView, DiffModeEnum } from "@git-diff-view/react";
import { DiffFile, changeMaxLengthToIgnoreLineDiff, getLang } from "@git-diff-view/core";
import "@git-diff-view/react/styles/diff-view-pure.css";
import type {
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  GitComparisonResponse,
  ProjectManagementDocument,
  ProjectManagementDocumentSummary,
  ProjectManagementHistoryEntry,
  WorktreeRecord,
} from "@shared/types";
import type { ProjectManagementSubTab } from "./project-management-panel";
import { getTmuxSessionName } from "../lib/tmux";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixAccordion, MatrixBadge, MatrixDetailField, MatrixMetric, MatrixTabButton } from "./matrix-primitives";
import { WorktreeTerminal } from "./worktree-terminal";

const ProjectManagementPanel = lazy(async () => {
  const module = await import("./project-management-panel");
  return { default: module.ProjectManagementPanel };
});

function getCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const GIT_COMPARISON_POLL_INTERVAL_MS = 3000;
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
  worktree: WorktreeRecord | null;
  worktreeOptions: MatrixDropdownOption[];
  worktreeCount: number;
  runningCount: number;
  selectedStatusLabel: string;
  onSelectWorktree: (value: string) => void;
  activeTab: "shell" | "background" | "git" | "project-management";
  onTabChange: (tab: "shell" | "background" | "git" | "project-management") => void;
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
  onSubscribeToBackgroundLogs: (branch: string, commandName: string) => () => void;
  onClearBackgroundLogs: () => void;
  projectManagementDocuments: ProjectManagementDocumentSummary[];
  projectManagementAvailableTags: string[];
  projectManagementAvailableStatuses: string[];
  projectManagementActiveSubTab: ProjectManagementSubTab;
  projectManagementSelectedDocumentId: string | null;
  projectManagementDocument: ProjectManagementDocument | null;
  projectManagementHistory: ProjectManagementHistoryEntry[];
  projectManagementLoading: boolean;
  projectManagementSaving: boolean;
  onProjectManagementSubTabChange: (tab: ProjectManagementSubTab) => void;
  onLoadProjectManagementDocuments: (options?: { silent?: boolean }) => Promise<unknown>;
  onLoadProjectManagementDocument: (documentId: string, options?: { silent?: boolean }) => Promise<ProjectManagementDocument | null>;
  onCreateProjectManagementDocument: (payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
  }) => Promise<ProjectManagementDocument | null>;
  onUpdateProjectManagementDocument: (documentId: string, payload: {
    title: string;
    markdown: string;
    tags: string[];
    status?: string;
    assignee?: string;
    archived?: boolean;
  }) => Promise<ProjectManagementDocument | null>;
}

export function WorktreeDetail({
  worktree,
  worktreeOptions,
  worktreeCount,
  runningCount,
  selectedStatusLabel,
  onSelectWorktree,
  activeTab,
  onTabChange,
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
  onSubscribeToBackgroundLogs,
  onClearBackgroundLogs,
  projectManagementDocuments,
  projectManagementAvailableTags,
  projectManagementAvailableStatuses,
  projectManagementActiveSubTab,
  projectManagementSelectedDocumentId,
  projectManagementDocument,
  projectManagementHistory,
  projectManagementLoading,
  projectManagementSaving,
  onProjectManagementSubTabChange,
  onLoadProjectManagementDocuments,
  onLoadProjectManagementDocument,
  onCreateProjectManagementDocument,
  onUpdateProjectManagementDocument,
}: WorktreeDetailProps) {
  const isRunning = Boolean(worktree?.runtime);
  const [copied, setCopied] = useState(false);
  const [selectedBackgroundCommandName, setSelectedBackgroundCommandName] = useState<string | null>(null);
  const [backgroundFilter, setBackgroundFilter] = useState("");
  const [selectedGitBaseBranch, setSelectedGitBaseBranch] = useState<string | null>(null);
  const [diffMode, setDiffMode] = useState<DiffModeEnum>(DiffModeEnum.SplitGitHub);
  const [diffTheme, setDiffTheme] = useState<"light" | "dark">("dark");
  const [diffWrap, setDiffWrap] = useState(false);
  const [diffHighlight, setDiffHighlight] = useState(false);
  const [diffFontSize, setDiffFontSize] = useState(13);
  const backgroundLogViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef(0);
  const quickLinks = worktree?.runtime?.quickLinks ?? [];
  const attachCommand = worktree
    ? `tmux attach-session -t '${getTmuxSessionName(worktree.branch).replace(/'/g, `'\\''`)}'`
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

    const handleVisibilityRefresh = () => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void loadComparison();
    };

    if (document.visibilityState === "visible") {
      void loadComparison();
    }

    const interval = window.setInterval(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      void loadComparison();
    }, GIT_COMPARISON_POLL_INTERVAL_MS);

    window.addEventListener("focus", handleVisibilityRefresh);
    document.addEventListener("visibilitychange", handleVisibilityRefresh);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
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

    void onLoadProjectManagementDocuments({ silent: true });
  }, [activeTab, onLoadProjectManagementDocuments]);

  useEffect(() => {
    if (activeTab !== "background" || !worktree?.branch) {
      return;
    }

    void onLoadBackgroundCommands(worktree.branch);
  }, [activeTab, onLoadBackgroundCommands, worktree?.branch]);

  useEffect(() => {
    if (activeTab !== "background" || !worktree?.branch || !selectedBackgroundCommand?.name) {
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
    activeTab,
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

  return (
    <section className="min-w-0 space-y-4 xl:flex xl:min-h-[calc(100vh-2rem)] xl:flex-col xl:space-y-4">
      <div className="matrix-panel rounded-none border-x-0 p-4 sm:p-5">
        <div className="flex items-center gap-2 theme-divider border-b pb-4">
          <MatrixTabButton active={activeTab === "shell"} label="Shell" onClick={() => onTabChange("shell")} />
          <MatrixTabButton active={activeTab === "background"} label="Background commands" onClick={() => onTabChange("background")} />
          <MatrixTabButton active={activeTab === "git"} label="Git status" onClick={() => onTabChange("git")} />
          <MatrixTabButton active={activeTab === "project-management"} label="Project management" onClick={() => onTabChange("project-management")} />
        </div>

        {activeTab === "shell" ? (
          <>
            <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 flex-1">
                <p className="matrix-kicker">Terminal focus</p>
                <h2 className="mt-1 text-2xl font-semibold theme-text-strong sm:text-3xl">
                  {worktree?.branch ?? "Select a worktree"}
                </h2>
                <p className="mt-1 text-sm theme-text-muted">
                  {worktree
                    ? "The shell is the primary surface. Runtime details stay visible, but the terminal owns the layout."
                    : "Choose a worktree from the worktree picker to open its terminal session."}
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
                  {worktree ? (
                    <>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || isRunning} onClick={onStart}>Start env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || !isRunning} onClick={onStop}>Stop env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onSyncEnv}>Sync .env</button>
                      <button type="button" className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onDelete}>Delete</button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
              <MatrixDetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
              <MatrixDetailField label="Head" value={worktree?.headSha ?? "-"} mono />
              <MatrixDetailField label="Started" value={worktree?.runtime?.runtimeStartedAt ? new Date(worktree.runtime.runtimeStartedAt).toLocaleString() : "-"} />
              <MatrixDetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
            </div>

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
        ) : activeTab === "background" ? (
          <div className="mt-4 space-y-4">
            <div className="theme-inline-panel p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="matrix-kicker">Background commands</p>
                  <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">Process control</h2>
                  <p className="mt-2 text-sm theme-text-muted">
                    Long-running dev services live here. Start the environment first, then manage each configured background command under PM2.
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
        ) : activeTab === "project-management" ? (
          <Suspense
            fallback={(
              <div className="mt-4 matrix-command rounded-none px-4 py-4 text-sm theme-empty-note">
                Loading project management workspace...
              </div>
            )}
          >
            <ProjectManagementPanel
              documents={projectManagementDocuments}
              availableTags={projectManagementAvailableTags}
              availableStatuses={projectManagementAvailableStatuses}
              activeSubTab={projectManagementActiveSubTab}
              selectedDocumentId={projectManagementSelectedDocumentId}
              document={projectManagementDocument}
              history={projectManagementHistory}
              loading={projectManagementLoading}
              saving={projectManagementSaving}
              onSubTabChange={onProjectManagementSubTabChange}
              onRefresh={onLoadProjectManagementDocuments}
              onSelectDocument={onLoadProjectManagementDocument}
              onCreateDocument={onCreateProjectManagementDocument}
              onUpdateDocument={onUpdateProjectManagementDocument}
            />
          </Suspense>
        ) : (
          <div className="mt-4 space-y-4">
            <div className="theme-inline-panel p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="matrix-kicker">Git status</p>
                  <h2 className="mt-2 text-2xl font-semibold theme-text-strong sm:text-3xl">Branch comparison</h2>
                  <p className="mt-2 text-sm theme-text-muted">
                    Compare the selected worktree against the default branch, including staged, unstaged, and untracked local changes in the effective diff.
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto_auto] xl:min-w-[42rem]">
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

              {gitComparison ? (
                <div className="mt-3 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
                  <MatrixDetailField label="Changed files" value={String(gitComparison.workingTreeSummary.changedFiles)} mono />
                  <MatrixDetailField label="Untracked files" value={String(gitComparison.workingTreeSummary.untrackedFiles)} mono />
                  <MatrixDetailField
                    label="Staged"
                    value={gitComparison.workingTreeSummary.staged ? "Yes" : "No"}
                    mono
                  />
                  <MatrixDetailField
                    label="Unstaged"
                    value={gitComparison.workingTreeSummary.unstaged ? "Yes" : "No"}
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
          </div>
        )}
      </div>

      <div className="min-w-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <WorktreeTerminal
          worktree={worktree}
          isTerminalVisible={isTerminalVisible}
          onTerminalVisibilityChange={onTerminalVisibilityChange}
          commandPaletteShortcut={commandPaletteShortcut}
          onCommandPaletteToggle={onCommandPaletteToggle}
          terminalShortcut={terminalShortcut}
          onTerminalShortcutToggle={onTerminalShortcutToggle}
          worktreeOptions={worktreeOptions}
          onSelectWorktree={onSelectWorktree}
          showSessionInfo={activeTab === "shell"}
        />
      </div>
    </section>
  );
}
