import React from "react";
import { useTranslation } from "react-i18next";
import { RefreshButton } from "@/components/ui/refresh-button";
import { HelpButton } from "@/components/ui/help-button";
import { QueryTimestamp } from "@/components/ui/query-timestamp";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";

interface CodexQuotaRingsProps {
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
  showRefresh = true,
  updatedLabel,
  refreshFailed = false,
  refreshError,
  statusLabel,
  statusMessage,
  statusTone,
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
      className={`codex-quota-panel flex min-w-0 flex-col rounded-2xl border border-border-default/70 bg-card/50 px-3 py-2 shadow-sm backdrop-blur-xl ${inline ? "w-full max-w-sm" : "mt-2"}`}
      aria-busy={loading}
    >
      <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate text-[11px] font-medium text-muted-foreground">
            {t("subscription.title")}
          </span>
          <HelpButton
            label={t("codexAccounts.helpLabel")}
            align="start"
            className="h-7 w-7"
          >
            <p>{t("codexAccounts.helpQuota")}</p>
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

      <div
        className={`min-w-0 items-center gap-3 ${inline ? "flex flex-wrap" : "grid grid-cols-[minmax(140px,1fr)_minmax(100px,auto)]"}`}
      >
        <div className={inline ? "shrink-0" : "flex min-w-0 justify-center"}>
          <svg
            viewBox="0 0 136 136"
            className={`shrink-0 ${inline ? "h-[76px] w-[76px]" : "aspect-square h-auto w-[160px] min-w-[140px] max-w-full"}`}
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
                      strokeLinecap={
                        tier.utilization === 100 ? "butt" : "round"
                      }
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
        </div>

        <div
          className={`space-y-3 [overflow-wrap:anywhere] ${inline ? "min-w-[125px] flex-1" : "min-w-0 max-w-[180px] justify-self-end text-right"}`}
        >
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
                <div
                  className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 ${inline ? "" : "justify-end"}`}
                >
                  <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 shrink-0 rounded-full bg-current ${ringColor(tier, index)}`}
                    />
                    <span>{labelFor(tier)}</span>
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

      {(refreshFailed || statusLabel || statusMessage) && (
        <div className="mt-1 text-[11px] leading-4 [overflow-wrap:anywhere]">
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
                ? t(
                    "codexAccounts.quotaRefreshFailed",
                    "刷新失败，显示上次成功数据",
                  )
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
    </div>
  );
}
