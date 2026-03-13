import type { WorktreeRuntime } from "../../shared/types.js";

export class RuntimeStore {
  private runtimes = new Map<string, WorktreeRuntime>();

  get(branch: string): WorktreeRuntime | undefined {
    return this.runtimes.get(branch);
  }

  set(runtime: WorktreeRuntime): void {
    this.runtimes.set(runtime.branch, runtime);
  }

  delete(branch: string): void {
    this.runtimes.delete(branch);
  }

  mergeInto<T extends { branch: string }>(worktrees: T[]): Array<T & { runtime?: WorktreeRuntime }> {
    return worktrees.map((worktree) => ({
      ...worktree,
      runtime: this.runtimes.get(worktree.branch),
    }));
  }
}
