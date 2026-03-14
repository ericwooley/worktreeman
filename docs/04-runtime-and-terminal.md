# Runtime and Terminal Flow

## Worktree creation

When you create a worktree from the UI, `worktreemanager` runs the Git worktree flow for that branch.

Conceptually:

```bash
git worktree add <path> -b <branch>
```

The resulting path is tracked by the UI so each branch has a visible local workspace.

## Runtime startup

When you click `Start env`, `worktreemanager` performs this sequence:

1. load `worktree.yml`
2. start Docker Compose with a branch-scoped project name
3. inspect the published host ports for configured services
4. resolve named service ports
5. render derived environment variables
6. run any configured startup commands in the worktree
7. store runtime metadata for the UI and terminal session

Compose is started with a branch-specific project name similar to:

```bash
docker compose -p wt-feature-search up -d
```

## In-memory environment injection

`worktreemanager` builds the runtime environment from:

1. static `env`
2. allocated `runtimePorts`
3. discovered `portMappings`
4. discovered `servicePorts`
5. rendered `derivedEnv`

That merged environment is passed directly into:

- startup commands
- the shell created by `node-pty`
- the tmux session used by the browser terminal

No `.env` files are written as part of this flow.

## Browser terminal

The browser terminal attaches to a tmux session named for the branch.

Conceptually:

```bash
tmux new-session -A -s wt-feature-search
```

That gives you a persistent shell session you can reconnect to from the UI while keeping the runtime environment for the selected worktree.

## Runtime shutdown

- `Stop env` runs `docker compose down` for that branch runtime
- `Delete` removes the Git worktree when the branch environment is no longer needed
