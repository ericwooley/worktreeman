# Operating Worktree Manager Across a Team

If multiple developers will use Worktree Manager in the same repository, the most important thing is to make the repo-level setup predictable.

## Keep `worktree.yml` in the repository

Treat `worktree.yml` as part of the project setup so everyone gets the same:

- worktree base directory
- Docker Compose file path
- service port mappings
- derived env values
- startup commands

## Check the full workflow before asking teammates to use it

Run through the normal flow yourself:

1. create a fresh worktree
2. start the runtime
3. confirm service ports resolve correctly
4. confirm derived env values match what the app expects
5. confirm the browser terminal attaches to the correct tmux session

## Tell teammates what happens when they click Start env

Developers should know whether the runtime will:

- install dependencies
- run migrations
- seed databases
- boot background services
- take extra time on first run

## Commands teammates will use most

```bash
worktreemanager init
worktreemanager serve
worktreemanager --help
```

## What Worktree Manager helps standardize

Using Worktree Manager across a team helps standardize:

- where disposable branch environments live
- how branch-specific Docker runtimes are named
- how ports are discovered after Docker starts
- how runtime env values get injected into terminals
- how developers reconnect to the same tmux-backed shell
