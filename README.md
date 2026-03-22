# worktreeman

worktreeman is the local app for creating Git worktrees, preparing branch-scoped runtime environments, managing background commands, and attaching to tmux-backed browser terminals.

## Local app

```bash
bun install
bun run dev -- init
bun run dev:watch -- --cwd /path/to/repo
```

Then open `http://127.0.0.1:4312`.

- `bun run dev -- <subcommand>` runs the CLI once and exits
- `bun run dev:watch -- --cwd /path/to/repo` starts the watched local server flow
- `bun run dev -- init` prompts for branch, worktree layout, and optional dynamic runtime port env vars
- `bun run dev -- init main --base-dir ..` keeps init non-interactive for sibling worktree layouts

## Build outputs

```bash
bun run build
```

- `dist/web` contains the local app frontend used by the CLI server
- `dist/docs` contains the standalone documentation website generated from Markdown files in `docs/`

## Package distribution

```bash
npm install -g worktreeman
worktreeman --help
```

- `npx worktreeman --help` runs the published CLI without a global install
- `npm install -g worktreeman` installs the command globally for repeated local use
- `npm pack` and `npm publish` use the `prepack` script to build `dist/cli.js` and `dist/web`

## Platform support

- The published CLI runs on Node.js 20+; Bun is only used to develop and build this repository
- macOS and Linux are the intended platforms because the runtime terminal depends on `tmux` and a Unix-style shell environment
- Windows is not currently supported for the full runtime flow

## tmux clipboard

For tmux-native copy mode in the browser terminal, add clipboard support to your tmux config:

```tmux
set -s set-clipboard external
set -g allow-passthrough on
set -g terminal-features 'xterm-256color:clipboard'
set -as terminal-overrides ',xterm-256color:Ms=\E]52;%p1%s;%p2%s\a'
```

- `set-clipboard external` lets tmux copy-mode push selections to the outer terminal clipboard without accepting clipboard writes from every app inside tmux
- `allow-passthrough on` helps modern passthrough-friendly terminal flows
- the `terminal-features` and `terminal-overrides` lines ensure OSC 52 clipboard support is available for `xterm-256color`

## Docs source

- `docs/*.md` is the source of truth for the standalone docs website
- `bun run build:docs` builds the publishable docs site
- `bun run preview:docs` builds and serves the docs site at `http://127.0.0.1:4174`

## CLI help

```bash
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts init --help
```
