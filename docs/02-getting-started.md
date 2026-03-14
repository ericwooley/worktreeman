# Getting Started

## Requirements

- Node.js 20+
- Git with `git worktree`
- Docker with `docker compose`
- tmux
- a Git repository you want to manage

## Install dependencies

```bash
npm install
```

## Generate `worktree.yml`

From the repository you want to manage:

```bash
worktreemanager init
```

That command:

- finds the Git root
- looks for a common Docker Compose file
- writes a starter `worktree.yml`

If you want to regenerate it:

```bash
worktreemanager init --force
```

## Start the local app

```bash
worktreemanager serve
```

Then open:

```text
http://127.0.0.1:4312
```

## Build the packaged app

```bash
npm run build
worktreemanager serve
```

Useful help output:

```bash
worktreemanager --help
worktreemanager init --help
```

## First run in the UI

After the app opens:

1. Enter a branch name and create a worktree.
2. Select that worktree from the list.
3. Click Start env.
4. Wait for Docker, port discovery, and startup commands to finish.
5. Use the terminal panel to work inside the branch session.
