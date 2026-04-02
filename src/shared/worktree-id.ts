import { createHash } from "node:crypto";

export type WorktreeId = string & { readonly __brand: unique symbol };

export function worktreeId(worktreePath: string): WorktreeId {
  return createHash("md5").update(worktreePath).digest("hex") as WorktreeId;
}

export function isWorktreeId(value: string): value is WorktreeId {
  return /^[a-f0-9]{32}$/i.test(value);
}
