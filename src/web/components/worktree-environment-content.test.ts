import assert from "node:assert/strict";
import test from "node:test";
import {
  BACKGROUND_COMMAND_CONTROL_DESCRIPTION,
  BACKGROUND_COMMAND_CONTROL_TITLE,
  ENVIRONMENT_SESSION_INFO_TITLE,
  WORKTREE_ENVIRONMENT_DESCRIPTION,
  WORKTREE_ENVIRONMENT_EMPTY_DESCRIPTION,
  WORKTREE_ENVIRONMENT_TAB_LABEL,
} from "./worktree-environment-content";

test("worktree environment copy stays aligned with the renamed top-level tab", () => {
  assert.equal(WORKTREE_ENVIRONMENT_TAB_LABEL, "Worktree Environment");
  assert.match(WORKTREE_ENVIRONMENT_DESCRIPTION, /runtime details, tmux access, and terminal controls/);
  assert.match(WORKTREE_ENVIRONMENT_EMPTY_DESCRIPTION, /open its environment and terminal session/);
});

test("background commands copy describes the nested environment sub tab", () => {
  assert.equal(BACKGROUND_COMMAND_CONTROL_TITLE, "Background command control");
  assert.match(BACKGROUND_COMMAND_CONTROL_DESCRIPTION, /inside this worktree environment/);
  assert.equal(ENVIRONMENT_SESSION_INFO_TITLE, "Environment session info");
});
