# Runtime and Terminal Flow

## Creating a worktree

When you create a branch worktree from the UI, the backend runs the Git worktree flow for that branch.

Conceptually:

```bash
git worktree add <path> -b <branch>
```

## Starting a runtime

When you click Start env, Worktree Manager:

1. loads `worktree.yml`
2. starts Docker Compose with a branch-scoped project name
3. inspects published host ports from Docker
4. resolves named service ports
5. renders derived environment variables
6. runs startup commands in the worktree
7. stores runtime metadata for the UI and terminal

Compose projects are launched with a project name like:

```bash
docker compose -p wt-feature-search-redesign up -d
```

## In-memory environment injection

Worktree Manager merges:

1. static `env` values
2. discovered `portMappings`
3. discovered `servicePorts`
4. rendered `derivedEnv` values

That merged environment is passed directly into:

- startup commands
- the `node-pty` shell
- the tmux session launched for the browser terminal

No `.env` files are written during that flow.

## tmux-backed browser terminal

The inline terminal attaches to a tmux session named from the branch.

Conceptually:

```bash
tmux new-session -A -s wt-feature-search-redesign
```

This gives the browser terminal a persistent shell that survives reconnects while still inheriting the runtime environment created for that worktree.

## Stopping and cleaning up

- Stop env runs Docker Compose down for that branch runtime
- Delete removes the Git worktree so finished branch environments are easy to clean up
