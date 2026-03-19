# Overview

`worktreemanager` is a local CLI and browser UI for running branch-based development environments out of one repository.

It is built for repositories that already use:

- `git worktree`
- `tmux`

Instead of manually creating worktrees, exporting ports, starting long-running commands, and keeping terminal sessions alive, `worktreemanager` wires those pieces together and exposes them in one local control panel.

## What it does

With `worktreemanager`, you can:

- create and remove Git worktrees for branches
- allocate configured runtime ports for each worktree
- inject runtime environment variables in memory instead of writing `.env` files
- run startup commands and background commands with the same resolved env
- open a browser terminal attached to a tmux session for that branch

## Why use it

The typical branch workflow usually turns into a mix of shell history, copied commands, and local setup notes.

`worktreemanager` reduces that by standardizing:

- where worktrees are created
- how configured runtime ports are allocated
- how derived environment variables are assembled
- how developers reconnect to the same terminal session

## Typical flow

1. Install `worktreemanager` from npm.
2. Run `worktreemanager init` or `worktreemanager init main` in the repository you want to manage.
3. Review the generated `worktree.yml`.
4. Start the local UI with `worktreemanager start`.
5. Create a worktree, start its runtime, and use the terminal panel.

## What it does not do

`worktreemanager` does not replace your application stack. It does not define your services, dependency graph, or startup logic.

You keep those in your repository. `worktreemanager` orchestrates them consistently across disposable branch environments.
