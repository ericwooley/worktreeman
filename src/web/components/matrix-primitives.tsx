import type { ReactNode } from "react";

export type MatrixBadgeTone = "active" | "idle" | "warning" | "danger" | "neutral";

export function getMatrixBadgeClass(tone: MatrixBadgeTone, compact = false): string {
  const sizeClass = compact
    ? "px-1.5 py-0.5 text-[10px] tracking-[0.14em]"
    : "px-2 py-0.5 text-[10px] tracking-[0.16em]";

  const toneClass = tone === "active"
    ? "theme-badge-active"
    : tone === "warning"
      ? "theme-badge-warning"
      : tone === "danger"
        ? "theme-badge-danger"
        : tone === "neutral"
          ? "theme-badge-neutral"
          : "theme-badge-idle";

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
        ? "border theme-tab-active"
        : "border border-transparent theme-tab-idle"}`}
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
      <p className="theme-text-soft text-xs uppercase tracking-[0.18em]">{label}</p>
      <p className={`theme-text-strong mt-2 break-all text-sm ${mono ? "font-mono" : ""}`}>{value}</p>
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
    <div className="theme-border-subtle theme-surface-soft border px-3 py-2">
      <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">{label}</p>
      <p className="theme-text-strong mt-1 text-base font-semibold">{value}</p>
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
    ? "theme-border-danger theme-danger-surface"
    : "theme-border theme-panel-overlay";
  const kickerTone = tone === "danger" ? "theme-text-danger" : "";
  const titleTone = tone === "danger" ? "theme-text-strong" : "theme-text-strong";
  const descriptionTone = tone === "danger" ? "theme-text-danger" : "theme-text-muted";

  return (
    <div className="theme-overlay fixed inset-0 z-40 flex items-center justify-center p-4 backdrop-blur-sm">
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
