# Overview

Worktree Manager is a local control plane for branch-based development.

It gives you one browser interface for:

- creating and removing Git worktrees
- starting branch-scoped Docker Compose environments
- discovering real published host ports after Docker starts
- injecting runtime environment variables in memory instead of writing `.env` files
- attaching to tmux-backed terminals through the browser

## What makes it different

The core idea is that every branch can act like a small disposable environment.

Instead of manually juggling:

- extra terminal tabs
- shell exports
- one-off Docker commands
- local port collisions
- detached tmux sessions

Worktree Manager coordinates those pieces together and keeps the wiring visible in one place.

## Typical workflow

1. Create a worktree for the branch you want to work on.
2. Start that branch runtime from the UI.
3. Let Worktree Manager discover real host ports and assemble runtime env values.
4. Open the browser terminal and work inside the tmux-backed session for that branch.
5. Stop the runtime and delete the worktree when you are done.

## What the app manages for you

- branch-specific worktree paths
- branch-scoped Docker Compose project names
- resolved host ports for services that publish dynamically
- runtime environment variables passed directly into startup commands and terminals
- persistent tmux sessions you can reconnect to from the browser
