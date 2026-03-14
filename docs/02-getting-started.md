# Getting Started

## Requirements

Install these first:

- Node.js 20+
- Git with `git worktree`
- Docker with `docker compose`
- tmux

You also need a Git repository that already contains the app or service stack you want to run.

## Install the CLI

Install `worktreemanager` globally from npm:

```bash
npm install -g worktreemanager
```

Check that the command is available:

```bash
worktreemanager --help
```

## Initialize a repository

From the repository root:

```bash
worktreemanager init main
```

That command will:

- locate the Git root
- create or reuse the `main` branch worktree
- look for a common Compose file in that worktree
- generate a starter `worktree.yml` in that branch worktree

If you want to regenerate the file:

```bash
worktreemanager init main --force
```

## Review `worktree.yml`

Before you start the UI, open the generated `worktree.yml` in the target branch worktree and confirm:

- the worktree base directory is correct
- the Compose file path is correct
- the services and ports you want resolved are listed
- any startup commands are safe to run automatically

## Start the local UI

Run:

```bash
worktreemanager start
```

Then open:

```text
http://127.0.0.1:4312
```

## First run

1. Enter a branch name.
2. Create the worktree.
3. Select that worktree in the list.
4. Click `Start env`.
5. Wait for Docker startup, port discovery, and any configured startup commands.
6. Use the terminal panel to work inside the tmux-backed session.

## Useful commands

```bash
worktreemanager --help
worktreemanager init --help
worktreemanager start --help
```
