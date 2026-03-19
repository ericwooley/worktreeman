import type { WorktreeRuntime } from "../../shared/types.js";

export class RuntimeStore {
  private runtimes = new Map<string, WorktreeRuntime>();

  get(branch: string): WorktreeRuntime | undefined {
    return this.runtimes.get(branch);
  }

  set(runtime: WorktreeRuntime): void {
    this.runtimes.set(runtime.branch, runtime);
  }

  delete(branch: string): WorktreeRuntime | undefined {
    const storedRuntime = this.runtimes.get(branch);
    this.runtimes.delete(branch);
    return storedRuntime;
  }

  entries(): WorktreeRuntime[] {
    return [...this.runtimes.values()];
  }

  mergeInto<T extends { branch: string }>(worktrees: T[]): Array<T & { runtime?: WorktreeRuntime }> {
    return worktrees.map((worktree) => ({
      ...worktree,
      runtime: this.runtimes.get(worktree.branch),
    }));
  }
}
