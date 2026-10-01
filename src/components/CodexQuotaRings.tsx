import React from "react";
import { Clock, Info, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";

interface CodexQuotaRingsProps {
  quota: SubscriptionQuota;
  tiers: QuotaTier[];
  labels: Record<string, string>;
  loading: boolean;
  refetch: () => void;
  inline?: boolean;
  updatedLabel: string;
  refreshFailed?: boolean;
  refreshError?: string | null;
}

// Missing or corrupt API data must never look like unused quota.
function knownPercentage(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 100;
}

function ringColor(tier: QuotaTier, index: number): string {
  if (!knownPercentage(tier.utilization)) return "text-muted-foreground";
  if (tier.utilization >= 90) return "text-red-500 dark:text-red-400";
  if (tier.utilization >= 70) return "text-amber-600 dark:text-amber-400";
  return index % 2 === 0
    ? "text-sky-600 dark:text-sky-400"
    : "text-violet-600 dark:text-violet-400";
}

function resetCountdown(resetsAt: string | null, now: number): string | null {
  if (!resetsAt) return null;
  const diff = new Date(resetsAt).getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d${hours % 24}h`;
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`;
}

/** Shared Codex gauge for account cards, managed providers and native login. */
export function CodexQuotaRings({
  quota,
  tiers,
  labels,
  loading,
  refetch,
  inline = false,
  updatedLabel,
  refreshFailed = false,
  refreshError,
}: CodexQuotaRingsProps) {
  const { t } = useTranslation();
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const usedLabel = t("codexAccounts.quotaUsedLabel", "已用");
  const unknownLabel = t("codexAccounts.quotaUnknown", "额度未知");
  const labelFor = (tier: QuotaTier) =>
    labels[tier.name] ? t(labels[tier.name]) : tier.name;
  const valueFor = (tier: QuotaTier) =>
    knownPercentage(tier.utilization)
      ? `${Math.round(tier.utilization)}%`
      : "—";

  return (
    <div
      className={`codex-quota-panel min-w-0 rounded-2xl border border-border-default/70 bg-card/50 px-3 py-3 shadow-sm backdrop-blur-xl ${inline ? "w-full max-w-sm" : "mt-3"}`}
      aria-busy={loading}
    >
      <div className="mb-2 flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-[11px] font-medium text-muted-foreground">
          {t("subscription.title")}
        </span>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className="flex items-center gap-1 text-[10px] text-muted-foreground"
            title={
              quota.queriedAt
                ? new Date(quota.queriedAt).toLocaleString()
                : undefined
            }
          >
            <Clock size={10} aria-hidden="true" />
            {updatedLabel}
          </span>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              refetch();
            }}
            disabled={loading}
            aria-label={t("subscription.refresh")}
            title={t("subscription.refresh")}
            className="codex-quota-refresh flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-default/60 bg-card/60 text-muted-foreground shadow-sm backdrop-blur-lg transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <RefreshCw
              size={12}
              aria-hidden="true"
              className={loading ? "animate-spin" : ""}
            />
          </button>
        </div>
      </div>

      {refreshFailed && (
        <p
          role="status"
          className="mb-3 break-words text-[11px] text-amber-700 dark:text-amber-400"
          title={refreshError || undefined}
        >
          {t("codexAccounts.quotaRefreshFailed", "刷新失败，显示上次成功数据")}
        </p>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <svg
          viewBox="0 0 136 136"
          className={`shrink-0 ${inline ? "h-[76px] w-[76px]" : "h-24 w-24"}`}
          role="img"
          aria-label={tiers
            .slice(0, 2)
            .map(
              (tier) =>
                `${labelFor(tier)}: ${knownPercentage(tier.utilization) ? `${valueFor(tier)} ${usedLabel}` : unknownLabel}`,
            )
            .join("; ")}
        >
          {tiers.slice(0, 2).map((tier, index) => {
            const radius = index === 0 ? 56 : 41;
            const known = knownPercentage(tier.utilization);
            return (
              <g key={tier.name} fill="none" strokeWidth={9}>
                <circle
                  cx={68}
                  cy={68}
                  r={radius}
                  stroke="currentColor"
                  className="text-muted-foreground/15"
                  strokeDasharray={known ? undefined : "3 5"}
                />
                {known && tier.utilization > 0 && (
                  <circle
                    cx={68}
                    cy={68}
                    r={radius}
                    pathLength={100}
                    stroke="currentColor"
                    strokeLinecap={tier.utilization === 100 ? "butt" : "round"}
                    strokeDasharray={`${tier.utilization} 100`}
                    transform="rotate(-90 68 68)"
                    className={ringColor(tier, index)}
                    data-quota-value={tier.utilization}
                  />
                )}
              </g>
            );
          })}
          <text
            x={68}
            y={73}
            textAnchor="middle"
            fill="currentColor"
            className="text-muted-foreground"
            fontSize={inline ? 15 : 13}
            fontWeight={600}
          >
            {usedLabel}
          </text>
        </svg>

        <div className="min-w-[125px] flex-1 space-y-3">
          {tiers.map((tier, index) => {
            const known = knownPercentage(tier.utilization);
            const reset = resetCountdown(tier.resetsAt, now);
            const resetDate = tier.resetsAt ? new Date(tier.resetsAt) : null;
            const validReset =
              resetDate && Number.isFinite(resetDate.getTime());
            const hasUsd =
              Number.isFinite(tier.usedValueUsd) &&
              Number.isFinite(tier.maxValueUsd) &&
              tier.usedValueUsd != null &&
              tier.maxValueUsd != null;
            return (
              <div key={tier.name} className="codex-quota-window min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${ringColor(tier, index)}`}
                    />
                    <span className="truncate">{labelFor(tier)}</span>
                  </span>
                  <span
                    className={`shrink-0 font-semibold tabular-nums ${inline ? "text-base" : "text-lg"} ${ringColor(tier, index)}`}
                    aria-label={
                      known ? `${valueFor(tier)} ${usedLabel}` : unknownLabel
                    }
                  >
                    {valueFor(tier)}
                  </span>
                </div>
                <span
                  className="mt-0.5 block text-[10px] leading-relaxed text-muted-foreground"
                  title={validReset ? resetDate.toLocaleString() : undefined}
                >
                  {reset
                    ? t("subscription.resetsIn", { time: reset })
                    : validReset
                      ? resetDate.toLocaleString()
                      : t("codexAccounts.quotaResetUnknown", "重置时间未知")}
                </span>
                {hasUsd && (
                  <span className="mt-0.5 block text-[10px] tabular-nums text-muted-foreground">
                    ${tier.usedValueUsd!.toFixed(2)} / $
                    {tier.maxValueUsd!.toFixed(2)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {quota.extraUsage?.isEnabled && (
        <div className="mt-3 border-t border-border-default/60 pt-2 text-xs text-muted-foreground">
          {t("subscription.extraUsage")}:{" "}
          {quota.extraUsage.currency === "USD" ? "$" : ""}
          {Number.isFinite(quota.extraUsage.usedCredits) &&
          quota.extraUsage.usedCredits != null
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

      <details className="mt-2 text-[10px] leading-relaxed text-muted-foreground">
        <summary
          className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(event) => event.stopPropagation()}
        >
          <Info size={11} aria-hidden="true" />
          {t("codexAccounts.helpLabel")}
        </summary>
        <p className="mt-1.5">{t("codexAccounts.helpQuota")}</p>
      </details>
    </div>
  );
}
