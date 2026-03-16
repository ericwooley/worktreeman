import { useEffect, useMemo, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type {
  WorktreeRecord,
  TerminalClientMessage,
  TerminalServerMessage,
} from "@shared/types";
import "@xterm/xterm/css/xterm.css";

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
      fontFamily: "IBM Plex Mono, Fira Code, monospace",
      fontSize: 13,
      theme: {
        background: "#0f1720",
        foreground: "#f8fafc",
        cursor: "#f97316",
        selectionBackground: "rgba(249, 115, 22, 0.28)",
      },
    });
    console.log("render temrinal");
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(hostRef.current);
    terminal.focus();
    fitAddon.fit();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws/terminal?branch=${encodeURIComponent(terminalBranch)}`,
    );

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data) as TerminalServerMessage;
      if (message.type === "output") {
        terminal.write(message.data);
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

    const resize = () => {
      fitAddon.fit();
      const payload: TerminalClientMessage = {
        type: "resize",
        cols: terminal.cols,
        rows: terminal.rows,
      };
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(payload));
      }
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(hostRef.current);

    const focusTerminal = () => terminal.focus();
    socket.addEventListener("open", resize);
    hostRef.current.addEventListener("click", focusTerminal);

    return () => {
      resizeObserver.disconnect();
      hostRef.current?.removeEventListener("click", focusTerminal);
      socket.close();
      terminal.dispose();
    };
  }, [sessionName, terminalBranch]);

  return (
    <section className="rounded-[2rem] border border-ink/10 bg-white/75 p-5 shadow-panel backdrop-blur">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">Inline terminal</h2>
          <p className="text-sm text-ink/65">
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
                className="rounded-2xl border border-ink/10 bg-mist px-3 py-2 font-mono text-xs text-ink/75"
              >
                <span className="text-ink">{key}</span>=
                <span className="break-all text-pine">{value}</span>
              </div>
            ))}
          </div>
          {Object.keys(worktree.runtime.allocatedPorts).length > 0 ? (
            <p className="mb-4 text-xs text-ink/55">
              Reserved local ports are held for this runtime and injected into
              the tmux-backed shell.
            </p>
          ) : null}
          <div
            ref={hostRef}
            className="h-[24rem] overflow-hidden rounded-[1.5rem] border border-ink/10 bg-ink p-3"
          />
        </>
      ) : (
        <div className="rounded-[1.5rem] border border-dashed border-ink/15 bg-mist/70 p-8 text-sm text-ink/60">
          Start a runtime to parse Docker ports, merge config env, and launch
          the tmux-backed shell.
        </div>
      )}
    </section>
  );
}
