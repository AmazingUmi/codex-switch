import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Check, CircleHelp, Loader2 } from "lucide-react";
import type { Provider } from "@/types";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  /** Effective provider from the existing direct/routing/failover state. */
  currentProviderId: string;
  /** Creates an account's missing binding and switches only after validation. */
  onSwitchAccount: (
    accountId: string,
    providerId?: string,
  ) => void | Promise<unknown>;
  /** Retained for callers migrating from configuration management. */
  onSwitchProvider?: (provider: Provider) => void | Promise<unknown>;
  onCreateConfiguration?: (accountId: string) => void;
  isSwitching?: boolean;
  isLoadingProviders?: boolean;
  isProvidersError?: boolean;
}

function AccountConfigurationActions({
  account,
  ...props
}: CodexAccountsPanelProps & { account: ManagedAuthAccount }) {
  const { t } = useTranslation();
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const [pending, setPending] = useState(false);
  const [switchError, setSwitchError] = useState<string | null>(null);
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
    setSwitchError(null);
    try {
      await props.onSwitchAccount(account.id, selected?.id);
    } catch (error) {
      setSwitchError(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="space-y-2 border-t border-border/60 pt-3">
      <div className="flex min-w-0 items-center justify-end gap-2">
        {configurations.length > 1 && (
          <details className="min-w-0 flex-1 text-xs text-muted-foreground">
            <summary className="w-fit cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t("codexAccounts.advancedConfiguration", "高级连接")}
            </summary>
            <Select
              value={selected?.id ?? "__automatic__"}
              onValueChange={(value) =>
                setSelectedProviderId(value === "__automatic__" ? "" : value)
              }
              disabled={isPending}
            >
              <SelectTrigger
                className="mt-2 h-8 w-full min-w-0"
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
          </details>
        )}
        <Button
          type="button"
          size="sm"
          className="h-8 shrink-0 gap-1.5"
          variant={isCurrentSelection ? "outline" : "default"}
          title={
            isCurrentSelection
              ? t("codexAccounts.current", "当前使用")
              : t("codexAccounts.switch", "切换到此账号")
          }
          aria-label={
            isCurrentSelection
              ? t("codexAccounts.current", "当前使用")
              : t("codexAccounts.switch", "切换到此账号")
          }
          disabled={
            isCurrentSelection ||
            cannotSwitch ||
            isPending ||
            props.isLoadingProviders ||
            props.isProvidersError
          }
          onClick={() => void switchAccount()}
        >
          {isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : isCurrentSelection ? (
            <Check className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {isCurrentSelection
            ? t("codexAccounts.current", "当前使用")
            : t("codexAccounts.switch", "切换到此账号")}
        </Button>
      </div>
      {switchError && (
        <p role="alert" className="break-words text-xs text-destructive">
          {t("codexAccounts.switchFailedInline", "切换未完成。")} {switchError}
        </p>
      )}
      {props.isProvidersError && (
        <p className="text-xs text-destructive">
          {t(
            "codexAccounts.connectionLoadFailed",
            "无法读取连接，请刷新后重试。",
          )}
        </p>
      )}
    </div>
  );
}

export function CodexAccountsPanel(props: CodexAccountsPanelProps) {
  const { t } = useTranslation();
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
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground"
                  title={t("codexAccounts.helpLabel", "账号与额度说明")}
                  aria-label={t("codexAccounts.helpLabel", "账号与额度说明")}
                >
                  <CircleHelp className="h-4 w-4" aria-hidden="true" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-4 text-xs leading-relaxed"
                aria-label={t("codexAccounts.helpLabel", "账号与额度说明")}
              >
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
                <p>
                  {t(
                    "codexAccounts.helpQuota",
                    "百分比表示已使用额度。5 小时与每周额度分别计算，并显示各自的重置时间；以账号实际返回的额度窗口为准。",
                  )}
                </p>
                <p>
                  {t(
                    "codexAccounts.credentialStoreHelp",
                    "账号切换目前支持文件凭据存储（file）。高级配置使用钥匙串、自动或内存存储时，会保留原设置并说明无法切换的原因。",
                  )}
                </p>
              </PopoverContent>
            </Popover>
          </>
        }
        currentAccountId={getCurrentCodexAccountId(
          props.providers,
          props.currentProviderId,
        )}
        renderAccountActions={(account) => (
          <AccountConfigurationActions
            key={account.id}
            {...props}
            account={account}
          />
        )}
      />
    </section>
  );
}
