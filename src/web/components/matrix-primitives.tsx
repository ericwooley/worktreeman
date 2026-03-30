import { useEffect, useId, useState, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

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

export function MatrixAccordion({
  summary,
  children,
  defaultOpen = false,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <details
      className="matrix-accordion"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="matrix-accordion-summary">
        <span className="min-w-0 flex-1">{summary}</span>
        <span className="matrix-accordion-indicator" aria-hidden="true">+</span>
      </summary>
      {open ? <div className="matrix-accordion-content">{children}</div> : null}
    </details>
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
  closeLabel = "Close dialog",
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
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      onClose();
    }
  }

  const content = (
    <div
      className="theme-overlay fixed inset-0 z-40 flex items-center justify-center p-4 backdrop-blur-sm"
      onClick={handleBackdropClick}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        className={`matrix-panel w-full ${maxWidthClass} border ${panelTone} p-4 sm:p-5`}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className={`matrix-kicker ${kickerTone}`}>{kicker}</p>
            <h2 id={titleId} className={`mt-2 text-xl font-semibold ${titleTone}`}>{title}</h2>
            {description ? <p id={descriptionId} className={`mt-2 text-sm ${descriptionTone}`}>{description}</p> : null}
          </div>
          <button
            type="button"
            className="matrix-button flex h-10 w-10 items-center justify-center rounded-none p-0 text-lg leading-none"
            onClick={onClose}
            aria-label={closeLabel}
          >
            <span aria-hidden="true">x</span>
          </button>
        </div>

        <div className="mt-4">{children}</div>

        {footer ? <div className="mt-4 flex justify-end gap-2">{footer}</div> : null}
      </div>
    </div>
  );

  if (typeof document === "undefined") {
    return content;
  }

  return createPortal(content, document.body);
}

/**
 * A shimmer placeholder line for skeleton loading states.
 * Use multiple stacked instances to suggest card content.
 */
export function MatrixSkeleton({
  className = "",
  heightClass = "h-3",
  widthClass = "w-full",
}: {
  className?: string;
  heightClass?: string;
  widthClass?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={`matrix-skeleton ${heightClass} ${widthClass} ${className}`}
    />
  );
}

/**
 * Composable skeleton card that mimics a MatrixCard with a header and footer.
 * Renders shimmer lines for title, description and a bottom metadata row.
 */
export function MatrixSkeletonCard({ className = "" }: { className?: string }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading…"
      className={`border theme-border-subtle p-3 space-y-3 ${className}`}
    >
      {/* eyebrow */}
      <MatrixSkeleton heightClass="h-2" widthClass="w-20" />
      {/* title */}
      <MatrixSkeleton heightClass="h-3" widthClass="w-3/4" />
      {/* description line 1 */}
      <MatrixSkeleton heightClass="h-2.5" widthClass="w-full" />
      {/* description line 2 */}
      <MatrixSkeleton heightClass="h-2.5" widthClass="w-5/6" />
      {/* footer */}
      <div className="flex items-center justify-between gap-3 pt-1">
        <MatrixSkeleton heightClass="h-2" widthClass="w-24" />
        <MatrixSkeleton heightClass="h-2" widthClass="w-16" />
      </div>
    </div>
  );
}

/**
 * A small inline spinner that inherits the existing pm-ai-spin animation.
 * Pair with a screen-reader label via aria-label on the wrapping element.
 */
export function MatrixSpinner({ label = "Loading…", className = "" }: { label?: string; className?: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className={`inline-flex items-center gap-2 text-xs theme-text-muted ${className}`}
    >
      <span className="matrix-spinner-sm" aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
