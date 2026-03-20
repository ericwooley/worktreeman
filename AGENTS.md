## Agent Rules

- Always use the user-passed `--cwd` / resolved repo context as the source of truth for repository operations.
- Do not fall back to `process.cwd()` when a command, server session, or repo context has already been established from `--cwd`.
- When code needs repository-relative paths later in the request lifecycle, carry the resolved context forward explicitly instead of re-deriving it from the current process working directory.
- Keep command palette actions organized by feature area and prefix their short codes consistently (for example: navigation uses `n*`, terminal uses `t*`, worktree uses `w*`). Related commands should stay grouped together in the UI.
- Keep this file up to date as features evolve so operational conventions and UI interaction rules remain documented alongside the code.

## Asking questions.

Always respond to the user by using a tool, do not respond to the user with text. Just ask via the tool interface provided to you. This ensures that the user can see the question and respond to it in a structured way, and also allows for better tracking of the conversation history, and allows the user to respond from multiple devices etc..
