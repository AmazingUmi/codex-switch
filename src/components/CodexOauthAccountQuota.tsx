import React from "react";
import { useTranslation } from "react-i18next";
import { useCodexOauthQuotaByAccountId } from "@/lib/query/subscription";
import { SubscriptionQuotaView } from "@/components/SubscriptionQuotaFooter";

interface CodexOauthAccountQuotaProps {
  /** cc-switch 自管的 ChatGPT 账号 ID */
  accountId: string;
}

/**
 * 设置 → 认证中心里，单个 ChatGPT (Codex OAuth) 账号的用量展示。
 *
 * 直接按 accountId 查询 cc-switch 自管 OAuth token 的订阅额度，复用
 * `SubscriptionQuotaView` 的环形布局（窗口图例 + 重置倒计时 + 刷新按钮），
 * 因此与供应商卡片里的额度展示保持完全一致的观感与状态处理。
 *
 * 面板打开时拉取一次，不轮询；用户可点卡片内的刷新按钮手动更新。
 */
const CodexOauthAccountQuota: React.FC<CodexOauthAccountQuotaProps> = ({
  accountId,
}) => {
  const { t } = useTranslation();
  const {
    data: quota,
    isFetching: loading,
    refetch,
    refreshFailed,
    refreshError,
  } = useCodexOauthQuotaByAccountId(accountId, {
    enabled: true,
    autoQuery: false,
  });

  return (
    <SubscriptionQuotaView
      quota={quota}
      loading={loading}
      refetch={refetch}
      appIdForExpiredHint="codex_oauth"
      expiredHint={t("codexAccounts.quotaExpiredHint")}
      inline={false}
      visualization="rings"
      refreshFailed={refreshFailed}
      refreshError={refreshError}
    />
  );
};

export default CodexOauthAccountQuota;
