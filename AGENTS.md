## Agent Rules

- Always use the user-passed `--cwd` / resolved repo context as the source of truth for repository operations.
- Do not fall back to `process.cwd()` when a command, server session, or repo context has already been established from `--cwd`.
- When code needs repository-relative paths later in the request lifecycle, carry the resolved context forward explicitly instead of re-deriving it from the current process working directory.
