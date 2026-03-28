import type { ReactNode } from "react";

function getClampClass(lines: 1 | 2 | 3 | 4) {
  return `matrix-card-clamp-${lines}`;
}

interface MatrixCardProps {
  children: ReactNode;
  selected?: boolean;
  interactive?: boolean;
  className?: string;
  as?: "article" | "div";
}

export function MatrixCard({
  children,
  selected = false,
  interactive = false,
  className = "",
  as = "article",
}: MatrixCardProps) {
  const Component = as;

  return (
    <Component
      className={[
        "matrix-card",
        selected ? "matrix-card-selected" : "",
        interactive ? "matrix-card-interactive" : "",
        className,
      ].filter(Boolean).join(" ")}
    >
      {children}
    </Component>
  );
}

export function MatrixCardTitle({
  children,
  lines = 2,
  className = "",
  title,
}: {
  children: ReactNode;
  lines?: 1 | 2 | 3 | 4;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={[
        "matrix-card-title theme-text-strong",
        getClampClass(lines),
        className,
      ].filter(Boolean).join(" ")}
      title={title}
    >
      {children}
    </div>
  );
}

export function MatrixCardDescription({
  children,
  lines = 2,
  className = "",
  title,
}: {
  children: ReactNode;
  lines?: 1 | 2 | 3 | 4;
  className?: string;
  title?: string;
}) {
  return (
    <div
      className={[
        "matrix-card-description theme-text-muted",
        getClampClass(lines),
        className,
      ].filter(Boolean).join(" ")}
      title={title}
    >
      {children}
    </div>
  );
}

export function MatrixCardFooter({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={["matrix-card-footer", className].filter(Boolean).join(" ")}>{children}</div>;
}
