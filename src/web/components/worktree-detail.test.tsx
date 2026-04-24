import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AiCommandConfig,
  AiCommandJob,
  AiCommandLogEntry,
  AiCommandLogSummary,
  BackgroundCommandLogsResponse,
  BackgroundCommandState,
  CommitGitChangesResponse,
  GitComparisonResponse,
  ProjectManagementDocument,
  ProjectManagementDocumentReview,
  ProjectManagementDocumentSummary,
  ProjectManagementDocumentSummaryResponse,
  ProjectManagementHistoryEntry,
  ProjectManagementUsersResponse,
  RunAiCommandRequest,
  RunAiCommandResponse,
  SystemStatusResponse,
  WorktreeRecord,
} from "@shared/types";

const sampleWorktree: WorktreeRecord = {
  id: "feature-branch" as WorktreeRecord["id"],
  branch: "feature/merge-actions",
  worktreePath: "/repo/.worktrees/feature-merge-actions",
  headSha: "abc1234",
  isBare: false,
  isDetached: false,
  locked: false,
  prunable: false,
};

const sampleGitComparison: GitComparisonResponse = {
  defaultBranch: "main",
  baseBranch: "main",
  compareBranch: "feature/merge-actions",
  mergeBase: null,
  ahead: 2,
  behind: 1,
  branches: [
    { name: "main", default: true },
    { name: "feature/merge-actions", current: true, hasWorktree: true },
  ],
  baseCommits: [],
  compareCommits: [],
  diff: "",
  workingTreeDiff: "",
  effectiveDiff: "",
  workingTreeSummary: {
    dirty: false,
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
    changedFiles: 0,
    conflictedFiles: 0,
    untrackedFiles: 0,
  },
  workingTreeConflicts: [],
  mergeStatus: {
    canMerge: true,
    hasConflicts: false,
    reason: null,
    conflicts: [],
  },
  mergeIntoCompareStatus: {
    canMerge: true,
    hasConflicts: false,
    reason: null,
    conflicts: [],
  },
};

const sampleAiCommands: AiCommandConfig = {
  smart: "smart",
  simple: "simple",
  autoStartRuntime: false,
};

function createAsyncNoop<T>(value: T) {
  return async () => value;
}

type WorktreeDetailProps = Parameters<typeof import("./worktree-detail")["WorktreeDetail"]>[0];

async function renderWorktreeDetail(overrides: Partial<WorktreeDetailProps> = {}) {
  const originalSelf = globalThis.self;
  Object.defineProperty(globalThis, "self", {
    configurable: true,
    writable: true,
    value: globalThis,
  });
  try {
    const { WorktreeDetail } = await import("./worktree-detail");

    return renderToStaticMarkup(
      <WorktreeDetail
        repoRoot="/repo"
        worktree={sampleWorktree}
        autoSyncRemote={null}
        worktreeOptions={[]}
        worktreeCount={1}
        runningCount={0}
        selectedStatusLabel="Selected"
        onSelectWorktree={() => undefined}
        activeTab="git"
        onTabChange={() => undefined}
        environmentSubTab="terminal"
        onEnvironmentSubTabChange={() => undefined}
        gitView="graph"
        onGitViewChange={() => undefined}
        isTerminalVisible={false}
        onTerminalVisibilityChange={() => undefined}
        commandPaletteShortcut="Ctrl+K"
        onCommandPaletteToggle={() => undefined}
        terminalShortcut="Ctrl+`"
        onTerminalShortcutToggle={() => undefined}
        isBusy={false}
        onStart={() => undefined}
        onStop={() => undefined}
        onSyncEnv={() => undefined}
        onDelete={() => undefined}
        onEnableAutoSync={() => undefined}
        onDisableAutoSync={() => undefined}
        onRunAutoSyncNow={() => undefined}
        backgroundCommands={[] as BackgroundCommandState[]}
        backgroundLogs={null as BackgroundCommandLogsResponse | null}
        gitComparison={sampleGitComparison}
        gitComparisonLoading={false}
        onLoadBackgroundCommands={createAsyncNoop([] as BackgroundCommandState[])}
        onStartBackgroundCommand={createAsyncNoop([] as BackgroundCommandState[])}
        onRestartBackgroundCommand={createAsyncNoop([] as BackgroundCommandState[])}
        onStopBackgroundCommand={createAsyncNoop([] as BackgroundCommandState[])}
        onLoadBackgroundLogs={createAsyncNoop({
          branch: sampleWorktree.branch,
          commandName: "dev",
          lines: [],
          missing: false,
        } as BackgroundCommandLogsResponse)}
        onLoadGitComparison={createAsyncNoop(sampleGitComparison)}
        onSubscribeToGitComparison={() => () => undefined}
        onMergeWorktreeIntoBase={createAsyncNoop(null as GitComparisonResponse | null)}
        onMergeBaseIntoWorktree={createAsyncNoop(null as GitComparisonResponse | null)}
        onResolveGitMergeConflicts={createAsyncNoop(null as GitComparisonResponse | null)}
        onGenerateGitCommitMessage={createAsyncNoop(null as { message: string } | null)}
        onCommitGitChanges={createAsyncNoop(null as CommitGitChangesResponse | null)}
        onSubscribeToBackgroundLogs={() => () => undefined}
        onClearBackgroundLogs={() => undefined}
        projectManagementDocuments={[] as ProjectManagementDocumentSummary[]}
        projectManagementWorktrees={[] as WorktreeRecord[]}
        projectManagementAvailableTags={[]}
        projectManagementAvailableStatuses={[]}
        projectManagementUsers={null as ProjectManagementUsersResponse | null}
        projectManagementReviews={[] as ProjectManagementDocumentReview[]}
        projectManagementDocumentReview={null as ProjectManagementDocumentReview | null}
        projectManagementActiveSubTab="document"
        projectManagementSelectedDocumentId={null}
        projectManagementDocumentPresentation="modal"
        projectManagementDocumentViewMode="document"
        projectManagementEditFormTab="write"
        projectManagementCreateFormTab="write"
        projectManagementDocument={null as ProjectManagementDocument | null}
        projectManagementHistory={[] as ProjectManagementHistoryEntry[]}
        projectManagementLoading={false}
        projectManagementError={null}
        projectManagementLastUpdatedAt={null}
        projectManagementSaving={false}
        projectManagementAiLogs={[] as AiCommandLogSummary[]}
        projectManagementAiLogDetail={null as AiCommandLogEntry | null}
        projectManagementSelectedAiLogJobId={null}
        projectManagementAiLogsLoading={false}
        projectManagementAiLogsError={null}
        projectManagementAiLogsLastUpdatedAt={null}
        projectManagementRunningAiJobs={[] as AiCommandJob[]}
        projectManagementAiActiveSubTab="log"
        systemStatus={null as SystemStatusResponse | null}
        systemLoading={false}
        systemError={null}
        systemLastUpdatedAt={null}
        systemSubTab="performance"
        projectManagementAiCommands={sampleAiCommands}
        projectManagementAiJob={null as AiCommandJob | null}
        projectManagementDocumentAiJob={null as AiCommandJob | null}
        onProjectManagementSubTabChange={() => undefined}
        onProjectManagementDocumentViewModeChange={() => undefined}
        onProjectManagementEditFormTabChange={() => undefined}
        onProjectManagementCreateFormTabChange={() => undefined}
        onProjectManagementOpenDocumentPage={() => undefined}
        onProjectManagementCloseDocument={() => undefined}
        onLoadProjectManagementDocuments={createAsyncNoop(null)}
        onLoadProjectManagementReviews={createAsyncNoop(null)}
        onLoadProjectManagementUsers={createAsyncNoop(null)}
        onLoadProjectManagementDocument={createAsyncNoop(null as ProjectManagementDocument | null)}
        onLoadProjectManagementAiLogs={createAsyncNoop(null)}
        onLoadProjectManagementAiLog={createAsyncNoop(null as AiCommandLogEntry | null)}
        onProjectManagementAiSubTabChange={() => undefined}
        onSystemSubTabChange={() => undefined}
        onLoadSystemStatus={createAsyncNoop(null as SystemStatusResponse | null)}
        onCreateProjectManagementDocument={createAsyncNoop(null as ProjectManagementDocument | null)}
        onUpdateProjectManagementDocument={createAsyncNoop(null as ProjectManagementDocument | null)}
        onUpdateProjectManagementDependencies={createAsyncNoop(null as ProjectManagementDocumentSummaryResponse | null)}
        onUpdateProjectManagementStatus={createAsyncNoop(null as ProjectManagementDocumentSummaryResponse | null)}
        onUpdateProjectManagementUsers={createAsyncNoop(null as ProjectManagementUsersResponse | null)}
        onBatchUpdateProjectManagementDocuments={createAsyncNoop(false)}
        onAddProjectManagementReviewEntry={createAsyncNoop(null as ProjectManagementDocumentReview | null)}
        onRunProjectManagementAiCommand={createAsyncNoop(null as AiCommandJob | null)}
        onRunProjectManagementDocumentAi={createAsyncNoop(null as RunAiCommandResponse | null)}
        onCancelProjectManagementDocumentAiCommand={createAsyncNoop(null as AiCommandJob | null)}
        onCancelProjectManagementAiCommand={createAsyncNoop(null as AiCommandJob | null)}
        onCancelProjectManagementAiLogJob={createAsyncNoop(null as AiCommandJob | null)}
        {...overrides}
      />,
    );
  } finally {
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      writable: true,
      value: originalSelf,
    });
  }
}

test("Git tab shows merge actions with base/main labels", async () => {
  const markup = await renderWorktreeDetail();

  assert.match(markup, />Merge into base</);
  assert.match(markup, />Merge base into main</);
  assert.doesNotMatch(markup, />Merge worktree into base</);
  assert.doesNotMatch(markup, />Merge base into worktree</);
});

test("Review tab renders linked document review timeline", async () => {
  const markup = await renderWorktreeDetail({
    activeTab: "review",
    worktree: {
      ...sampleWorktree,
      linkedDocument: {
        id: "doc-1",
        number: 1,
        title: "Dependencies",
        summary: "Track prerequisite document work.",
        status: "todo",
        archived: false,
      },
    },
    projectManagementDocuments: [{
      id: "doc-1",
      number: 1,
      title: "Dependencies",
      summary: "Track prerequisite document work.",
      tags: ["feature"],
      dependencies: [],
      status: "todo",
      assignee: "Eric",
      archived: false,
      createdAt: "2026-03-20T10:00:00.000Z",
      updatedAt: "2026-03-25T10:00:00.000Z",
      historyCount: 2,
    }],
    projectManagementReviews: [{
      documentId: "doc-1",
      entries: [{
        id: "review-1",
        documentId: "doc-1",
        kind: "comment",
        source: "user",
        eventType: "comment",
        body: "## Review note\n\nNeed a **final QA pass**",
        createdAt: "2026-03-25T11:30:00.000Z",
        updatedAt: "2026-03-25T11:30:00.000Z",
        authorName: "Casey Reviewer",
        authorEmail: "casey@example.com",
      }],
    }],
  });

  assert.match(markup, />Review</);
  assert.match(markup, /Linked document/);
  assert.match(markup, /Dependencies/);
  assert.match(markup, /Track comments, AI activity, and merge events/);
  assert.match(markup, /Add review entry/);
  assert.match(markup, /Casey Reviewer/);
  assert.match(markup, /Need a <strong>final QA pass<\/strong>/);
  assert.match(markup, /Continue implementation/);
  assert.match(markup, /Smart AI will continue implementing this review with the linked document, prior AI runs, and your new request\./);
});

test("Review tab shows live AI output instead of the follow-up composer while AI is active", async () => {
  const markup = await renderWorktreeDetail({
    activeTab: "review",
    worktree: {
      ...sampleWorktree,
      linkedDocument: {
        id: "doc-1",
        number: 1,
        title: "Dependencies",
        summary: "Track prerequisite document work.",
        status: "todo",
        archived: false,
      },
    },
    projectManagementRunningAiJobs: [{
      jobId: "job-1",
      fileName: "job-1.md",
      worktreeId: sampleWorktree.id,
      branch: sampleWorktree.branch,
      worktreePath: sampleWorktree.worktreePath,
      commandId: "smart",
      command: "opencode run ...",
      input: "Continue this review",
      status: "running",
      startedAt: "2026-03-25T12:00:00.000Z",
      completedAt: undefined,
      pid: 1234,
      processName: "wtm:ai:job-1",
      exitCode: null,
      stdout: "Working...",
      stderr: "",
      error: null,
      documentId: "doc-1",
      origin: {
        kind: "worktree-review",
        label: "Review follow-up",
        description: "Continue review activity for Dependencies",
        location: {
          tab: "review",
          branch: sampleWorktree.branch,
          worktreeId: sampleWorktree.id,
          documentId: "doc-1",
        },
      },
      outputEvents: [{
        id: "evt-1",
        source: "stdout",
        text: "Working...",
        timestamp: "2026-03-25T12:00:01.000Z",
      }],
    }],
  });

  assert.match(markup, /AI is active/);
  assert.match(markup, /Follow the live output for this worktree before starting another AI follow-up\./);
  assert.match(markup, /Worktree AI is working/);
  assert.match(markup, /Mixed output timeline/);
  assert.match(markup, /Cancel AI/);
  assert.doesNotMatch(markup, /Smart AI will continue implementing this review with the linked document, prior AI runs, and your new request\./);
});
