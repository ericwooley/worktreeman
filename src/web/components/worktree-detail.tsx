import type { WorktreeRecord } from "@shared/types";
import { WorktreeTerminal } from "./worktree-terminal";

export function WorktreeDetail({ worktree }: { worktree: WorktreeRecord | null }) {
  return (
    <section className="min-w-0 space-y-4 xl:space-y-4">
      <div className="matrix-panel rounded-[1.8rem] p-4 sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="matrix-kicker">Terminal focus</p>
            <h2 className="mt-2 text-2xl font-semibold text-[#ecffec] sm:text-3xl">
              {worktree?.branch ?? "Select a worktree"}
            </h2>
            <p className="mt-2 text-sm text-[#9cd99c]">
              {worktree
                ? "The shell is the primary surface. Runtime details stay visible, but the terminal owns the layout."
                : "Choose a worktree from the side rail to open its terminal session."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="rounded-full border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] px-3 py-1 font-mono text-xs text-[#b9ffb9]">
              {worktree?.runtime ? "tmux attached" : "idle"}
            </div>
            {worktree?.runtime?.dockerStartedAt ? (
              <div className="rounded-full border border-[rgba(74,255,122,0.12)] bg-[rgba(7,24,10,0.7)] px-3 py-1 font-mono text-xs text-[#7fe19e]">
                live since {new Date(worktree.runtime.dockerStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </div>
            ) : null}
          </div>
        </div>

        <div className="mt-5 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
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
