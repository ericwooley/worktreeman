# Publishing the Docs Site

The standalone docs site is built from the Markdown files in `docs/`.

## Build the docs site

```bash
npm run build:docs
```

## Preview the docs site locally

```bash
npm run preview:docs
```

That serves the generated site over HTTP at:

```text
http://127.0.0.1:4174
```

Output:

```text
dist/docs
```

## Full project build

```bash
npm run build
```

That produces:

- `dist/web` for the local app frontend used by the CLI server
- `dist/docs` for the standalone documentation website
- `dist` server output for the CLI itself

## Recommended publishing model

Publish `dist/docs` to any static host such as:

- Netlify
- Vercel
- GitHub Pages
- Cloudflare Pages

## Important distinction

The docs site is static and publishable by itself.

The local app is different. It depends on:

- machine-local Git access
- Docker commands
- tmux
- the Node API and WebSocket server

So the docs site should explain the product, while the CLI-served app remains the real local operator interface.
