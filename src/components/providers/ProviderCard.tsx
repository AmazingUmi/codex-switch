import { useMemo } from "react";
import { GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import type { Provider } from "@/types";
import { cn } from "@/lib/utils";
import { ProviderActions } from "@/components/providers/ProviderActions";
import { ProviderIcon } from "@/components/ProviderIcon";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";
import { providerSupportsDirectConnection } from "@/utils/providerCapabilities";
import { resolveProviderIcon } from "@/utils/providerIcon";
import { ProviderStatusBadge } from "@/components/providers/ProviderStatusBadge";
import { ApiBalance } from "@/components/providers/ApiBalance";
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
  onDelete,
  onOpenWebsite,
  onTest,
  isTesting,
  dragHandleProps,
}: ProviderCardProps) {
  const { t } = useTranslation();
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

  const unsupportedDirect = !providerSupportsDirectConnection(appId, provider);

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
                className="text-base font-semibold leading-none min-w-0 flex-1 truncate"
                title={provider.name}
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

            {displayUrl ? (
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
              <ApiBalance provider={provider} />
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
              onDelete={() => onDelete(provider)}
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
    </div>
  );
}
