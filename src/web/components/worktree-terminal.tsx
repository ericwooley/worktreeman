import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  WorktreeRecord,
  TerminalClientMessage,
  TerminalServerMessage,
  TmuxClientInfo,
} from "@shared/types";
import { disconnectTmuxClient, getTmuxClients } from "../lib/api";
import "@xterm/xterm/css/xterm.css";

export function WorktreeTerminal({
  worktree,
}: {
  worktree: WorktreeRecord | null;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLElement | null>(null);
  const sessionName = worktree?.runtime?.tmuxSession ?? null;
  const terminalBranch = worktree?.runtime?.branch ?? worktree?.branch ?? null;
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [tmuxClients, setTmuxClients] = useState<TmuxClientInfo[]>([]);
  const [currentClientId, setCurrentClientId] = useState<string | null>(null);
  const [disconnectingClientId, setDisconnectingClientId] = useState<string | null>(null);
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const lastCopiedSelectionRef = useRef("");
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
  const runtimeEnvEntries = useMemo(
    () => (worktree?.runtime ? Object.entries(worktree.runtime.env) : []),
    [worktree?.runtime],
  );
  const visibleEnvEntries = useMemo(() => runtimeEnvEntries.slice(0, 8), [runtimeEnvEntries]);

  const refreshTmuxClients = async (branch: string) => {
    const clients = await getTmuxClients(branch);
    setTmuxClients(clients);
    return clients;
  };

  useEffect(() => {
    if (!containerRef.current || typeof document === "undefined" || !document.fullscreenEnabled) {
      return;
    }

    const onFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === containerRef.current);
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

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
  }, [isFullscreen]);

  useEffect(() => {
    if (!hostRef.current || !terminalBranch || !sessionName) {
      return;
    }

    hostRef.current.replaceChildren();

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: '"MesloLGS NF", "SauceCodePro Nerd Font Mono", "Hack Nerd Font Mono", "FiraCode Nerd Font Mono", monospace',
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
        terminal.writeln(`\r\n[session closed: ${message.exitCode ?? "unknown"}]`);
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
      if (!selection || selection === lastCopiedSelectionRef.current || !navigator.clipboard?.writeText) {
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
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
      window.removeEventListener("focus", handleViewportResize);
      socket.close();
      if (outputBuffer) {
        terminal.write(outputBuffer);
      }
      terminal.dispose();
    };
  }, [sessionName, terminalBranch]);

  const toggleFullscreen = async () => {
    if (!containerRef.current || typeof document === "undefined" || !document.fullscreenEnabled) {
      return;
    }

    if (document.fullscreenElement === containerRef.current) {
      await document.exitFullscreen();
      return;
    }

    await containerRef.current.requestFullscreen();
  };

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
    <section
      ref={containerRef}
      className={`matrix-panel terminal-shell min-w-0 overflow-hidden rounded-none ${isFullscreen ? "h-full rounded-none" : "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"}`}
    >
      <div className="border-b border-[rgba(74,255,122,0.14)] px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="matrix-kicker">Primary shell</p>
            <h2 className="text-xl font-semibold text-[#ecffec] sm:text-2xl">Inline terminal</h2>
            <p className="mt-1 text-sm text-[#9cd99c]">
              {worktree?.runtime
                ? `tmux session ${worktree.runtime.tmuxSession} with injected runtime env`
                : "Select a running worktree to attach to its tmux session."}
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="matrix-button rounded-none px-4 py-2 text-sm"
              onClick={() => void toggleFullscreen()}
              disabled={!canFullscreen}
            >
              {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
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
                Runtime env will appear here once the selected worktree is running.
              </div>
            ) : null}
          </div>

          <div className="border border-[rgba(74,255,122,0.14)] bg-[rgba(0,0,0,0.24)] px-4 py-3 text-xs text-[#8fd18f]">
            <div className="flex items-center justify-between gap-2">
              <p className="font-semibold uppercase tracking-[0.18em] text-[#6cb96c]">Attached tmux clients</p>
              <span className="text-[#7fe19e]">{tmuxClients.length}</span>
            </div>
            <div className="mt-3 space-y-2">
              {tmuxClients.length ? tmuxClients.map((client) => {
                const isCurrent = client.id === currentClientId;

                return (
                  <div key={client.id} className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.24)] px-3 py-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-[#d7ffd7]">{client.tty}</p>
                        <p className="text-[11px] text-[#6cb96c]">pid {client.pid}{client.isControlMode ? " • control" : ""}</p>
                      </div>
                      {isCurrent ? (
                        <span className="border border-[rgba(74,255,122,0.16)] px-2 py-1 text-[11px] text-[#4aff7a]">This session</span>
                      ) : (
                        <button
                          type="button"
                          className="matrix-button matrix-button-danger rounded-none px-2 py-1 text-[11px]"
                          disabled={disconnectingClientId === client.id}
                          onClick={() => void handleDisconnectClient(client.id)}
                        >
                          {disconnectingClientId === client.id ? "Disconnecting" : "Disconnect"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              }) : (
                <p>No tmux clients attached.</p>
              )}
            </div>
            <p className="mt-3 leading-5">
              Tap to focus. Fullscreen turns the shell into the dominant workspace, which is especially useful on smaller screens.
            </p>
          </div>
        </div>
      </div>

      <div className={`${isFullscreen ? "flex min-h-0 flex-1 flex-col" : "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"}`}>
        {worktree?.runtime ? (
          <div className="flex h-full min-h-[24rem] min-w-0 flex-1 flex-col">
            {Object.keys(worktree.runtime.allocatedPorts).length > 0 ? (
              <p className="px-4 py-3 text-xs text-[#8fd18f]">
                Reserved local ports are held for this runtime and injected into the tmux-backed shell.
              </p>
            ) : null}

            <div
              className={`min-w-0 w-full ${isFullscreen ? "min-h-0 flex-1" : "flex-none"}`}
              style={isFullscreen ? undefined : { height: "calc(100vh - 50px)" }}
            >
               <div
                 ref={hostRef}
                 className="min-h-0 min-w-0 h-full w-full overflow-hidden border border-[rgba(74,255,122,0.18)] bg-[#020703] shadow-[inset_0_1px_0_rgba(181,255,196,0.04)]"
                 style={{ contain: "layout size", height: isFullscreen ? "100dvh" : "calc(100dvh - 50px)" }}
               />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-[22rem] items-center justify-center border border-dashed border-[rgba(74,255,122,0.16)] bg-[rgba(0,0,0,0.22)] p-6 text-center text-sm text-[#8fd18f] sm:p-8">
            Start a runtime to parse Docker ports, merge config env, and launch the tmux-backed shell.
          </div>
        )}
      </div>
    </section>
  );
}
