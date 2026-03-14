# Worktree Manager

Worktree Manager is the local app for creating Git worktrees, starting branch-scoped Docker Compose runtimes, and attaching to tmux-backed browser terminals.

## Local app

```bash
npm install
node --import tsx src/cli.ts init main
npm run dev
```

Then open `http://127.0.0.1:4312`.

## Build outputs

```bash
npm run build
```

- `dist/web` contains the local app frontend used by the CLI server
- `dist/docs` contains the standalone documentation website generated from Markdown files in `docs/`

## Docs source

- `docs/*.md` is the source of truth for the standalone docs website
- `npm run build:docs` builds the publishable docs site
- `npm run preview:docs` builds and serves the docs site at `http://127.0.0.1:4174`

## CLI help

```bash
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts init --help
```
