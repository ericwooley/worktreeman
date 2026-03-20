import { useEffect, useMemo, useRef, useState } from "react";
import { MatrixBadge } from "./matrix-primitives";

export interface MatrixDropdownOption {
  value: string;
  label: string;
  description?: string;
  badgeLabel?: string;
  badgeTone?: "active" | "idle";
}

interface MatrixDropdownProps {
  label: string;
  value: string | null;
  options: MatrixDropdownOption[];
  placeholder: string;
  disabled?: boolean;
  emptyLabel?: string;
  onChange: (value: string) => void;
}

export function MatrixDropdown({
  label,
  value,
  options,
  placeholder,
  disabled = false,
  emptyLabel = "No options",
  onChange,
}: MatrixDropdownProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedOption = useMemo(
    () => options.find((option) => option.value === value) ?? null,
    [options, value],
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${open ? "z-[80]" : "z-10"}`}>
      <button
        type="button"
        className="theme-border-subtle theme-dropdown-trigger flex h-full min-h-[100%] w-full items-center justify-between gap-3 border px-3 py-2 text-left transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <div className="min-w-0">
          <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">{label}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="theme-text-strong truncate font-mono text-sm">
              {selectedOption?.label ?? placeholder}
            </span>
            {selectedOption?.badgeLabel ? <MatrixBadge tone={selectedOption.badgeTone ?? "idle"} compact>{selectedOption.badgeLabel}</MatrixBadge> : null}
          </div>
        </div>
        <span className={`theme-text-accent-soft font-mono text-sm transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          v
        </span>
      </button>

      {open ? (
        <div
          className="theme-border theme-dropdown-menu absolute left-0 right-0 z-[90] mt-2 max-h-[18rem] overflow-auto border backdrop-blur-md"
          role="listbox"
          aria-label={`${label} selector`}
        >
          {options.length ? options.map((option) => {
            const isSelected = option.value === value;

            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full items-center justify-between gap-3 border-b px-3 py-2 text-left transition-colors duration-150 last:border-b-0 ${isSelected
                  ? "theme-border-subtle theme-row-active theme-text-strong"
                  : "theme-border-faint theme-row-idle theme-text theme-hover-text-strong"}`}
                role="option"
                aria-selected={isSelected}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <div className="min-w-0">
                  <p className="truncate font-mono text-sm">{option.label}</p>
                  {option.description ? (
                    <p className="theme-text-soft mt-1 truncate text-[10px] uppercase tracking-[0.16em]">
                      {option.description}
                    </p>
                  ) : null}
                </div>
                {option.badgeLabel ? <MatrixBadge tone={option.badgeTone ?? "idle"}>{option.badgeLabel}</MatrixBadge> : null}
              </button>
            );
          }) : (
            <div className="theme-text-muted px-3 py-3 text-sm">{emptyLabel}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
