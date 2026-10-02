import { useId, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { useUsageTrends } from "@/lib/query/usage";
import { Loader2 } from "lucide-react";
import {
  fmtInt,
  getLocaleFromLanguage,
  getUsageTimeZone,
  parseFiniteNumber,
} from "./format";
import { resolveUsageRange } from "@/lib/usageRange";
import type { UsageRangeSelection } from "@/types/usage";

interface UsageTrendChartProps {
  range: UsageRangeSelection;
  rangeLabel: string;
  appType?: string;
  providerName?: string;
  accountId?: string;
  providerId?: string;
  model?: string;
  refreshIntervalMs: number;
}

export interface UsageTrendStatLike {
  date: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  totalCost: string | number;
}

export interface UsageTrendChartPoint {
  /** Unique category key for Recharts — must not collide across years. */
  xKey: string;
  rawDate: string;
  /** Short tick label shown on the X axis. */
  label: string;
  /** Fuller label used by the tooltip. */
  tooltipLabel: string;
  hour: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number | null;
}

/** Build chart rows from backend trend stats. Exported for unit tests. */
export function buildUsageTrendChartData(
  trends: UsageTrendStatLike[] | undefined,
  options: {
    isHourly: boolean;
    dateLocale: string;
    /** Inclusive range endpoints (unix seconds). Used to decide year labels. */
    startDate: number;
    endDate: number;
    timeZone?: string;
  },
): UsageTrendChartPoint[] {
  const { isHourly, dateLocale, startDate, endDate, timeZone } = options;
  const calendarParts = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone,
    }).formatToParts(date);
  const calendarKey = (date: Date) =>
    calendarParts(date)
      .filter((part) => ["year", "month", "day"].includes(part.type))
      .map((part) => `${part.type}:${part.value}`)
      .join("/");
  const start = new Date(startDate * 1000);
  const end = new Date(endDate * 1000);
  const sameDay = calendarKey(start) === calendarKey(end);
  const year = (date: Date) =>
    calendarParts(date).find((part) => part.type === "year")?.value;
  const spansMultipleYears = year(start) !== year(end);

  return (
    trends
      ?.filter((stat) => Number.isFinite(new Date(stat.date).getTime()))
      .map((stat) => {
        const pointDate = new Date(stat.date);
        const cost = parseFiniteNumber(stat.totalCost);
        // Category identity stays independent of display labels, including DST repeats.
        const xKey = stat.date;
        const tooltipLabel = pointDate.toLocaleString(dateLocale, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
          timeZoneName: "longOffset",
          timeZone,
        });
        const label = isHourly
          ? pointDate.toLocaleString(dateLocale, {
              ...(sameDay
                ? {}
                : {
                    month: "2-digit",
                    day: "2-digit",
                    ...(spansMultipleYears ? { year: "2-digit" } : {}),
                  }),
              hour: "2-digit",
              minute: "2-digit",
              hourCycle: "h23",
              timeZone,
            })
          : pointDate.toLocaleDateString(dateLocale, {
              ...(spansMultipleYears ? { year: "2-digit" } : {}),
              month: "2-digit",
              day: "2-digit",
              timeZone,
            });

        return {
          xKey,
          rawDate: stat.date,
          label,
          tooltipLabel,
          hour: pointDate.getHours(),
          inputTokens: stat.totalInputTokens,
          outputTokens: stat.totalOutputTokens,
          cacheCreationTokens: stat.totalCacheCreationTokens,
          cacheReadTokens: stat.totalCacheReadTokens,
          cost: cost ?? null,
        };
      }) || []
  );
}

/** Resolve a tick label by the unique category key (not by filtered tick index). */
export function formatUsageTrendTickLabel(
  xKey: string,
  chartData: UsageTrendChartPoint[],
): string {
  const point = chartData.find((row) => row.xKey === xKey);
  return point?.label ?? xKey;
}

export function createUsageTrendTokenTickFormatter(
  locale: string,
): Intl.NumberFormat {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    compactDisplay: "short",
    maximumFractionDigits: 1,
  });
}

export function formatUsageTrendTokenTickLabel(
  value: unknown,
  formatter: Intl.NumberFormat,
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return "--";

  return formatter.format(num);
}

export function formatUsageTrendCostTickLabel(
  value: unknown,
  locale = "en-US",
  compact = true,
): string {
  const num = parseFiniteNumber(value);
  if (num == null) return "—";
  if (num === 0) return "$0";
  if (Math.abs(num) < (compact ? 0.001 : 0.000001))
    return `$${num.toExponential(compact ? 1 : 2)}`;
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    currencyDisplay: "narrowSymbol",
    ...(compact
      ? { notation: "compact", maximumSignificantDigits: 3 }
      : { maximumFractionDigits: 6, minimumFractionDigits: 0 }),
  }).format(num);
}

const TREND_SERIES = [
  {
    key: "inputTokens",
    label: "usage.inputTokens",
    fallback: "输入 Tokens",
    color: "#3b82f6",
    gradient: "input",
  },
  {
    key: "outputTokens",
    label: "usage.outputTokens",
    fallback: "输出 Tokens",
    color: "#22c55e",
    gradient: "output",
  },
  {
    key: "cacheCreationTokens",
    label: "usage.cacheCreationTokens",
    fallback: "缓存创建",
    color: "#f97316",
    gradient: "cacheCreation",
  },
  {
    key: "cacheReadTokens",
    label: "usage.cacheReadTokens",
    fallback: "缓存命中",
    color: "#a855f7",
    gradient: "cacheRead",
  },
  {
    key: "cost",
    label: "usage.estimatedCost",
    fallback: "Estimated cost",
    color: "#f43f5e",
    gradient: null,
  },
] as const;

export function UsageTrendChart({
  range,
  rangeLabel,
  providerName,
  accountId,
  providerId,
  model,
  refreshIntervalMs,
}: UsageTrendChartProps) {
  const { t, i18n } = useTranslation();
  const gradientId = `usage-trend-${useId().replace(/:/g, "")}`;
  const { startDate, endDate } = resolveUsageRange(range);
  const { data: trends, isLoading } = useUsageTrends(
    range,
    { appType: "codex", providerName, accountId, providerId, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  const durationSeconds = Math.max(endDate - startDate, 0);
  const isHourly = durationSeconds <= 24 * 60 * 60;
  const language = i18n.resolvedLanguage || i18n.language || "en";
  const dateLocale = getLocaleFromLanguage(language);
  const timeZone = getUsageTimeZone();
  const tokenTickFormatter = useMemo(
    () => createUsageTrendTokenTickFormatter(dateLocale),
    [dateLocale],
  );

  const chartData = useMemo(
    () =>
      buildUsageTrendChartData(trends, {
        isHourly,
        dateLocale,
        startDate,
        endDate,
      }),
    [trends, isHourly, dateLocale, startDate, endDate],
  );

  if (isLoading) {
    return (
      <div className="glass-card flex h-[280px] sm:h-[320px] items-center justify-center rounded-xl">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground/30" />
      </div>
    );
  }

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const point = payload[0]?.payload as UsageTrendChartPoint | undefined;
      const heading = point?.tooltipLabel ?? point?.label ?? "";
      return (
        <div className="glass-popover min-w-[220px] px-3 py-2.5 text-xs">
          <p className="mb-2 border-b border-border/30 pb-2 font-medium text-foreground">
            {heading}
          </p>
          <div className="space-y-1.5">
            {payload.map((entry: any) => (
              <div key={entry.dataKey} className="flex items-center gap-2">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                <span className="text-muted-foreground">{entry.name}</span>
                <span className="ml-auto pl-4 font-medium tabular-nums text-foreground">
                  {entry.dataKey === "cost"
                    ? formatUsageTrendCostTickLabel(
                        entry.value,
                        dateLocale,
                        false,
                      )
                    : fmtInt(entry.value, dateLocale)}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="glass-card rounded-xl px-3 py-4 sm:px-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h3 className="text-base font-semibold">
          {t("usage.trends", "使用趋势")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {rangeLabel} · {timeZone}
        </p>
      </div>
      {chartData.length === 0 ? (
        <div className="flex h-32 items-center justify-center text-sm text-muted-foreground">
          {t("usage.noData")}
        </div>
      ) : (
        <>
          <div className="h-[280px] w-full sm:h-[320px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={chartData}
                margin={{ top: 8, right: 0, left: 0, bottom: 0 }}
              >
                <defs>
                  {TREND_SERIES.filter((series) => series.gradient).map(
                    (series) => (
                      <linearGradient
                        key={series.key}
                        id={`${gradientId}-${series.gradient}`}
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor={series.color}
                          stopOpacity={0.14}
                        />
                        <stop
                          offset="95%"
                          stopColor={series.color}
                          stopOpacity={0}
                        />
                      </linearGradient>
                    ),
                  )}
                </defs>
                <CartesianGrid
                  strokeDasharray="3 5"
                  vertical={false}
                  stroke="hsl(var(--border))"
                  opacity={0.25}
                />
                <XAxis
                  dataKey="xKey"
                  axisLine={false}
                  tickLine={false}
                  height={28}
                  tickMargin={8}
                  minTickGap={28}
                  interval="preserveStartEnd"
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  tickFormatter={(value) =>
                    formatUsageTrendTickLabel(String(value), chartData)
                  }
                  allowDuplicatedCategory={false}
                />
                <YAxis
                  yAxisId="tokens"
                  width={50}
                  axisLine={false}
                  tickLine={false}
                  tickMargin={8}
                  tickCount={5}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  tickFormatter={(value) =>
                    formatUsageTrendTokenTickLabel(value, tokenTickFormatter)
                  }
                />
                <YAxis
                  yAxisId="cost"
                  orientation="right"
                  width={58}
                  axisLine={false}
                  tickLine={false}
                  tickMargin={8}
                  tickCount={5}
                  tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }}
                  tickFormatter={(value) =>
                    formatUsageTrendCostTickLabel(value, dateLocale)
                  }
                />
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{
                    stroke: "hsl(var(--muted-foreground))",
                    strokeOpacity: 0.25,
                    strokeDasharray: "3 3",
                  }}
                />
                {TREND_SERIES.map((series) => (
                  <Area
                    key={series.key}
                    yAxisId={series.key === "cost" ? "cost" : "tokens"}
                    type="monotone"
                    dataKey={series.key}
                    name={t(series.label, series.fallback)}
                    stroke={series.color}
                    fill={
                      series.gradient
                        ? `url(#${gradientId}-${series.gradient})`
                        : "none"
                    }
                    fillOpacity={1}
                    strokeWidth={1.8}
                    strokeDasharray={series.key === "cost" ? "4 4" : undefined}
                    dot={
                      chartData.filter(
                        (point) =>
                          point[series.key] != null &&
                          Number.isFinite(point[series.key]),
                      ).length === 1
                        ? { r: 3, fill: series.color, strokeWidth: 0 }
                        : false
                    }
                    activeDot={{
                      r: 4,
                      strokeWidth: 2,
                      stroke: "hsl(var(--background))",
                    }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-muted-foreground">
            {TREND_SERIES.map((series) => (
              <span
                key={series.key}
                className="inline-flex items-center gap-1.5"
              >
                <span
                  aria-hidden="true"
                  className="w-4 border-t-2"
                  style={{
                    borderColor: series.color,
                    borderStyle: series.key === "cost" ? "dashed" : "solid",
                  }}
                />
                {t(series.label, series.fallback)}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
