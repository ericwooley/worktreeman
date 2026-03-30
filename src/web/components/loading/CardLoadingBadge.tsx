import { MatrixBadge, MatrixSpinner } from "../matrix-primitives";

/**
 * Small inline spinner + badge for compact list / chip contexts.
 * Use inside card headers or inline with text when a per-item action is loading.
 *
 * @example
 * {isLoading ? <CardLoadingBadge label="Loading document…" /> : null}
 */
export function CardLoadingBadge({
  label = "Loading…",
  compact = true,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <MatrixSpinner label={label} className="text-[10px]" />
      <MatrixBadge tone="neutral" compact={compact}>
        {label}
      </MatrixBadge>
    </span>
  );
}
