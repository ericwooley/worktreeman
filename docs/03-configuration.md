# Configuration

`worktreemanager` reads configuration from one of these files at the repository root:

- `worktree.yml`
- `worktree.yaml`
- `worktreemanager.yml`
- `worktreemanager.yaml`

In most repos, `worktree.yml` is the best default.

## Schema and editor support

If you want editor validation and autocomplete, put this at the top of the file:

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json
```

You can also keep a top-level `$schema` key in the file body if you want, but the comment form is the primary editor hint used by YAML language servers.

## Recommended full example

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json

env:
  NODE_ENV: development
  APP_NAME: my-app

runtimePorts:
  - PORT
  - VITE_PORT

derivedEnv:
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app
  APP_URL: http://localhost:${PORT}

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
    - service: minio
      containerPort: 9001
      envName: MINIO_CONSOLE_PORT
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

## How configuration flows at runtime

When you click `Start env`, `worktreemanager` builds the runtime in this order:

1. Start with static `env`
2. Allocate any `runtimePorts`
3. Run `docker compose up -d`
4. Discover Docker ports from `docker.portMappings`
5. Discover named ports from `docker.servicePorts`
6. Render `derivedEnv` from the values above
7. Render `quickLinks` from the final assembled env
8. Run `startupCommands`
9. Expose the final env to the tmux-backed shell and UI

That ordering matters:

- `derivedEnv` can reference values from `env`, `runtimePorts`, `docker.portMappings`, and `docker.servicePorts`
- `quickLinks` can reference all of the above plus previously-derived values

## Compose port declaration recommendation

For Docker Compose files, prefer published host ports that use env interpolation with `0` as the default host port.

Example:

```yml
ports:
  - "${DB_PORT:-0}:5432"
```

This gives Docker freedom to choose an open host port while still giving `worktreemanager` a stable env var name to discover and inject.

`worktreemanager init` can often detect these env names automatically.

## Top-level fields

## `env`

Static environment variables added to every runtime for the repo.

Use `env` for values that do not depend on runtime port allocation or Docker inspection.

Example:

```yml
env:
  NODE_ENV: development
  LOG_LEVEL: debug
```

## `runtimePorts`

Environment variable names that should receive a reserved free local port.

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
- they can be started and stopped independently from the UI
- their logs appear in the `Background commands` tab
- the core runtime-backed `docker compose` command appears there automatically and does not need to be declared

## `worktrees`

Worktree layout settings.

### `worktrees.baseDir`

Directory where new Git worktrees are created.

This path is resolved relative to the repository root unless you provide an absolute path.

Example:

```yml
worktrees:
  baseDir: .worktrees
```

## `docker`

The `docker` section is only for Docker Compose-specific configuration.

## `docker.composeFile`

Compose file to run when the environment starts.

Example:

```yml
docker:
  composeFile: docker-compose.yml
```

## `docker.projectPrefix`

Prefix used when building branch-scoped Compose project names.

For example, branch `feature/search` may become a Compose project like `wt-feature-search`.

## `docker.portMappings`

Explicit Docker-discovered port bindings that should become environment variables.

Use this when you already know:

- the Compose service name
- the container port
- the env var name you want exposed

Example:

```yml
docker:
  portMappings:
    - service: postgres
      containerPort: 5432
      envName: DB_PORT
```

After the environment starts, `worktreemanager` inspects the real published host port and injects it as `DB_PORT`.

## `docker.servicePorts`

Named logical service ports discovered from Docker at runtime.

Use this when you want a stable logical name in config and UI, even if the actual host port changes.

Example:

```yml
docker:
  servicePorts:
    backendServer:
      service: api
      containerPort: 3000
      envName: BACKEND_SERVER_PORT
```

This lets other parts of the config refer to `BACKEND_SERVER_PORT` without hard-coding a host port.

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
  baseDir: .worktrees

docker:
  projectPrefix: wt

startupCommands:
  - pnpm install

backgroundCommands:
  Web dev:
    command: pnpm run dev
```

## App plus Docker database

```yml
env:
  NODE_ENV: development

runtimePorts:
  - PORT

derivedEnv:
  DATABASE_URL: postgresql://postgres:postgres@localhost:${DB_PORT}/app

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

## Notes on `init`

`worktreemanager init` creates a starter config and can detect useful Docker port mappings from your Compose file.

It also writes the schema header automatically so editors can validate the file.

You should still review the generated file and adjust:

- `runtimePorts`
- `derivedEnv`
- `quickLinks`
- `startupCommands`
- `backgroundCommands`

to match your actual workflow.
