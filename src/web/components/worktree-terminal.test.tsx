import assert from "node:assert/strict";
import test from "#test-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorktreeRecord } from "@shared/types";

const WORKTREE_ID = "88888888888888888888888888888888" as WorktreeRecord["id"];

const sampleWorktree: WorktreeRecord = {
  id: WORKTREE_ID,
  branch: "feature-shell-reconnect",
  worktreePath: "/repo/feature-shell-reconnect",
  isBare: false,
  isDetached: false,
  locked: false,
  prunable: false,
  runtime: {
    id: WORKTREE_ID,
    branch: "feature-shell-reconnect",
    worktreePath: "/repo/feature-shell-reconnect",
    env: {
      APP_PORT: "43043",
      FEATURE_FLAG: "enabled",
    },
    quickLinks: [],
    allocatedPorts: {
      APP_PORT: 43043,
    },
    tmuxSession: "wt-feature-shell-reconnect",
    runtimeStartedAt: "2026-03-28T01:00:42.348Z",
  },
};

async function renderTerminal(overrides: Record<string, unknown> = {}) {
  Object.assign(globalThis as Record<string, unknown>, { self: globalThis });
  const { WorktreeTerminal } = await import("./worktree-terminal");

  return renderToStaticMarkup(
    <WorktreeTerminal
      repoRoot="/repo"
      worktree={sampleWorktree}
      isTerminalVisible={false}
      onTerminalVisibilityChange={() => undefined}
      worktreeOptions={[
        { value: sampleWorktree.branch, label: sampleWorktree.branch },
      ]}
      onSelectWorktree={() => undefined}
      showSessionInfo
      commandPaletteShortcut="Meta+K"
      onCommandPaletteToggle={() => undefined}
      terminalShortcut="Meta+J"
      onTerminalShortcutToggle={() => undefined}
      {...overrides}
    />,
  );
}

test("worktree terminal renders reconnect and restart controls beside session details", async () => {
  const markup = await renderTerminal();

  assert.match(markup, /Environment session info/);
  assert.match(markup, /Connected/);
  assert.match(markup, />Show terminal</);
  assert.match(markup, />Reconnect shell</);
  assert.match(markup, />Restart environment</);
  assert.match(markup, /tmux session wt-feature-shell-reconnect is docked as a fixed terminal overlay/);
  assert.match(markup, /APP_PORT/);
  assert.match(markup, /FEATURE_FLAG/);
  assert.match(markup, /Attached tmux clients/);
});

test("worktree terminal keeps shell actions disabled when no worktree is selected", async () => {
  const markup = await renderTerminal({
    repoRoot: null,
    worktree: null,
    worktreeOptions: [],
  });

  assert.match(markup, /Disconnected/);
  assert.match(markup, /Select a worktree to attach to its tmux session/);
  assert.match(markup, /disabled=""[^>]*>Show terminal</);
  assert.match(markup, /disabled=""[^>]*>Reconnect shell</);
  assert.match(markup, /disabled=""[^>]*>Restart environment</);
});
