/** Shared relative-time labels for query results. Timestamps use milliseconds. */
export function formatRelativeTime(
  timestamp: number,
  now: number,
  t: (key: string, options?: { count?: number }) => string,
): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 60) return t("usage.justNow");
  if (seconds < 3600)
    return t("usage.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86400)
    return t("usage.hoursAgo", { count: Math.floor(seconds / 3600) });
  return t("usage.daysAgo", { count: Math.floor(seconds / 86400) });
}
