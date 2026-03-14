# Configuration

`worktreemanager` reads `worktree.yml` from the repository root.

Example:

```yml
env:
  NODE_ENV: development
  APP_NAME: my-app

runtimePorts:
  - PORT
  - VITE_PORT

worktrees:
  baseDir: .worktrees

docker:
  composeFile: docker-compose.yml
  projectPrefix: wt
  portMappings:
    - service: postgres
      containerPort: 5432
      envName: DATABASE_PORT
  servicePorts:
    backendServer:
      service: api
      containerPort: 3000
      envName: BACKEND_SERVER_PORT
  derivedEnv:
    DATABASE_URL: postgres://postgres:postgres@localhost:${DATABASE_PORT}/app

startupCommands:
  - npm install
  - npm run db:migrate
```

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

## `docker.servicePorts`

Use `servicePorts` when you want a stable logical name in config and UI while still resolving the host port at runtime.

Example:

```text
BACKEND_SERVER_PORT=<resolved-host-port>
```

## `docker.derivedEnv`

Derived environment variables are rendered after port discovery.

Use this for full URLs, DSNs, and connection strings that depend on resolved host ports.

## `startupCommands`

Commands that run inside the worktree after Docker is up and the runtime environment has been assembled.

Keep these predictable. Anything listed here will run when a developer clicks `Start env`.
