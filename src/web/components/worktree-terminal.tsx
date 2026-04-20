import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type {
  WorktreeRecord,
  TerminalClientMessage,
  TerminalServerMessage,
  TmuxClientInfo,
} from "@shared/types";
import { disconnectTmuxClient, getTmuxClients, reconnectTerminal, restartRuntime, subscribeToTmuxClients } from "../lib/api";
import { getTmuxSessionName } from "../lib/tmux";
import { MatrixDropdown, type MatrixDropdownOption } from "./matrix-dropdown";
import { MatrixBadge } from "./matrix-primitives";
import { shortcutFromKeyboardEvent } from "./command-palette";
import { ENVIRONMENT_SESSION_INFO_TITLE, WORKTREE_ENVIRONMENT_KICKER } from "./worktree-environment-content";
import { getTerminalCopyDecision, logTerminalCopyEvent, writeTerminalTextToClipboard } from "./worktree-terminal-copy";

const TERMINAL_DRAWER_VISIBLE_HEIGHT = 52;
const TERMINAL_SURFACE_MODE_STORAGE_KEY = "worktreeman.terminalSurfaceMode";

type TerminalSurfaceMode = "dark" | "light";
type TerminalConnectionState = "connecting" | "connected" | "disconnected";

function getCssVariable(name: string, fallback: string): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getTerminalTheme(surfaceMode: TerminalSurfaceMode) {
  const background = surfaceMode === "light"
    ? getCssVariable("--base07", "#ffffff")
    : getCssVariable("--base00", "#000000");
  const foreground = surfaceMode === "light"
    ? getCssVariable("--base01", "#111111")
    : getCssVariable("--base05", "#ffffff");
  const cursor = surfaceMode === "light"
    ? getCssVariable("--base0D", "#2563eb")
    : getCssVariable("--base0B", "#ffffff");
  const selectionSource = surfaceMode === "light" ? "--rgb-base0D" : "--rgb-base0E";
  const selectionRgb = getCssVariable(selectionSource, "192 132 252").replace(/\s+/g, ", ");

  return {
    background,
    foreground,
    cursor,
    selectionBackground: `rgba(${selectionRgb}, 0.28)`,
  };
}

function decodeOsc52Payload(data: string): string {
  if (typeof window !== "undefined" && typeof window.atob === "function") {
    return decodeURIComponent(Array.from(window.atob(data), (char) => `%${char.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""));
  }

  return data;
}

export function WorktreeTerminal({
  repoRoot,
  worktree,
  isTerminalVisible,
  onTerminalVisibilityChange,
  worktreeOptions,
  onSelectWorktree,
  showSessionInfo = true,
  commandPaletteShortcut,
  onCommandPaletteToggle,
  terminalShortcut,
  onTerminalShortcutToggle,
}: {
  repoRoot: string | null;
  worktree: WorktreeRecord | null;
  isTerminalVisible: boolean;
  onTerminalVisibilityChange: (visible: boolean) => void;
  worktreeOptions: MatrixDropdownOption[];
  onSelectWorktree: (value: string) => void;
  showSessionInfo?: boolean;
  commandPaletteShortcut: string;
  onCommandPaletteToggle: () => void;
  terminalShortcut: string;
  onTerminalShortcutToggle: () => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const shellSurfaceRef = useRef<HTMLDivElement | null>(null);
  const sessionName = worktree?.runtime?.tmuxSession
    ?? (worktree && repoRoot ? getTmuxSessionName(repoRoot, worktree.id) : null);
  const terminalBranch = worktree?.runtime?.branch ?? worktree?.branch ?? null;
  const [tmuxClients, setTmuxClients] = useState<TmuxClientInfo[]>([]);
  const [currentClientId, setCurrentClientId] = useState<string | null>(null);
  const [disconnectingClientId, setDisconnectingClientId] = useState<
    string | null
  >(null);
  const [terminalConnectionState, setTerminalConnectionState] = useState<TerminalConnectionState>(
    worktree?.runtime ? "connected" : "disconnected",
  );
  const [terminalStatusMessage, setTerminalStatusMessage] = useState<string | null>(null);
  const [reconnectGeneration, setReconnectGeneration] = useState(0);
  const [reconnectingTerminal, setReconnectingTerminal] = useState(false);
  const [restartingRuntime, setRestartingRuntime] = useState(false);
  const [terminalSurfaceMode, setTerminalSurfaceMode] = useState<TerminalSurfaceMode>(() => {
    if (typeof window === "undefined") {
      return "dark";
    }

    return window.localStorage.getItem(TERMINAL_SURFACE_MODE_STORAGE_KEY) === "light"
      ? "light"
      : "dark";
  });
  const scheduleResizeRef = useRef<((force?: boolean) => void) | null>(null);
  const lastCopiedSelectionRef = useRef("");
  const commandPaletteShortcutRef = useRef(commandPaletteShortcut);
  const terminalShortcutRef = useRef(terminalShortcut);
  const commandPaletteToggleRef = useRef(onCommandPaletteToggle);
  const terminalShortcutToggleRef = useRef(onTerminalShortcutToggle);
  const runtimeEnvEntries = useMemo(
    () => (worktree?.runtime ? Object.entries(worktree.runtime.env) : []),
    [worktree?.runtime],
  );
  const visibleEnvEntries = useMemo(
    () => runtimeEnvEntries.slice(0, 8),
    [runtimeEnvEntries],
  );
  const connectionBadgeTone = terminalConnectionState === "connected"
    ? "active"
    : terminalConnectionState === "connecting"
      ? "warning"
      : "danger";
  const connectionBadgeLabel = terminalConnectionState === "connected"
    ? "Connected"
    : terminalConnectionState === "connecting"
      ? "Connecting"
      : "Disconnected";

  useEffect(() => {
    commandPaletteShortcutRef.current = commandPaletteShortcut;
    terminalShortcutRef.current = terminalShortcut;
    commandPaletteToggleRef.current = onCommandPaletteToggle;
    terminalShortcutToggleRef.current = onTerminalShortcutToggle;
  }, [commandPaletteShortcut, onCommandPaletteToggle, onTerminalShortcutToggle, terminalShortcut]);

  useEffect(() => {
    if (!worktree) {
      setTerminalConnectionState("disconnected");
      return;
    }

    setTerminalConnectionState(worktree.runtime ? "connected" : "disconnected");
  }, [worktree]);

  useEffect(() => {
    window.localStorage.setItem(TERMINAL_SURFACE_MODE_STORAGE_KEY, terminalSurfaceMode);
  }, [terminalSurfaceMode]);

  const drawer = worktree ? (
    <div
      className="fixed inset-x-0 bottom-0 z-[35] h-[100dvh] transition-transform duration-300 ease-out"
      style={{
        transform: isTerminalVisible
          ? "translateY(0)"
          : `translateY(calc(100dvh - ${TERMINAL_DRAWER_VISIBLE_HEIGHT}px))`,
      }}
    >
      <div className="flex h-full flex-col" data-terminal-surface-mode={terminalSurfaceMode}>
        <div className="theme-terminal-drawer z-20 shrink-0 border-t backdrop-blur-md">
          <div
            aria-expanded={isTerminalVisible}
            className="theme-terminal-drawer-row grid min-h-[52px] cursor-pointer gap-2 border-b px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-4"
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
            <div className="theme-text-strong flex min-w-0 items-center justify-between gap-3 text-left transition-colors duration-150 hover:text-white">
              <div className="min-w-0">
                <p className="theme-text-muted text-[0.6rem] uppercase tracking-[0.22em]">
                  Terminal drawer
                </p>
                <p className="truncate font-mono text-sm sm:text-[0.95rem]">
                  {worktree?.branch ?? "No worktree selected"}
                </p>
              </div>
            </div>

            <div className="flex min-w-0 items-center justify-end gap-2">
              {isTerminalVisible ? (
                <div
                  className="flex items-center gap-1"
                  onClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => event.stopPropagation()}
                >
                  <button
                    type="button"
                    className={`theme-terminal-mode-toggle rounded-none px-2 py-1 text-[11px] uppercase tracking-[0.16em] ${terminalSurfaceMode === "dark" ? "theme-terminal-mode-toggle-active" : "theme-terminal-mode-toggle-idle"}`}
                    onClick={() => setTerminalSurfaceMode("dark")}
                  >
                    Dark
                  </button>
                  <button
                    type="button"
                    className={`theme-terminal-mode-toggle rounded-none px-2 py-1 text-[11px] uppercase tracking-[0.16em] ${terminalSurfaceMode === "light" ? "theme-terminal-mode-toggle-active" : "theme-terminal-mode-toggle-idle"}`}
                    onClick={() => setTerminalSurfaceMode("light")}
                  >
                    Light
                  </button>
                </div>
              ) : null}

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
        </div>

        <div className="theme-terminal-border theme-shell-shadow matrix-panel flex min-h-0 flex-1 flex-col overflow-hidden border-x-0 border-t border-b-0">
          <div className="theme-terminal-surface flex min-h-0 flex-1 flex-col">
            <div ref={shellSurfaceRef} className="min-h-0 min-w-0 flex-1 overflow-hidden">
              <div
                ref={hostRef}
                className="theme-terminal-border theme-terminal-surface theme-shell-host h-full w-full overflow-hidden border-b"
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

  const handleReconnectTerminal = async () => {
    if (!terminalBranch) {
      return;
    }

    setReconnectingTerminal(true);
    setTerminalConnectionState("connecting");
    setTerminalStatusMessage(null);
    setCurrentClientId(null);

    try {
      const payload = await reconnectTerminal(terminalBranch);
      setTmuxClients(payload.clients);
      setReconnectGeneration((value) => value + 1);
      setTerminalStatusMessage(`Reconnected to tmux session ${payload.tmuxSession}.`);
    } catch (error) {
      setTerminalConnectionState("disconnected");
      setTerminalStatusMessage(error instanceof Error ? error.message : "Unable to reconnect to the shell.");
    } finally {
      setReconnectingTerminal(false);
    }
  };

  const handleRestartRuntime = async () => {
    if (!terminalBranch) {
      return;
    }

    setRestartingRuntime(true);
    setTerminalConnectionState("connecting");
    setTerminalStatusMessage(null);
    setCurrentClientId(null);

    try {
      await restartRuntime(terminalBranch);
      const payload = await reconnectTerminal(terminalBranch);
      setTmuxClients(payload.clients);
      setReconnectGeneration((value) => value + 1);
      setTerminalStatusMessage("Restarted the worktree environment and reloaded the shell environment.");
    } catch (error) {
      setTerminalConnectionState("disconnected");
      setTerminalStatusMessage(error instanceof Error ? error.message : "Unable to restart the worktree environment.");
    } finally {
      setRestartingRuntime(false);
    }
  };

  useEffect(() => {
    if (!terminalBranch || !worktree) {
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
    const unsubscribe = subscribeToTmuxClients(terminalBranch, (event) => {
      if (!cancelled) {
        setTmuxClients(event.clients);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [sessionName, terminalBranch, worktree]);

  useEffect(() => {
    scheduleResizeRef.current?.(true);
  }, [isTerminalVisible]);

  useEffect(() => {
    const worktreeId = worktree?.id ?? null;

    if (!hostRef.current || !terminalBranch || !sessionName || !worktreeId) {
      setTerminalConnectionState("disconnected");
      return;
    }

    setTerminalConnectionState("connecting");

    hostRef.current.replaceChildren();

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      try {
        if (disposed || !hostRef.current) {
          return;
        }

        const host = hostRef.current;
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily:
            '"MesloLGS NF", "SauceCodePro Nerd Font Mono", "Hack Nerd Font Mono", "FiraCode Nerd Font Mono", monospace',
          fontSize: 13,
          altClickMovesCursor: false,
          macOptionClickForcesSelection: true,
          theme: getTerminalTheme(terminalSurfaceMode),
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        host.style.width = "100%";
        host.style.maxWidth = "100%";
        terminal.open(host);
        const osc52Disposable = terminal.parser.registerOscHandler(52, (data) => {
          const separatorIndex = data.indexOf(";");
          if (separatorIndex === -1) {
            logTerminalCopyEvent("osc52-ignored", { reason: "missing-separator" });
            return false;
          }

          const encodedPayload = data.slice(separatorIndex + 1);
          if (!encodedPayload || encodedPayload === "?") {
            logTerminalCopyEvent("osc52-ignored", {
              reason: !encodedPayload ? "empty-payload" : "read-request",
            });
            return true;
          }

          try {
            const decoded = decodeOsc52Payload(encodedPayload);
            logTerminalCopyEvent("osc52-copy-attempt", {
              textLength: decoded.length,
              clipboardAvailable: Boolean(navigator.clipboard?.writeText),
            });
            void writeTerminalTextToClipboard(decoded).then((method) => {
              logTerminalCopyEvent("osc52-copy-success", { textLength: decoded.length, method });
            }).catch((error) => {
              logTerminalCopyEvent("osc52-copy-failed", {
                textLength: decoded.length,
                error: error instanceof Error ? error.message : String(error),
              });
            });
            return true;
          } catch (error) {
            logTerminalCopyEvent("osc52-copy-decode-failed", {
              error: error instanceof Error ? error.message : String(error),
            });
            return false;
          }
        });
        terminal.attachCustomKeyEventHandler((event) => {
          const shortcut = shortcutFromKeyboardEvent(event);
          if (!shortcut) {
            if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "c") {
              const selection = terminal.getSelection();
              if (!selection) {
                logTerminalCopyEvent("keyboard-copy-skipped", { reason: "no-selection" });
                return true;
              }

              logTerminalCopyEvent("keyboard-copy-attempt", {
                textLength: selection.length,
                clipboardAvailable: Boolean(navigator.clipboard?.writeText),
              });
              void writeTerminalTextToClipboard(selection).then((method) => {
                lastCopiedSelectionRef.current = selection;
                logTerminalCopyEvent("keyboard-copy-success", { textLength: selection.length, method });
              }).catch((error) => {
                lastCopiedSelectionRef.current = "";
                logTerminalCopyEvent("keyboard-copy-failed", {
                  textLength: selection.length,
                  error: error instanceof Error ? error.message : String(error),
                });
              });
              event.preventDefault();
              return false;
            }

            return true;
          }

          if (shortcut === terminalShortcutRef.current) {
            event.preventDefault();
            terminalShortcutToggleRef.current();
            return false;
          }

          if (shortcut !== commandPaletteShortcutRef.current) {
            return true;
          }

          event.preventDefault();
          commandPaletteToggleRef.current();
          return false;
        });
        terminal.focus();

        let lastCols = 0;
        let lastRows = 0;
        let lastHostWidth = 0;
        let lastHostHeight = 0;
        let resizeFrame: number | null = null;
        let pendingResizeForce = false;
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
        const socketUrl = `${protocol}//${window.location.host}/ws/terminal?id=${encodeURIComponent(worktreeId)}`;
        const socket = new WebSocket(
          socketUrl,
        );
        logTerminalCopyEvent("terminal-socket-connect", {
          url: socketUrl,
          readyState: socket.readyState,
        });

        socket.addEventListener("open", () => {
          logTerminalCopyEvent("terminal-socket-open", { readyState: socket.readyState });
          triggerInitialResizePass();
        });

        socket.addEventListener("message", (event) => {
          if (disposed) {
            return;
          }

          const message = JSON.parse(event.data) as TerminalServerMessage;
          if (message.type === "output") {
            enqueueOutput(message.data);
          }
          if (message.type === "error") {
            setTerminalConnectionState("disconnected");
            setTerminalStatusMessage(message.message);
            terminal.writeln(`\r\n[error] ${message.message}`);
          }
          if (message.type === "exit") {
            setTerminalConnectionState("disconnected");
            setCurrentClientId(null);
            setTerminalStatusMessage(`Terminal session closed (${message.exitCode ?? "unknown"}).`);
            terminal.writeln(
              `\r\n[session closed: ${message.exitCode ?? "unknown"}]`,
            );
          }
          if (message.type === "ready") {
            setTerminalConnectionState("connected");
            setTerminalStatusMessage(null);
            setCurrentClientId(message.clientId);
            if (isTerminalVisible) {
              terminal.focus();
            }
          }
        });

        socket.addEventListener("error", () => {
          logTerminalCopyEvent("terminal-socket-error", { readyState: socket.readyState });
        });

        socket.addEventListener("close", (event) => {
          if (disposed) {
            return;
          }

          logTerminalCopyEvent("terminal-socket-close", {
            code: event.code,
            reason: event.reason,
            wasClean: event.wasClean,
          });

          setTerminalConnectionState("disconnected");
          setCurrentClientId(null);
          setTerminalStatusMessage((current) => current ?? "Terminal disconnected. Reconnect to attach again.");
        });

        terminal.onData((data) => {
          const payload: TerminalClientMessage = { type: "input", data };
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(payload));
          }
        });

        const resize = (force = false) => {
          const rect = host.getBoundingClientRect();
          const nextHostWidth = Math.round(rect.width);
          const nextHostHeight = Math.round(rect.height);

          if (nextHostWidth <= 0 || nextHostHeight <= 0) {
            return;
          }

          fitAddon.fit();

          const nextCols = terminal.cols;
          const nextRows = terminal.rows;

          if (
            !force &&
            nextCols === lastCols &&
            nextRows === lastRows &&
            nextHostWidth === lastHostWidth &&
            nextHostHeight === lastHostHeight
          ) {
            return;
          }

          lastHostWidth = nextHostWidth;
          lastHostHeight = nextHostHeight;
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
          pendingResizeForce = pendingResizeForce || force;

          if (resizeFrame !== null) {
            return;
          }

          resizeFrame = window.requestAnimationFrame(() => {
            resizeFrame = null;
            const nextForce = pendingResizeForce;
            pendingResizeForce = false;
            resize(nextForce);
          });
        };

        const triggerInitialResizePass = () => {
          scheduleResize(true);
          window.requestAnimationFrame(() => scheduleResize(true));
          window.setTimeout(() => scheduleResize(true), 0);
          window.setTimeout(() => scheduleResize(true), 150);
        };

        scheduleResizeRef.current = scheduleResize;

        const resizeObserver = new ResizeObserver(() => {
          scheduleResize();
        });
        const shellSurface = shellSurfaceRef.current;
        if (shellSurface) {
          resizeObserver.observe(shellSurface);
        }
        resizeObserver.observe(host);

        const hasDomSelection = () => Boolean(window.getSelection()?.toString());
        const focusTerminal = () => {
          if (terminal.getSelection() || hasDomSelection()) {
            return;
          }

          terminal.focus();
          scheduleResize(true);
        };
        const hasTerminalFocus = () => Boolean(host.contains(document.activeElement));
        const copySelection = () => {
          const selection = terminal.getSelection();

          if (!selection) {
            logTerminalCopyEvent("selection-copy-skipped", { reason: "no-selection" });
            return;
          }

          if (selection === lastCopiedSelectionRef.current) {
            logTerminalCopyEvent("selection-copy-skipped", {
              reason: "already-copied",
              textLength: selection.length,
            });
            return;
          }

          lastCopiedSelectionRef.current = selection;
          logTerminalCopyEvent("selection-copy-attempt", {
            textLength: selection.length,
            clipboardAvailable: Boolean(navigator.clipboard?.writeText),
          });
          void writeTerminalTextToClipboard(selection).catch((error) => {
            lastCopiedSelectionRef.current = "";
            logTerminalCopyEvent("selection-copy-failed", {
              textLength: selection.length,
              error: error instanceof Error ? error.message : String(error),
            });
          }).then((method) => {
            if (lastCopiedSelectionRef.current === selection) {
              logTerminalCopyEvent("selection-copy-success", { textLength: selection.length, method });
            }
          });
        };
        const handleViewportResize = () => {
          scheduleResize(true);
        };
        const handleDrawerTransitionEnd = () => {
          scheduleResize(true);
        };
        const scheduleCopySelection = () => {
          window.requestAnimationFrame(() => {
            window.setTimeout(() => copySelection(), 0);
          });
        };
        const handleMouseUp = () => {
          scheduleCopySelection();
        };
        const handleSelectionChange = () => {
          const selection = terminal.getSelection();
          const domSelection = window.getSelection()?.toString() ?? "";
          logTerminalCopyEvent("selection-change", {
            terminalSelectionLength: selection.length,
            domSelectionLength: domSelection.length,
          });
          if (!selection) {
            lastCopiedSelectionRef.current = "";
          }

          if (selection || domSelection) {
            scheduleCopySelection();
          }
        };
        const handleCopy = (event: ClipboardEvent) => {
          const selection = terminal.getSelection();
          const domSelection = window.getSelection()?.toString() ?? "";
          const decision = getTerminalCopyDecision({
            hasTerminalFocus: hasTerminalFocus(),
            terminalSelection: selection,
            domSelection,
          });
          logTerminalCopyEvent("document-copy", {
            shouldHandle: decision.shouldHandle,
            reason: decision.reason,
            terminalSelectionLength: selection.length,
            domSelectionLength: domSelection.length,
          });
          if (!decision.shouldHandle) {
            return;
          }

          event.preventDefault();
          event.clipboardData?.setData("text/plain", selection);
          lastCopiedSelectionRef.current = selection;
          logTerminalCopyEvent("document-copy-handled", { textLength: selection.length });
        };
        terminal.onSelectionChange(handleSelectionChange);
        host.addEventListener("click", focusTerminal);
        host.addEventListener("mouseup", handleMouseUp);
        host.addEventListener("focusin", focusTerminal);
        shellSurface?.addEventListener("transitionend", handleDrawerTransitionEnd);
        document.addEventListener("copy", handleCopy, true);
        window.addEventListener("resize", handleViewportResize);
        window.visualViewport?.addEventListener("resize", handleViewportResize);
        window.addEventListener("focus", handleViewportResize);
        triggerInitialResizePass();
        void document.fonts?.ready?.then(() => scheduleResize(true));

        cleanup = () => {
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
          host.removeEventListener("click", focusTerminal);
          host.removeEventListener("mouseup", handleMouseUp);
          host.removeEventListener("focusin", focusTerminal);
          shellSurface?.removeEventListener("transitionend", handleDrawerTransitionEnd);
          document.removeEventListener("copy", handleCopy, true);
          window.removeEventListener("resize", handleViewportResize);
          window.visualViewport?.removeEventListener("resize", handleViewportResize);
          window.removeEventListener("focus", handleViewportResize);
          socket.close();
          if (outputBuffer) {
            terminal.write(outputBuffer);
          }
          osc52Disposable.dispose();
          terminal.dispose();
        };

        if (disposed) {
          cleanup();
          cleanup = null;
        }
      } catch (error) {
        if (disposed) {
          return;
        }

        setTerminalConnectionState("disconnected");
        setTerminalStatusMessage(
          error instanceof Error ? error.message : "Unable to load the terminal client.",
        );
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [reconnectGeneration, sessionName, terminalBranch, terminalSurfaceMode, worktree?.id]);

  const handleDisconnectClient = async (clientId: string) => {
    if (!terminalBranch || clientId === currentClientId) {
      return;
    }

    setDisconnectingClientId(clientId);
    try {
      await disconnectTmuxClient(terminalBranch, clientId);
      setTmuxClients((current) => current.filter((client) => client.id !== clientId));
    } finally {
      setDisconnectingClientId(null);
    }
  };

  return (
    <>
      {showSessionInfo ? (
      <section className="matrix-panel min-w-0 overflow-hidden rounded-none">
        <div className="theme-divider border-b px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="matrix-kicker">{WORKTREE_ENVIRONMENT_KICKER}</p>
              <h2 className="theme-text-strong text-xl font-semibold sm:text-2xl">
                {ENVIRONMENT_SESSION_INFO_TITLE}
              </h2>
              <p className="theme-text-muted mt-1 text-sm">
                  {worktree
                    ? `tmux session ${sessionName} is docked as a fixed terminal overlay`
                    : "Select a worktree to attach to its tmux session."}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
                <MatrixBadge tone={connectionBadgeTone}>{connectionBadgeLabel}</MatrixBadge>
                <button
                  type="button"
                  className="matrix-button rounded-none px-4 py-2 text-sm"
                  onClick={() => onTerminalVisibilityChange(!isTerminalVisible)}
                    disabled={!worktree}
                >
                {isTerminalVisible ? "Stow terminal" : "Show terminal"}
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-4 py-2 text-sm"
                onClick={() => void handleReconnectTerminal()}
                disabled={!worktree || reconnectingTerminal || restartingRuntime}
              >
                {reconnectingTerminal ? "Reconnecting…" : "Reconnect shell"}
              </button>
              <button
                type="button"
                className="matrix-button rounded-none px-4 py-2 text-sm"
                onClick={() => void handleRestartRuntime()}
                disabled={!worktree || restartingRuntime || reconnectingTerminal}
              >
                {restartingRuntime ? "Restarting…" : "Restart environment"}
              </button>
            </div>
          </div>

          {terminalStatusMessage ? (
            <div className="theme-inline-panel theme-text-muted mt-4 px-4 py-3 text-sm" data-terminal-status-message>
              <p className="theme-text-strong">Terminal status</p>
              <p className="mt-1">{terminalStatusMessage}</p>
            </div>
          ) : null}

          <div className="mt-4 grid gap-3 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {visibleEnvEntries.map(([key, value]) => (
                <div
                  key={key}
                  className="matrix-command theme-text-muted rounded-none px-3 py-2 font-mono text-xs"
                >
                  <span className="theme-text-strong">{key}</span>=
                  <span className="theme-text-accent break-all">{value}</span>
                </div>
              ))}
              {!visibleEnvEntries.length ? (
                <div className="matrix-command theme-empty-note rounded-none px-3 py-3 text-xs sm:col-span-2 xl:col-span-4">
                  Runtime env will appear here after you start the selected worktree environment.
                </div>
              ) : null}
            </div>

            <div className="theme-inline-panel theme-text-muted px-4 py-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <p className="theme-text-soft font-semibold uppercase tracking-[0.18em]">
                  Attached tmux clients
                </p>
                <span className="theme-chip-muted">{tmuxClients.length}</span>
              </div>
              <div className="mt-3 space-y-2">
                {tmuxClients.length ? (
                  tmuxClients.map((client) => {
                    const isCurrent = client.id === currentClientId;

                    return (
                      <div
                        key={client.id}
                        className="theme-inline-panel px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="min-w-0">
                            <p className="theme-text truncate font-mono">
                              {client.tty}
                            </p>
                            <p className="theme-text-soft text-[11px]">
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
