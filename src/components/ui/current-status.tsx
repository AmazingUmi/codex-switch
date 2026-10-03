export function CurrentStatus({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      title={label}
      className="relative flex h-7 w-7 shrink-0 items-center justify-center"
    >
      <span
        aria-hidden="true"
        className="current-status-wave pointer-events-none absolute h-[26px] w-[26px] rounded-full border border-emerald-500 dark:border-emerald-400"
      />
      <span
        aria-hidden="true"
        className="current-status-dot pointer-events-none relative h-2 w-2 rounded-full bg-emerald-500/85 dark:bg-emerald-400/85"
      />
    </span>
  );
}
