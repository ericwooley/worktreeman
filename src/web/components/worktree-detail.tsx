import type { WorktreeRecord } from "@shared/types";
import { WorktreeTerminal } from "./worktree-terminal";

export function WorktreeDetail({ worktree }: { worktree: WorktreeRecord | null }) {
  return (
    <section className="space-y-6">
      <div className="rounded-[2rem] border border-white/45 bg-white/66 p-5 shadow-panel backdrop-blur-md">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.28em] text-pine">Worktree detail</p>
            <h2 className="mt-2 text-2xl font-semibold text-ink">
              {worktree?.branch ?? "Select a worktree"}
            </h2>
            <p className="mt-2 text-sm text-ink/65">
              {worktree
                ? "Inspect the isolated path, runtime wiring, and injected environment before jumping into the terminal."
                : "Choose a worktree from the list to inspect its runtime and terminal session."}
            </p>
          </div>
          <div className="rounded-full border border-white/45 bg-[rgba(250,246,239,0.76)] px-3 py-1 font-mono text-xs text-ink/70">
            {worktree?.runtime ? "tmux attached" : "idle"}
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm sm:grid-cols-2">
          <DetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
          <DetailField label="Head" value={worktree?.headSha ?? "-"} mono />
          <DetailField label="Compose project" value={worktree?.runtime?.composeProject ?? "-"} mono />
          <DetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
        </div>
      </div>

      <WorktreeTerminal worktree={worktree} />
    </section>
  );
}

function DetailField({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-[1.4rem] border border-white/45 bg-[rgba(248,243,236,0.72)] px-4 py-3 backdrop-blur-sm">
      <p className="text-xs uppercase tracking-[0.18em] text-ink/45">{label}</p>
      <p className={`mt-2 break-all text-sm text-ink ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
