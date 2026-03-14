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
node --import tsx src/cli.ts init
```

That command:

- finds the Git root
- looks for a common Docker Compose file
- writes a starter `worktree.yml`

If you want to regenerate it:

```bash
node --import tsx src/cli.ts init --force
```

## Start the local app

```bash
npm run dev
```

Then open:

```text
http://127.0.0.1:4312
```

## Build the packaged app

```bash
npm run build
node dist/cli.js serve
```

Useful help output:

```bash
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts init --help
```
