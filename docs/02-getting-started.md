# Getting Started

## Contents

- [Requirements](#requirements)
- [Install the CLI](#install-the-cli)
- [Initialize a repository](#initialize-a-repository)
- [Review `worktree.yml`](#review-worktreeyml)
- [Prepare your Docker Compose file](#prepare-your-docker-compose-file)
  - [Force a specific port for one branch with `.env`](#force-a-specific-port-for-one-branch-with-env)
  - [Use arbitrary runtime port env vars too](#use-arbitrary-runtime-port-env-vars-too)
  - [A good mental model](#a-good-mental-model)
- [Starter templates](#starter-templates)
  - [1. Postgres-only service](#1-postgres-only-service)
  - [2. App + API + database](#2-app--api--database)
  - [3. App + MinIO + webhook listener](#3-app--minio--webhook-listener)
- [Start the local UI](#start-the-local-ui)
- [First run](#first-run)
- [Useful commands](#useful-commands)

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

From the repository root, you can either let `init` ask you questions:

```bash
worktreemanager init
```

Or provide the branch up front:

```bash
worktreemanager init main
```

That command will:

- locate the Git root
- ask which branch should hold the shared config when needed
- ask what `worktrees.baseDir` should be when needed
- ask which environment variables should get dynamically reserved local ports, such as `PORT` or `VITE_PORT`
- create or reuse the target branch worktree
- look for a common Compose file in that worktree
- generate a starter `worktree.yml` in that branch worktree

If you want to regenerate the file:

```bash
worktreemanager init main --force
```

If you already know the worktree layout you want, you can also pass it directly:

```bash
worktreemanager init main --base-dir ..
```

## Review `worktree.yml`

Before you start the UI, open the generated `worktree.yml` in the target branch worktree and confirm:

- the worktree base directory is correct
- the Compose file path is correct
- the services and ports you want resolved are listed
- any startup commands are safe to run automatically

## Prepare your Docker Compose file

If your repo uses Docker Compose, the most important setup step is making published host ports dynamic by default.

The recommended pattern is:

```yml
services:
  postgres:
    image: postgres:16
    ports:
      - "${DB_PORT:-0}:5432"

  minio:
    image: minio/minio
    command: server /data --console-address ':9001'
    ports:
      - "${MINIO_PORT:-0}:9000"
      - "${MINIO_CONSOLE_PORT:-0}:9001"
```

Why `0` matters:

- `0` tells Docker to choose any open host port
- that avoids port collisions between branches
- `worktreemanager` can still discover the real published host port and inject it into your runtime env

That means a config entry like this:

```yml
docker:
  portMappings:
    - service: postgres
      containerPort: 5432
      envName: DB_PORT
```

turns into a real runtime value such as:

```text
DB_PORT=32841
```

### Force a specific port for one branch with `.env`

Sometimes you do want a fixed port for a specific branch or a specific local workflow.

Because Compose interpolation reads from `.env`, you can override the default `0` behavior by setting a real port in the branch worktree:

```env
DB_PORT=55432
MINIO_CONSOLE_PORT=59001
```

With the same Compose file:

```yml
ports:
  - "${DB_PORT:-0}:5432"
```

Docker will now try to bind the fixed host port from the `.env` file instead of choosing a random one.

This is useful when:

- one branch needs to integrate with another local tool expecting a fixed port
- you want a stable connection string for a temporary workflow
- you need to match a port that another system already points at

If the fixed port is already in use, Docker will fail to start that service, so the default recommendation is still to use `0` unless you have a specific reason not to.

### Use arbitrary runtime port env vars too

Not every useful port comes from Docker.

You can ask `worktreemanager` to allocate additional free local ports for arbitrary environment variables with `runtimePorts`:

```yml
runtimePorts:
  - PORT
  - VITE_PORT
  - WEBHOOK_PORT
```

This is useful for things like:

- frontend dev servers
- Vite or Next.js preview ports
- webhook listeners
- callback ports for local integrations
- any non-Docker process started from `startupCommands`, the terminal, or `Background commands`

Those values become available everywhere in the runtime:

- startup commands
- background commands
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

### A good mental model

Use these two rules:

1. If the port belongs to a Docker service, prefer Compose `ports:` with `${NAME:-0}` and map it with `docker.portMappings` or `docker.servicePorts`.
2. If the port belongs to an arbitrary local process, use `runtimePorts`.

That gives you branch-safe defaults while still letting you pin a specific port from `.env` when needed.

For the full field-by-field reference, see [`docs/03-configuration.md`](docs/03-configuration.md).

## Starter templates

These are copy/paste starting points you can adapt for common setups.

### 1. Postgres-only service

Use this when the main thing you need from Docker is a database, and the rest of your app runs from local commands.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT

derivedEnv:
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app
  APP_URL: http://localhost:${PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}
  - name: PostgreSQL
    url: postgresql://postgres:postgres@localhost:${DB_PORT}/postgres

worktrees:
  baseDir: .worktrees

docker:
  composeFile: docker-compose.yml
  projectPrefix: wt
  portMappings:
    - service: postgres
      containerPort: 5432
      envName: DB_PORT

startupCommands:
  - pnpm install
  - pnpm run db:migrate

backgroundCommands:
  Web dev:
    command: pnpm run dev
```

Matching Compose snippet:

```yml
services:
  postgres:
    image: postgres:16
    ports:
      - "${DB_PORT:-0}:5432"
```

### 2. App + API + database

Use this when your Compose stack brings up multiple backend services and you still want one stable frontend dev port outside Docker.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}
  API_BASE_URL: http://localhost:${BACKEND_SERVER_PORT}
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app

quickLinks:
  - name: App
    url: http://localhost:${PORT}
  - name: API health
    url: http://localhost:${BACKEND_SERVER_PORT}/health
  - name: PostgreSQL
    url: postgresql://postgres:postgres@localhost:${DB_PORT}/postgres

worktrees:
  baseDir: .worktrees

docker:
  composeFile: docker-compose.yml
  projectPrefix: wt
  portMappings:
    - service: postgres
      containerPort: 5432
      envName: DB_PORT
  servicePorts:
    backendServer:
      service: api
      containerPort: 3000
      envName: BACKEND_SERVER_PORT

startupCommands:
  - pnpm install
  - pnpm run db:migrate

backgroundCommands:
  Web dev:
    command: pnpm run dev
  Worker:
    command: pnpm run worker
```

Matching Compose snippet:

```yml
services:
  api:
    build: .
    ports:
      - "${BACKEND_SERVER_PORT:-0}:3000"

  postgres:
    image: postgres:16
    ports:
      - "${DB_PORT:-0}:5432"
```

### 3. App + MinIO + webhook listener

Use this when you want Docker-managed backing services plus arbitrary local ports for non-Docker listeners.

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT
  - WEBHOOK_PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}
  WEBHOOK_URL: http://localhost:${WEBHOOK_PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}
  - name: MinIO Console
    url: http://localhost:${MINIO_CONSOLE_PORT}
  - name: Webhook listener
    url: http://localhost:${WEBHOOK_PORT}

worktrees:
  baseDir: .worktrees

docker:
  composeFile: docker-compose.yml
  projectPrefix: wt
  portMappings:
    - service: minio
      containerPort: 9001
      envName: MINIO_CONSOLE_PORT

startupCommands:
  - pnpm install

backgroundCommands:
  Web dev:
    command: pnpm run dev
  Webhook receiver:
    command: pnpm run webhook:dev
```

Matching Compose snippet:

```yml
services:
  minio:
    image: minio/minio
    command: server /data --console-address ':9001'
    ports:
      - "${MINIO_PORT:-0}:9000"
      - "${MINIO_CONSOLE_PORT:-0}:9001"
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
