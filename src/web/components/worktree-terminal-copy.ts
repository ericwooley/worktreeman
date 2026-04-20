export function getTerminalCopyDecision({
  hasTerminalFocus,
  terminalSelection,
  domSelection,
}: {
  hasTerminalFocus: boolean;
  terminalSelection: string;
  domSelection: string;
}) {
  if (!terminalSelection) {
    return { shouldHandle: false, reason: "no-terminal-selection" } as const;
  }

  if (hasTerminalFocus) {
    return { shouldHandle: true, reason: "terminal-focused" } as const;
  }

  if (!domSelection || domSelection === terminalSelection) {
    return { shouldHandle: true, reason: "terminal-selection-matches-dom" } as const;
  }

  return { shouldHandle: false, reason: "dom-selection-mismatch" } as const;
}

export function shouldHandleTerminalCopy(options: {
  hasTerminalFocus: boolean;
  terminalSelection: string;
  domSelection: string;
}) {
  return getTerminalCopyDecision(options).shouldHandle;
}

export function logTerminalCopyEvent(event: string, details: Record<string, unknown> = {}) {
  if (typeof console === "undefined" || typeof console.info !== "function") {
    return;
  }

  console.info("[terminal-copy]", event, details);
}

function copyWithExecCommand(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") {
    return false;
  }

  const activeElement = document.activeElement && typeof (document.activeElement as { focus?: unknown }).focus === "function"
    ? document.activeElement as { focus: () => void }
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();

  try {
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    activeElement?.focus();
  }
}

export async function writeTerminalTextToClipboard(text: string): Promise<"async-clipboard" | "exec-command"> {
  const asyncClipboard = navigator.clipboard?.writeText;
  if (asyncClipboard) {
    try {
      await asyncClipboard.call(navigator.clipboard, text);
      return "async-clipboard";
    } catch {
      if (copyWithExecCommand(text)) {
        return "exec-command";
      }

      throw new Error("Clipboard write failed via async clipboard and execCommand fallback.");
    }
  }

  if (copyWithExecCommand(text)) {
    return "exec-command";
  }

  throw new Error("Clipboard write is unavailable in this browser context.");
}
