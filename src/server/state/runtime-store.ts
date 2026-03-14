import type { ReservedPort } from "../services/runtime-port-service.js";
import type { WorktreeRuntime } from "../../shared/types.js";

interface StoredRuntime {
  runtime: WorktreeRuntime;
  reservedPorts: ReservedPort[];
}

export class RuntimeStore {
  private runtimes = new Map<string, StoredRuntime>();

  get(branch: string): WorktreeRuntime | undefined {
    return this.runtimes.get(branch)?.runtime;
  }

  set(runtime: WorktreeRuntime, reservedPorts: ReservedPort[] = []): void {
    this.runtimes.set(runtime.branch, { runtime, reservedPorts });
  }

  delete(branch: string): StoredRuntime | undefined {
    const storedRuntime = this.runtimes.get(branch);
    this.runtimes.delete(branch);
    return storedRuntime;
  }

  getReservedPorts(branch: string): ReservedPort[] {
    return this.runtimes.get(branch)?.reservedPorts ?? [];
  }

  mergeInto<T extends { branch: string }>(worktrees: T[]): Array<T & { runtime?: WorktreeRuntime }> {
    return worktrees.map((worktree) => ({
      ...worktree,
      runtime: this.runtimes.get(worktree.branch)?.runtime,
    }));
  }
}
