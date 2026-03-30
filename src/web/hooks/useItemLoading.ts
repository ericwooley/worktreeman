import { useState } from "react";

/**
 * Small hook for per-item loading state by id.
 * Avoids duplicated ad-hoc boolean flags in list components.
 *
 * Usage:
 *   const { loadingId, startLoading, stopLoading } = useItemLoading();
 *   <button disabled={loadingId === item.id} onClick={() => { startLoading(item.id); doWork().finally(stopLoading); }}>
 */
export function useItemLoading() {
  const [loadingId, setLoadingId] = useState<string | null>(null);

  function startLoading(id: string) {
    setLoadingId(id);
  }

  function stopLoading() {
    setLoadingId(null);
  }

  return { loadingId, startLoading, stopLoading };
}
