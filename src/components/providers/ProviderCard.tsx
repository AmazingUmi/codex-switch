import { useMemo, useState, useEffect } from "react";
import {
  AlertTriangle,
  GripVertical,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import type { Provider } from "@/types";
import { authApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ProviderActions } from "@/components/providers/ProviderActions";
import { ProviderIcon } from "@/components/ProviderIcon";
import UsageFooter from "@/components/UsageFooter";
import SubscriptionQuotaFooter from "@/components/SubscriptionQuotaFooter";
import CopilotQuotaFooter from "@/components/CopilotQuotaFooter";
import CodexOauthQuotaFooter from "@/components/CodexOauthQuotaFooter";
import XaiOauthQuotaFooter from "@/components/XaiOauthQuotaFooter";
import { PROVIDER_TYPES, TEMPLATE_TYPES } from "@/config/constants";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
} from "@/utils/providerConfigUtils";
import { resolveManagedAccountId } from "@/lib/authBinding";
import {
  resolveCodexOfficialIdentity,
  providerSupportsDirectConnection,
} from "@/utils/providerCapabilities";
import { useUsageQuery } from "@/lib/query/queries";
import { resolveProviderIcon } from "@/utils/providerIcon";
import { ProviderStatusBadge } from "@/components/providers/ProviderStatusBadge";
import { ApiBalance } from "@/components/providers/ApiBalance";
import {
  isApiBalanceConnection,
  resolveApiBalanceCredentials,
  supportsApiBalance,
} from "@/utils/apiBalance";

interface DragHandleProps {
  attributes: DraggableAttributes;
  listeners: DraggableSyntheticListeners;
  isDragging: boolean;
}

interface ProviderCardProps {
  provider: Provider;
  isCurrent: boolean;
  appId: "codex";
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onConfigureUsage: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onDuplicate: (provider: Provider) => void;
  onTest?: (provider: Provider) => void;
  onOpenTerminal?: (provider: Provider) => void;
  isTesting?: boolean;
  dragHandleProps?: DragHandleProps;
}

/** 判断是否为官方供应商（无自定义 base URL / API key，直连官方 API） */
function isOfficialProvider(provider: Provider): boolean {
  if (provider.category === "official") {
    return true;
  }

  const config = provider.settingsConfig as Record<string, any>;
  // 无 OPENAI_API_KEY → 使用 Codex CLI 内置 OAuth（官方）
  const apiKey = config?.auth?.OPENAI_API_KEY;
  const bearerToken =
    typeof config?.config === "string"
      ? extractCodexExperimentalBearerToken(config.config)
      : undefined;
  return (
    !bearerToken &&
    (!apiKey || (typeof apiKey === "string" && apiKey.trim() === ""))
  );
}

const extractApiUrl = (provider: Provider, fallbackText: string) => {
  if (provider.notes?.trim()) {
    return provider.notes.trim();
  }

  if (provider.websiteUrl) {
    return provider.websiteUrl;
  }

  const config = provider.settingsConfig;

  if (config && typeof config === "object") {
    const object = config as Record<string, any>;
    const envBase =
      object?.env?.ANTHROPIC_BASE_URL || object?.env?.GOOGLE_GEMINI_BASE_URL;
    if (typeof envBase === "string" && envBase.trim()) {
      return envBase;
    }

    const directBaseUrl =
      object.baseUrl ||
      object.base_url ||
      object.options?.baseURL ||
      (Array.isArray(object.models)
        ? object.models.find(
            (model: unknown) =>
              model &&
              typeof model === "object" &&
              typeof (model as Record<string, unknown>).baseUrl === "string",
          )?.baseUrl
        : undefined);
    if (typeof directBaseUrl === "string" && directBaseUrl.trim()) {
      return directBaseUrl;
    }

    const baseUrl = object.config;

    if (typeof baseUrl === "string" && baseUrl.includes("base_url")) {
      const extractedBaseUrl = extractCodexBaseUrl(baseUrl);
      if (extractedBaseUrl) {
        return extractedBaseUrl;
      }
    }
  }

  return fallbackText;
};

export function ProviderCard({
  provider,
  isCurrent,
  appId,
  onSwitch,
  onEdit,
  onOpenWebsite,
  onTest,
  isTesting,
  dragHandleProps,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const codexOfficialIdentity = resolveCodexOfficialIdentity(appId, provider);
  const managedCodexAccountId = resolveManagedAccountId(
    provider.meta,
    "codex_oauth",
  )?.trim();
  const {
    data: codexAuthStatus,
    isSuccess: isCodexAuthStatusSuccess,
    isError: isCodexAuthStatusError,
  } = useQuery({
    queryKey: ["managed-auth-status", "codex_oauth"],
    queryFn: () => authApi.authGetStatus("codex_oauth"),
    enabled:
      codexOfficialIdentity === "managed_account" &&
      Boolean(managedCodexAccountId),
    staleTime: 30_000,
  });
  const managedCodexAccount = codexAuthStatus?.accounts.find(
    (account) => account.id === managedCodexAccountId,
  );
  const manualNote = provider.notes?.trim() || undefined;
  const providerNameIncludesAccountLogin = Boolean(
    managedCodexAccount?.login &&
      (provider.name.trim() === managedCodexAccount.login ||
        provider.name.trim() ===
          `OpenAI Official (${managedCodexAccount.login})`),
  );

  const fallbackUrlText = t("provider.notConfigured", {
    defaultValue: "未配置接口地址",
  });

  const displayUrl = useMemo(() => {
    return extractApiUrl(provider, fallbackUrlText);
  }, [provider, fallbackUrlText]);

  const isClickableUrl = useMemo(() => {
    if (provider.notes?.trim()) {
      return false;
    }
    if (displayUrl === fallbackUrlText) {
      return false;
    }
    return true;
  }, [provider.notes, displayUrl, fallbackUrlText]);

  const isBoundCodexOfficial = codexOfficialIdentity === "managed_account";
  const usageEnabled =
    provider.meta?.usage_script?.enabled ?? isBoundCodexOfficial;
  const isOfficial = isOfficialProvider(provider);
  const isOfficialSubscriptionUsage =
    provider.meta?.usage_script?.templateType ===
    TEMPLATE_TYPES.OFFICIAL_SUBSCRIPTION;
  const officialSubscriptionEnabled =
    isOfficial && usageEnabled && isOfficialSubscriptionUsage;
  const isCopilot =
    provider.meta?.providerType === PROVIDER_TYPES.GITHUB_COPILOT ||
    provider.meta?.usage_script?.templateType === "github_copilot";
  const isCodexOauth = isBoundCodexOfficial;
  // xAI OAuth (SuperGrok 反代)：额度经自管 OAuth token 自动显示，与 codex_oauth 同构
  const isXaiOauth = provider.meta?.providerType === PROVIDER_TYPES.XAI_OAUTH;
  const unsupportedDirect = !providerSupportsDirectConnection(appId, provider);
  const hasNativeBalance = supportsApiBalance(
    resolveApiBalanceCredentials(provider).baseUrl,
  );
  const showApiBalance =
    isApiBalanceConnection(provider) &&
    !isCopilot &&
    !isCodexOauth &&
    !isXaiOauth &&
    (codexOfficialIdentity === "api_key" || provider.category !== "official") &&
    (!usageEnabled ||
      hasNativeBalance ||
      provider.meta?.usage_script?.templateType === TEMPLATE_TYPES.BALANCE);
  // 获取用量数据以判断是否有多套餐
  const autoQueryInterval = isCurrent
    ? provider.meta?.usage_script?.autoQueryInterval || 0
    : 0;

  // 脚本用量只在「已启用 + 非官方 + 非官方订阅模板」时才查询；展开判定必须复用同一谓词，
  // 因为禁用的 React Query observer 仍会返回同 key 的旧缓存。
  const scriptUsageActive =
    usageEnabled &&
    !isOfficial &&
    !isOfficialSubscriptionUsage &&
    !showApiBalance;
  const { data: usage } = useUsageQuery(provider.id, appId, {
    enabled: scriptUsageActive,
    autoQueryInterval,
  });

  const isTokenPlan =
    provider.meta?.usage_script?.templateType === "token_plan";
  // 官方订阅的额度窗口不能按普通多套餐展开；缓存残留的旧脚本结果同样不认。
  const hasMultiplePlans =
    scriptUsageActive &&
    !isTokenPlan &&
    usage?.success &&
    usage.data &&
    usage.data.length > 1;

  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    if (hasMultiplePlans) {
      setIsExpanded(true);
    }
  }, [hasMultiplePlans]);

  const handleOpenWebsite = () => {
    if (!isClickableUrl) {
      return;
    }
    onOpenWebsite(displayUrl);
  };

  const hasStateHighlight = isCurrent;

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border border-border p-4 transition-all duration-300",
        "bg-card text-card-foreground group",
        "hover:border-border-active",
        isCurrent && "border-blue-500/60 shadow-sm shadow-blue-500/10",
        !hasStateHighlight && "hover:shadow-sm",
        dragHandleProps?.isDragging &&
          "cursor-grabbing border-primary shadow-lg scale-105 z-10",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 bg-gradient-to-r to-transparent transition-opacity duration-500 pointer-events-none",
          isCurrent && "from-blue-500/10",
          !hasStateHighlight && "from-primary/10",
          hasStateHighlight ? "opacity-100" : "opacity-0",
        )}
      />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {dragHandleProps && (
            <button
              type="button"
              className={cn(
                "-ml-1.5 flex-shrink-0 cursor-grab active:cursor-grabbing p-1.5",
                "text-muted-foreground/50 hover:text-muted-foreground transition-colors",
                dragHandleProps.isDragging && "cursor-grabbing",
              )}
              aria-label={t("provider.dragHandle")}
              {...dragHandleProps.attributes}
              {...dragHandleProps.listeners}
            >
              <GripVertical className="h-4 w-4" />
            </button>
          )}

          <div className="h-8 w-8 flex-shrink-0 rounded-lg bg-muted flex items-center justify-center border border-border group-hover:scale-105 transition-transform duration-300">
            <ProviderIcon
              icon={resolveProviderIcon(
                appId,
                provider.icon,
                provider.iconColor,
              )}
              name={provider.name}
              color={provider.iconColor}
              size={20}
            />
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2 min-h-7">
              <h3
                className={cn(
                  "text-base font-semibold leading-none",
                  codexOfficialIdentity && "min-w-0 flex-1 truncate",
                )}
                title={codexOfficialIdentity ? provider.name : undefined}
              >
                {provider.name}
              </h3>

              {unsupportedDirect && (
                <ProviderStatusBadge
                  tone="warning"
                  label={t("provider.unsupportedDirect", {
                    defaultValue: "不支持直连",
                  })}
                  title={t("notifications.directConnectionRequired", {
                    defaultValue:
                      "仅支持 Codex 原生 Responses 直连和 OpenAI 官方账号。请编辑旧配置后再启用。",
                  })}
                />
              )}
            </div>

            {codexOfficialIdentity && codexOfficialIdentity !== "api_key" ? (
              <div className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground">
                {codexOfficialIdentity === "native_login" ? (
                  <span className="min-w-0 truncate" title={manualNote}>
                    {manualNote ??
                      t("codex.followCodexLoginDescription", {
                        defaultValue: "账号会随 Codex CLI 当前登录变化",
                      })}
                  </span>
                ) : managedCodexAccount ? (
                  <>
                    <span
                      className="min-w-0 truncate"
                      title={manualNote ?? managedCodexAccount.login}
                    >
                      {manualNote ??
                        (providerNameIncludesAccountLogin
                          ? t("codex.openAiAccount", {
                              defaultValue: "OpenAI 账号",
                            })
                          : managedCodexAccount.login)}
                    </span>
                    {managedCodexAccount.reauth_required && (
                      <span className="inline-flex shrink-0 items-center gap-1 text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3.5 w-3.5" />
                        {t("codexOauth.reauthBadge", "需要重新登录")}
                      </span>
                    )}
                  </>
                ) : isCodexAuthStatusError ? (
                  <span className="inline-flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-300">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                    <span className="truncate">
                      {t("codex.accountStatusUnavailable", {
                        defaultValue: "无法读取账号信息",
                      })}
                    </span>
                  </span>
                ) : isCodexAuthStatusSuccess ? (
                  <>
                    <span className="inline-flex min-w-0 items-center gap-1 text-sm text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      <span className="truncate">
                        {t("codex.boundAccountUnavailable", {
                          defaultValue: "绑定的账号不可用",
                        })}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="shrink-0 text-sm font-medium text-primary hover:underline"
                      onClick={() => onEdit(provider)}
                    >
                      {t("codex.chooseAccount", {
                        defaultValue: "选择账号",
                      })}
                    </button>
                  </>
                ) : (
                  <span className="min-w-0 truncate">
                    {t("codex.accountLoading", {
                      defaultValue: "正在加载账号…",
                    })}
                  </span>
                )}
              </div>
            ) : displayUrl ? (
              <button
                type="button"
                onClick={handleOpenWebsite}
                className={cn(
                  "inline-flex max-w-full items-center overflow-hidden text-left text-sm",
                  isClickableUrl
                    ? "text-blue-500 transition-colors hover:underline dark:text-blue-400 cursor-pointer"
                    : "text-muted-foreground cursor-default",
                )}
                title={displayUrl}
                disabled={!isClickableUrl}
              >
                <span className="min-w-0 truncate">{displayUrl}</span>
              </button>
            ) : null}
          </div>
        </div>

        <div className="flex items-center ml-auto min-w-0 gap-3">
          <div className="ml-auto">
            <div className="flex items-center gap-1">
              {isCopilot ? (
                <CopilotQuotaFooter
                  meta={provider.meta}
                  inline={true}
                  isCurrent={isCurrent}
                />
              ) : isCodexOauth ? (
                !isBoundCodexOfficial || usageEnabled ? (
                  <CodexOauthQuotaFooter
                    meta={provider.meta}
                    inline={true}
                    isCurrent={isCurrent}
                    autoQueryInterval={
                      isBoundCodexOfficial
                        ? (provider.meta?.usage_script?.autoQueryInterval ?? 5)
                        : undefined
                    }
                  />
                ) : null
              ) : isXaiOauth ? (
                <XaiOauthQuotaFooter
                  meta={provider.meta}
                  inline={true}
                  isCurrent={isCurrent}
                />
              ) : showApiBalance ? (
                <ApiBalance provider={provider} />
              ) : isOfficial ? (
                officialSubscriptionEnabled ? (
                  <SubscriptionQuotaFooter
                    appId={appId}
                    inline={true}
                    isCurrent={isCurrent}
                    autoQueryInterval={
                      provider.meta?.usage_script?.autoQueryInterval ?? 0
                    }
                  />
                ) : null
              ) : hasMultiplePlans ? (
                <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium">
                    {t("usage.multiplePlans", {
                      count: usage?.data?.length || 0,
                      defaultValue: `${usage?.data?.length || 0} 个套餐`,
                    })}
                  </span>
                </div>
              ) : (
                <UsageFooter
                  provider={provider}
                  providerId={provider.id}
                  appId={appId}
                  usageEnabled={usageEnabled}
                  isCurrent={isCurrent}
                  isInConfig={true}
                  inline={true}
                />
              )}
              {hasMultiplePlans && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsExpanded(!isExpanded);
                  }}
                  className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors text-gray-500 dark:text-gray-400 flex-shrink-0"
                  title={
                    isExpanded
                      ? t("usage.collapse", { defaultValue: "收起" })
                      : t("usage.expand", { defaultValue: "展开" })
                  }
                >
                  {isExpanded ? (
                    <ChevronUp size={14} />
                  ) : (
                    <ChevronDown size={14} />
                  )}
                </button>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            <ProviderActions
              appId={appId}
              isCurrent={isCurrent}
              isTesting={isTesting}
              switchDisabledReason={
                unsupportedDirect
                  ? t("notifications.directConnectionRequired", {
                      defaultValue:
                        "仅支持 Codex 原生 Responses 直连和 OpenAI 官方账号。请编辑旧配置后再启用。",
                    })
                  : undefined
              }
              onSwitch={() => onSwitch(provider)}
              onEdit={() => onEdit(provider)}
              onTest={
                // 连通检测对第三方/自定义/Copilot/Codex-OAuth 供应商开放（这些正是旧的
                // 真实请求探测会误报、而可达性探测能正确处理的对象）。官方供应商
                // (category === "official") 一律隐藏：它们 base_url 故意留空、走客户端
                // 默认/OAuth 端点，无法提供可靠的探测目标。
                onTest && provider.category !== "official"
                  ? () => onTest(provider)
                  : undefined
              }
            />
          </div>
        </div>
      </div>

      {isExpanded && hasMultiplePlans && (
        <div className="mt-4 pt-4 border-t border-border-default">
          <UsageFooter
            provider={provider}
            providerId={provider.id}
            appId={appId}
            usageEnabled={usageEnabled}
            isCurrent={isCurrent}
            isInConfig={true}
            inline={false}
          />
        </div>
      )}
    </div>
  );
}
