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

## What ships where

- the CLI and local app are the real operator interface
- the standalone docs site is a separate static artifact built from Markdown files in `docs/`
- the local app stays focused on filesystem access, Git, Docker, and tmux integration
