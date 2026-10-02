import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Check, Loader2 } from "lucide-react";
import type { Provider } from "@/types";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { Label } from "@/components/ui/label";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";
import { useCodexOauthQuotaByAccountId } from "@/lib/query/subscription";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getCodexAccountProviders,
  getCurrentCodexAccountId,
} from "./accountProviders";

export interface CodexAccountsPanelProps {
  providers: Provider[];
  /** Provider currently written to the native Codex configuration. */
  currentProviderId: string;
  /** Creates an account's missing binding and switches only after validation. */
  onSwitchAccount: (
    accountId: string,
    providerId?: string,
  ) => void | Promise<unknown>;
  /** Retained for callers migrating from configuration management. */
  onSwitchProvider?: (provider: Provider) => void | Promise<unknown>;
  onCreateConfiguration?: (accountId: string) => void;
  onAddAccount?: (startLogin: () => void) => void;
  isSwitching?: boolean;
  isLoadingProviders?: boolean;
  isProvidersError?: boolean;
  /** Optional bulk operation below the account list. */
  showLogoutAll?: boolean;
}

function AccountSwitchAction({
  account,
  selectedProviderId,
  onError,
  onPendingChange,
  ...props
}: CodexAccountsPanelProps & {
  account: ManagedAuthAccount;
  selectedProviderId?: string;
  onError: (error: string | null) => void;
  onPendingChange: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const configurations = getCodexAccountProviders(props.providers, account.id);
  const selected = configurations.find(
    (provider) => provider.id === selectedProviderId,
  );
  const isCurrent =
    getCurrentCodexAccountId(props.providers, props.currentProviderId) ===
    account.id;
  const isCurrentSelection =
    isCurrent && (!selected || selected.id === props.currentProviderId);
  const isPending = pending || props.isSwitching;
  // Observe the card's account-scoped result without starting another request.
  const { data: quota } = useCodexOauthQuotaByAccountId(account.id, {
    enabled: false,
    autoQuery: false,
  });
  const cannotSwitch =
    !!account.reauth_required ||
    !!account.requires_reauth ||
    quota?.credentialStatus === "expired" ||
    quota?.credentialStatus === "not_found";

  const switchAccount = async () => {
    setPending(true);
    onPendingChange(true);
    onError(null);
    try {
      await props.onSwitchAccount(account.id, selected?.id);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
      onPendingChange(false);
    }
  };

  const label = isCurrentSelection
    ? t("codexAccounts.current", "当前使用")
    : t("codexAccounts.switch", "切换到此账号");
  const disabledReason = isPending
    ? t("codexAccounts.switchPending", "正在切换账号…")
    : props.isProvidersError
      ? t("codexAccounts.connectionLoadFailed", "无法读取连接，请刷新后重试。")
      : props.isLoadingProviders
        ? t("codexOauth.statusLoading", "正在加载...")
        : cannotSwitch
          ? t("codexAccounts.quotaExpiredHint", "请进入“编辑账号”重新登录。")
          : isCurrentSelection
            ? label
            : null;

  return (
    <>
      <Button
        type="button"
        size="icon"
        className="h-7 w-7 shrink-0 rounded-full"
        variant={isCurrentSelection ? "outline" : "default"}
        title={disabledReason ?? label}
        aria-label={label}
        disabled={!!disabledReason}
        onClick={() => void switchAccount()}
      >
        {isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : isCurrentSelection ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
      {disabledReason && !isCurrentSelection && (
        <HelpButton
          label={t("codexAccounts.switchUnavailable", "为何无法切换")}
        >
          <p>{disabledReason}</p>
        </HelpButton>
      )}
    </>
  );
}

export function CodexAccountsPanel(props: CodexAccountsPanelProps) {
  const { t } = useTranslation();
  const [selectedProviders, setSelectedProviders] = useState<
    Record<string, string>
  >({});
  const [draftProviders, setDraftProviders] = useState<Record<string, string>>(
    {},
  );
  const [pendingAccounts, setPendingAccounts] = useState<
    Record<string, boolean>
  >({});
  const [switchErrors, setSwitchErrors] = useState<
    Record<string, string | null>
  >({});
  const currentProvider = props.providers.find(
    (provider) => provider.id === props.currentProviderId,
  );
  const currentIdentity = currentProvider
    ? resolveCodexOfficialIdentity("codex", currentProvider)
    : null;
  return (
    <section
      className="space-y-3"
      aria-label={t("codexAccounts.title", "ChatGPT 账号")}
    >
      <CodexOAuthSection
        presentation="cards"
        showAccountQuota
        showLogoutAll={props.showLogoutAll}
        onAddAccount={props.onAddAccount}
        headerActions={
          <>
            {currentProvider &&
              currentIdentity !== "managed_account" &&
              currentIdentity !== "native_login" && (
                <span
                  className="min-w-0 truncate text-xs text-muted-foreground"
                  title={currentProvider.name}
                  data-testid="current-api-connection"
                >
                  {currentProvider.name}
                </span>
              )}
            <HelpButton label={t("codexAccounts.accountHelpLabel", "账号说明")}>
              <p>
                {t(
                  "codexAccounts.directSwitchHelp",
                  "登录后的 ChatGPT 账号可以直接切换。默认账号仅供高级托管配置使用，与当前使用的账号无关。",
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
        currentAccountId={getCurrentCodexAccountId(
          props.providers,
          props.currentProviderId,
        )}
        renderAccountHeaderActions={(account) => (
          <AccountSwitchAction
            key={account.id}
            {...props}
            account={account}
            selectedProviderId={selectedProviders[account.id]}
            onPendingChange={(pending) =>
              setPendingAccounts((previous) => ({
                ...previous,
                [account.id]: pending,
              }))
            }
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
          if (props.isProvidersError)
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
        onAccountEditOpened={(account) =>
          setDraftProviders((previous) => ({
            ...previous,
            [account.id]: selectedProviders[account.id] ?? "",
          }))
        }
        onAccountEditSaved={(account) =>
          setSelectedProviders((previous) => ({
            ...previous,
            [account.id]: draftProviders[account.id] ?? "",
          }))
        }
        renderAccountEditOptions={(account) => {
          const configurations = getCodexAccountProviders(
            props.providers,
            account.id,
          );
          if (configurations.length <= 1) return null;
          const selected = configurations.find(
            (provider) => provider.id === draftProviders[account.id],
          );
          return (
            <div className="space-y-1.5">
              <Label htmlFor="codex-account-configuration">
                {t("codexAccounts.advancedConfiguration", "高级连接")}
              </Label>
              <Select
                value={selected?.id ?? "__automatic__"}
                onValueChange={(value) =>
                  setDraftProviders((previous) => ({
                    ...previous,
                    [account.id]: value === "__automatic__" ? "" : value,
                  }))
                }
                disabled={
                  pendingAccounts[account.id] ||
                  props.isSwitching ||
                  props.isLoadingProviders ||
                  props.isProvidersError
                }
              >
                <SelectTrigger
                  id="codex-account-configuration"
                  className="h-8 w-full min-w-0"
                  aria-label={`${t("codexAccounts.configuration", "账号配置")}: ${account.login}`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__automatic__">
                    {t("codexAccounts.automaticConfiguration", "自动选择")}
                  </SelectItem>
                  {configurations.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          );
        }}
      />
    </section>
  );
}
