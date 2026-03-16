# Worktree Manager

Worktree Manager is the local app for creating Git worktrees, starting branch-scoped Docker Compose runtimes, and attaching to tmux-backed browser terminals.

## Local app

```bash
npm install
pnpm run dev -- init
pnpm run dev:watch -- --cwd /path/to/repo
```

Then open `http://127.0.0.1:4312`.

- `pnpm run dev -- <subcommand>` runs the CLI once and exits
- `pnpm run dev:watch -- --cwd /path/to/repo` starts the watched local server flow
- `pnpm run dev -- init` prompts for branch, worktree layout, and optional dynamic runtime port env vars
- `pnpm run dev -- init main --base-dir ..` keeps init non-interactive for sibling worktree layouts

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
