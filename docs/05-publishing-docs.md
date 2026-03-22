# Team Setup Notes

If multiple developers will use `worktreeman` in the same repository, treat the managed bare layout plus the `wtm-settings` branch and its `worktree.yml` file as part of the project setup.

## Keep `worktree.yml` in version control

Keeping `worktree.yml` in the `wtm-settings` worktree helps the team share the same:

- worktree base directory
- Compose file path
- port resolution rules
- derived environment variables
- startup command behavior

## Validate the workflow once

Before asking the rest of the team to use the tool, verify the full path yourself:

1. run `worktreeman create --cwd /path/to/repo` or `worktreeman clone <remote> --cwd /path/to/repo`
2. run `worktreeman init --cwd /path/to/repo` and answer the setup questions
3. keep the `wtm-settings` worktree checked out locally wherever you run `worktreeman start`
4. create a fresh worktree
5. start the runtime
6. confirm the right ports are injected
7. confirm the terminal attaches to the expected tmux session

## Be explicit about startup commands

Developers should know what happens when they click `Start env`.

For example, the configured workflow may:

- install dependencies
- run database migrations
- seed local data
- boot sidecar services

Keep that behavior documented in the repository so startup is predictable.

## Common commands

```bash
npm install -g worktreeman
worktreeman init
worktreeman start
worktreeman --help
```
