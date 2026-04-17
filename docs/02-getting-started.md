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

Supported platforms:

- macOS and Linux are the intended environments
- Windows is not currently supported for the full runtime flow because `tmux` and the browser terminal path assume a Unix-style shell environment

If you want tmux copy-mode selections to reach your system clipboard from the browser terminal, add this to your `~/.tmux.conf`:

```tmux
set -s set-clipboard external
set -g allow-passthrough on
set -g terminal-features 'xterm-256color:clipboard'
set -as terminal-overrides ',xterm-256color:Ms=\E]52;%p1%s;%p2%s\a'
```

## Install the CLI

Run the CLI without installing it globally (recommended for one-off use):

```bash
npx -y worktreeman start
```

For a full first-time setup in a new managed repo, the usual sequence is:

```bash
npx -y worktreeman create --cwd /path/to/repo
npx -y worktreeman init --cwd /path/to/repo
npx -y worktreeman start --cwd /path/to/repo
```

If you prefer a global install for repeated local use:

```bash
npm install -g worktreeman
worktreeman --help
```

## Initialize a repository

Create a new managed repository layout:

```bash
worktreeman create --cwd /path/to/repo
```

Or clone an existing remote directly into the managed layout:

```bash
worktreeman clone git@github.com:owner/repo.git --cwd /path/to/repo
```

That setup creates this required structure:

```text
/path/to/repo/
  .bare/
  .git
  main/
  wtm-settings/
```

After that, `worktreeman init` will:

- locate the managed bare-layout root
- create or reuse the `wtm-settings` worktree for the shared config
- ask which environment variables should get dynamically reserved local ports, such as `PORT` or `VITE_PORT`
- generate a starter `worktree.yml` in `wtm-settings/`

If you want to regenerate the file:

```bash
worktreeman init --cwd /path/to/repo --force
```

## Review `worktree.yml`

Before you start the UI, open the generated `worktree.yml` in the `wtm-settings` worktree and confirm:

- the worktree base directory is correct
- the runtime port env vars you want are listed
- any startup commands are safe to run automatically
- any long-running processes you want are listed under `backgroundCommands`

Once the UI is running, you can also use the `Config` button in the header to edit the shared file in a built-in Monaco editor modal.

`worktreeman start` reads config from that checked-out `wtm-settings` worktree only and fails if the bare layout is missing or invalid.

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

Notes:

- allocated runtime ports are reserved on loopback for local development use
- these values are ephemeral per runtime start, so consume them through env interpolation rather than hard-coding them elsewhere

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
    command: pnpm run dev
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
  baseDir: .

startupCommands:
  - pnpm install
  - pnpm run db:migrate

backgroundCommands:
  Web dev:
    command: pnpm run dev
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
  baseDir: .

startupCommands:
  - pnpm install
  - pnpm run db:migrate

backgroundCommands:
  Web dev:
    command: pnpm run dev
  Worker:
    command: pnpm run worker
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
  baseDir: .

startupCommands:
  - pnpm install

backgroundCommands:
  Docker services:
    command: docker compose up
  Web dev:
    command: pnpm run dev
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
http://localhost:4312
```

Notes on host selection:

- Use `--host auto` to let worktreeman prefer a Tailscale interface, then WireGuard, then a private LAN address, and finally localhost.
- Binding to wildcard hosts such as `0.0.0.0` or `::` requires `--dangerously-expose-to-network` to prevent accidental exposure of the terminal-enabled UI.

## Troubleshooting

- `worktreeman start` says the layout is invalid: make sure the repo root contains `.bare/`, a `.git` file pointing at `./.bare`, and checked-out `main/` plus `wtm-settings/`
- your app did not pick up `${PORT}` or another runtime var: start the environment from the UI first so `runtimePorts`, `derivedEnv`, and tmux env injection all run
- a setup command works in one shell but not another: `startupCommands` run through the user's shell with `SHELL -lc`, so shell configuration can affect behavior
- you need remote access to the UI: prefer `--host auto` for Tailscale or other private-network interfaces before using wildcard binds

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
