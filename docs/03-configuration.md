# Configuration

## Contents

- [Schema and editor support](#schema-and-editor-support)
- [Recommended full example](#recommended-full-example)
- [How configuration flows at runtime](#how-configuration-flows-at-runtime)
- [Compose port declaration recommendation](#compose-port-declaration-recommendation)
- [Top-level fields](#top-level-fields)
- [`env`](#env)
- [`runtimePorts`](#runtimeports)
- [`derivedEnv`](#derivedenv)
- [`quickLinks`](#quicklinks)
- [`startupCommands`](#startupcommands)
- [`backgroundCommands`](#backgroundcommands)
- [`worktrees`](#worktrees)
  - [`worktrees.baseDir`](#worktreesbasedir)
- [Practical patterns](#practical-patterns)
- [Minimal app with one dev server](#minimal-app-with-one-dev-server)
- [App plus database and worker](#app-plus-database-and-worker)
- [Notes on `init`](#notes-on-init)

`worktreeman` reads configuration from one of these files in the checked-out `wtm-settings` worktree inside the managed bare layout:

- `worktree.yml`
- `worktree.yaml`
- `worktreeman.yml`
- `worktreeman.yaml`

In most repos, `worktree.yml` is the best default.

## Schema and editor support

If you want editor validation and autocomplete, put this at the top of the file:

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json
```

You can also keep a top-level `$schema` key in the file body if you want, but the comment form is the primary editor hint used by YAML language servers.

If you start the local UI, the header `Config` action opens the shared `worktree.yml` in a built-in Monaco editor modal and saves directly back to the checked-out settings worktree.

## Recommended full example

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json

env:
  NODE_ENV: development
  APP_NAME: my-app

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

## How configuration flows at runtime

When you click `Start env`, `worktreeman` builds the runtime in this order:

1. Start with static `env`
2. Allocate any `runtimePorts`
3. Render `derivedEnv` from the values above
4. Render `quickLinks` from the final assembled env
5. Prepare the tmux-backed runtime session
6. Run `startupCommands` sequentially and wait for them to finish
7. Start all configured `backgroundCommands` under PM2
8. Expose the final env to the tmux-backed shell and UI

That ordering matters:

- `derivedEnv` can reference values from `env` and `runtimePorts`
- `quickLinks` can reference all of the above plus previously-derived values

## Top-level fields

## `env`

Static environment variables added to every runtime for the repo.

Use `env` for values that do not depend on runtime port allocation.

Example:

```yml
env:
  NODE_ENV: development
  LOG_LEVEL: debug
```

## `runtimePorts`

Environment variable names that should receive an allocated free local port.

Use this when your app needs a free port that is not discovered from Docker, such as:

- a frontend dev server
- a webhook callback listener
- a local preview server

Example:

```yml
runtimePorts:
  - PORT
  - WEBHOOK_PORT
```

If `PORT` is allocated as `28737`, that value is available to:

- `startupCommands`
- the tmux shell session
- `derivedEnv`
- `quickLinks`

## `derivedEnv`

Derived environment variables rendered from other env values using `${VAR_NAME}` interpolation.

Use this for values like:

- URLs
- DSNs
- connection strings
- compound app configuration values

Example:

```yml
derivedEnv:
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app
  API_BASE_URL: http://localhost:${BACKEND_SERVER_PORT}
```

## `quickLinks`

Quick links are rendered after the runtime env and `derivedEnv` are assembled and shown in the UI as clickable links.

Each entry is an ordered object with:

- `name`: label shown in the UI
- `url`: rendered URL or connection string

Example:

```yml
quickLinks:
  - name: PostgreSQL
    url: postgresql://postgres:postgres@localhost:${DB_PORT}/postgres
  - name: MinIO Console
    url: http://localhost:${MINIO_CONSOLE_PORT}
```

Notes:

- Order is preserved
- `${VAR_NAME}` interpolation is supported in `url`
- these are useful for browser links, health checks, dashboards, admin panels, and connection strings you want visible in one place

## `startupCommands`

Commands that run after the runtime environment has been assembled.

Use this for predictable setup work such as:

- dependency install
- database migrations
- code generation
- cache priming

Example:

```yml
startupCommands:
  - pnpm install
  - pnpm run db:migrate
```

Keep these commands idempotent and predictable. They run when a developer starts the environment.

## `backgroundCommands`

Named long-running commands shown in the `Background commands` tab.

These are intended for processes such as:

- `pnpm run dev`
- workers
- file watchers
- background job processors

Example:

```yml
backgroundCommands:
  Web dev:
    command: pnpm run dev
  Worker:
    command: pnpm run worker
```

Notes:

- these commands are run with PM2
- they start automatically after `startupCommands` finish during `Start env`
- they can be started and stopped independently from the UI
- their logs appear in the `Background commands` tab
- if you want `docker compose up`, declare it explicitly as a background command like any other process

## `worktrees`

Worktree layout settings.

### `worktrees.baseDir`

Directory where new Git worktrees are created.

This path is resolved relative to the repository root unless you provide an absolute path.

Example:

```yml
worktrees:
  baseDir: .
```

## Practical patterns

## Minimal app with one dev server

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
  Web dev:
    command: pnpm run dev
```

## App plus database and worker

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT
  - DB_PORT

derivedEnv:
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
```

## Notes on `init`

`worktreeman init` creates a starter config in the `wtm-settings` worktree with the schema header and the basic runtime fields.

It also writes the schema header automatically so editors can validate the file.

`worktreeman start` expects the managed bare layout plus the checked-out `wtm-settings` worktree to be present locally and does not fall back to any other repository shape.

You should still review the generated file and adjust:

- `runtimePorts`
- `derivedEnv`
- `quickLinks`
- `startupCommands`
- `backgroundCommands`

to match your actual workflow.
