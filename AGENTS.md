## Agent Rules

- Always use the user-passed `--cwd` / resolved repo context as the source of truth for repository operations.
- Do not fall back to `process.cwd()` when a command, server session, or repo context has already been established from `--cwd`.
- When code needs repository-relative paths later in the request lifecycle, carry the resolved context forward explicitly instead of re-deriving it from the current process working directory.
- Keep command palette actions organized by feature area and prefix their short codes consistently (for example: navigation uses `n*`, terminal uses `t*`, worktree uses `w*`). Related commands should stay grouped together in the UI.
- Keep this file up to date as features evolve so operational conventions and UI interaction rules remain documented alongside the code.

## Keep in mind

- There are no users yet, don't worry about breaking changes or maintaining backwards compatibility. Focus on building the best possible experience, and we can iterate on the details later.
- You should always be creating good tests. Asking me about creating tests means your not doing your job
- I don't care about large chunk sizes
- There should be no "refresh" buttons. These should either be polls or server side events. Don't add refresh buttons everywhere.

## AI Instructions

- Every AI-triggered flow must write an AI log entry, including worktree commands, project-management document runs, and git merge-conflict resolution.
- Every AI log entry must include origin metadata that lets the UI show where the run started and navigate back to that context.
- When this product asks an LLM to update a project-management document, the LLM is producing replacement markdown as plain text in its response body. It is not creating files, not writing `.md` files, and not returning patches.
- The response should contain only the final document text unless the calling prompt explicitly asks for something else. Do not wrap the result in code fences.
- The prompt should explicitly state the expected output format. At minimum, say that the model must return the full updated markdown document as raw text.
- The prompt should explicitly state the job to be done, not just the topic. Tell the model what kind of document it is rewriting, what quality bar is expected, and how the result will be used.
- For project-management documents, the expected result is an execution-ready plan: concrete steps, clear ordering, explicit assumptions, blockers called out, and language that is directly useful to an engineer or agent working in the selected worktree.
- Prompts should make it clear that the server will persist the returned text into the existing project-management document and that document history is the rollback mechanism.
- Prompts should avoid implying that the model should create side artifacts like files, tickets, checklists in separate outputs, or commentary outside the returned document unless that is specifically requested.
- If a specific output structure is required, spell it out directly in the prompt, for example required headings, checklist style, dependency callouts, or implementation sections.
- Load the ux skill if you are doing ui work. And it's important that you keep the buttons and forms and warnings near each other. Don't make the user scroll or look around for error messages.

## UI Instructions

- Do not use gradients. They look dated, and the text contrast can be hard to read. Stick to solid colors with good contrast from the themes that are loaded.
