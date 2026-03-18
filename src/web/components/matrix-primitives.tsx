import type { ReactNode } from "react";

export type MatrixBadgeTone = "active" | "idle" | "warning" | "danger" | "neutral";

export function getMatrixBadgeClass(tone: MatrixBadgeTone, compact = false): string {
  const sizeClass = compact
    ? "px-1.5 py-0.5 text-[10px] tracking-[0.14em]"
    : "px-2 py-0.5 text-[10px] tracking-[0.16em]";

  const toneClass = tone === "active"
    ? "border-[rgba(74,255,122,0.16)] bg-[rgba(7,24,10,0.76)] text-[#7fe19e]"
    : tone === "warning"
      ? "border-[rgba(255,207,118,0.22)] bg-[rgba(38,27,5,0.4)] text-[#ffd892]"
      : tone === "danger"
        ? "border-[rgba(255,109,109,0.22)] bg-[rgba(33,8,8,0.42)] text-[#ffb4b4]"
        : tone === "neutral"
          ? "border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.28)] text-[#b9ffb9]"
          : "border-[rgba(74,255,122,0.1)] bg-[rgba(0,0,0,0.2)] text-[#75bb75]";

  return `border uppercase ${sizeClass} ${toneClass}`;
}

export function MatrixBadge({
  children,
  tone = "neutral",
  compact = false,
}: {
  children: ReactNode;
  tone?: MatrixBadgeTone;
  compact?: boolean;
}) {
  return <span className={getMatrixBadgeClass(tone, compact)}>{children}</span>;
}

export function MatrixTabButton({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`px-4 py-2 text-sm uppercase tracking-[0.18em] transition-colors ${active
        ? "border border-[rgba(74,255,122,0.2)] bg-[rgba(9,30,12,0.72)] text-[#ecffec]"
        : "border border-transparent bg-[rgba(0,0,0,0.18)] text-[#75bb75] hover:border-[rgba(74,255,122,0.12)] hover:text-[#b9ffb9]"}`}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

export function MatrixDetailField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="matrix-command rounded-none px-4 py-3">
      <p className="text-xs uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className={`mt-2 break-all text-sm text-[#ecffec] ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

export function MatrixMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="border border-[rgba(74,255,122,0.12)] bg-[rgba(0,0,0,0.18)] px-3 py-2">
      <p className="text-[0.6rem] uppercase tracking-[0.18em] text-[#6cb96c]">{label}</p>
      <p className="mt-1 text-base font-semibold text-[#ecffec]">{value}</p>
    </div>
  );
}

export function MatrixModal({
  kicker,
  title,
  description,
  tone = "neutral",
  closeLabel = "Close",
  onClose,
  children,
  footer,
  maxWidthClass = "max-w-2xl",
}: {
  kicker: string;
  title: ReactNode;
  description?: ReactNode;
  tone?: Exclude<MatrixBadgeTone, "active" | "idle"> | "neutral";
  closeLabel?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  maxWidthClass?: string;
}) {
  const panelTone = tone === "danger"
    ? "border-[rgba(255,109,109,0.22)] bg-[rgba(17,6,6,0.96)]"
    : "border-[rgba(74,255,122,0.18)] bg-[rgba(2,7,3,0.96)]";
  const kickerTone = tone === "danger" ? "text-[#ff9f9f]" : "";
  const titleTone = tone === "danger" ? "text-[#ffe3e3]" : "text-[#ecffec]";
  const descriptionTone = tone === "danger" ? "text-[#ffb4b4]" : "text-[#9cd99c]";

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[rgba(1,7,3,0.82)] p-4 backdrop-blur-sm">
      <div className={`matrix-panel w-full ${maxWidthClass} border ${panelTone} p-4 sm:p-5`}>
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={`matrix-kicker ${kickerTone}`}>{kicker}</p>
            <h2 className={`mt-2 text-xl font-semibold ${titleTone}`}>{title}</h2>
            {description ? <p className={`mt-2 text-sm ${descriptionTone}`}>{description}</p> : null}
          </div>
          <button
            type="button"
            className="matrix-button rounded-none px-3 py-2 text-sm"
            onClick={onClose}
          >
            {closeLabel}
          </button>
        </div>

        <div className="mt-4">{children}</div>

        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );
}
