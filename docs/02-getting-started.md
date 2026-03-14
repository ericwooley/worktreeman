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
worktreemanager init
```

That command will:

- locate the Git root
- look for a common Compose file
- generate a starter `worktree.yml`

If you want to regenerate the file:

```bash
worktreemanager init --force
```

## Review `worktree.yml`

Before you start the UI, open `worktree.yml` and confirm:

- the worktree base directory is correct
- the Compose file path is correct
- the services and ports you want resolved are listed
- any startup commands are safe to run automatically

## Start the local UI

Run:

```bash
worktreemanager serve
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
worktreemanager serve --help
```
