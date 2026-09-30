import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Plus } from "lucide-react";
import type { Provider } from "@/types";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";
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
  onSwitchProvider: (provider: Provider) => void | Promise<unknown>;
  onCreateConfiguration: (accountId: string) => void;
  isSwitching?: boolean;
  isLoadingProviders?: boolean;
  isProvidersError?: boolean;
}

function AccountConfigurationActions({
  account,
  providers,
  currentProviderId,
  onSwitchProvider,
  onCreateConfiguration,
  isSwitching,
  isLoadingProviders,
  isProvidersError,
}: CodexAccountsPanelProps & { account: ManagedAuthAccount }) {
  const { t } = useTranslation();
  const [selectedProviderId, setSelectedProviderId] = useState("");
  const configurations = getCodexAccountProviders(providers, account.id);
  const current = configurations.find(
    (provider) => provider.id === currentProviderId,
  );
  const selected =
    configurations.find((provider) => provider.id === selectedProviderId) ??
    current ??
    (configurations.length === 1 ? configurations[0] : undefined);

  if (isLoadingProviders || isProvidersError) {
    return (
      <p className="border-t pt-3 text-xs text-muted-foreground">
        {isProvidersError
          ? t("codexAccounts.configurationUnavailable", "当前配置不可用")
          : t("codexAccounts.configurationLoading", "正在加载配置…")}
      </p>
    );
  }

  if (configurations.length === 0) {
    return (
      <div className="space-y-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">
          {t(
            "codexAccounts.unbound",
            "配置此账号后即可切换 Codex 使用的账号。",
          )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!!account.reauth_required || isSwitching}
          onClick={() => onCreateConfiguration(account.id)}
        >
          <Plus className="h-3.5 w-3.5" />
          {t("codexAccounts.configure", "配置账号")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 border-t pt-3">
      {configurations.length > 1 ? (
        <Select
          value={selected?.id ?? ""}
          onValueChange={setSelectedProviderId}
          disabled={isSwitching}
        >
          <SelectTrigger
            className="h-8 min-w-0 flex-1"
            aria-label={`${t("codexAccounts.configuration", "账号配置")}: ${account.login}`}
          >
            <SelectValue
              placeholder={t("codexAccounts.chooseConfiguration", "选择配置")}
            />
          </SelectTrigger>
          <SelectContent>
            {configurations.map((provider) => (
              <SelectItem key={provider.id} value={provider.id}>
                {provider.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
          title={configurations[0].name}
        >
          {configurations[0].name}
        </span>
      )}
      <Button
        type="button"
        size="sm"
        variant={selected?.id === currentProviderId ? "outline" : "default"}
        disabled={
          !selected ||
          selected.id === currentProviderId ||
          !!account.reauth_required ||
          isSwitching
        }
        onClick={() => {
          if (selected) void onSwitchProvider(selected);
        }}
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
        {selected?.id === currentProviderId
          ? t("codexAccounts.current", "当前使用")
          : t("codexAccounts.switch", "切换到此账号")}
      </Button>
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
  const identityLabel =
    currentIdentity === "native_login"
      ? t("codexAccounts.nativeLogin", "原生 Codex 登录")
      : currentIdentity === "api_key"
        ? t("codexAccounts.apiKey", "OpenAI API")
        : currentIdentity === "managed_account"
          ? t("codexAccounts.managedAccount", "ChatGPT 账号")
          : t("codexAccounts.customConfiguration", "自定义配置");
  return (
    <section
      className="space-y-5"
      aria-label={t("codexAccounts.title", "ChatGPT 账号")}
    >
      <div className="space-y-1">
        <h2 className="text-xl font-semibold tracking-tight">
          {t("codexAccounts.title", "ChatGPT 账号")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "codexAccounts.description",
            "查看每个账号的额度与重置时间，并选择 Codex 使用的账号。默认账号用于未指定账号的托管认证。",
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {t(
            "codexAccounts.restartHint",
            "切换后，请重启正在运行的 Codex 客户端以使用新的账号配置。",
          )}
        </p>
      </div>
      <div
        className="flex min-w-0 flex-wrap items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm"
        data-testid="current-codex-configuration"
      >
        <span className="shrink-0 text-muted-foreground">
          {t("codexAccounts.currentConfiguration", "当前 Codex 配置")}
        </span>
        {currentProvider ? (
          <>
            <span
              className="min-w-0 truncate font-medium"
              title={currentProvider.name}
            >
              {currentProvider.name}
            </span>
            <Badge variant="outline" className="shrink-0">
              {identityLabel}
            </Badge>
          </>
        ) : (
          <span className="text-muted-foreground">
            {props.isLoadingProviders
              ? t("codexAccounts.configurationLoading", "正在加载配置…")
              : t("codexAccounts.configurationUnavailable", "当前配置不可用")}
          </span>
        )}
      </div>
      <CodexOAuthSection
        presentation="cards"
        showAccountQuota
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
