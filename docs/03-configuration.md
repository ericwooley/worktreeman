# Configuration

`worktreemanager` reads `worktree.yml` from the repository root.

For Docker Compose files, prefer host port declarations that use env interpolation with `0` as the default host port, for example:

```yml
ports:
  - "${DB_PORT:-0}:5432"
```

That lets Docker choose an open host port while still giving `worktreemanager` a stable env var name to resolve and inject.

Example:

```yml
# yaml-language-server: $schema=https://raw.githubusercontent.com/ericwooley/worktreeman/main/worktree.schema.json

env:
  NODE_ENV: development
  APP_NAME: my-app

runtimePorts:
  - PORT
  - VITE_PORT

derivedEnv:
  DATABASE_URL: postgres://postgres:postgres@localhost:${DB_PORT}/app

quickLinks:
  App: http://localhost:${PORT}
  API health: http://localhost:${BACKEND_SERVER_PORT}/health

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
  - npm install
  - npm run db:migrate

backgroundCommands:
  Web dev:
    command: pnpm run dev
```

During `worktreemanager init`, the wizard can ask for these `runtimePorts` entries in a loop so you can add names like `PORT`, `VITE_PORT`, or `WEBHOOK_PORT` before the file is written.

## `env`

Static environment variables added to every runtime for that repository.

Use this for values that do not depend on Docker port discovery.

## `runtimePorts`

Use `runtimePorts` when you want `worktreemanager` to allocate an available local port and inject it as an environment variable.

Example:

```yml
runtimePorts:
  - PORT
```

When a runtime starts, `worktreemanager` reserves a free local port and injects it into startup commands and the tmux-backed terminal session:

```text
PORT=28737
```

This is separate from Docker port discovery. Use it when your app needs its own open local port for a dev server or callback listener.

## `worktrees.baseDir`

The directory where new Git worktrees are created.

This path is resolved relative to the repository root unless you provide an absolute path.

## `docker.composeFile`

The Compose file `worktreemanager` should run when you click `Start env`.

## `docker.projectPrefix`

The prefix used when creating branch-scoped Compose project names.

For example, a branch named `feature/search` may produce a project name like `wt-feature-search`.

## `docker.portMappings`

Use `portMappings` when you already know the service and container port you want to expose as an environment variable.

After Docker starts, `worktreemanager` inspects the real published host port and injects it under `envName`.

If your Compose file uses `ports:` entries like `"${DB_PORT:-0}:5432"`, `init` now detects `DB_PORT` directly and uses that as the generated `envName` instead of inventing a service-based name.

## `docker.servicePorts`

Use `servicePorts` when you want a stable logical name in config and UI while still resolving the host port at runtime.

Example:

```text
BACKEND_SERVER_PORT=<resolved-host-port>
```

## `derivedEnv`

Derived environment variables are rendered after port discovery.

Use this for full URLs, DSNs, and connection strings that depend on resolved host ports.

## `quickLinks`

Quick links are rendered after runtime env and derived env are assembled.

Use this for clickable URLs you want surfaced in the UI, like app roots, admin panels, health endpoints, dashboards, and docs.

They support the same `${VAR_NAME}` interpolation as `derivedEnv`, so they can reference runtime ports, discovered Docker ports, service ports, and previously-derived values.

## `startupCommands`

Commands that run inside the worktree after Docker is up and the runtime environment has been assembled.

Keep these predictable. Anything listed here will run when a developer clicks `Start env`.

## `backgroundCommands`

Background commands appear in the `Background commands` tab.

Use this for long-running processes you want to start and stop independently after the environment is up, like:

```yml
backgroundCommands:
  Web dev:
    command: pnpm run dev
  Worker:
    command: pnpm run worker
```

These commands are run with PM2 so they can be inspected externally.

`docker compose up` is treated specially: the environment itself always appears in the tab as the built-in `docker compose` runtime-backed command, even if you do not define it under `backgroundCommands`.
