# worktreeman

worktreeman is the local app for creating Git worktrees, preparing branch-scoped runtime environments, managing background commands, and attaching to tmux-backed browser terminals.

- Hosted docs: https://ericwooley.github.io/worktreeman/

## Quick Start

One-off run without a global install:

```bash
npx -y worktreeman create --cwd /path/to/repo
npx -y worktreeman init --cwd /path/to/repo
npx -y worktreeman start --cwd /path/to/repo
```

Then open the printed local URL, usually `http://localhost:4312`.

Quick start notes:

- `npx -y worktreeman start` is the fastest way to try the published CLI without installing it globally
- `create` bootstraps the required bare-layout repository structure
- `init` creates `wtm-settings/worktree.yml` so the UI has runtime config to load
- `start` serves the local UI and prints the resolved bind host and port

## Local Development

```bash
pnpm install
pnpm run dev -- create --cwd /path/to/repo
pnpm run dev:watch -- --cwd /path/to/repo
node --import tsx src/cli.ts start --cwd /path/to/repo
```

Then open `http://localhost:4312`.

- `pnpm run dev -- <subcommand>` runs the CLI once and exits
- `pnpm run dev -- create --cwd /path/to/repo` bootstraps the required bare layout with `.bare/`, `.git`, `main/`, and `wtm-settings/`
- `pnpm run dev -- clone <remote> --cwd /path/to/repo` clones a remote into that same layout and checks out `main/` plus `wtm-settings/`
- `pnpm run dev:watch -- --cwd /path/to/repo` starts the watched local server flow and refuses to run outside the required bare layout
- `worktreeman start` defaults to localhost for the local-only UI
- `worktreeman start --host auto` prefers a Tailscale address, then WireGuard, then a private LAN address, then localhost
- `worktreeman start --host 0.0.0.0 --dangerously-expose-to-network` is required for wildcard binds because the terminal UI would otherwise be exposed to the network

Host selection notes:

- `--host auto` prefers a Tailscale interface, then WireGuard, then a private LAN address, and finally falls back to localhost. This is convenient when using remote networking such as Tailscale.
- Binding to wildcard hosts like `0.0.0.0` will refuse to start unless you pass `--dangerously-expose-to-network` to acknowledge that the terminal-enabled UI will be accessible on all interfaces.

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
pnpm run build
```

- `dist/web` contains the local app frontend used by the CLI server
- `dist/docs` contains the standalone documentation website generated from Markdown files in `docs/`

## Package distribution

Run without installing globally (recommended for one-off use):

```bash
npx -y worktreeman start
```

Or install globally for repeated local use:

```bash
npm install -g worktreeman
worktreeman --help
```

- `npx -y worktreeman start` runs the published CLI without a global install and immediately starts the UI
- `npm install -g worktreeman` installs the command globally for repeated local use
- `npm pack` and `npm publish` use the `prepack` script to build `dist/cli.js` and `dist/web`

## Configuration Examples

Minimal `worktree.yml`:

```yml
runtimePorts:
  - PORT

derivedEnv:
  APP_URL: http://localhost:${PORT}

quickLinks:
  - name: App
    url: http://localhost:${PORT}

startupCommands:
  - pnpm install

backgroundCommands:
  Web dev:
    command: pnpm run dev
```

Pin the local UI to a preferred port when available:

```yml
preferredPort: 4900
```

Configuration notes:

- `preferredPort` applies to the worktreeman HTTP server itself; if that port is busy and you did not explicitly force a CLI port, worktreeman will choose another free port
- `runtimePorts` reserve loopback ports for your app processes and inject them into startup commands, background commands, tmux shells, derived env, and quick links
- `startupCommands` run sequentially in the user's shell via `SHELL -lc '<command>'`
- `backgroundCommands` are long-running processes managed under PM2 after startup commands finish

## Troubleshooting

- `worktreeman start` fails outside the managed layout: run `worktreeman create --cwd /path/to/repo` or `worktreeman clone <remote> --cwd /path/to/repo` first
- Browser terminal loads but copy-mode clipboard does not reach the system clipboard: add the tmux clipboard settings from the `tmux clipboard` section below
- Expected `localhost:4312` but got another port: a preferred/default port was already in use, so worktreeman allocated another free port and printed it at startup
- Remote host binding refused: wildcard hosts such as `0.0.0.0` require `--dangerously-expose-to-network`
- Startup command behaves differently than expected: remember commands run through the user's shell, so shell startup files and shell syntax can affect behavior

## Platform support

- The published CLI runs on Node.js 20+; pnpm is the expected package manager for developing this repository
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
- `pnpm run build:docs` builds the publishable docs site
- `pnpm run preview:docs` builds and serves the docs site at `http://127.0.0.1:4174`

## CLI help

```bash
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts init --help
```
