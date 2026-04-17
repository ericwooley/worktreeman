# Overview

`worktreeman` is a local CLI and browser UI for running branch-based development environments out of one repository.

Hosted docs: https://ericwooley.github.io/worktreeman/

It is built for repositories that already use:

- `git worktree`
- `tmux`

Instead of manually creating worktrees, exporting ports, starting long-running commands, and keeping terminal sessions alive, `worktreeman` wires those pieces together and exposes them in one local control panel.

## What it does

With `worktreeman`, you can:

- create and remove Git worktrees for branches
- allocate configured runtime ports for each worktree
- inject runtime environment variables in memory instead of writing `.env` files
- run startup commands and background commands with the same resolved env
- open a browser terminal attached to a tmux session for that branch

## Why use it

The typical branch workflow usually turns into a mix of shell history, copied commands, and local setup notes.

`worktreeman` reduces that by standardizing:

- where worktrees are created
- how configured runtime ports are allocated
- how derived environment variables are assembled
- how developers reconnect to the same terminal session

## Typical flow

1. Install `worktreeman` from npm or run it one-off with `npx -y worktreeman`.
2. Run `worktreeman create --cwd /path/to/repo` or `worktreeman clone <remote> --cwd /path/to/repo`.
3. Review the generated `wtm-settings/worktree.yml`.
4. Start the local UI with `worktreeman start --cwd /path/to/repo`.
5. Create a worktree, start its runtime, and use the terminal panel.

`worktreeman` only runs in its required bare layout: `.git` must point to `./.bare`, `.bare/` must be bare, and checked-out worktrees such as `main/` and `wtm-settings/` must live directly under the same root.

## What it does not do

`worktreeman` does not replace your application stack. It does not define your services, dependency graph, or startup logic.

You keep those in your repository. `worktreeman` orchestrates them consistently across disposable branch environments.

It currently targets macOS and Linux workflows. Windows is not supported for the full runtime experience because the terminal flow depends on `tmux` and Unix-style shell behavior.
