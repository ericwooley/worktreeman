import { useEffect, useMemo, useRef } from "react";
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
  const sessionName = worktree?.runtime?.tmuxSession ?? null;
  const terminalBranch = worktree?.runtime?.branch ?? worktree?.branch ?? null;
  const runtimeEnvEntries = useMemo(
    () => (worktree?.runtime ? Object.entries(worktree.runtime.env) : []),
    [worktree?.runtime],
  );

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
        terminal.writeln(
          `\r\n[session closed: ${message.exitCode ?? "unknown"}]`,
        );
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
    socket.addEventListener("open", () => scheduleResize(true));
    hostRef.current.addEventListener("click", focusTerminal);
    return () => {
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
      }
      if (outputFrame !== null) {
        window.cancelAnimationFrame(outputFrame);
      }
      resizeObserver.disconnect();
      hostRef.current?.removeEventListener("click", focusTerminal);
      socket.close();
      if (outputBuffer) {
        terminal.write(outputBuffer);
      }
      terminal.dispose();
    };
  }, [sessionName, terminalBranch]);

  return (
    <section className="matrix-panel min-w-0 rounded-[2rem] p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-[#ecffec]">Inline terminal</h2>
          <p className="text-sm text-[#9cd99c]">
            {worktree?.runtime
              ? `tmux session ${worktree.runtime.tmuxSession} with injected runtime env`
              : "Select a running worktree to attach to its tmux session."}
          </p>
        </div>
      </div>

      {worktree?.runtime ? (
        <>
          <div className="mb-4 grid gap-2 sm:grid-cols-2">
            {runtimeEnvEntries.map(([key, value]) => (
              <div
                key={key}
                className="matrix-command rounded-2xl px-3 py-2 font-mono text-xs text-[#9cd99c]"
              >
                <span className="text-[#ecffec]">{key}</span>=
                <span className="break-all text-[#4aff7a]">{value}</span>
              </div>
            ))}
          </div>
          {Object.keys(worktree.runtime.allocatedPorts).length > 0 ? (
            <p className="mb-4 text-xs text-[#8fd18f]">
              Reserved local ports are held for this runtime and injected into
              the tmux-backed shell.
            </p>
          ) : null}
          <div
            ref={hostRef}
            className="h-[24rem] min-w-0 w-full max-w-full overflow-hidden rounded-[1.5rem] border border-[rgba(74,255,122,0.18)] bg-[#020703] p-3 shadow-[inset_0_1px_0_rgba(181,255,196,0.04)]"
            style={{ contain: "layout size" }}
          />
        </>
      ) : (
        <div className="rounded-[1.5rem] border border-dashed border-[rgba(74,255,122,0.16)] bg-[rgba(0,0,0,0.22)] p-8 text-sm text-[#8fd18f]">
          Start a runtime to parse Docker ports, merge config env, and launch
          the tmux-backed shell.
        </div>
      )}
    </section>
  );
}
