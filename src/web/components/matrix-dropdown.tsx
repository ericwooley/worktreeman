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
        className="flex h-full min-h-[100%] w-full items-center justify-between gap-3 border border-[rgba(74,255,122,0.12)] bg-[linear-gradient(180deg,rgba(8,28,12,0.9),rgba(0,0,0,0.72))] px-3 py-2 text-left shadow-[inset_0_1px_0_rgba(181,255,196,0.04)] transition-colors duration-150 hover:border-[rgba(74,255,122,0.32)] hover:bg-[linear-gradient(180deg,rgba(10,34,14,0.94),rgba(1,10,3,0.82))] disabled:cursor-not-allowed disabled:opacity-60"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <div className="min-w-0">
          <p className="text-[0.6rem] uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
          <div className="mt-1 flex items-center gap-2">
            <span className="truncate font-mono text-sm text-[#ecffec]">
              {selectedOption?.label ?? placeholder}
            </span>
            {selectedOption?.badgeLabel ? <MatrixBadge tone={selectedOption.badgeTone ?? "idle"} compact>{selectedOption.badgeLabel}</MatrixBadge> : null}
          </div>
        </div>
        <span className={`font-mono text-sm text-[#7fe19e] transition-transform duration-150 ${open ? "rotate-180" : ""}`}>
          v
        </span>
      </button>

      {open ? (
        <div
          className="absolute left-0 right-0 z-[90] mt-2 max-h-[18rem] overflow-auto border border-[rgba(74,255,122,0.18)] bg-[rgba(2,10,4,0.96)] shadow-[0_18px_48px_rgba(0,0,0,0.5)] backdrop-blur-md"
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
                  ? "border-[rgba(74,255,122,0.16)] bg-[rgba(9,30,12,0.74)] text-[#ecffec]"
                  : "border-[rgba(74,255,122,0.08)] text-[#b9ffb9] hover:bg-[rgba(9,30,12,0.58)] hover:text-[#ecffec]"}`}
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
                    <p className="mt-1 truncate text-[10px] uppercase tracking-[0.16em] text-[#6cb96c]">
                      {option.description}
                    </p>
                  ) : null}
                </div>
                {option.badgeLabel ? <MatrixBadge tone={option.badgeTone ?? "idle"}>{option.badgeLabel}</MatrixBadge> : null}
              </button>
            );
          }) : (
            <div className="px-3 py-3 text-sm text-[#8fd18f]">{emptyLabel}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
