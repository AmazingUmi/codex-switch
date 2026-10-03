import {
  getCodexActiveSelection,
  type CodexActiveSelection,
} from "@/lib/api/auth";
import type { ProvidersQueryData } from "@/lib/query/queries";
import { isCodexAccountProvider } from "@/components/codex/accountProviders";
import { forgetApiBalanceCredentials } from "@/hooks/useApiBalance";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { providersApi, settingsApi, type AppId } from "@/lib/api";
import type { ProviderEditorSave, SwitchResult } from "@/lib/api/providers";
import { parseLiveEditConflict } from "@/lib/errors/liveEditConflict";
import type { Provider, Settings } from "@/types";
import {
  extractErrorMessage,
  translatePiProviderMutationError,
} from "@/utils/errorUtils";
import { generateUUID } from "@/utils/uuid";
import { openclawKeys } from "@/hooks/useOpenClaw";
import { invalidateHermesProviderCaches } from "@/hooks/useHermes";
import { usageKeys } from "@/lib/query/usage";
import { invalidatePiProviderCaches } from "@/lib/query/pi";
import { GROKBUILD_OFFICIAL_PROVIDER_ID } from "@/utils/providerCapabilities";

export const useAddProviderMutation = (appId: AppId) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (
      providerInput: Omit<Provider, "id"> & {
        providerKey?: string;
        addToLive?: boolean;
        ensureClaudeDesktopOfficialSeed?: boolean;
        ensureGrokBuildOfficialSeed?: boolean;
        editorSave?: ProviderEditorSave;
      },
    ) => {
      const {
        providerKey: _providerKey,
        addToLive,
        ensureClaudeDesktopOfficialSeed,
        ensureGrokBuildOfficialSeed,
        editorSave,
        ...rest
      } = providerInput;

      if (appId === "claude-desktop" && ensureClaudeDesktopOfficialSeed) {
        await providersApi.ensureClaudeDesktopOfficialProvider();
        const providers = await providersApi.getAll(appId);
        const officialProvider = providers["claude-desktop-official"];
        if (!officialProvider) {
          throw new Error("Claude Desktop official provider was not created");
        }
        return officialProvider;
      }

      if (appId === "grokbuild" && ensureGrokBuildOfficialSeed) {
        await providersApi.ensureGrokBuildOfficialProvider();
        const providers = await providersApi.getAll(appId);
        const officialProvider = providers[GROKBUILD_OFFICIAL_PROVIDER_ID];
        if (!officialProvider) {
          throw new Error("Grok Build official provider was not created");
        }
        return officialProvider;
      }

      let id: string;

      if (
        appId === "opencode" ||
        appId === "openclaw" ||
        appId === "hermes" ||
        appId === "pi" ||
        appId === "mcode"
      ) {
        if (
          providerInput.category === "omo" ||
          providerInput.category === "omo-slim"
        ) {
          const prefix = providerInput.category === "omo" ? "omo" : "omo-slim";
          id = `${prefix}-${generateUUID()}`;
        } else {
          if (!providerInput.providerKey) {
            throw new Error(`Provider key is required for ${appId}`);
          }
          id = providerInput.providerKey;
        }
      } else {
        id = generateUUID();
      }

      const newProvider: Provider = {
        ...rest,
        id,
        createdAt: Date.now(),
      };
      delete (newProvider as any).providerKey;

      await providersApi.add(newProvider, appId, addToLive, editorSave);
      return newProvider;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["omo", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo", "provider-count"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "provider-count"],
        });
      }

      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }

      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }
      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after adding provider",
          trayError,
        );
      }

      toast.success(
        t("notifications.providerAdded", {
          defaultValue: "供应商已添加",
        }),
        {
          closeButton: true,
        },
      );
    },
    onError: (error: Error) => {
      // 编辑冲突由对话框让用户选保留哪一边，不弹失败提示。
      if (parseLiveEditConflict(error)) return;
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.addFailed", {
          defaultValue: "添加供应商失败: {{error}}",
          error: detail,
        }),
      );
    },
    onSettled: async () => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useUpdateProviderMutation = (appId: AppId) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async ({
      provider,
      originalId,
      editorSave,
    }: {
      provider: Provider;
      originalId?: string;
      editorSave?: ProviderEditorSave;
    }) => {
      await providersApi.update(provider, appId, originalId, editorSave);
      return provider;
    },
    onSuccess: async (provider, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      await queryClient.invalidateQueries({
        queryKey: usageKeys.script(provider.id, appId),
      });
      if (variables.originalId && variables.originalId !== provider.id) {
        await queryClient.invalidateQueries({
          queryKey: usageKeys.script(variables.originalId, appId),
        });
      }
      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }
      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }
      toast.success(
        t("notifications.updateSuccess", {
          defaultValue: "供应商更新成功",
        }),
        {
          closeButton: true,
        },
      );
    },
    onError: (error: Error) => {
      if (parseLiveEditConflict(error)) return;
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.updateFailed", {
          defaultValue: "更新供应商失败: {{error}}",
          error: detail,
        }),
      );
    },
    onSettled: async () => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useDeleteProviderMutation = (appId: AppId) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  const clearProviderUsage = async (providerId: string) => {
    await queryClient.cancelQueries({ queryKey: ["api-balance", providerId] });
    queryClient.removeQueries({ queryKey: ["api-balance", providerId] });
    await queryClient.cancelQueries({
      queryKey: usageKeys.script(providerId, appId),
    });
    queryClient.removeQueries({
      queryKey: usageKeys.script(providerId, appId),
    });
    forgetApiBalanceCredentials(providerId);
  };

  const reconcileDeleteError = async (providerId: string) => {
    if (appId !== "codex") return;
    await Promise.all([
      queryClient.cancelQueries({ queryKey: ["providers", appId] }),
      queryClient.cancelQueries({ queryKey: ["codex-active-selection"] }),
    ]);
    const [providersRead] = await Promise.allSettled([
      providersApi.getAll(appId),
      queryClient.fetchQuery({
        queryKey: ["codex-active-selection"],
        queryFn: getCodexActiveSelection,
        staleTime: 0,
        retry: false,
      }),
      queryClient.invalidateQueries({
        queryKey: ["managed-auth-status", "codex_oauth"],
        refetchType: "none",
      }),
    ]);
    if (providersRead.status !== "fulfilled") return;
    const providers = Object.fromEntries(
      Object.entries(providersRead.value).filter(
        ([, provider]) => !isCodexAccountProvider(provider),
      ),
    );
    queryClient.setQueryData<ProvidersQueryData>(
      ["providers", appId],
      (previous) => ({
        ...previous,
        providers,
        currentProviderId:
          previous?.currentProviderId && providers[previous.currentProviderId]
            ? previous.currentProviderId
            : "",
        activeSelection:
          previous?.activeSelection?.kind === "provider" &&
          !providers[previous.activeSelection.providerId]
            ? null
            : previous?.activeSelection,
      }),
    );
    if (!providersRead.value[providerId]) await clearProviderUsage(providerId);
  };

  return useMutation({
    mutationFn: async (providerId: string) => {
      await providersApi.delete(providerId, appId);
    },
    onSuccess: async (_, providerId) => {
      if (appId === "codex") {
        await queryClient.cancelQueries({
          queryKey: ["codex-active-selection"],
        });
        queryClient.setQueryData<CodexActiveSelection>(
          ["codex-active-selection"],
          (selection) =>
            selection?.kind === "provider" &&
            selection.providerId === providerId
              ? null
              : selection,
        );
        await queryClient.invalidateQueries({
          queryKey: ["codex-active-selection"],
        });
        await queryClient.cancelQueries({ queryKey: ["providers", appId] });
        queryClient.setQueryData<ProvidersQueryData>(
          ["providers", appId],
          (previous) => {
            if (!previous) return previous;
            const providers = { ...previous.providers };
            delete providers[providerId];
            const wasCurrent =
              previous.activeSelection?.kind === "provider" &&
              previous.activeSelection.providerId === providerId;
            return {
              ...previous,
              providers,
              activeSelection: wasCurrent ? null : previous.activeSelection,
              currentProviderId: wasCurrent ? "" : previous.currentProviderId,
            };
          },
        );
        await clearProviderUsage(providerId);
        await queryClient.invalidateQueries({
          queryKey: ["managed-auth-status", "codex_oauth"],
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });

      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["omo", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo", "provider-count"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "provider-count"],
        });
      }

      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }

      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }
      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after deleting provider",
          trayError,
        );
      }

      toast.success(
        t("notifications.deleteSuccess", {
          defaultValue: "供应商已删除",
        }),
        {
          closeButton: true,
        },
      );
    },
    onError: async (error: Error, providerId) => {
      const rawDetail = extractErrorMessage(error);
      const detail =
        (appId === "pi"
          ? translatePiProviderMutationError(rawDetail, t)
          : "") ||
        rawDetail ||
        t("common.unknown");
      toast.error(
        t("notifications.deleteFailed", {
          defaultValue: "删除供应商失败: {{error}}",
          error: detail,
        }),
      );
      await reconcileDeleteError(providerId);
    },
    onSettled: async () => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useSwitchProviderMutation = (appId: AppId) => {
  const queryClient = useQueryClient();
  const { t } = useTranslation();

  return useMutation({
    mutationFn: async (providerId: string): Promise<SwitchResult> => {
      return await providersApi.switch(providerId, appId);
    },
    onSuccess: async () => {
      if (appId === "codex") {
        await queryClient.invalidateQueries({
          queryKey: ["codex-active-selection"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["managed-auth-status", "codex_oauth"],
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["providers", appId] });
      if (appId === "claude-desktop") {
        await queryClient.invalidateQueries({
          queryKey: ["claudeDesktopStatus"],
        });
      }

      // OpenCode/OpenClaw: also invalidate live provider IDs cache to update button state
      if (appId === "opencode") {
        await queryClient.invalidateQueries({
          queryKey: ["opencodeLiveProviderIds"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["opencode", "runtime-models"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo", "current-provider-id"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["omo-slim", "current-provider-id"],
        });
      }
      if (appId === "openclaw") {
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.liveProviderIds,
        });
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.defaultModel,
        });
        await queryClient.invalidateQueries({
          queryKey: openclawKeys.health,
        });
      }
      if (appId === "hermes") {
        await invalidateHermesProviderCaches(queryClient);
      }
      try {
        await providersApi.updateTrayMenu();
      } catch (trayError) {
        console.error(
          "Failed to update tray menu after switching provider",
          trayError,
        );
      }
    },
    onError: (error: Error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");

      toast.error(
        t("notifications.switchFailedTitle", { defaultValue: "切换失败" }),
        {
          description: t("notifications.switchFailed", {
            defaultValue: "切换失败：{{error}}",
            error: detail,
          }),
          duration: 6000,
          action: {
            label: t("common.copy", { defaultValue: "复制" }),
            onClick: () => {
              navigator.clipboard?.writeText(detail).catch(() => undefined);
            },
          },
        },
      );
    },
    onSettled: async () => {
      if (appId === "pi") {
        await invalidatePiProviderCaches(queryClient);
      }
    },
  });
};

export const useSaveSettingsMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (settings: Settings) => {
      await settingsApi.save(settings);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      await queryClient.invalidateQueries({
        queryKey: ["opencode", "runtime-models"],
      });
    },
  });
};
