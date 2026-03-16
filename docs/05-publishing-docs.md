# Team Setup Notes

If multiple developers will use `worktreemanager` in the same repository, treat `worktree.yml` as part of the project setup.

## Keep `worktree.yml` in version control

Checking in `worktree.yml` helps the team share the same:

- worktree base directory
- Compose file path
- port resolution rules
- derived environment variables
- startup command behavior

## Validate the workflow once

Before asking the rest of the team to use the tool, verify the full path yourself:

1. run `worktreemanager init` and answer the setup questions
2. create a fresh worktree
3. start the runtime
4. confirm the right ports are injected
5. confirm the terminal attaches to the expected tmux session

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
npm install -g worktreemanager
worktreemanager init
worktreemanager start
worktreemanager --help
```
