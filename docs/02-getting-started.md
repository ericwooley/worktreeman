# Getting Started

## Contents

- [Requirements](#requirements)
- [Install the CLI](#install-the-cli)
- [Initialize a repository](#initialize-a-repository)
- [Review `worktree.yml`](#review-worktreeyml)
- [Use runtime ports](#use-runtime-ports)
- [Run startup and background commands](#run-startup-and-background-commands)
- [Starter templates](#starter-templates)
  - [1. App with one dev server](#1-app-with-one-dev-server)
  - [2. App plus database and worker](#2-app-plus-database-and-worker)
  - [3. App plus Docker commands as background processes](#3-app-plus-docker-commands-as-background-processes)
- [Start the local UI](#start-the-local-ui)
- [First run](#first-run)
- [Useful commands](#useful-commands)

## Requirements

Install these first:

- Node.js 20+
- Git with `git worktree`
- tmux

You also need a Git repository that already contains the app or service stack you want to run.

## Install the CLI

Install `worktreeman` globally with Bun:

```bash
bun add -g worktreeman
```

Check that the command is available:

```bash
worktreeman --help
```

## Initialize a repository

From the repository root, you can either let `init` ask you questions:

```bash
worktreeman init
```

Or provide the branch up front:

```bash
worktreeman init main
```

That command will:

- locate the Git root
- ask which branch should hold the shared config when needed
- ask what `worktrees.baseDir` should be when needed
- ask which environment variables should get dynamically reserved local ports, such as `PORT` or `VITE_PORT`
- create or reuse the target branch worktree
- generate a starter `worktree.yml` in that branch worktree

If you want to regenerate the file:

```bash
worktreeman init main --force
```

If you already know the worktree layout you want, you can also pass it directly:

```bash
worktreeman init main --base-dir ..
```

## Review `worktree.yml`

Before you start the UI, open the generated `worktree.yml` in the target branch worktree and confirm:

- the worktree base directory is correct
- the runtime port env vars you want are listed
- any startup commands are safe to run automatically
- any long-running processes you want are listed under `backgroundCommands`

## Use runtime ports

If your repo needs free local ports for dev servers, webhook listeners, or other processes, add them to `runtimePorts`:

```yml
runtimePorts:
  - PORT
  - VITE_PORT
  - WEBHOOK_PORT
```

Those values are allocated when you click `Start env`, then injected into:

- `startupCommands`
- `backgroundCommands`
- the tmux shell session
- `derivedEnv`
- `quickLinks`

Example:

```yml
derivedEnv:
  APP_URL: http://localhost:${PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}
  - name: Webhook receiver
    url: http://localhost:${WEBHOOK_PORT}
```

## Run startup and background commands

`Start env` runs in this order:

1. allocate configured `runtimePorts`
2. render `derivedEnv`
3. render `quickLinks`
4. prepare the tmux session
5. run `startupCommands` sequentially and wait for them to finish
6. start every configured `backgroundCommand` under PM2

If you want `docker compose up`, put it in `backgroundCommands` like any other long-running process:

```yml
backgroundCommands:
  Docker services:
    command: docker compose up
  Web dev:
    command: bun run dev
```

For the full field-by-field reference, see [`docs/03-configuration.md`](docs/03-configuration.md).

## Starter templates

These are copy/paste starting points you can adapt for common setups.

### 1. App with one dev server

Use this when your app mainly needs one allocated app port and a single long-running dev process.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}

worktrees:
  baseDir: .worktrees

startupCommands:
  - bun install
  - bun run db:migrate

backgroundCommands:
  Web dev:
    command: bun run dev
```

### 2. App plus database and worker

Use this when setup work should run first and then multiple long-running processes should stay up.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT
  - DB_PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app

quickLinks:
  - name: App
    url: http://localhost:${PORT}
  - name: PostgreSQL
    url: postgresql://postgres:postgres@localhost:${DB_PORT}/postgres

worktrees:
  baseDir: .worktrees

startupCommands:
  - bun install
  - bun run db:migrate

backgroundCommands:
  Web dev:
    command: bun run dev
  Worker:
    command: bun run worker
```

### 3. App plus Docker commands as background processes

Use this when you still want Docker in your workflow, but only as a normal background command.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}

worktrees:
  baseDir: .worktrees

startupCommands:
  - bun install

backgroundCommands:
  Docker services:
    command: docker compose up
  Web dev:
    command: bun run dev
```

These are intentionally minimal starting points. After pasting one in, the usual next steps are:

- add or remove `runtimePorts`
- tighten `derivedEnv`
- add more `quickLinks`
- add migrations or setup commands to `startupCommands`
- add long-running dev processes to `backgroundCommands`

## Start the local UI

Run:

```bash
worktreeman start
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
5. Wait for startup commands to finish and background commands to launch.
6. Use the terminal panel to work inside the tmux-backed session.

## Useful commands

```bash
worktreeman --help
worktreeman init --help
worktreeman start --help
```
