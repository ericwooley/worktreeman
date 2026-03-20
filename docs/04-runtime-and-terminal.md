# Runtime and Terminal Flow

## Worktree creation

When you create a worktree from the UI, `worktreeman` runs the Git worktree flow for that branch.

Conceptually:

```bash
git worktree add <path> -b <branch>
```

The resulting path is tracked by the UI so each branch has a visible local workspace.

## Runtime startup

When you click `Start env`, `worktreeman` performs this sequence:

1. load `worktree.yml`
2. allocate configured `runtimePorts`
3. render derived environment variables
4. render quick links
5. prepare the tmux session for the branch
6. run any configured startup commands in the worktree and wait for them to finish
7. start all configured background commands under PM2
8. store runtime metadata for the UI and terminal session

## In-memory environment injection

`worktreeman` builds the runtime environment from:

1. static `env`
2. allocated `runtimePorts`
3. rendered `derivedEnv`

That merged environment is passed directly into:

- startup commands
- background commands
- the shell created by `node-pty`
- the tmux session used by the browser terminal

If you want Docker in the workflow, declare a Docker command in `backgroundCommands`. It is treated the same as any other PM2-managed process.

No `.env` files are written as part of this flow.

## Browser terminal

The browser terminal attaches to a tmux session named for the branch.

Conceptually:

```bash
tmux new-session -A -s wt-feature-search
```

That gives you a persistent shell session you can reconnect to from the UI while keeping the runtime environment for the selected worktree.

## Runtime shutdown

- `Stop env` stops background commands and kills the tmux session for that branch runtime
- `Delete` removes the Git worktree when the branch environment is no longer needed
