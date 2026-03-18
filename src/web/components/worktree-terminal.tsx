import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  WorktreeRecord,
  TerminalClientMessage,
  TerminalServerMessage,
  TmuxClientInfo,
} from "@shared/types";
import { disconnectTmuxClient, getTmuxClients } from "../lib/api";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge } from "./matrix-primitives";
import { shortcutFromKeyboardEvent } from "./command-palette";
import "@xterm/xterm/css/xterm.css";

const TERMINAL_DRAWER_VISIBLE_HEIGHT = 52;

export function WorktreeTerminal({
  worktree,
  isTerminalVisible,
  onTerminalVisibilityChange,
  worktreeOptions,
  onSelectWorktree,
  showSessionInfo = true,
  commandPaletteShortcut,
  onCommandPaletteToggle,
}: {
  worktree: WorktreeRecord | null;
  isTerminalVisible: boolean;
  onTerminalVisibilityChange: (visible: boolean) => void;
  worktreeOptions: MatrixDropdownOption[];
  onSelectWorktree: (value: string) => void;
  showSessionInfo?: boolean;
  commandPaletteShortcut: string;
  onCommandPaletteToggle: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sessionName = worktree?.runtime?.tmuxSession ?? null;
  const terminalBranch = worktree?.runtime?.branch ?? worktree?.branch ?? null;
  const [tmuxClients, setTmuxClients] = useState<TmuxClientInfo[]>([]);
  const [currentClientId, setCurrentClientId] = useState<string | null>(null);
  const [disconnectingClientId, setDisconnectingClientId] = useState<
    string | null
  >(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const lastCopiedSelectionRef = useRef("");
  const runtimeEnvEntries = useMemo(
    () => (worktree?.runtime ? Object.entries(worktree.runtime.env) : []),
    [worktree?.runtime],
  );
  const visibleEnvEntries = useMemo(
    () => runtimeEnvEntries.slice(0, 8),
    [runtimeEnvEntries],
  );
  const drawer = worktree?.runtime ? (
    <div
      className="fixed inset-x-0 bottom-0 z-[35] h-[100dvh] transition-transform duration-300 ease-out"
      style={{
        transform: isTerminalVisible
          ? "translateY(0)"
          : `translateY(calc(100dvh - ${TERMINAL_DRAWER_VISIBLE_HEIGHT}px))`,
      }}
    >
      <div className="flex h-full flex-col">
        <div className="z-20 shrink-0 border-t border-[rgba(233,213,255,0.42)] bg-[linear-gradient(180deg,rgba(168,85,247,0.24),rgba(30,12,47,0.88))] shadow-[0_-10px_36px_rgba(48,12,82,0.28)] backdrop-blur-md">
          <div
            aria-expanded={isTerminalVisible}
            className="grid min-h-[52px] cursor-pointer gap-2 border-b border-[rgba(196,181,253,0.24)] px-3 py-2 sm:grid-cols-[auto_minmax(15rem,22rem)] sm:items-center sm:px-4"
            role="button"
            tabIndex={0}
            onClick={() => onTerminalVisibilityChange(!isTerminalVisible)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onTerminalVisibilityChange(!isTerminalVisible);
              }
            }}
          >
            <div className="flex min-w-0 items-center justify-between gap-3 text-left text-[#f8f3ff] transition-colors duration-150 hover:text-white">
              <div className="min-w-0">
                <p className="text-[0.6rem] uppercase tracking-[0.22em] text-[rgba(243,232,255,0.7)]">
                  Terminal drawer
                </p>
                <p className="truncate font-mono text-sm text-[#f8f3ff] sm:text-[0.95rem]">
                  {worktree?.branch ?? "No worktree selected"}
                </p>
              </div>
            </div>

            {isTerminalVisible ? (
              <div onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <MatrixDropdown
                  label="Worktree"
                  value={worktree?.branch ?? null}
                  options={worktreeOptions}
                  placeholder="Select worktree"
                  onChange={onSelectWorktree}
                />
              </div>
            ) : null}
          </div>
        </div>

        <div className="matrix-panel flex min-h-0 flex-1 flex-col overflow-hidden border-x-0 border-t border-b-0 border-[rgba(196,181,253,0.16)] shadow-[0_-18px_80px_rgba(0,0,0,0.72)]">
          <div className="flex min-h-0 flex-1 flex-col bg-[#020703]">
            <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <div
                ref={hostRef}
                className="h-full w-full overflow-hidden border-b border-b-[rgba(196,181,253,0.18)] bg-[#020703] shadow-[inset_0_1px_0_rgba(243,232,255,0.08)]"
                style={{ contain: "layout size" }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  ) : null;

  const refreshTmuxClients = async (branch: string) => {
    const clients = await getTmuxClients(branch);
    setTmuxClients(clients);
    return clients;
  };

  useEffect(() => {
    if (!terminalBranch || !worktree?.runtime) {
      setTmuxClients([]);
      setCurrentClientId(null);
      return;
    }

    let cancelled = false;

    const refreshClients = async () => {
      try {
        const clients = await refreshTmuxClients(terminalBranch);
        if (!cancelled) {
          setTmuxClients(clients);
        }
      } catch {
        if (!cancelled) {
          setTmuxClients([]);
        }
      }
    };

    void refreshClients();
    const interval = window.setInterval(refreshClients, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [sessionName, terminalBranch, worktree?.runtime]);

  useEffect(() => {
    scheduleResizeRef.current?.(true);
  }, [isTerminalVisible]);

  useEffect(() => {
    if (!hostRef.current || !terminalBranch || !sessionName) {
      return;
    }

    hostRef.current.replaceChildren();

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily:
        '"MesloLGS NF", "SauceCodePro Nerd Font Mono", "Hack Nerd Font Mono", "FiraCode Nerd Font Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#0f1720",
        foreground: "#f8fafc",
        cursor: "#f97316",
        selectionBackground: "rgba(249, 115, 22, 0.28)",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    hostRef.current.style.width = "100%";
    hostRef.current.style.maxWidth = "100%";
    terminal.open(hostRef.current);
    terminal.attachCustomKeyEventHandler((event) => {
      const shortcut = shortcutFromKeyboardEvent(event);
      if (!shortcut || shortcut !== commandPaletteShortcut) {
        return true;
      }

      event.preventDefault();
      onCommandPaletteToggle();
      return false;
    });
    terminal.focus();
    fitAddon.fit();

    let lastCols = terminal.cols;
    let lastRows = terminal.rows;
    let lastHostWidth = Math.round(hostRef.current.clientWidth);
    let lastHostHeight = Math.round(hostRef.current.clientHeight);
    let resizeFrame: number | null = null;
    let outputFrame: number | null = null;
    let outputBuffer = "";

    const flushOutput = () => {
      outputFrame = null;
      if (!outputBuffer) {
        return;
      }

      terminal.write(outputBuffer);
      outputBuffer = "";
    };

    const enqueueOutput = (data: string) => {
      outputBuffer += data;

      if (outputFrame !== null) {
        return;
      }

      outputFrame = window.requestAnimationFrame(flushOutput);
    };

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws/terminal?branch=${encodeURIComponent(terminalBranch)}`,
    );

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as TerminalServerMessage;
      if (message.type === "output") {
        enqueueOutput(message.data);
      }
      if (message.type === "error") {
        terminal.writeln(`\r\n[error] ${message.message}`);
      }
      if (message.type === "exit") {
        terminal.writeln(
          `\r\n[session closed: ${message.exitCode ?? "unknown"}]`,
        );
      }
      if (message.type === "ready") {
        setCurrentClientId(message.clientId);
        terminal.focus();
      }
    });

    terminal.onData((data) => {
      const payload: TerminalClientMessage = { type: "input", data };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    });

    const resize = (force = false) => {
      fitAddon.fit();

      const nextCols = terminal.cols;
      const nextRows = terminal.rows;

      if (nextCols !== terminal.cols || nextRows !== terminal.rows) {
        terminal.resize(nextCols, nextRows);
      }

      if (!force && nextCols === lastCols && nextRows === lastRows) {
        return;
      }

      lastCols = nextCols;
      lastRows = nextRows;

      const payload: TerminalClientMessage = {
        type: "resize",
        cols: nextCols,
        rows: nextRows,
      };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    const scheduleResize = (force = false) => {
      if (resizeFrame !== null) {
        return;
      }

      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        resize(force);
      });
    };

    scheduleResizeRef.current = scheduleResize;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }

      const nextWidth = Math.round(entry.contentRect.width);
      const nextHeight = Math.round(entry.contentRect.height);

      if (
        nextWidth <= 0 ||
        nextHeight <= 0 ||
        (nextWidth === lastHostWidth && nextHeight === lastHostHeight)
      ) {
        return;
      }

      lastHostWidth = nextWidth;
      lastHostHeight = nextHeight;
      scheduleResize();
    });
    resizeObserver.observe(hostRef.current);

    const focusTerminal = () => {
      terminal.focus();
      scheduleResize(true);
    };
    const copySelection = () => {
      const selection = terminal.getSelection().trim();
      if (
        !selection ||
        selection === lastCopiedSelectionRef.current ||
        !navigator.clipboard?.writeText
      ) {
        return;
      }

      lastCopiedSelectionRef.current = selection;
      void navigator.clipboard.writeText(selection).catch(() => {
        lastCopiedSelectionRef.current = "";
      });
    };
    const handleViewportResize = () => {
      lastHostWidth = Math.round(hostRef.current?.clientWidth ?? 0);
      lastHostHeight = Math.round(hostRef.current?.clientHeight ?? 0);
      scheduleResize(true);
    };
    const handleMouseUp = () => {
      window.requestAnimationFrame(copySelection);
    };

    socket.addEventListener("open", () => scheduleResize(true));
    hostRef.current.addEventListener("click", focusTerminal);
    hostRef.current.addEventListener("mouseup", handleMouseUp);
    hostRef.current.addEventListener("focusin", focusTerminal);
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    window.addEventListener("focus", handleViewportResize);
    void document.fonts?.ready?.then(() => scheduleResize(true));

    return () => {
      if (scheduleResizeRef.current === scheduleResize) {
        scheduleResizeRef.current = null;
      }
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (outputFrame !== null) {
        window.cancelAnimationFrame(outputFrame);
      }
      resizeObserver.disconnect();
      hostRef.current?.removeEventListener("click", focusTerminal);
      hostRef.current?.removeEventListener("mouseup", handleMouseUp);
      hostRef.current?.removeEventListener("focusin", focusTerminal);
      window.removeEventListener("resize", handleViewportResize);
      window.visualViewport?.removeEventListener(
        "resize",
        handleViewportResize,
      );
      window.removeEventListener("focus", handleViewportResize);
      socket.close();
      if (outputBuffer) {
        terminal.write(outputBuffer);
      }
      terminal.dispose();
    };
  }, [sessionName, terminalBranch]);

  const handleDisconnectClient = async (clientId: string) => {
    if (!terminalBranch || clientId === currentClientId) {
      return;
    }

    setDisconnectingClientId(clientId);
    try {
      await disconnectTmuxClient(terminalBranch, clientId);
      await refreshTmuxClients(terminalBranch);
    } finally {
      setDisconnectingClientId(null);
    }
  };

  return (
    <>
      {showSessionInfo ? (
      <section className="matrix-panel min-w-0 overflow-hidden rounded-none">
        <div className="border-b border-[rgba(74,255,122,0.14)] px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="matrix-kicker">Primary shell</p>
              <h2 className="text-xl font-semibold text-[#ecffec] sm:text-2xl">
                Terminal session info
              </h2>
              <p className="mt-1 text-sm text-[#9cd99c]">
                {worktree?.runtime
                  ? `tmux session ${worktree.runtime.tmuxSession} is docked as a fixed terminal overlay`
                  : "Select a running worktree to attach to its tmux session."}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  className="matrix-button rounded-none px-4 py-2 text-sm"
                  onClick={() => onTerminalVisibilityChange(!isTerminalVisible)}
                  disabled={!worktree?.runtime}
                >
                {isTerminalVisible ? "Stow terminal" : "Show terminal"}
              </button>
            </div>
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {visibleEnvEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="matrix-command rounded-none px-3 py-2 font-mono text-xs text-[#9cd99c]"
                >
                  <span className="text-[#ecffec]">{key}</span>=
                  <span className="break-all text-[#4aff7a]">{value}</span>
                </div>
              ))}
              {!visibleEnvEntries.length ? (
                <div className="matrix-command rounded-none px-3 py-3 text-xs text-[#8fd18f] sm:col-span-2 xl:col-span-4">
                  Runtime env will appear here once the selected worktree is
                  running.
                </div>
              ) : null}
            </div>

            <div className="border border-[rgba(74,255,122,0.14)] bg-[rgba(0,0,0,0.24)] px-4 py-3 text-xs text-[#8fd18f]">
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold uppercase tracking-[0.18em] text-[#6cb96c]">
                  Attached tmux clients
                </p>
                <span className="text-[#7fe19e]">{tmuxClients.length}</span>
              </div>
              <div className="mt-3 space-y-2">
                {tmuxClients.length ? (
                  tmuxClients.map((client) => {
                    const isCurrent = client.id === currentClientId;

                    return (
                      <div
                        key={client.id}
                        className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.24)] px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="truncate font-mono text-[#d7ffd7]">
                              {client.tty}
                            </p>
                            <p className="text-[11px] text-[#6cb96c]">
                              pid {client.pid}
                              {client.isControlMode ? " • control" : ""}
                            </p>
                          </div>
                          {isCurrent ? (
                            <MatrixBadge tone="active">This session</MatrixBadge>
                          ) : (
                            <button
                              type="button"
                              className="matrix-button matrix-button-danger rounded-none px-2 py-1 text-[11px]"
                              disabled={disconnectingClientId === client.id}
                              onClick={() =>
                                void handleDisconnectClient(client.id)
                              }
                            >
                              {disconnectingClientId === client.id
                                ? "Disconnecting"
                                : "Disconnect"}
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                ) : (
                  <p>No tmux clients attached.</p>
                )}
              </div>
              <p className="mt-3 leading-5">
                The live terminal is a fixed overlay that slides down off the
                bottom edge. When stowed, its window border stays visible so you
                can pull it back instantly.
              </p>
            </div>
          </div>
        </div>
      </section>
      ) : null}

      {typeof document !== "undefined" && drawer
        ? createPortal(drawer, document.body)
        : drawer}
    </>
  );
}
