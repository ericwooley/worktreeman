export function formatAutoRefreshStatus(value: string | null | undefined, now = Date.now()): string {
  if (!value) {
    return "Waiting for automatic updates";
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return `Updated ${value}`;
  }

  const elapsedSeconds = Math.max(0, Math.floor((now - parsed) / 1000));
  if (elapsedSeconds < 5) {
    return "Updated just now";
  }

  if (elapsedSeconds < 60) {
    return `Updated ${elapsedSeconds}s ago`;
  }

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) {
    return `Updated ${elapsedMinutes}m ago`;
  }

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `Updated ${elapsedHours}h ago`;
  }

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays < 7) {
    return `Updated ${elapsedDays}d ago`;
  }

  return `Updated ${new Date(parsed).toLocaleString()}`;
}
