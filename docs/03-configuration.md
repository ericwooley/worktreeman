# Configuration

The repository root config file is `worktree.yml`.

Example:

```yml
env:
  NODE_ENV: development
  APP_NAME: worktree-manager

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

Static environment values that are always included in runtime processes.

## `worktrees.baseDir`

The base directory where new Git worktrees are created.

## `docker.portMappings`

Explicit service-to-container-port mappings. After Docker starts, Worktree Manager resolves the real host port and exposes it through the `envName` you specify.

## `docker.servicePorts`

Named service ports let you define a logical name like `backendServer` while still resolving the real host port at runtime.

Example resolved env behavior:

```text
BACKEND_SERVER_PORT=<resolved-host-port>
```

## `docker.derivedEnv`

Derived environment variables are rendered after runtime port discovery. This is useful for full URLs and connection strings.

## `startupCommands`

Commands that run inside the worktree after Docker Compose is up and runtime env has been assembled.
