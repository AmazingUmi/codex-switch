import { useTranslation } from "react-i18next";
import { RefreshButton } from "@/components/ui/refresh-button";
import { QueryTimestamp } from "@/components/ui/query-timestamp";
import { useApiBalance } from "@/hooks/useApiBalance";
import type { Provider } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";

export function ApiBalance({ provider }: { provider: Provider }) {
  const { t, i18n } = useTranslation();
  const query = useApiBalance(provider);
  const label = t("apiBalance.label", "余额");
  // A rejected refresh retains query.data; hide it so stale amounts do not look
  // like a successful live balance query.
  const balances =
    query.enabled &&
    !query.isError &&
    query.data?.success &&
    Array.isArray(query.data.data)
      ? query.data.data.filter(
          (item) =>
            item &&
            typeof item.remaining === "number" &&
            Number.isFinite(item.remaining) &&
            Boolean(item.unit),
        )
      : undefined;
  const reason = !query.supported
    ? t("apiBalance.unsupported", "此供应商暂不支持余额查询")
    : !query.enabled
      ? t("apiBalance.missingKey", "请先填写 API Key")
      : query.isError
        ? extractErrorMessage(query.error)
        : !query.data?.success
          ? query.data?.error
          : !balances?.length
            ? t("apiBalance.empty", "供应商未返回有效余额")
            : undefined;
  const hasWarning = balances?.some((item) => item.isValid === false);
  const numberFormat = new Intl.NumberFormat(i18n.language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const details = [
    t("apiBalance.explanation", "余额来自供应商账户接口，不同币种分别显示。"),
    query.lastSuccessfulUpdatedAt > 0 &&
      `${t("apiBalance.updated", "更新时间")}：${new Date(query.lastSuccessfulUpdatedAt).toLocaleString(i18n.language)}`,
    query.isFetching && t("apiBalance.loading", "正在查询余额…"),
    reason,
    hasWarning &&
      t("apiBalance.unavailable", "供应商提示当前余额不可用于 API 调用。"),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      aria-label={label}
      aria-busy={query.isFetching}
    >
      <div className="min-w-[5rem] text-right">
        <QueryTimestamp
          timestamp={query.lastSuccessfulUpdatedAt}
          className="justify-end"
        />
        <div
          className="flex flex-wrap justify-end gap-x-3 text-sm font-semibold tabular-nums leading-5"
          title={details}
        >
          {balances?.length ? (
            balances.map((item, index) => (
              <span key={`${item.unit}-${index}`}>
                <span className="mr-1 text-[10px] font-medium text-muted-foreground">
                  {item.unit}
                </span>
                {numberFormat.format(item.remaining!)}
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </div>
      </div>
      {query.enabled && (
        <RefreshButton
          label={t("apiBalance.refresh", "刷新余额")}
          loading={query.isFetching}
          onRefresh={() => void query.refetch()}
        />
      )}
    </div>
  );
}
