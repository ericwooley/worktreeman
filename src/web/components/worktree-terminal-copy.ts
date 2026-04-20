export function shouldHandleTerminalCopy({
  hasTerminalFocus,
  terminalSelection,
  domSelection,
}: {
  hasTerminalFocus: boolean;
  terminalSelection: string;
  domSelection: string;
}) {
  if (!terminalSelection) {
    return false;
  }

  if (hasTerminalFocus) {
    return true;
  }

  return !domSelection || domSelection === terminalSelection;
}
