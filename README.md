# Worktree Manager

Worktree Manager is the local app for creating Git worktrees, preparing branch-scoped runtime environments, managing background commands, and attaching to tmux-backed browser terminals.

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

## Standalone binaries

```bash
bun run build:binary
```

- `bun run build:binary` builds the default standalone binary at `dist/worktreemanager`
- `bun run build:binary:linux-x64` builds `dist/worktreemanager-linux-x64`
- `bun run build:binary:linux-arm64` builds `dist/worktreemanager-linux-arm64`
- `bun run build:binary:macos-x64` builds `dist/worktreemanager-macos-x64`
- `bun run build:binary:macos-arm64` builds `dist/worktreemanager-macos-arm64`
- `bun run build:binary:all` runs all per-target scripts and is intended for CI or native per-platform runners
- `bun run build:binary:prepare` only builds the shared frontend and embedded asset inputs used by the binary builds

Because the compiled CLI embeds the platform-native `node-pty` addon, the safest approach is to build each target on a matching runner:

- Linux targets on Linux runners
- macOS targets on macOS runners
- Use `build:binary:all` in CI only when the work is split across native jobs instead of one machine cross-compiling every target

## Install script

```bash
curl -fsSL https://raw.githubusercontent.com/ericwooley/worktreeman/main/install.sh | bash
```

- The installer downloads the latest matching GitHub release binary for your OS and CPU
- It verifies the download with `worktreemanager-checksums.txt`
- It installs to `~/.local/bin/worktreemanager` by default
- Set `INSTALL_DIR=/your/bin/dir` to choose a different install location
- Set `WORKTREEMANAGER_VERSION=v0.1.0` to install a specific release tag

## Docs source

- `docs/*.md` is the source of truth for the standalone docs website
- `bun run build:docs` builds the publishable docs site
- `bun run preview:docs` builds and serves the docs site at `http://127.0.0.1:4174`

## CLI help

```bash
node --import tsx src/cli.ts --help
node --import tsx src/cli.ts init --help
```
