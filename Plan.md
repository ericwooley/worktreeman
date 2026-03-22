# Project Management Execution Plan

## Goals

- Add a project-management system backed by a dedicated orphan Git branch.
- Store project documents as Automerge CRDT documents.
- Keep documents markdown-first and tag-aware.
- Cache reduced branch state in memory so reads stay fast after the first replay.
- Seed the system with a default `Project Outline` document.

## Checklist

- Add `@automerge/automerge`
- Define project-management constants in `src/shared/constants.ts`
- Add shared project-management types in `src/shared/types.ts`
- Implement `src/server/services/project-management-service.ts`
- Add in-memory reduced-state caching keyed by branch head SHA
- Add project-management API routes in `src/server/routes/api.ts`
- Add typed client helpers in `src/web/lib/api.ts`
- Extend `src/web/hooks/use-dashboard-state.ts`
- Add `src/web/components/project-management-panel.tsx`
- Replace the project-management placeholder in `src/web/components/worktree-detail.tsx`
- Add `src/server/services/project-management-service.test.ts`
- Update the `test` script in `package.json`
- Run tests, typecheck, and build

## Implementation Phases

### 1. Types and constants

- Add a dedicated branch name, ref, batch filename, schema version, and default seed title.
- Add shared types for document summaries, full documents, history entries, create/update requests, and batch updates.

### 2. Automerge document model

- Model each document as an Automerge document with:
  - `id`
  - `title`
  - `markdown`
  - `tags`
  - `createdAt`
  - `updatedAt`
- Store real Automerge changes in Git commits, not plain markdown diffs.
- Normalize tags to lowercase slugs.

### 3. Git-backed event log

- Use a dedicated orphan branch such as `wtm-project-management`.
- Store one batch payload per commit in `batch.json`.
- Append via Git plumbing only:
  - `rev-parse`
  - `hash-object`
  - `mktree`
  - `commit-tree`
  - `update-ref`
- Use optimistic concurrency with retry around `update-ref`.

### 4. Reduced-state cache

- Keep one in-memory cache per repo.
- Cache shape should include:
  - `headSha`
  - `documentsById`
  - `documentOrder`
  - `tagIndex`
  - `historyByDocumentId`
  - `updatedAt`
- Replay only new commits when the cached head is an ancestor of the latest branch head.
- Rebuild from scratch if ancestry breaks.

### 5. Backend API

- Add endpoints for:
  - listing documents
  - reading one document
  - reading one document history
  - creating a document
  - appending updates
  - appending a multi-update batch

### 6. Frontend

- Build a project-management panel with:
  - document list
  - tag filter
  - document creation form
  - markdown editor
  - markdown preview
  - history panel
- Reuse Monaco for markdown editing.

### 7. Testing

- Cover:
  - empty-branch bootstrap
  - seed document creation
  - multiple updates in one commit
  - DAG replay across commits
  - incremental cache replay
  - cache rebuild on divergence
  - concurrent append retry behavior
  - markdown and tag convergence after replay

## Seed Document

Title: `Project Outline`

Suggested starter content:

```md
# Project Outline

## Goals

- Define the scope
- Track major workstreams
- Capture decisions and risks

## Open Questions

- What ships first?
- What is blocked?
- What needs design?
```
