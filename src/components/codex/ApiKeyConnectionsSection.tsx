import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Download, Loader2, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ProviderList } from "@/components/providers/ProviderList";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { SectionHeader } from "@/components/ui/section-header";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";
import { extractErrorMessage } from "@/utils/errorUtils";

export interface ApiKeyConnectionsSectionProps {
  providers: Record<string, Provider>;
  currentProviderId: string;
  isLoading?: boolean;
  onSwitch: (provider: Provider) => void;
  onEdit: (provider: Provider) => void;
  onDelete: (provider: Provider) => void;
  onDuplicate: (provider: Provider) => void;
  onConfigureUsage?: (provider: Provider) => void;
  onOpenWebsite: (url: string) => void;
  onAddApiKey: () => void;
}

export function ApiKeyConnectionsSection({
  onAddApiKey,
  ...listProps
}: ApiKeyConnectionsSectionProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const importInFlight = useRef(false);
  const importMutation = useMutation({
    mutationFn: () => providersApi.importDefault("codex"),
    onSuccess: (imported) => {
      if (imported) {
        void queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
        toast.success(t("provider.importCurrentDescription"));
      } else {
        toast.info(t("provider.noProviders"));
      }
    },
    onError: (error: unknown) => {
      toast.error(extractErrorMessage(error) || t("settings.importFailed"));
      void queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
    },
    onSettled: () => {
      importInFlight.current = false;
    },
  });

  return (
    <section className="space-y-4" aria-label="API Key">
      <SectionHeader
        title={t("codexAccounts.configurationsTitle", "API Key")}
        actions={
          <>
            <HelpButton
              label={t("codexAccounts.configurationsHelp", "连接配置用途")}
              className="h-8 w-8"
              align="end"
            >
              <p>
                {t(
                  "codexAccounts.configurationsDescription",
                  "在这里管理 API Key 连接和已保存的高级配置。ChatGPT 订阅额度显示在对应账号卡片中。",
                )}
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start"
                disabled={importMutation.isPending}
                onClick={() => {
                  if (importInFlight.current) return;
                  importInFlight.current = true;
                  importMutation.mutate();
                }}
              >
                {importMutation.isPending ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Download className="h-4 w-4" aria-hidden="true" />
                )}
                {t("provider.importCurrent", "导入当前配置")}
              </Button>
            </HelpButton>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8"
              aria-label={t(
                "codexAccounts.addApiKeyConnection",
                "添加 API Key",
              )}
              onClick={onAddApiKey}
            >
              <Plus className="h-4 w-4" aria-hidden="true" />
            </Button>
          </>
        }
      />
      <ProviderList
        {...listProps}
        appId="codex"
        emptyState={
          <div className="flex min-h-[88px] items-center justify-center rounded-lg border border-dashed border-border px-4 text-sm text-muted-foreground">
            {t("codexAccounts.noApiKeys", "暂无 API Key")}
          </div>
        }
      />
    </section>
  );
}
