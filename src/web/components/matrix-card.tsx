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

interface MatrixCardHeaderProps {
  title: ReactNode;
  titleLines?: 1 | 2 | 3 | 4;
  titleText?: string;
  description?: ReactNode;
  descriptionLines?: 1 | 2 | 3 | 4;
  descriptionText?: string;
  eyebrow?: ReactNode;
  badges?: ReactNode;
  actions?: ReactNode;
  className?: string;
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

export function MatrixCardHeader({
  title,
  titleLines = 2,
  titleText,
  description,
  descriptionLines = 2,
  descriptionText,
  eyebrow,
  badges,
  actions,
  className = "",
}: MatrixCardHeaderProps) {
  return (
    <div className={["matrix-card-header", className].filter(Boolean).join(" ")}>
      <div className="matrix-card-header-main">
        {eyebrow ? <div className="matrix-card-eyebrow">{eyebrow}</div> : null}
        <MatrixCardTitle lines={titleLines} title={titleText}>
          {title}
        </MatrixCardTitle>
        {description ? (
          <MatrixCardDescription className="mt-2" lines={descriptionLines} title={descriptionText}>
            {description}
          </MatrixCardDescription>
        ) : null}
      </div>
      {badges || actions ? (
        <div className="matrix-card-header-side">
          {badges ? <div className="matrix-card-badge-row">{badges}</div> : null}
          {actions ? <div className="matrix-card-actions">{actions}</div> : null}
        </div>
      ) : null}
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
