import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundCommandLogsResponse, BackgroundCommandState, WorktreeRecord } from "@shared/types";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge, MatrixDetailField, MatrixMetric, MatrixTabButton } from "./matrix-primitives";
import { WorktreeTerminal } from "./worktree-terminal";

interface WorktreeDetailProps {
  worktree: WorktreeRecord | null;
  worktrees: WorktreeRecord[];
  onSelectWorktree: (branch: string) => void;
  worktreeCount: number;
  runningCount: number;
  selectedStatusLabel: string;
  activeTab: "shell" | "background" | "git";
  onTabChange: (tab: "shell" | "background" | "git") => void;
  isTerminalVisible: boolean;
  onTerminalVisibilityChange: (visible: boolean) => void;
  isBusy: boolean;
  onStart: () => void;
  onStop: () => void;
  onSyncEnv: () => void;
  onDelete: () => void;
  backgroundCommands: BackgroundCommandState[];
  backgroundLogs: BackgroundCommandLogsResponse | null;
  onLoadBackgroundCommands: (branch: string) => Promise<BackgroundCommandState[]>;
  onStartBackgroundCommand: (branch: string, commandName: string) => Promise<BackgroundCommandState[]>;
  onStopBackgroundCommand: (branch: string, commandName: string) => Promise<BackgroundCommandState[]>;
  onLoadBackgroundLogs: (branch: string, commandName: string) => Promise<BackgroundCommandLogsResponse>;
  onSubscribeToBackgroundLogs: (branch: string, commandName: string) => () => void;
  onClearBackgroundLogs: () => void;
}

export function WorktreeDetail({
  worktree,
  worktrees,
  onSelectWorktree,
  worktreeCount,
  runningCount,
  selectedStatusLabel,
  activeTab,
  onTabChange,
  isTerminalVisible,
  onTerminalVisibilityChange,
  isBusy,
  onStart,
  onStop,
  onSyncEnv,
  onDelete,
  backgroundCommands,
  backgroundLogs,
  onLoadBackgroundCommands,
  onStartBackgroundCommand,
  onStopBackgroundCommand,
  onLoadBackgroundLogs,
  onSubscribeToBackgroundLogs,
  onClearBackgroundLogs,
}: WorktreeDetailProps) {
  const isRunning = Boolean(worktree?.runtime);
  const [copied, setCopied] = useState(false);
  const [selectedBackgroundCommandName, setSelectedBackgroundCommandName] = useState<string | null>(null);
  const [backgroundFilter, setBackgroundFilter] = useState("");
  const backgroundLogViewportRef = useRef<HTMLDivElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const previousScrollHeightRef = useRef(0);
  const quickLinks = worktree?.runtime ? Object.entries(worktree.runtime.quickLinks ?? {}) : [];
  const selectedWorktree = useMemo(
    () => worktrees.find((entry) => entry.branch === worktree?.branch) ?? null,
    [worktree?.branch, worktrees],
  );
  const worktreeOptions = useMemo<MatrixDropdownOption[]>(
    () => worktrees.map((entry) => ({
      value: entry.branch,
      label: entry.branch,
      description: entry.runtime ? "Runtime active" : "Idle",
      badgeLabel: entry.runtime ? "Active" : "Idle",
      badgeTone: entry.runtime ? "active" : "idle",
    })),
    [worktrees],
  );
  const attachCommand = worktree?.runtime
    ? `tmux attach-session -t '${worktree.runtime.tmuxSession.replace(/'/g, `'\\''`)}'`
    : null;
  const selectedBackgroundCommand = useMemo(
    () => backgroundCommands.find((entry) => entry.name === selectedBackgroundCommandName) ?? backgroundCommands[0] ?? null,
    [backgroundCommands, selectedBackgroundCommandName],
  );
  const backgroundCommandOptions = useMemo<MatrixDropdownOption[]>(
    () => backgroundCommands.map((command) => ({
      value: command.name,
      label: command.name,
      description: command.manager === "runtime" ? "Runtime managed" : "PM2 managed",
      badgeLabel: command.running ? "Running" : "Stopped",
      badgeTone: command.running ? "active" : "idle",
    })),
    [backgroundCommands],
  );
  const filteredBackgroundLogLines = useMemo(() => {
    const lines = backgroundLogs && selectedBackgroundCommand && backgroundLogs.commandName === selectedBackgroundCommand.name
      ? backgroundLogs.lines
      : [];
    if (!backgroundFilter.trim()) {
      return lines;
    }

    const query = backgroundFilter.toLowerCase();
    return lines.filter((line) => line.text.toLowerCase().includes(query));
  }, [backgroundFilter, backgroundLogs, selectedBackgroundCommand?.name]);

  useEffect(() => {
    if (!selectedBackgroundCommandName && backgroundCommands[0]) {
      setSelectedBackgroundCommandName(backgroundCommands[0].name);
      return;
    }

    if (selectedBackgroundCommandName && !backgroundCommands.some((entry) => entry.name === selectedBackgroundCommandName)) {
      setSelectedBackgroundCommandName(backgroundCommands[0]?.name ?? null);
    }
  }, [backgroundCommands, selectedBackgroundCommandName]);

  useEffect(() => {
    if (selectedBackgroundCommandName === "Environment" && backgroundCommands.some((entry) => entry.name === "docker compose")) {
      setSelectedBackgroundCommandName("docker compose");
    }
  }, [backgroundCommands, selectedBackgroundCommandName]);

  useEffect(() => {
    if (activeTab !== "background" || !worktree?.branch) {
      return;
    }

    void onLoadBackgroundCommands(worktree.branch);
  }, [activeTab, onLoadBackgroundCommands, worktree?.branch]);

  useEffect(() => {
    if (activeTab !== "background" || !worktree?.branch || !selectedBackgroundCommand?.name) {
      onClearBackgroundLogs();
      return;
    }

    shouldStickToBottomRef.current = true;
    previousScrollHeightRef.current = 0;

    let cancelled = false;

    const loadInitialLogs = async () => {
      await onLoadBackgroundLogs(worktree.branch, selectedBackgroundCommand.name);
      if (cancelled) {
        return;
      }

      const viewport = backgroundLogViewportRef.current;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        previousScrollHeightRef.current = viewport.scrollHeight;
      }
    };

    void loadInitialLogs();
    const unsubscribe = onSubscribeToBackgroundLogs(worktree.branch, selectedBackgroundCommand.name);

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    activeTab,
    onClearBackgroundLogs,
    onLoadBackgroundLogs,
    onSubscribeToBackgroundLogs,
    selectedBackgroundCommand?.name,
    worktree?.branch,
  ]);

  useEffect(() => {
    const viewport = backgroundLogViewportRef.current;
    if (!viewport) {
      return;
    }

    const previousScrollHeight = previousScrollHeightRef.current;
    const nextScrollHeight = viewport.scrollHeight;

    if (shouldStickToBottomRef.current) {
      viewport.scrollTop = nextScrollHeight;
    } else if (previousScrollHeight > 0 && nextScrollHeight > previousScrollHeight) {
      viewport.scrollTop += nextScrollHeight - previousScrollHeight;
    }

    previousScrollHeightRef.current = nextScrollHeight;
  }, [filteredBackgroundLogLines]);

  const handleBackgroundLogScroll = () => {
    const viewport = backgroundLogViewportRef.current;
    if (!viewport) {
      return;
    }

    const distanceFromBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
    shouldStickToBottomRef.current = distanceFromBottom <= 12;
  };

  const copyAttachCommand = async () => {
    if (!attachCommand) {
      return;
    }

    await navigator.clipboard.writeText(attachCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="min-w-0 space-y-4 xl:flex xl:min-h-[calc(100vh-2rem)] xl:flex-col xl:space-y-4">
      <div className="matrix-panel rounded-none border-x-0 p-4 sm:p-5">
        <div className="flex items-center gap-2 border-b border-[rgba(74,255,122,0.14)] pb-4">
          <MatrixTabButton active={activeTab === "shell"} label="Shell" onClick={() => onTabChange("shell")} />
          <MatrixTabButton active={activeTab === "background"} label="Background commands" onClick={() => onTabChange("background")} />
          <MatrixTabButton active={activeTab === "git"} label="Git status" onClick={() => onTabChange("git")} />
        </div>

        {activeTab === "shell" ? (
          <>
            <div className="mt-4 flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
              <div className="min-w-0 flex-1">
                <p className="matrix-kicker">Terminal focus</p>
                <h2 className="mt-1 text-2xl font-semibold text-[#ecffec] sm:text-3xl">
                  {worktree?.branch ?? "Select a worktree"}
                </h2>
                <p className="mt-1 text-sm text-[#9cd99c]">
                  {worktree
                    ? "The shell is the primary surface. Runtime details stay visible, but the terminal owns the layout."
                    : "Choose a worktree from the environment picker to open its terminal session."}
                </p>
              </div>

              <div className="flex min-w-0 flex-col gap-2 xl:max-w-[52rem] xl:items-end">
                <div className="grid w-full gap-2 text-left xl:w-auto xl:min-w-[34rem] xl:grid-cols-[minmax(14rem,1.2fr)_repeat(3,minmax(0,1fr))]">
                  <MatrixDropdown
                    label="Environment"
                    value={selectedWorktree?.branch ?? null}
                    options={worktreeOptions}
                    placeholder="Select worktree"
                    onChange={onSelectWorktree}
                  />
                  <MatrixMetric label="Worktrees" value={String(worktreeCount)} />
                  <MatrixMetric label="Running" value={String(runningCount)} />
                  <MatrixMetric label="Selected" value={selectedStatusLabel} />
                </div>

                <div className="flex flex-wrap items-center gap-2 xl:justify-end">
                  <MatrixBadge tone="neutral">{worktree?.runtime ? "tmux attached" : "idle"}</MatrixBadge>
                  {worktree?.runtime?.dockerStartedAt ? (
                    <MatrixBadge tone="active">live since {new Date(worktree.runtime.dockerStartedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</MatrixBadge>
                  ) : null}
                  {worktree ? (
                    <>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || isRunning} onClick={onStart}>Start env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy || !isRunning} onClick={onStop}>Stop env</button>
                      <button type="button" className="matrix-button rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onSyncEnv}>Sync .env</button>
                      <button type="button" className="matrix-button matrix-button-danger rounded-none px-3 py-1.5 text-sm" disabled={isBusy} onClick={onDelete}>Delete</button>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-3 text-sm md:grid-cols-2 xl:grid-cols-4">
              <MatrixDetailField label="Path" value={worktree?.worktreePath ?? "-"} mono />
              <MatrixDetailField label="Head" value={worktree?.headSha ?? "-"} mono />
              <MatrixDetailField label="Compose project" value={worktree?.runtime?.composeProject ?? "-"} mono />
              <MatrixDetailField label="tmux session" value={worktree?.runtime?.tmuxSession ?? "-"} mono />
            </div>

            <div className="mt-4 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Quick links</p>
                <span className="text-xs text-[#7fe19e]">{quickLinks.length}</span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {quickLinks.length ? quickLinks.map(([label, href]) => (
                  <a
                    key={label}
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="matrix-command rounded-none px-4 py-3 text-sm text-[#d7ffd7] transition-colors duration-150 hover:border-[rgba(74,255,122,0.24)] hover:text-[#4aff7a]"
                  >
                    <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
                    <p className="mt-2 break-all font-mono text-xs">{href}</p>
                  </a>
                )) : (
                  <div className="matrix-command rounded-none px-4 py-3 text-xs text-[#8fd18f] sm:col-span-2 xl:col-span-3">
                    Quick links appear here after the runtime resolves its ports.
                  </div>
                )}
              </div>
            </div>

            {attachCommand ? (
              <div className="mt-3 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-3">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Attach command</p>
                    <p className="mt-2 break-all font-mono text-sm text-[#d7ffd7]">{attachCommand}</p>
                  </div>
                  <button type="button" className="matrix-button rounded-none px-3 py-2 text-sm" onClick={() => void copyAttachCommand()}>
                    {copied ? "Copied" : "Copy"}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : activeTab === "background" ? (
          <div className="mt-4 space-y-4">
            <div className="border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-4">
              <div className="flex flex-col gap-3 xl:flex-row xl:items-start xl:justify-between">
                <div>
                  <p className="matrix-kicker">Background commands</p>
                  <h2 className="mt-2 text-2xl font-semibold text-[#ecffec] sm:text-3xl">Process control</h2>
                  <p className="mt-2 text-sm text-[#9cd99c]">
                    Long-running dev services live here. `docker compose up` is runtime-backed; other commands run under PM2 after the environment is created.
                  </p>
                </div>

                <div className="grid gap-2 sm:grid-cols-[minmax(16rem,1fr)_auto_auto] xl:min-w-[42rem]">
                  <MatrixDropdown
                    label="Command"
                    value={selectedBackgroundCommand?.name ?? null}
                    options={backgroundCommandOptions}
                    placeholder="No commands"
                    disabled={!backgroundCommands.length}
                    emptyLabel="No background commands are configured yet."
                    onChange={setSelectedBackgroundCommandName}
                  />

                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    disabled={!worktree?.branch || !selectedBackgroundCommand || !selectedBackgroundCommand.canStart || selectedBackgroundCommand.running || isBusy}
                    onClick={() => worktree && selectedBackgroundCommand ? void onStartBackgroundCommand(worktree.branch, selectedBackgroundCommand.name) : undefined}
                  >
                    Start
                  </button>

                  <button
                    type="button"
                    className="matrix-button rounded-none px-3 py-2 text-sm"
                    disabled={!worktree?.branch || !selectedBackgroundCommand || !selectedBackgroundCommand.running || isBusy}
                    onClick={() => worktree && selectedBackgroundCommand ? void onStopBackgroundCommand(worktree.branch, selectedBackgroundCommand.name) : undefined}
                  >
                    Stop
                  </button>
                </div>
              </div>

              {selectedBackgroundCommand ? (
                <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
                  <div className="matrix-command rounded-none px-4 py-3">
                    <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Command</p>
                    <p className="mt-2 break-all font-mono text-sm text-[#ecffec]">{selectedBackgroundCommand.command}</p>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <MatrixDetailField label="Manager" value={selectedBackgroundCommand.manager === "runtime" ? "Runtime" : "PM2"} />
                    <MatrixDetailField label="Status" value={selectedBackgroundCommand.status} mono />
                    <MatrixDetailField label="PID" value={selectedBackgroundCommand.pid ? String(selectedBackgroundCommand.pid) : "-"} mono />
                    <MatrixDetailField
                      label="Started"
                      value={selectedBackgroundCommand.startedAt
                        ? new Date(selectedBackgroundCommand.startedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                        : "-"}
                    />
                  </div>
                </div>
              ) : (
                <div className="mt-4 matrix-command rounded-none px-4 py-3 text-sm text-[#8fd18f]">
                  No background commands are configured yet.
                </div>
              )}

              {selectedBackgroundCommand?.note ? (
                <div className="mt-3 border border-[rgba(255,207,118,0.22)] bg-[rgba(38,27,5,0.4)] px-3 py-2 text-sm text-[#ffd892]">
                  {selectedBackgroundCommand.note}
                </div>
              ) : null}
            </div>

            <div className="border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">Logs</p>
                  <p className="mt-2 text-sm text-[#9cd99c]">Grep hides lines that do not contain the search text.</p>
                </div>

                <label className="w-full sm:max-w-xs">
                  <span className="sr-only">Filter logs</span>
                  <input
                    value={backgroundFilter}
                    onChange={(event) => setBackgroundFilter(event.target.value)}
                    placeholder="grep logs"
                    className="matrix-input h-10 w-full rounded-none px-3 text-sm outline-none"
                  />
                </label>
              </div>

               <div
                 ref={backgroundLogViewportRef}
                 onScroll={handleBackgroundLogScroll}
                 className="mt-4 max-h-[28rem] overflow-auto border border-[rgba(74,255,122,0.12)] bg-[rgba(1,8,3,0.86)] font-mono text-xs"
               >
                {filteredBackgroundLogLines.length ? filteredBackgroundLogLines.map((line) => (
                  <div
                    key={line.id}
                    className={`border-b px-4 py-2 last:border-b-0 ${line.source === "stderr"
                      ? "border-[rgba(255,120,120,0.12)] text-[#ffb4b4]"
                      : "border-[rgba(74,255,122,0.08)] text-[#d7ffd7]"}`}
                  >
                    {line.timestamp ? (
                      <span className="mr-3 text-[rgba(146,214,146,0.62)]">
                        {new Date(line.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                    ) : null}
                    <span>{line.text}</span>
                  </div>
                )) : (
                  <div className="px-4 py-4 text-[#8fd18f]">
                    {selectedBackgroundCommand
                      ? backgroundFilter.trim()
                        ? "No log lines match the current grep filter."
                        : "No log output yet."
                      : "Choose a background command to inspect logs."}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="mt-4 border border-[rgba(74,255,122,0.18)] bg-[rgba(0,0,0,0.24)] p-4">
            <p className="matrix-kicker">Git status</p>
            <h2 className="mt-2 text-2xl font-semibold text-[#ecffec] sm:text-3xl">Planned</h2>
            <p className="mt-2 text-sm text-[#9cd99c]">
              This section is a todo placeholder for the richer git workflow ideas you want to add next.
            </p>
            <div className="mt-4 matrix-command rounded-none px-4 py-3 text-sm text-[#8fd18f]">
              TODO: build out git status, actions, review flow, and branch insights here.
            </div>
          </div>
        )}
      </div>

      <div className="min-w-0 xl:flex xl:min-h-0 xl:flex-1 xl:flex-col">
        <WorktreeTerminal
          worktree={worktree}
          isTerminalVisible={isTerminalVisible}
          onTerminalVisibilityChange={onTerminalVisibilityChange}
          showSessionInfo={activeTab === "shell"}
        />
      </div>
    </section>
  );
}
