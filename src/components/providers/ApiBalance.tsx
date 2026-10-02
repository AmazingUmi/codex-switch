import { Loader2, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
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

  return (
    <div
      className="flex shrink-0 items-center gap-1.5"
      aria-label={label}
      aria-busy={query.isFetching}
    >
      <div className="min-w-[5rem] text-right">
        <div className="text-[11px] leading-4 text-muted-foreground">
          {label}
        </div>
        <div className="flex flex-wrap justify-end gap-x-3 text-sm font-semibold tabular-nums leading-5">
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
      <HelpButton label={t("apiBalance.details", "余额详情")} align="end">
        <p>
          {t(
            "apiBalance.explanation",
            "余额来自供应商账户接口，不同币种分别显示。",
          )}
        </p>
        {query.isFetching && <p>{t("apiBalance.loading", "正在查询余额…")}</p>}
        {reason && (
          <p className="break-words text-muted-foreground">{reason}</p>
        )}
        {hasWarning && (
          <p className="text-amber-700 dark:text-amber-300">
            {t(
              "apiBalance.unavailable",
              "供应商提示当前余额不可用于 API 调用。",
            )}
          </p>
        )}
        {query.dataUpdatedAt > 0 && !query.isError && query.data?.success && (
          <p className="text-muted-foreground">
            {t("apiBalance.updated", "更新时间")}：
            {new Date(query.dataUpdatedAt).toLocaleTimeString(i18n.language)}
          </p>
        )}
        <p className="text-muted-foreground">
          {t(
            "apiBalance.supported",
            "支持 DeepSeek、阶跃星辰、硅基流动、OpenRouter 和 Novita AI 的官方接口。OpenRouter 余额接口需要管理密钥。",
          )}
        </p>
      </HelpButton>
      {query.enabled && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
          aria-label={t("apiBalance.refresh", "刷新余额")}
          title={t("apiBalance.refresh", "刷新余额")}
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {query.isFetching ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </Button>
      )}
    </div>
  );
}
