import { useEffect, useMemo, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  WorktreeRecord,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@shared/types";
import "@xterm/xterm/css/xterm.css";

const MIN_TERMINAL_COLS = 80;

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
  const canFullscreen = typeof document !== "undefined" && document.fullscreenEnabled;
  const runtimeEnvEntries = useMemo(
    () => (worktree?.runtime ? Object.entries(worktree.runtime.env) : []),
    [worktree?.runtime],
  );
  const visibleEnvEntries = useMemo(() => runtimeEnvEntries.slice(0, 8), [runtimeEnvEntries]);

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

      const nextCols = Math.max(terminal.cols, MIN_TERMINAL_COLS);
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

    const focusTerminal = () => terminal.focus();
    const handleViewportResize = () => {
      lastHostWidth = Math.round(hostRef.current?.clientWidth ?? 0);
      lastHostHeight = Math.round(hostRef.current?.clientHeight ?? 0);
      scheduleResize(true);
    };

    socket.addEventListener("open", () => scheduleResize(true));
    hostRef.current.addEventListener("click", focusTerminal);
    window.addEventListener("resize", handleViewportResize);
    window.visualViewport?.addEventListener("resize", handleViewportResize);

    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (outputFrame !== null) {
        window.cancelAnimationFrame(outputFrame);
      }
      resizeObserver.disconnect();
      hostRef.current?.removeEventListener("click", focusTerminal);
      window.removeEventListener("resize", handleViewportResize);
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
      socket.close();
      if (outputBuffer) {
        terminal.write(outputBuffer);
      }
      terminal.dispose();
    };
  }, [isFullscreen, sessionName, terminalBranch]);

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

  return (
    <section
      ref={containerRef}
      className={`matrix-panel terminal-shell min-w-0 overflow-hidden rounded-[1.8rem] ${isFullscreen ? "h-full rounded-none" : "xl:flex xl:flex-col"}`}
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
              className="matrix-button rounded-full px-4 py-2 text-sm"
              onClick={() => void toggleFullscreen()}
              disabled={!canFullscreen}
            >
              {isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {visibleEnvEntries.map(([key, value]) => (
              <div
                key={key}
                className="matrix-command rounded-2xl px-3 py-2 font-mono text-xs text-[#9cd99c]"
              >
                <span className="text-[#ecffec]">{key}</span>=
                <span className="break-all text-[#4aff7a]">{value}</span>
              </div>
            ))}
            {!visibleEnvEntries.length ? (
              <div className="matrix-command rounded-2xl px-3 py-3 text-xs text-[#8fd18f] sm:col-span-2 xl:col-span-4">
                Runtime env will appear here once the selected worktree is running.
              </div>
            ) : null}
          </div>

          <div className="rounded-[1.2rem] border border-[rgba(74,255,122,0.14)] bg-[rgba(0,0,0,0.24)] px-4 py-3 text-xs text-[#8fd18f]">
            <p className="font-semibold uppercase tracking-[0.18em] text-[#6cb96c]">Terminal notes</p>
            <p className="mt-2 leading-5">
              Tap to focus. Fullscreen turns the shell into the dominant workspace, which is especially useful on smaller screens.
            </p>
            {runtimeEnvEntries.length > visibleEnvEntries.length ? (
              <p className="mt-2 text-[#7fe19e]">
                Showing {visibleEnvEntries.length} of {runtimeEnvEntries.length} env vars in the header.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className={`px-3 pb-3 pt-3 sm:px-4 sm:pb-4 ${isFullscreen ? "flex min-h-0 flex-1 flex-col" : "xl:flex xl:min-h-0 xl:flex-1 xl:flex-col"}`}>
        {worktree?.runtime ? (
          <div className="flex h-full min-h-[24rem] min-w-0 flex-1 flex-col">
            {Object.keys(worktree.runtime.allocatedPorts).length > 0 ? (
              <p className="mb-3 text-xs text-[#8fd18f]">
                Reserved local ports are held for this runtime and injected into the tmux-backed shell.
              </p>
            ) : null}

            <div
              className={`min-w-0 w-full max-w-full ${isFullscreen ? "min-h-0 flex-1" : "flex-none"}`}
              style={isFullscreen ? undefined : { height: "calc(100vh - 50px)" }}
            >
              <div
                ref={hostRef}
                className="min-h-0 min-w-0 h-full w-full overflow-hidden border border-[rgba(74,255,122,0.18)] bg-[#020703] p-2 sm:p-3 shadow-[inset_0_1px_0_rgba(181,255,196,0.04)]"
                style={{ contain: "layout size" }}
              />
            </div>
          </div>
        ) : (
          <div className="flex h-full min-h-[22rem] items-center justify-center rounded-[1.5rem] border border-dashed border-[rgba(74,255,122,0.16)] bg-[rgba(0,0,0,0.22)] p-6 text-center text-sm text-[#8fd18f] sm:p-8">
            Start a runtime to parse Docker ports, merge config env, and launch the tmux-backed shell.
          </div>
        )}
      </div>
    </section>
  );
}
