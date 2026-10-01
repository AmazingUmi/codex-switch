import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRightLeft, Check, CircleHelp, Plus } from "lucide-react";
import type { Provider } from "@/types";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
      <div className="flex justify-end border-t pt-3">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-8 w-8"
          title={t("codexAccounts.configure", "配置账号")}
          aria-label={t("codexAccounts.configure", "配置账号")}
          disabled={!!account.reauth_required || isSwitching}
          onClick={() => onCreateConfiguration(account.id)}
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" />
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
        size="icon"
        className="h-8 w-8 shrink-0"
        title={
          selected?.id === currentProviderId
            ? t("codexAccounts.current", "当前使用")
            : t("codexAccounts.switch", "切换到此账号")
        }
        aria-label={
          selected?.id === currentProviderId
            ? t("codexAccounts.current", "当前使用")
            : t("codexAccounts.switch", "切换到此账号")
        }
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
        {selected?.id === currentProviderId ? (
          <Check className="h-3.5 w-3.5" aria-hidden="true" />
        ) : (
          <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
        )}
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
        <Popover>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-7 w-7 shrink-0 text-muted-foreground"
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
                "codexAccounts.helpBinding",
                "“默认”账号用于未指定账号的托管认证；“当前使用”来自 Codex 当前生效的配置，两者可以不同。",
              )}
            </p>
            <p>
              {t(
                "codexAccounts.restartHint",
                "切换后，请重启正在运行的 Codex 客户端以使用新的账号配置。",
              )}
            </p>
            <p>
              {t(
                "codexAccounts.helpQuota",
                "百分比表示已使用额度。5 小时与每周额度分别计算，并显示各自的重置时间；以账号实际返回的额度窗口为准。",
              )}
            </p>
          </PopoverContent>
        </Popover>
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
