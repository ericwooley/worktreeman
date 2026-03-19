import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MatrixBadge, type MatrixBadgeTone } from "./matrix-primitives";

export const DEFAULT_COMMAND_PALETTE_SHORTCUT = "Ctrl+Shift+P";

export interface CommandPaletteItem {
  id: string;
  code: string;
  title: string;
  subtitle?: string;
  group?: string;
  keywords?: string[];
  badgeLabel?: string;
  badgeTone?: MatrixBadgeTone;
  disabled?: boolean;
  closeOnSelect?: boolean;
  action: () => void;
}

export interface CommandPaletteShortcutSetting {
  id: string;
  label: string;
  shortcut: string;
  defaultShortcut: string;
  onChange: (shortcut: string) => void;
  onReset: () => void;
}

export function normalizeShortcutKey(key: string): string | null {
  if (key === " ") {
    return "Space";
  }

  if (["Shift", "Control", "Alt", "Meta"].includes(key)) {
    return null;
  }

  if (key.length === 1) {
    return key.toUpperCase();
  }

  const aliases: Record<string, string> = {
    Escape: "Escape",
    Esc: "Escape",
    Enter: "Enter",
    Return: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    ArrowUp: "ArrowUp",
    ArrowDown: "ArrowDown",
    ArrowLeft: "ArrowLeft",
    ArrowRight: "ArrowRight",
  };

  return aliases[key] ?? key;
}

export function shortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = normalizeShortcutKey(event.key);
  if (!key) {
    return null;
  }

  const parts = [
    event.ctrlKey ? "Ctrl" : null,
    event.altKey ? "Alt" : null,
    event.shiftKey ? "Shift" : null,
    event.metaKey ? "Meta" : null,
    key,
  ].filter(Boolean);

  return parts.join("+");
}

export function formatShortcutLabel(shortcut: string): string {
  return shortcut.replace(/Meta/g, "Cmd").replace(/Arrow/g, "");
}

function getFuzzyScore(query: string, candidate: string): number | null {
  if (!query) {
    return 0;
  }

  const needle = query.toLowerCase();
  const haystack = candidate.toLowerCase();
  let needleIndex = 0;
  let score = 0;
  let consecutive = 0;
  let firstMatchIndex = -1;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] === needle[needleIndex]) {
      if (firstMatchIndex === -1) {
        firstMatchIndex = index;
      }
      score += 5 + consecutive * 2;
      consecutive += 1;
      needleIndex += 1;
    } else {
      consecutive = 0;
    }
  }

  if (needleIndex !== needle.length) {
    return null;
  }

  return score - Math.max(firstMatchIndex, 0) * 0.05 - (haystack.length - needle.length) * 0.01;
}

function getQuickSelectKey(index: number): string | null {
  if (index < 0 || index > 9) {
    return null;
  }

  return index === 9 ? "0" : String(index + 1);
}

export function CommandPalette({
  open,
  commands,
  shortcut,
  onClose,
  onShortcutChange,
  onShortcutReset,
  title = "Command palette",
  placeholder = "Type a command or worktree name, or :code",
  emptyState = "No commands match the current search.",
  fuzzyModeLabel = "Fuzzy mode: search commands by name",
  codeModeLabel = "Code mode: exact command codes",
  codeModeHint = "Prefix with `:`",
  autoExecuteExactCode = true,
  scopeKey = "default",
  shortcutSettings,
}: {
  open: boolean;
  commands: CommandPaletteItem[];
  shortcut: string;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  onShortcutChange: (shortcut: string) => void;
  onShortcutReset: () => void;
  title?: string;
  placeholder?: string;
  emptyState?: string;
  fuzzyModeLabel?: string;
  codeModeLabel?: string;
  codeModeHint?: string;
  autoExecuteExactCode?: boolean;
  scopeKey?: string;
  shortcutSettings: CommandPaletteShortcutSetting[];
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recordingShortcutId, setRecordingShortcutId] = useState<string | null>(null);
  const isCodeMode = query.startsWith(":");
  const codeQuery = isCodeMode ? query.slice(1).trim().toLowerCase() : "";

  const exactCodeMatch = useMemo(
    () => isCodeMode && codeQuery
      ? commands.find((command) => command.code.toLowerCase() === codeQuery) ?? null
      : null,
    [codeQuery, commands, isCodeMode],
  );

  const codeMatchedCommands = useMemo(
    () => isCodeMode
      ? commands.filter((command) => command.code.toLowerCase().startsWith(codeQuery))
      : [],
    [codeQuery, commands, isCodeMode],
  );

  const filteredCommands = useMemo(() => {
    if (isCodeMode) {
      return codeMatchedCommands;
    }

    return commands
      .map((command) => {
        const candidate = [command.title, command.subtitle, command.group, ...(command.keywords ?? [])]
          .filter(Boolean)
          .join(" ");
        const score = getFuzzyScore(query, candidate);
        return score === null ? null : { command, score };
      })
      .filter((entry): entry is { command: CommandPaletteItem; score: number } => entry !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.command);
  }, [codeMatchedCommands, commands, isCodeMode, query]);

  const focusInput = () => {
    const input = inputRef.current;
    if (!input) {
      return;
    }

    input.focus();
    input.select();
  };

  useEffect(() => {
    if (!open) {
      setQuery("");
      setActiveIndex(0);
      setRecordingShortcutId(null);
      return;
    }

    const frame = window.requestAnimationFrame(focusInput);
    const timeout = window.setTimeout(focusInput, 30);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    if (!open || !autoExecuteExactCode || !isCodeMode || !exactCodeMatch || exactCodeMatch.disabled) {
      return;
    }

    if (exactCodeMatch.closeOnSelect !== false) {
      onClose();
    }
    exactCodeMatch.action();
  }, [autoExecuteExactCode, exactCodeMatch, isCodeMode, onClose, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (recordingShortcutId) {
        if (event.key === "Escape") {
          event.preventDefault();
          setRecordingShortcutId(null);
          return;
        }

        const nextShortcut = shortcutFromKeyboardEvent(event);
        if (!nextShortcut) {
          return;
        }

        event.preventDefault();
        shortcutSettings.find((setting) => setting.id === recordingShortcutId)?.onChange(nextShortcut);
        setRecordingShortcutId(null);
        return;
      }

      const pressedShortcut = shortcutFromKeyboardEvent(event);
      if (pressedShortcut && pressedShortcut === shortcut) {
        event.preventDefault();
        event.stopPropagation();
        onClose({ restoreFocus: true });
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onClose({ restoreFocus: true });
        return;
      }

      if (!filteredCommands.length) {
        return;
      }

      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((current) => (current + 1) % filteredCommands.length);
        return;
      }

      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (current - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }

      if (event.key === "Enter") {
        const command = filteredCommands[activeIndex];
        if (!command || command.disabled) {
          return;
        }

        event.preventDefault();
        if (command.closeOnSelect !== false) {
          onClose();
        }
        command.action();
        return;
      }

      if (!isCodeMode && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && /^[0-9]$/.test(event.key)) {
        const quickIndex = event.key === "0" ? 9 : Number(event.key) - 1;
        const command = filteredCommands[quickIndex];
        if (!command || command.disabled) {
          return;
        }

        event.preventDefault();
        if (command.closeOnSelect !== false) {
          onClose();
        }
        command.action();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, filteredCommands, isCodeMode, onClose, open, recordingShortcutId, shortcut, shortcutSettings]);

  useEffect(() => {
    if (!open) {
      return;
    }

    setQuery("");
    setActiveIndex(0);
    setRecordingShortcutId(null);

    const frame = window.requestAnimationFrame(focusInput);
    const timeout = window.setTimeout(focusInput, 30);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [open, scopeKey]);

  if (!open) {
    return null;
  }

  const palette = (
    <div className="fixed inset-0 z-50 bg-[rgba(1,7,3,0.82)] p-4 backdrop-blur-sm" onClick={() => onClose({ restoreFocus: true })}>
      <div
        className="mx-auto mt-[8vh] w-full max-w-3xl border border-[rgba(74,255,122,0.18)] bg-[rgba(2,7,3,0.98)] shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="border-b border-[rgba(74,255,122,0.12)] px-4 py-4 sm:px-5">
          <p className="matrix-kicker">{title}</p>
          <div className="mt-3 border border-[rgba(74,255,122,0.16)] bg-[rgba(0,0,0,0.28)]">
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={placeholder}
              className="h-12 w-full bg-transparent px-4 font-mono text-sm text-[#ecffec] outline-none placeholder:text-[#6cb96c]"
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-3 text-xs text-[#8fd18f]">
            <span>{isCodeMode ? codeModeLabel : fuzzyModeLabel}</span>
            {isCodeMode ? <span className="font-mono text-[#ecffec]">{codeModeHint}</span> : null}
          </div>
        </div>

        <div className="max-h-[50vh] overflow-auto">
          {filteredCommands.length ? filteredCommands.map((command, index) => {
            const active = index === activeIndex;
            const quickSelectKey = !isCodeMode ? getQuickSelectKey(index) : null;

            return (
              <button
                key={command.id}
                type="button"
                className={`flex w-full items-start justify-between gap-3 border-b px-4 py-3 text-left transition-colors last:border-b-0 ${active
                  ? "border-[rgba(74,255,122,0.16)] bg-[rgba(9,30,12,0.72)]"
                  : "border-[rgba(74,255,122,0.08)] bg-transparent hover:bg-[rgba(9,30,12,0.54)]"} ${command.disabled ? "opacity-60" : ""}`}
                disabled={command.disabled}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => {
                  if (command.disabled) {
                    return;
                  }

                  if (command.closeOnSelect !== false) {
                    onClose();
                  }
                  command.action();
                }}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {quickSelectKey ? (
                        <span className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.22)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#ffd892]">
                          {quickSelectKey}
                        </span>
                      ) : null}
                      <p className="font-mono text-sm text-[#ecffec]">{command.title}</p>
                      {command.group ? <span className="text-[10px] uppercase tracking-[0.18em] text-[#6cb96c]">{command.group}</span> : null}
                      <span className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.22)] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#7fe19e]">
                      :{command.code}
                    </span>
                  </div>
                  {command.subtitle ? <p className="mt-1 text-sm text-[#9cd99c]">{command.subtitle}</p> : null}
                </div>
                {command.badgeLabel ? (
                  <MatrixBadge tone={command.badgeTone ?? "neutral"}>{command.badgeLabel}</MatrixBadge>
                ) : null}
              </button>
            );
          }) : (
            <div className="px-4 py-6 text-sm text-[#8fd18f]">{emptyState}</div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-[rgba(74,255,122,0.12)] px-4 py-3 text-sm text-[#9cd99c] sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="grid flex-1 gap-3 sm:grid-cols-2">
            {shortcutSettings.map((setting) => {
              const isRecording = recordingShortcutId === setting.id;

              return (
                <div key={setting.id} className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.18)] px-3 py-3">
                  <p className="text-[0.65rem] uppercase tracking-[0.18em] text-[#6cb96c]">{setting.label}</p>
                  <p className="mt-1 font-mono text-[#ecffec]">
                    {isRecording ? "Press a new shortcut..." : formatShortcutLabel(setting.shortcut)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      onClick={() => setRecordingShortcutId(setting.id)}
                    >
                      Change shortcut
                    </button>
                    <button
                      type="button"
                      className="matrix-button rounded-none px-3 py-2 text-sm"
                      onClick={setting.onReset}
                    >
                      Reset to {formatShortcutLabel(setting.defaultShortcut)}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );

  return typeof document !== "undefined" ? createPortal(palette, document.body) : palette;
}
