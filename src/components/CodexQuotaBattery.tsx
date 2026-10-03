import React from "react";
import { useTranslation } from "react-i18next";
import { RefreshButton } from "@/components/ui/refresh-button";
import { HelpButton } from "@/components/ui/help-button";
import { QueryTimestamp } from "@/components/ui/query-timestamp";
import { QuotaBatteryTrack } from "@/components/QuotaBatteryTrack";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";
import {
  DEFAULT_QUOTA_BATTERY_THRESHOLDS,
  type QuotaBatteryThresholds,
} from "@/utils/quotaBatteryThresholds";

interface CodexQuotaBatteryProps {
  quota: SubscriptionQuota;
  tiers: QuotaTier[];
  labels: Record<string, string>;
  loading: boolean;
  refetch: () => void;
  inline?: boolean;
  showRefresh?: boolean;
  updatedLabel: string;
  refreshFailed?: boolean;
  refreshError?: string | null;
  statusLabel?: string;
  statusMessage?: string | null;
  statusTone?: "warning" | "error";
  thresholds?: QuotaBatteryThresholds;
}

// Only these dedicated names are exact matches in query_codex_api. Numeric
// names (including 30_day) may round durations and cannot supply a fallback.
const WINDOW_MILLISECONDS = new Map([
  ["five_hour", 5 * 60 * 60 * 1000],
  ["seven_day", 7 * 24 * 60 * 60 * 1000],
]);

function remainingQuota(utilization: number): number | null {
  return Number.isFinite(utilization) && utilization >= 0 && utilization <= 100
    ? 100 - utilization
    : null;
}

function windowDuration(tier: QuotaTier): number | null {
  if (tier.windowDurationSeconds != null) {
    const milliseconds = tier.windowDurationSeconds * 1000;
    return Number.isFinite(milliseconds) && milliseconds > 0
      ? milliseconds
      : null;
  }
  return WINDOW_MILLISECONDS.get(tier.name) ?? null;
}

function countdown(resetAt: number, now: number): string | null {
  if (!Number.isFinite(resetAt) || resetAt <= now) return null;
  const minutes = Math.floor((resetAt - now) / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

// Animate the visual charge once when a window first receives known quota.
// Accessible meter values always describe the actual quota, including mid-entry.
function useQuotaBatteryEntry(remaining: number | null, rowIndex: number) {
  const [animatedRemaining, setAnimatedRemaining] = React.useState<
    number | null
  >(() =>
    remaining !== null &&
    window.matchMedia?.("(prefers-reduced-motion: no-preference)").matches
      ? 100
      : null,
  );
  const hasPlayed = React.useRef(false);

  React.useLayoutEffect(() => {
    const motion = window.matchMedia?.(
      "(prefers-reduced-motion: no-preference)",
    );
    if (remaining === null) {
      setAnimatedRemaining(null);
      return;
    }
    if (hasPlayed.current || !motion?.matches || remaining === 100) {
      hasPlayed.current = true;
      setAnimatedRemaining(null);
      return;
    }

    let frame: number;
    let startedAt: number | undefined;
    const finish = () => {
      hasPlayed.current = true;
      cancelAnimationFrame(frame);
      setAnimatedRemaining(null);
    };
    const update = (timestamp: number) => {
      hasPlayed.current = true;
      startedAt ??= timestamp;
      const progress = Math.max(
        0,
        Math.min(1, (timestamp - startedAt - rowIndex * 70) / 1100),
      );
      const eased = progress * progress * (3 - 2 * progress);
      setAnimatedRemaining(
        progress === 1 ? null : 100 - (100 - remaining) * eased,
      );
      if (progress < 1) frame = requestAnimationFrame(update);
    };
    const onMotionChange = () => {
      if (!motion.matches) finish();
    };
    setAnimatedRemaining(100);
    frame = requestAnimationFrame(update);
    motion.addEventListener("change", onMotionChange);
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", onMotionChange);
    };
  }, [remaining, rowIndex]);

  return remaining === null ? null : (animatedRemaining ?? remaining);
}

function QuotaBatteryWindow({
  tier,
  rowIndex,
  labels,
  now,
  thresholds,
}: {
  tier: QuotaTier;
  rowIndex: number;
  labels: Record<string, string>;
  now: number;
  thresholds: QuotaBatteryThresholds;
}) {
  const { t } = useTranslation();
  const remainingLabel = t("codexAccounts.quotaRemainingLabel");
  const unknownLabel = t("codexAccounts.quotaUnknown");
  const remaining = remainingQuota(tier.utilization);
  const displayedRemaining = useQuotaBatteryEntry(remaining, rowIndex);
  const known = remaining !== null;
  const labelKey = Object.prototype.hasOwnProperty.call(labels, tier.name)
    ? labels[tier.name]
    : undefined;
  const label = labelKey ? t(labelKey) : tier.name;
  const value = known ? `${Math.round(remaining)}%` : "—";
  const displayedValue = known ? `${Math.round(displayedRemaining!)}%` : "—";
  const resetAt = tier.resetsAt ? Date.parse(tier.resetsAt) : NaN;
  const validReset = Number.isFinite(resetAt);
  const reset = countdown(resetAt, now);
  const duration = windowDuration(tier);
  const timeRemaining =
    validReset && duration
      ? Math.max(0, Math.min(100, ((resetAt - now) / duration) * 100))
      : null;
  const tone = !known
    ? "unknown"
    : displayedRemaining! <= thresholds.low
      ? "low"
      : displayedRemaining! <= thresholds.warning
        ? "warning"
        : "available";
  const hasUsd =
    tier.usedValueUsd != null &&
    tier.maxValueUsd != null &&
    Number.isFinite(tier.usedValueUsd) &&
    Number.isFinite(tier.maxValueUsd);

  return (
    <div
      className="codex-quota-window min-w-0"
      data-quota-tone={tone}
      data-entry-animating={displayedRemaining !== remaining}
      style={
        {
          "--codex-quota-remaining": displayedRemaining ?? 0,
        } as React.CSSProperties
      }
    >
      <div>
        <div className="mb-3 flex min-w-0 items-baseline justify-between gap-3">
          <span className="min-w-0 break-words text-xs font-medium text-muted-foreground">
            {label}
          </span>
          <span className="flex shrink-0 items-baseline gap-1.5">
            <span
              className="codex-battery-value text-[28px] font-semibold leading-none tabular-nums"
              aria-hidden="true"
            >
              {displayedValue}
            </span>
            {known && (
              <span className="text-[11px] text-muted-foreground">
                {remainingLabel}
              </span>
            )}
          </span>
        </div>
        <QuotaBatteryTrack
          charged={known && displayedRemaining! > 0}
          role={known ? "meter" : "img"}
          aria-label={known ? label : `${label}: ${unknownLabel}`}
          aria-valuemin={known ? 0 : undefined}
          aria-valuemax={known ? 100 : undefined}
          aria-valuenow={remaining ?? undefined}
          aria-valuetext={known ? `${value} ${remainingLabel}` : undefined}
        >
          {timeRemaining !== null && (
            <span
              className="codex-battery-time-marker"
              aria-hidden="true"
              data-time-remaining={timeRemaining}
              style={
                {
                  "--codex-quota-time": `${timeRemaining}%`,
                } as React.CSSProperties
              }
            />
          )}
        </QuotaBatteryTrack>
      </div>
      <div>
        <span
          className="relative mt-3 block text-[11px] leading-relaxed text-muted-foreground"
          title={validReset ? new Date(resetAt).toLocaleString() : undefined}
        >
          {reset
            ? t("subscription.resetsIn", { time: reset })
            : validReset
              ? new Date(resetAt).toLocaleString()
              : t("codexAccounts.quotaResetUnknown")}
        </span>
        {hasUsd && (
          <span className="mt-0.5 block text-[11px] tabular-nums text-muted-foreground">
            ${tier.usedValueUsd!.toFixed(2)} / ${tier.maxValueUsd!.toFixed(2)}
          </span>
        )}
      </div>
    </div>
  );
}

/** Account-card quota: charge is remaining quota, the grey marker is time. */
export function CodexQuotaBattery({
  quota,
  tiers,
  labels,
  loading,
  refetch,
  inline = false,
  showRefresh = true,
  updatedLabel,
  refreshFailed = false,
  refreshError,
  statusLabel,
  statusMessage,
  statusTone,
  thresholds = DEFAULT_QUOTA_BATTERY_THRESHOLDS,
}: CodexQuotaBatteryProps) {
  const { t } = useTranslation();
  const [now, setNow] = React.useState(Date.now);
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div
      className={`codex-quota-panel codex-quota-battery flex min-w-0 flex-col rounded-2xl px-3 py-3 ${inline ? "w-full max-w-sm" : "mt-2"}`}
      aria-busy={loading}
      data-window-count={tiers.length}
    >
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {t("subscription.title")}
          </span>
          <HelpButton
            label={t("codexAccounts.helpLabel")}
            align="start"
            className="h-7 w-7"
          >
            <p>{t("codexAccounts.helpQuotaBattery")}</p>
          </HelpButton>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <QueryTimestamp timestamp={quota.queriedAt} label={updatedLabel} />
          {showRefresh && (
            <RefreshButton
              label={t("subscription.refresh")}
              loading={loading}
              onRefresh={refetch}
            />
          )}
        </div>
      </div>

      <div className="codex-quota-windows mt-4 space-y-6">
        {tiers.map((tier, rowIndex) => (
          <QuotaBatteryWindow
            key={tier.name}
            tier={tier}
            rowIndex={rowIndex}
            labels={labels}
            now={now}
            thresholds={thresholds}
          />
        ))}
      </div>

      {(refreshFailed || statusLabel || statusMessage) && (
        <div className="mt-3 text-[11px] leading-4 [overflow-wrap:anywhere]">
          {(refreshFailed || statusLabel) && (
            <p
              role="status"
              className={
                refreshFailed || statusTone === "warning"
                  ? "text-amber-700 dark:text-amber-400"
                  : statusTone === "error"
                    ? "text-red-500 dark:text-red-400"
                    : "text-muted-foreground"
              }
              title={refreshError || undefined}
            >
              {refreshFailed
                ? t("codexAccounts.quotaRefreshFailed")
                : statusLabel}
            </p>
          )}
          {statusMessage && (
            <p className="mt-1 text-muted-foreground">{statusMessage}</p>
          )}
        </div>
      )}

      {quota.extraUsage?.isEnabled && (
        <div className="mt-3 border-t border-border-default/60 pt-2 text-xs text-muted-foreground">
          {t("subscription.extraUsage")}:{" "}
          {quota.extraUsage.currency === "USD" ? "$" : ""}
          {quota.extraUsage.usedCredits != null &&
          Number.isFinite(quota.extraUsage.usedCredits)
            ? quota.extraUsage.usedCredits.toFixed(2)
            : "—"}
          {quota.extraUsage.monthlyLimit != null &&
            Number.isFinite(quota.extraUsage.monthlyLimit) && (
              <>
                {" "}
                / {quota.extraUsage.currency === "USD" ? "$" : ""}
                {quota.extraUsage.monthlyLimit.toFixed(2)}
              </>
            )}
        </div>
      )}
    </div>
  );
}
