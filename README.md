# worktreeman

worktreeman is the local app for creating Git worktrees, preparing branch-scoped runtime environments, managing background commands, and attaching to tmux-backed browser terminals.

## Local app

```bash
bun install
bun run dev -- create --cwd /path/to/repo
bun run dev:watch -- --cwd /path/to/repo
node --import tsx src/cli.ts start --cwd /path/to/repo
```

Then open `http://localhost:4312`.

- `bun run dev -- <subcommand>` runs the CLI once and exits
- `bun run dev -- create --cwd /path/to/repo` bootstraps the required bare layout with `.bare/`, `.git`, `main/`, and `wtm-settings/`
- `bun run dev -- clone <remote> --cwd /path/to/repo` clones a remote into that same layout and checks out `main/` plus `wtm-settings/`
- `bun run dev:watch -- --cwd /path/to/repo` starts the watched local server flow and refuses to run outside the required bare layout
- `worktreeman start` defaults to localhost for the local-only UI
- `worktreeman start --host auto` prefers a Tailscale address, then WireGuard, then a private LAN address, then localhost
- `worktreeman start --host 0.0.0.0 --dangerously-expose-to-network` is required for wildcard binds because the terminal UI would otherwise be exposed to the network

## Required repository layout

`worktreeman` only runs in this layout:

```text
repo-root/
  .bare/
  .git          # exactly: gitdir: ./.bare
  main/
  wtm-settings/
```

- `.bare/` must be a bare Git repository
- `.git` must be a plain text file containing exactly `gitdir: ./.bare`
- `wtm-settings/worktree.yml` is the only config source
- generated feature worktrees live directly under the same root, for example `repo-root/feature-x`

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
