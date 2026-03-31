import { MatrixBadge } from "./matrix-primitives";
import type { PwaInstallStatus } from "../lib/pwa";

export function PwaInstallCard({
  status,
  onInstall,
}: {
  status: PwaInstallStatus;
  onInstall: () => void;
}) {
  const statusTone = status === "installed"
    ? "active"
    : status === "available"
      ? "active"
      : "warning";
  const statusLabel = status === "installed"
    ? "Installed"
    : status === "available"
      ? "Ready"
      : status === "installing"
        ? "Prompt open"
        : "Waiting";

  return (
    <section className="border theme-inline-panel p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="theme-text-soft text-[0.6rem] uppercase tracking-[0.18em]">Install app</p>
            <MatrixBadge tone={statusTone} compact>{statusLabel}</MatrixBadge>
          </div>
          <p className="mt-2 text-sm theme-text-strong">Install worktreeman as a desktop app.</p>
          <p className="mt-1 text-xs leading-5 theme-text-muted">
            {status === "installed"
              ? "worktreeman is already installed and can launch from your app launcher or dock."
              : status === "available"
                ? "Your browser says this workspace is ready to install. Open the install prompt now."
                : status === "installing"
                  ? "Finish the browser install prompt to pin worktreeman like a native app."
                  : "The install prompt will appear here once the browser marks this app as ready. If it does not, use your browser install menu."}
          </p>
        </div>

        {status === "installed" ? null : (
          <button
            type="button"
            className="matrix-button h-11 rounded-none px-3 text-sm font-semibold"
            onClick={onInstall}
            disabled={status !== "available"}
          >
            {status === "available" ? "Install app" : status === "installing" ? "Check browser" : "Waiting for prompt"}
          </button>
        )}
      </div>
    </section>
  );
}
