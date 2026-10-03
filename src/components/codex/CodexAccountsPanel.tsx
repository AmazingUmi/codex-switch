import { useState } from "react";
import { useSettingsQuery } from "@/lib/query";
import { getQuotaBatteryThresholds } from "@/utils/quotaBatteryThresholds";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Loader2 } from "lucide-react";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { CurrentStatus } from "@/components/ui/current-status";
import type { SubscriptionQuota } from "@/types/subscription";
export interface CodexAccountsPanelProps {
  currentAccountId: string | null;
  onSwitchAccount: (accountId: string) => void | Promise<unknown>;
  onAddAccount?: (startLogin: () => void) => void;
  isSwitching?: boolean;
  isLoadingSelection?: boolean;
  isSelectionError?: boolean;
  /** An interrupted native switch may be resolved by an explicit selection. */
  canReconfirmSelection?: boolean;
  showLogoutAll?: boolean;
}

function AccountSwitchAction({
  account,
  quota,
  onError,
  ...props
}: CodexAccountsPanelProps & {
  account: ManagedAuthAccount;
  quota?: SubscriptionQuota;
  onError: (error: string | null) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const isCurrentSelection =
    !props.isSelectionError && props.currentAccountId === account.id;
  const isPending = pending || props.isSwitching;
  const cannotSwitch =
    !!account.reauth_required ||
    !!account.requires_reauth ||
    quota?.credentialStatus === "expired" ||
    quota?.credentialStatus === "not_found";

  const switchAccount = async () => {
    setPending(true);
    onError(null);
    try {
      await props.onSwitchAccount(account.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  const label = isCurrentSelection
    ? t("codexAccounts.current", "当前使用")
    : t("codexAccounts.switch", "切换到此账号");
  const disabledReason = isPending
    ? t("codexAccounts.switchPending", "正在切换账号…")
    : props.isSelectionError && !props.canReconfirmSelection
      ? t("codexAccounts.connectionLoadFailed", "无法读取连接，请刷新后重试。")
      : props.isLoadingSelection
        ? t("codexOauth.statusLoading", "正在加载...")
        : cannotSwitch
          ? t("codexAccounts.quotaExpiredHint", "请进入“编辑账号”重新登录。")
          : isCurrentSelection
            ? label
            : null;

  if (isCurrentSelection) return <CurrentStatus label={label} />;

  return (
    <>
      {disabledReason && !isCurrentSelection && (
        <HelpButton
          label={t("codexAccounts.switchUnavailable", "为何无法切换")}
        >
          <p>{disabledReason}</p>
        </HelpButton>
      )}
      <Button
        type="button"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-full"
        variant="default"
        title={disabledReason ?? label}
        aria-label={label}
        disabled={!!disabledReason}
        onClick={() => void switchAccount()}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
    </>
  );
}

export function CodexAccountsPanel(props: CodexAccountsPanelProps) {
  const { t } = useTranslation();
  const { data: settings } = useSettingsQuery();
  const [switchErrors, setSwitchErrors] = useState<
    Record<string, string | null>
  >({});
  return (
    <section
      className="space-y-3"
      aria-label={t("codexAccounts.title", "ChatGPT 账号")}
    >
      {props.canReconfirmSelection && (
        <p role="status" className="text-xs text-amber-700 dark:text-amber-300">
          {t(
            "codexAccounts.selectionUncertainHint",
            "当前连接尚未确认，请选择账号重新切换。",
          )}
        </p>
      )}
      <CodexOAuthSection
        presentation="cards"
        batteryThresholds={getQuotaBatteryThresholds(settings)}
        showAccountQuota
        showLogoutAll={props.showLogoutAll}
        onAddAccount={props.onAddAccount}
        headerActions={
          <>
            <HelpButton label={t("codexAccounts.accountHelpLabel", "账号说明")}>
              <p>
                {t(
                  "codexAccounts.directSwitchHelp",
                  "登录后的 ChatGPT 账号可以直接切换，并独立查询订阅额度。",
                )}
              </p>
              <p>
                {t(
                  "codexAccounts.restartHint",
                  "切换会更新本地 Codex 登录和配置；已运行的客户端可能需要重新打开才能读取。",
                )}
              </p>
            </HelpButton>
          </>
        }
        currentAccountId={
          props.isSelectionError ? null : props.currentAccountId
        }
        renderAccountHeaderActions={(account, quota) => (
          <AccountSwitchAction
            key={account.id}
            {...props}
            account={account}
            quota={quota}
            onError={(error) =>
              setSwitchErrors((previous) => ({
                ...previous,
                [account.id]: error,
              }))
            }
          />
        )}
        renderAccountActions={(account) => {
          const error = switchErrors[account.id];
          if (error)
            return (
              <p role="alert" className="break-words text-xs text-destructive">
                {t("codexAccounts.switchFailedInline", "切换未完成。")} {error}
              </p>
            );
          if (props.isSelectionError && !props.canReconfirmSelection)
            return (
              <p className="text-xs text-destructive">
                {t(
                  "codexAccounts.connectionLoadFailed",
                  "无法读取连接，请刷新后重试。",
                )}
              </p>
            );
          return null;
        }}
      />
    </section>
  );
}
