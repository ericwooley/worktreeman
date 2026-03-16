import type { WorktreeRecord } from "@shared/types";
import { WorktreeTerminal } from "./worktree-terminal";

export function WorktreeDetail({ worktree }: { worktree: WorktreeRecord | null }) {
  return (
    <section className="min-w-0 space-y-6">
      <div className="matrix-panel rounded-[2rem] p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="matrix-kicker">Worktree detail</p>
            <h2 className="mt-2 text-2xl font-semibold text-[#ecffec]">
              {worktree?.branch ?? "Select a worktree"}
            </h2>
            <p className="mt-2 text-sm text-[#9cd99c]">
              {worktree
                ? "Inspect the isolated path, runtime wiring, and injected environment before jumping into the terminal."
                : "Choose a worktree from the list to inspect its runtime and terminal session."}
            </p>
          </div>
          <div className="rounded-full border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] px-3 py-1 font-mono text-xs text-[#b9ffb9]">
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
    <div className="matrix-command rounded-[1.4rem] px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className={`mt-2 break-all text-sm text-[#ecffec] ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}
