import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useDashboardState } from "../hooks/use-dashboard-state";
import { MatrixModal } from "./matrix-primitives";
import { WorktreeDetail } from "./worktree-detail";

export function Dashboard() {
  const initialParams = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const {
    state,
    error,
    loading,
    busyBranch,
    lastEnvSync,
    shutdownStatus,
    backgroundCommands,
    backgroundLogs,
    clearLastEnvSync,
    clearBackgroundLogs,
    create,
    remove,
    start,
    stop,
    syncEnv,
    loadBackgroundCommands,
    startBackgroundCommand,
    stopBackgroundCommand,
    loadBackgroundLogs,
    subscribeToBackgroundLogs,
    refresh,
  } = useDashboardState();
  const [branch, setBranch] = useState("");
  const [selectedBranch, setSelectedBranch] = useState<string | null>(initialParams.get("env"));
  const [activeTab, setActiveTab] = useState<"shell" | "background" | "git">(
    initialParams.get("tab") === "git"
      ? "git"
      : initialParams.get("tab") === "background"
        ? "background"
        : "shell",
  );
  const [isTerminalVisible, setIsTerminalVisible] = useState(initialParams.get("terminal") === "open");
  const [deleteConfirmBranch, setDeleteConfirmBranch] = useState<string | null>(null);

  const selected = useMemo(
    () => {
      if (!state?.worktrees.length) {
        return null;
      }

      return state.worktrees.find((entry) => entry.branch === selectedBranch)
        ?? state.worktrees.find((entry) => entry.runtime)
        ?? state.worktrees[0]
        ?? null;
    },
    [selectedBranch, state?.worktrees],
  );

  useEffect(() => {
    if (!selected?.branch || selected.branch === selectedBranch) {
      return;
    }

    setSelectedBranch(selected.branch);
  }, [selected?.branch, selectedBranch]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    if (selectedBranch) {
      params.set("env", selectedBranch);
    } else {
      params.delete("env");
    }

    params.set("tab", activeTab);

    if (isTerminalVisible) {
      params.set("terminal", "open");
    } else {
      params.delete("terminal");
    }

    const nextUrl = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ""}${window.location.hash}`;
    window.history.replaceState(null, "", nextUrl);
  }, [activeTab, isTerminalVisible, selectedBranch]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!branch.trim()) {
      return;
    }

    await create(branch.trim());
    setBranch("");
  };

  const confirmDelete = async () => {
    if (!deleteConfirmBranch) {
      return;
    }

    await remove(deleteConfirmBranch);
    setDeleteConfirmBranch(null);
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-0 pt-0 pb-3 text-[#d7ffd7] sm:pb-4 lg:pb-6">
      <div className="relative z-10 flex w-full flex-col gap-3">
        <header className="matrix-panel rounded-none border-x-0 p-3 sm:p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 flex-1 space-y-1">
              <p className="matrix-kicker">Local orchestration cockpit</p>
              <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0 flex-1">
                  <h1 className="text-2xl font-semibold tracking-tight text-[#ecffec] sm:text-3xl">Worktree Manager</h1>
                  <p className="mt-1 text-sm leading-5 text-[#9cd99c] sm:text-base">
                    Terminal-first control surface for jumping between branch runtimes without losing the shell.
                  </p>
                </div>
              </div>
            </div>

            <div className="flex w-full flex-col gap-2 pt-12 xl:max-w-[40rem]">
              <form className="flex w-full flex-col gap-2 sm:flex-row" onSubmit={onSubmit}>
                <input
                  value={branch}
                  onChange={(event) => setBranch(event.target.value)}
                  placeholder="feature/branch-name"
                  className="matrix-input h-10 flex-1 rounded-none px-3 text-sm outline-none"
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="matrix-button h-10 flex-1 rounded-none px-3 text-sm font-semibold sm:flex-none"
                  >
                    Create
                  </button>
                  <button className="matrix-button h-10 rounded-none px-3 text-sm" onClick={() => void refresh()} type="button">
                    Refresh
                  </button>
                </div>
              </form>
              <p className="text-xs text-[#75bb75]">
                Pick a worktree from the shell header and the terminal keeps full width.
              </p>
            </div>
          </div>
        </header>

        <section className="min-w-0">
          {shutdownStatus?.active || shutdownStatus?.completed || shutdownStatus?.failed ? (
            <div className="matrix-panel mb-4 rounded-none border-x-0 border-[rgba(255,196,87,0.24)] bg-[rgba(27,16,1,0.9)] p-4 sm:p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="matrix-kicker text-[#ffcf76]">Server shutdown</p>
                  <h2 className="mt-2 text-lg font-semibold text-[#fff3d6]">
                    {shutdownStatus.active
                      ? "Server is shutting down"
                      : shutdownStatus.failed
                        ? "Shutdown failed"
                        : "Shutdown complete"}
                  </h2>
                  <p className="mt-2 text-sm text-[#ffd892]">
                    {shutdownStatus.active
                      ? "The server is cleaning up runtimes and active connections."
                      : "These are the latest shutdown logs reported by the server."}
                  </p>
                </div>
                <div className="border border-[rgba(255,207,118,0.24)] bg-[rgba(0,0,0,0.24)] px-3 py-1 font-mono text-xs text-[#ffe1a8]">
                  {shutdownStatus.logs.length} log{shutdownStatus.logs.length === 1 ? "" : "s"}
                </div>
              </div>

              <div className="mt-4 max-h-[16rem] overflow-auto border border-[rgba(255,207,118,0.18)] bg-[rgba(0,0,0,0.32)]">
                {shutdownStatus.logs.map((entry) => (
                  <div
                    key={entry.id}
                    className={`border-b px-4 py-2 font-mono text-xs last:border-b-0 ${entry.level === "error"
                      ? "border-[rgba(255,120,120,0.16)] text-[#ffb4b4]"
                      : "border-[rgba(255,207,118,0.12)] text-[#ffe1a8]"}`}
                  >
                    <span className="mr-3 text-[rgba(255,225,168,0.6)]">
                      {new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                    <span>{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <WorktreeDetail
            worktree={selected}
            worktrees={state?.worktrees ?? []}
            onSelectWorktree={setSelectedBranch}
            worktreeCount={state?.worktrees.length ?? 0}
            runningCount={(state?.worktrees ?? []).filter((entry) => entry.runtime).length}
            selectedStatusLabel={selected?.branch ? "Live" : "None"}
            activeTab={activeTab}
            onTabChange={setActiveTab}
            isTerminalVisible={isTerminalVisible}
            onTerminalVisibilityChange={setIsTerminalVisible}
            isBusy={busyBranch === selected?.branch}
            onStart={() => selected ? void start(selected.branch) : undefined}
            onStop={() => selected ? void stop(selected.branch) : undefined}
            onSyncEnv={() => selected ? void syncEnv(selected.branch) : undefined}
            onDelete={() => setDeleteConfirmBranch(selected?.branch ?? null)}
            backgroundCommands={backgroundCommands}
            backgroundLogs={backgroundLogs}
            onLoadBackgroundCommands={loadBackgroundCommands}
            onStartBackgroundCommand={startBackgroundCommand}
            onStopBackgroundCommand={stopBackgroundCommand}
            onLoadBackgroundLogs={loadBackgroundLogs}
            onSubscribeToBackgroundLogs={subscribeToBackgroundLogs}
            onClearBackgroundLogs={clearBackgroundLogs}
          />
        </section>
      </div>

      {deleteConfirmBranch ? (
        <MatrixModal
          kicker="Confirm delete"
          title={<>Delete worktree `{deleteConfirmBranch}`?</>}
          description="This removes the worktree, stops any running environment for it, and clears its persisted tmux session."
          tone="danger"
          closeLabel="Cancel"
          maxWidthClass="max-w-xl"
          onClose={() => setDeleteConfirmBranch(null)}
          footer={(
            <>
              <button
                type="button"
                className="matrix-button rounded-none px-3 py-2 text-sm"
                onClick={() => setDeleteConfirmBranch(null)}
              >
                Keep worktree
              </button>
              <button
                type="button"
                className="matrix-button matrix-button-danger rounded-none px-3 py-2 text-sm"
                onClick={() => void confirmDelete()}
              >
                Delete worktree
              </button>
            </>
          )}
        >
          <div className="border border-[rgba(255,109,109,0.18)] bg-[rgba(0,0,0,0.28)] p-3 font-mono text-sm text-[#ffd0d0]">
            This action cannot be undone from the UI.
          </div>
        </MatrixModal>
      ) : null}

      {lastEnvSync ? (
        <MatrixModal
          kicker="Env sync output"
          title={<>Synced env files for {lastEnvSync.branch}</>}
          description={lastEnvSync.copiedFiles.length > 0
            ? "These files were copied from the shared config source into the selected worktree."
            : "No .env files were found to copy from the shared config source."}
          onClose={clearLastEnvSync}
        >
          <div className="border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.28)] p-3">
            {lastEnvSync.copiedFiles.length > 0 ? (
              <div className="max-h-[50vh] overflow-auto font-mono text-sm text-[#d7ffd7]">
                {lastEnvSync.copiedFiles.map((filePath) => (
                  <div key={filePath} className="border-b border-[rgba(74,255,122,0.08)] py-2 last:border-b-0">
                    {filePath}
                  </div>
                ))}
              </div>
            ) : (
              <p className="font-mono text-sm text-[#7fe19e]">No matching `.env*` files found.</p>
            )}
          </div>
        </MatrixModal>
      ) : null}
    </main>
  );
}
