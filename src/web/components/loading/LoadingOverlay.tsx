import { MatrixSpinner } from "../matrix-primitives";

/**
 * Full-area translucent overlay with centered MatrixSpinner and accessible label.
 * Renders inline within a relatively-positioned container.
 *
 * The host element should have `position: relative` — use the `matrix-card-loading`
 * CSS class on the card wrapper to get that plus pointer-events: none.
 *
 * @example
 * <div className={`p-3 ${isLoading ? "matrix-card-loading" : ""}`}>
 *   <LoadingOverlay visible={isLoading} label="Loading document…" />
 *   {children}
 * </div>
 */
export function LoadingOverlay({
  visible,
  label = "Loading…",
  ariaLive = "polite",
}: {
  visible: boolean;
  label?: string;
  ariaLive?: "polite" | "assertive";
}) {
  if (!visible) {
    return null;
  }

  return (
    <>
      {/* Accessible live region announces loading start to screen readers */}
      <span
        role="status"
        aria-live={ariaLive}
        aria-atomic="true"
        className="sr-only"
      >
        {label}
      </span>
      {/* Visual overlay — positioned by .matrix-card-loading on the parent */}
      <div
        className="loading-overlay"
        aria-hidden="true"
      >
        <MatrixSpinner label={label} />
      </div>
    </>
  );
}
