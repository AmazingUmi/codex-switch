import { useId, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { PieChart } from "lucide-react";
import { CapsuleControl } from "@/components/ui/capsule";
import {
  fmtUsd,
  formatTokensShort,
  getLocaleFromLanguage,
  getResolvedLang,
  parseFiniteNumber,
} from "./format";

export interface UsageComparisonItem {
  id: string;
  label: string;
  totalTokens: number;
  totalCost: string;
}

interface UsageStatsPanelProps {
  children: ReactNode;
  items: UsageComparisonItem[];
  comparisonTitle: string;
}

type Metric = "tokens" | "cost";

const colors = [
  "#5b8def",
  "#50b9ad",
  "#aa93e7",
  "#dcb575",
  "#df92ab",
  "#73b4d6",
  "#8abb98",
  "#768bdd",
  "#d9a077",
  "#ba97d4",
];

function slicePath(start: number, share: number) {
  const point = (turn: number, radius: number) => {
    const angle = turn * 2 * Math.PI - Math.PI / 2;
    return `${100 + radius * Math.cos(angle)} ${100 + radius * Math.sin(angle)}`;
  };
  const large = share > 0.5 ? 1 : 0;
  return `M ${point(start, 90)} A 90 90 0 ${large} 1 ${point(start + share, 90)} L ${point(start + share, 66)} A 66 66 0 ${large} 0 ${point(start, 66)} Z`;
}

export function UsageStatsPanel({
  children,
  items,
  comparisonTitle,
}: UsageStatsPanelProps) {
  const { t, i18n } = useTranslation();
  const gradientPrefix = useId().replace(/:/g, "");
  const [metric, setMetric] = useState<Metric>("tokens");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const lang = getResolvedLang(i18n);
  const locale = getLocaleFromLanguage(lang);
  const ranked = items
    .map((item, index) => {
      const parsed = parseFiniteNumber(
        metric === "cost" ? item.totalCost : item.totalTokens,
      );
      return {
        ...item,
        value: parsed != null && parsed >= 0 ? parsed : null,
        color: colors[index] ?? `hsl(${(index * 137.508) % 360} 65% 52%)`,
        gradientId: `${gradientPrefix}-slice-${index}`,
      };
    })
    .sort((a, b) => (b.value ?? -1) - (a.value ?? -1));
  const values = ranked.flatMap((item) =>
    item.value == null ? [] : [item.value],
  );
  const total = values.length
    ? values.reduce((sum, value) => sum + value, 0)
    : null;
  let position = 0;
  const slices = ranked.flatMap((item) => {
    if (item.value == null || item.value <= 0 || total == null || total <= 0)
      return [];
    const share = item.value / total;
    const slice = { ...item, share, start: position };
    position += share;
    return [slice];
  });
  const highlightedId = hoveredId ?? focusedId;
  const hasHighlight = slices.some((item) => item.id === highlightedId);
  const formatValue = (value: number | null, exact = false) => {
    if (value == null) return "—";
    if (metric === "cost")
      return fmtUsd(value, exact || (value > 0 && value < 0.0001) ? 6 : 4);
    return exact
      ? `${value.toLocaleString(locale)} Tokens`
      : formatTokensShort(value, lang);
  };

  return (
    <div className="usage-stats-panel">
      <div className="usage-stats-layout">
        <div className="glass-card usage-stats-table">{children}</div>
        <section
          className="glass-card usage-comparison"
          aria-label={comparisonTitle}
        >
          <div className="usage-comparison-header">
            <h3 className="inline-flex min-w-0 items-center gap-2 text-sm font-semibold">
              <PieChart
                className="h-4 w-4 shrink-0 text-primary"
                aria-hidden="true"
              />
              {comparisonTitle}
            </h3>
            <CapsuleControl
              value={metric}
              onChange={setMetric}
              label={t("usage.comparison.metric", "Comparison metric")}
              className="usage-comparison-control"
              options={[
                { value: "cost", label: t("usage.comparison.cost", "Cost") },
                {
                  value: "tokens",
                  label: t("usage.comparison.tokens", "Tokens"),
                },
              ]}
            />
          </div>
          {ranked.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {t("usage.noData", "No data")}
            </p>
          ) : (
            <>
              <div className="usage-comparison-body">
                <div className="usage-comparison-chart">
                  <svg
                    className="usage-comparison-pie"
                    viewBox="0 0 200 200"
                    aria-hidden="true"
                  >
                    <defs>
                      {slices.map((item) => (
                        <linearGradient
                          key={item.id}
                          id={item.gradientId}
                          x1="0"
                          y1="0"
                          x2="1"
                          y2="1"
                        >
                          <stop
                            offset="0%"
                            stopColor={item.color}
                            stopOpacity="0.7"
                          />
                          <stop offset="100%" stopColor={item.color} />
                        </linearGradient>
                      ))}
                    </defs>
                    <circle
                      cx="100"
                      cy="100"
                      r="78"
                      className="usage-pie-empty"
                    />
                    {slices.map((item) => {
                      const props = {
                        className: "usage-pie-slice",
                        "data-slice-id": item.id,
                        "data-share": item.share,
                        "data-dimmed":
                          hasHighlight && highlightedId !== item.id,
                        onPointerEnter: () => setHoveredId(item.id),
                        onPointerLeave: () => setHoveredId(null),
                      };
                      const title = `${item.label}: ${formatValue(item.value, true)} (${(item.share * 100).toFixed(1)}%)`;
                      return item.share === 1 ? (
                        <circle
                          key={item.id}
                          cx="100"
                          cy="100"
                          r="78"
                          fill="none"
                          stroke={`url(#${item.gradientId})`}
                          strokeWidth="24"
                          {...props}
                        >
                          <title>{title}</title>
                        </circle>
                      ) : (
                        <path
                          key={item.id}
                          d={slicePath(item.start, item.share)}
                          fill={`url(#${item.gradientId})`}
                          {...props}
                        >
                          <title>{title}</title>
                        </path>
                      );
                    })}
                  </svg>
                  <div className="usage-comparison-center">
                    <span className="text-xs text-muted-foreground">
                      {t("usage.comparison.total", "Total")}
                    </span>
                    <span
                      className="usage-comparison-total"
                      data-long={formatValue(total).length > 10}
                      title={formatValue(total, true)}
                    >
                      {formatValue(total)}
                    </span>
                  </div>
                </div>
                <ol
                  className="app-scroll usage-comparison-list"
                  aria-label={comparisonTitle}
                >
                  {ranked.map((item) => {
                    const share =
                      total != null && total > 0 && item.value != null
                        ? `${((item.value / total) * 100).toFixed(1)}%`
                        : null;
                    return (
                      <li
                        key={item.id}
                        className="usage-comparison-legend"
                        role="img"
                        tabIndex={0}
                        data-highlighted={highlightedId === item.id}
                        aria-label={`${item.label}: ${formatValue(item.value, true)}${share ? ` (${share})` : ""}`}
                        title={`${item.label}: ${formatValue(item.value, true)}${share ? ` (${share})` : ""}`}
                        onPointerEnter={() => setHoveredId(item.id)}
                        onPointerLeave={() => setHoveredId(null)}
                        onFocus={() => setFocusedId(item.id)}
                        onBlur={() => setFocusedId(null)}
                      >
                        <span
                          className="usage-comparison-swatch"
                          style={{ background: item.color }}
                          aria-hidden="true"
                        />
                        <div className="min-w-0" aria-hidden="true">
                          <span className="block truncate font-medium">
                            {item.label}
                          </span>
                          <span className="usage-comparison-value">
                            {formatValue(item.value)}
                            {share && (
                              <span className="text-muted-foreground">
                                {share}
                              </span>
                            )}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </div>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {metric === "cost"
                  ? t("usage.comparison.costHint", "Estimated cost in USD.")
                  : t(
                      "usage.comparison.tokensHint",
                      "Tokens match the table: fresh input + output.",
                    )}
              </p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
