import React from "react";
import { useTranslation } from "react-i18next";
import { useCodexOauthQuotaByAccountId } from "@/lib/query/subscription";
import { SubscriptionQuotaView } from "@/components/SubscriptionQuotaFooter";

export type CodexAccountQuotaQuery = Pick<
  ReturnType<typeof useCodexOauthQuotaByAccountId>,
  "data" | "isFetching"
> & { refetch: () => void };

interface CodexOauthAccountQuotaProps {
  accountId: string;
  enabled?: boolean;
  children?: (
    query: CodexAccountQuotaQuery,
    view: React.ReactNode,
  ) => React.ReactNode;
}

/** One account query supplies its header refresh, switch eligibility and quota view. */
const QueriedAccountQuota: React.FC<CodexOauthAccountQuotaProps> = ({
  accountId,
  children,
}) => {
  const { t } = useTranslation();
  const query = useCodexOauthQuotaByAccountId(accountId, {
    enabled: true,
    autoQuery: false,
  });
  const view = (
    <SubscriptionQuotaView
      quota={query.data}
      loading={query.isFetching}
      refetch={query.refetch}
      appIdForExpiredHint="codex_oauth"
      expiredHint={t("codexAccounts.quotaExpiredHint")}
      inline={false}
      visualization="rings"
      showRefresh={!children}
      refreshFailed={query.refreshFailed}
      refreshError={query.refreshError}
    />
  );

  return <>{children ? children(query, view) : view}</>;
};

const CodexOauthAccountQuota: React.FC<CodexOauthAccountQuotaProps> = ({
  enabled = true,
  children,
  ...props
}) => {
  if (!enabled) {
    return (
      <>
        {children?.(
          { data: undefined, isFetching: false, refetch: () => {} },
          null,
        )}
      </>
    );
  }
  return <QueriedAccountQuota {...props}>{children}</QueriedAccountQuota>;
};

export default CodexOauthAccountQuota;
