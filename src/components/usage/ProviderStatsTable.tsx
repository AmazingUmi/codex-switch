import { useTranslation } from "react-i18next";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useProviderStats,
  useUsageAttributionChoices,
} from "@/lib/query/usage";
import {
  flatSourceChoices,
  sourceIdentity,
  sourceOptionLabel,
  usageSourceName,
} from "@/lib/usageSource";
import { fmtUsd } from "./format";
import type { ProviderStats, UsageRangeSelection } from "@/types/usage";

interface ProviderStatsTableProps {
  range: UsageRangeSelection;
  appType?: string;
  providerName?: string;
  accountId?: string;
  providerId?: string;
  model?: string;
  refreshIntervalMs: number;
}

export function ProviderStatsTable({
  range,
  providerName,
  accountId,
  providerId,
  model,
  refreshIntervalMs,
}: ProviderStatsTableProps) {
  const { t } = useTranslation();
  const choices = useUsageAttributionChoices();
  const sources = flatSourceChoices(choices.data ?? []);
  const sourceLabel = (stat: ProviderStats) => {
    const current = sources.find(
      (source) =>
        sourceIdentity(source.accountId, source.providerId) === stat.sourceId,
    );
    return current
      ? sourceOptionLabel(
          current,
          sources,
          t("usage.records.accountType", "Subscription account"),
          t("usage.records.apiType", "API source"),
        )
      : usageSourceName(stat) || t("usage.records.untagged", "Unassigned");
  };
  const { data: stats, isLoading } = useProviderStats(
    range,
    { appType: "codex", providerName, accountId, providerId, model },
    {
      refetchInterval: refreshIntervalMs > 0 ? refreshIntervalMs : false,
    },
  );

  if (isLoading) {
    return <div className="h-[400px] animate-pulse rounded bg-gray-100" />;
  }

  return (
    <div className="rounded-lg border border-border/50 bg-card/40 backdrop-blur-sm overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("usage.source", "Source")}</TableHead>
            <TableHead className="text-right">
              {t("usage.requests", "用量记录数")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.tokens", "Tokens")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.estimatedCost", "Estimated cost")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.successRate", "成功率")}
            </TableHead>
            <TableHead className="text-right">
              {t("usage.avgLatency", "平均延迟")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {stats?.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={6}
                className="text-center text-muted-foreground"
              >
                {t("usage.noData", "暂无数据")}
              </TableCell>
            </TableRow>
          ) : (
            stats?.map((stat) => (
              <TableRow key={stat.sourceId}>
                <TableCell
                  className="max-w-[240px] truncate font-medium"
                  title={sourceLabel(stat)}
                >
                  {sourceLabel(stat)}
                </TableCell>
                <TableCell className="text-right">
                  {stat.requestCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {stat.totalTokens.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {fmtUsd(stat.totalCost, 4)}
                </TableCell>
                <TableCell className="text-right">
                  {stat.successRate.toFixed(1)}%
                </TableCell>
                <TableCell className="text-right">
                  {stat.avgLatencyMs}ms
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
