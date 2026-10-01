import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Settings,
  Minus,
  Maximize2,
  Minimize2,
  X,
  BarChart2,
  Users,
} from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Provider, VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import { proxyKeys, useProvidersQuery, useSettingsQuery } from "@/lib/query";
import {
  providersApi,
  settingsApi,
  type AppId,
  type ProviderSwitchEvent,
} from "@/lib/api";
import { checkEnvConflicts } from "@/lib/api/env";
import { useProviderActions } from "@/hooks/useProviderActions";
import { useCodexAccountSwitch } from "@/hooks/useCodexAccountSwitch";
import type { ProviderEditorSave } from "@/lib/api/providers";
import { useProxyStatus } from "@/hooks/useProxyStatus";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useLastValidValue } from "@/hooks/useLastValidValue";
import { useAutoFailoverEnabled } from "@/lib/query/failover";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isTextEditableTarget } from "@/utils/domUtils";
import { deepClone } from "@/utils/deepClone";
import {
  isWindows,
  isLinux,
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
} from "@/lib/platform";
import { ProviderList } from "@/components/providers/ProviderList";
import { CodexAccountsPanel } from "@/components/codex/CodexAccountsPanel";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { HomeUsageDashboard } from "@/components/usage/HomeUsageDashboard";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import { ProxyToggle } from "@/components/proxy/ProxyToggle";
import { FailoverToggle } from "@/components/proxy/FailoverToggle";
import { RoutingActivationBrand } from "@/components/proxy/RoutingActivationBrand";
import UsageScriptModal from "@/components/UsageScriptModal";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { Button } from "@/components/ui/button";
import { APP_IDS, isProxyAppId } from "@/config/appConfig";

import {
  isProductApp,
  normalizeProductApp,
  normalizeProductView,
  type ProductView,
} from "@/config/productShell";

interface SyncStatusUpdatedPayload {
  source?: string;
  status?: string;
  error?: string;
}

const DEFAULT_DRAG_BAR_HEIGHT = isWindows() || isLinux() ? 0 : 28; // px
const HEADER_HEIGHT = 56; // px

const STORAGE_KEY = "cc-switch-last-app";
const getInitialApp = (): AppId => {
  return normalizeProductApp(localStorage.getItem(STORAGE_KEY));
};

const VIEW_STORAGE_KEY = "cc-switch-last-view";
const getInitialView = (): ProductView =>
  normalizeProductView(localStorage.getItem(VIEW_STORAGE_KEY));

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeApp, setRequestedApp] = useState<AppId>(getInitialApp);
  const setActiveApp = useCallback((app: AppId) => {
    if (isProductApp(app)) setRequestedApp(app);
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, activeApp);
  }, [activeApp]);
  const [currentView, setRequestedView] = useState<ProductView>(getInitialView);
  const setCurrentView = useCallback((view: ProductView) => {
    setRequestedView(normalizeProductView(view));
  }, []);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState("general");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [homeTab, setHomeTab] = useState<"accounts" | "usage">("accounts");
  const {
    switchAccount,
    isSwitching: isAccountSwitching,
    isCurrentUncertain,
  } = useCodexAccountSwitch();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  useEffect(() => {
    localStorage.setItem(VIEW_STORAGE_KEY, currentView);
  }, [currentView]);

  const { data: settingsData } = useSettingsQuery();
  const useAppWindowControls =
    isLinux() && (settingsData?.useAppWindowControls ?? false);
  const dragBarHeight = useAppWindowControls ? 32 : DEFAULT_DRAG_BAR_HEIGHT;
  const contentTopOffset = dragBarHeight + HEADER_HEIGHT + 12;
  // This is a presentation mask; never rewrite persisted multi-app settings.
  const visibleApps = useMemo<VisibleApps>(
    () =>
      Object.fromEntries(
        APP_IDS.map((app) => [app, isProductApp(app)]),
      ) as unknown as VisibleApps,
    [],
  );

  const getFirstVisibleApp = (): AppId => {
    return APP_IDS.find((app) => visibleApps[app]) ?? "codex";
  };

  useEffect(() => {
    if (!visibleApps[activeApp]) {
      setActiveApp(getFirstVisibleApp());
    }
  }, [visibleApps, activeApp]);

  const [editingProvider, setEditingProvider] = useState<Provider | null>(null);
  const [usageProvider, setUsageProvider] = useState<Provider | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    provider: Provider;
  } | null>(null);
  const [envConflicts, setEnvConflicts] = useState<EnvConflict[]>([]);
  const [showEnvBanner, setShowEnvBanner] = useState(false);

  const effectiveEditingProvider = useLastValidValue(editingProvider);
  const effectiveUsageProvider = useLastValidValue(usageProvider);
  const mainScrollRef = useRef<HTMLElement>(null);
  const providerScrollContainerRef = useRef<HTMLDivElement>(null);

  useUsageCacheBridge();

  useLayoutEffect(() => {
    if (currentView !== "providers") return;

    for (const container of [
      mainScrollRef.current,
      providerScrollContainerRef.current,
    ]) {
      if (container) {
        container.scrollTop = 0;
        container.scrollLeft = 0;
      }
    }
  }, [activeApp, currentView, homeTab]);

  const addActionButtonClass = "rounded-full w-8 h-8";

  const {
    isRunning: isProxyRunning,
    takeoverStatus,
    status: proxyStatus,
  } = useProxyStatus();
  const proxyAppId = isProxyAppId(activeApp) ? activeApp : null;
  const currentAppUsesProxy = proxyAppId !== null;
  const isCurrentAppTakeoverActive = proxyAppId
    ? takeoverStatus?.[proxyAppId] || false
    : false;
  const activeProviderId = useMemo(() => {
    if (!proxyAppId) return undefined;
    const target = proxyStatus?.active_targets?.find(
      (t) => t.app_type === proxyAppId,
    );
    return target?.provider_id;
  }, [proxyStatus?.active_targets, proxyAppId]);

  const {
    data,
    isLoading,
    isError: hasProvidersError,
    refetch,
  } = useProvidersQuery(activeApp, {
    isProxyRunning: currentAppUsesProxy && isProxyRunning,
  });
  const providers = useMemo(() => data?.providers ?? {}, [data]);
  const currentProviderId = data?.currentProviderId ?? "";
  const {
    data: isAutoFailoverEnabled,
    isPlaceholderData: isFailoverStatusLoading,
    isError: hasFailoverStatusError,
  } = useAutoFailoverEnabled(activeApp, proxyAppId !== null);
  const accountCurrentProviderId =
    isProxyRunning && isCurrentAppTakeoverActive
      ? isFailoverStatusLoading ||
        hasFailoverStatusError ||
        isAutoFailoverEnabled === undefined
        ? ""
        : isAutoFailoverEnabled
          ? (activeProviderId ?? "")
          : currentProviderId
      : currentProviderId;
  const {
    addProvider,
    updateProvider,
    switchProvider,
    deleteProvider,
    saveUsageScript,
  } = useProviderActions(
    activeApp,
    currentAppUsesProxy && isProxyRunning,
    isProxyRunning && isCurrentAppTakeoverActive,
  );
  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;

    const setupListener = async () => {
      try {
        const off = await providersApi.onSwitched(
          async (event: ProviderSwitchEvent) => {
            if (!isProductApp(event.appType)) return;
            if (event.appType === activeApp) {
              await refetch();
            }
          },
        );
        if (!active) {
          off();
          return;
        }
        unsubscribe = off;
      } catch (error) {
        console.error("[App] Failed to subscribe provider switch event", error);
      }
    };

    void setupListener();
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [activeApp, queryClient, refetch]);

  useTauriEvent("universal-provider-synced", async () => {
    await queryClient.invalidateQueries({ queryKey: ["providers"] });
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to update tray menu", error);
    }
  });

  // 应用项目后刷新相关缓存（providers 由既有 provider-switched 监听承接；
  // proxy 状态由后端直接改 DB，不走 mutation，必须显式刷新）
  useTauriEvent("profile-applied", async () => {
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
    await queryClient.invalidateQueries({
      queryKey: proxyKeys.takeoverStatus,
    });
    await queryClient.invalidateQueries({ queryKey: proxyKeys.status });
    await queryClient.invalidateQueries({
      queryKey: ["providers", "claude-desktop"],
    });
  });

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "webdav-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.webdavSync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<SyncStatusUpdatedPayload | null | undefined>(
    "s3-sync-status-updated",
    async (payload) => {
      const statusPayload = payload ?? {};
      await queryClient.invalidateQueries({ queryKey: ["settings"] });
      if (statusPayload.source !== "auto" || statusPayload.status !== "error") {
        return;
      }
      toast.error(
        t("settings.s3Sync.autoSyncFailedToast", {
          error: statusPayload.error || t("common.unknown"),
        }),
      );
    },
  );

  useTauriEvent<{ appType: string; providerName: string }>(
    "proxy-official-warning",
    (payload) => {
      if (!isProductApp(payload.appType)) return;
      toast.warning(
        t("notifications.proxyOfficialWarning", {
          name: payload.providerName,
          defaultValue: `当前供应商 ${payload.providerName} 是官方供应商，建议切换到第三方供应商后再使用代理接管`,
        }),
        { duration: 8000 },
      );
    },
  );

  useEffect(() => {
    let active = true;
    let unlistenResize: (() => void) | undefined;

    const setupWindowStateSync = async () => {
      try {
        const currentWindow = getCurrentWindow();
        const syncWindowMaximizedState = async () => {
          const maximized = await currentWindow.isMaximized();
          if (active) {
            setIsWindowMaximized(maximized);
          }
        };

        await syncWindowMaximizedState();
        unlistenResize = await currentWindow.onResized(() => {
          void syncWindowMaximizedState();
        });
      } catch (error) {
        console.error("[App] Failed to sync window maximized state", error);
      }
    };

    void setupWindowStateSync();
    return () => {
      active = false;
      unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    // settingsData 未加载时跳过，避免用 fallback false 覆盖 Rust 侧已设好的装饰状态
    if (!settingsData) return;

    const syncWindowDecorations = async () => {
      try {
        await getCurrentWindow().setDecorations(!useAppWindowControls);
      } catch (error) {
        console.error("[App] Failed to update window decorations", error);
      }
    };

    void syncWindowDecorations();
  }, [useAppWindowControls, settingsData]);

  useEffect(() => {
    const checkEnvOnStartup = async () => {
      try {
        const flatConflicts = await checkEnvConflicts("codex");

        if (flatConflicts.length > 0) {
          setEnvConflicts(flatConflicts);
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on startup:",
          error,
        );
      }
    };

    checkEnvOnStartup();
  }, []);

  useEffect(() => {
    const checkMigration = async () => {
      try {
        const migrated = await invoke<boolean>("get_migration_result");
        if (migrated) {
          toast.success(
            t("migration.success", { defaultValue: "配置迁移成功" }),
            { closeButton: true },
          );
        }
      } catch (error) {
        console.error("[App] Failed to check migration result:", error);
      }
    };

    checkMigration();
  }, [t]);

  useEffect(() => {
    const checkSkillsMigration = async () => {
      try {
        const result = await invoke<{ count: number; error?: string } | null>(
          "get_skills_migration_result",
        );
        if (result?.error) {
          toast.error(t("migration.skillsFailed"), {
            description: t("migration.skillsFailedDescription"),
            closeButton: true,
          });
          console.error("[App] Skills SSOT migration failed:", result.error);
          return;
        }
        if (result && result.count > 0) {
          toast.success(t("migration.skillsSuccess", { count: result.count }), {
            closeButton: true,
          });
          await queryClient.invalidateQueries({ queryKey: ["skills"] });
        }
      } catch (error) {
        console.error("[App] Failed to check skills migration result:", error);
      }
    };

    checkSkillsMigration();
  }, [t, queryClient]);

  useEffect(() => {
    const checkEnvOnSwitch = async () => {
      try {
        const conflicts = await checkEnvConflicts(activeApp);

        if (conflicts.length > 0) {
          setEnvConflicts((prev) => {
            const existingKeys = new Set(
              prev.map((c) => `${c.varName}:${c.sourcePath}`),
            );
            const newConflicts = conflicts.filter(
              (c) => !existingKeys.has(`${c.varName}:${c.sourcePath}`),
            );
            return [...prev, ...newConflicts];
          });
          const dismissed = sessionStorage.getItem("env_banner_dismissed");
          if (!dismissed) {
            setShowEnvBanner(true);
          }
        }
      } catch (error) {
        console.error(
          "[App] Failed to check environment conflicts on app switch:",
          error,
        );
      }
    };

    checkEnvOnSwitch();
  }, [activeApp]);

  const currentViewRef = useRef(currentView);
  useEffect(() => {
    currentViewRef.current = currentView;
  }, [currentView]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "," && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setCurrentView("settings");
        return;
      }

      if (event.key !== "Escape" || event.defaultPrevented) return;

      if (document.body.style.overflow === "hidden") return;

      const view = currentViewRef.current;
      if (view === "providers") return;

      if (isTextEditableTarget(event.target)) return;

      event.preventDefault();
      setCurrentView("providers");
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleOpenWebsite = async (url: string) => {
    try {
      await settingsApi.openExternal(url);
    } catch (error) {
      const detail =
        extractErrorMessage(error) ||
        t("notifications.openLinkFailed", {
          defaultValue: "链接打开失败",
        });
      toast.error(detail);
    }
  };

  const handleEditProvider = async ({
    provider,
    originalId,
    editorSave,
  }: {
    provider: Provider;
    originalId?: string;
    editorSave?: ProviderEditorSave;
  }) => {
    await updateProvider(provider, originalId, editorSave);
    setEditingProvider(null);
  };

  const handleConfirmAction = async () => {
    if (!confirmAction) return;
    await deleteProvider(confirmAction.provider.id);
    setConfirmAction(null);
  };

  const handleDuplicateProvider = async (provider: Provider) => {
    const newSortIndex =
      provider.sortIndex !== undefined ? provider.sortIndex + 1 : undefined;

    const duplicatedProvider: Omit<Provider, "id" | "createdAt"> = {
      name: `${provider.name} copy`,
      settingsConfig: deepClone(provider.settingsConfig),
      websiteUrl: provider.websiteUrl,
      category: provider.category,
      sortIndex: newSortIndex, // 复制原 sortIndex + 1
      meta: provider.meta ? deepClone(provider.meta) : undefined,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };

    if (provider.sortIndex !== undefined) {
      const updates = Object.values(providers)
        .filter(
          (p) =>
            p.sortIndex !== undefined &&
            p.sortIndex >= newSortIndex! &&
            p.id !== provider.id,
        )
        .map((p) => ({
          id: p.id,
          sortIndex: p.sortIndex! + 1,
        }));

      if (updates.length > 0) {
        try {
          await providersApi.updateSortOrder(updates, activeApp);
        } catch (error) {
          console.error("[App] Failed to update sort order", error);
          toast.error(
            t("provider.sortUpdateFailed", {
              defaultValue: "排序更新失败",
            }),
          );
          return; // 如果排序更新失败，不继续添加
        }
      }
    }

    await addProvider(duplicatedProvider);
  };

  const confirmActionMessage = useMemo(() => {
    if (!confirmAction) return "";

    return t("confirm.deleteProviderMessage", {
      name: confirmAction.provider.name,
    });
  }, [confirmAction, t]);

  const handleImportSuccess = async () => {
    try {
      await queryClient.invalidateQueries({
        queryKey: ["providers"],
        refetchType: "all",
      });
      await queryClient.refetchQueries({
        queryKey: ["providers"],
        type: "all",
      });
    } catch (error) {
      console.error("[App] Failed to refresh providers after import", error);
      await refetch();
    }
    try {
      await providersApi.updateTrayMenu();
    } catch (error) {
      console.error("[App] Failed to refresh tray menu", error);
    }
  };

  const notifyWindowControlError = (error: unknown) => {
    toast.error(
      t("notifications.windowControlFailed", {
        defaultValue: "窗口控制失败：{{error}}",
        error: extractErrorMessage(error),
      }),
    );
  };

  const handleWindowMinimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch (error) {
      console.error("[App] Failed to minimize window", error);
      notifyWindowControlError(error);
    }
  };

  const handleWindowToggleMaximize = async () => {
    try {
      const currentWindow = getCurrentWindow();
      await currentWindow.toggleMaximize();
      setIsWindowMaximized(await currentWindow.isMaximized());
    } catch (error) {
      console.error("[App] Failed to toggle maximize", error);
      notifyWindowControlError(error);
    }
  };

  const handleWindowClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (error) {
      console.error("[App] Failed to close window", error);
      notifyWindowControlError(error);
    }
  };

  const configurationContent = (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">
          {t("codexAccounts.configurationsTitle", "Connection configurations")}
        </h2>
        <Button
          onClick={() => {
            setIsAddOpen(true);
          }}
          size="icon"
          className={addActionButtonClass}
          aria-label={t("codexAccounts.addConfiguration", "Add configuration")}
          title={t("codexAccounts.addConfiguration", "Add configuration")}
        >
          <Plus className="h-5 w-5" aria-hidden="true" />
        </Button>
      </div>
      <details className="glass rounded-xl px-4 py-2 text-xs text-muted-foreground">
        <summary className="cursor-pointer">
          {t("codexAccounts.configurationsHelp", "连接配置用途")}
        </summary>
        <p className="pt-2 leading-relaxed">
          {t(
            "codexAccounts.configurationsDescription",
            "用于 API Key 连接和可选的高级配置。ChatGPT 账号登录后可在主页直接切换。",
          )}
        </p>
      </details>
      <ProviderList
        providers={Object.fromEntries(
          Object.entries(providers).filter(
            ([, provider]) => !provider.meta?.codexAccountManaged,
          ),
        )}
        currentProviderId={currentProviderId}
        appId="codex"
        isLoading={isLoading}
        isProxyRunning={currentAppUsesProxy && isProxyRunning}
        isProxyTakeover={isProxyRunning && isCurrentAppTakeoverActive}
        activeProviderId={activeProviderId}
        onSwitch={switchProvider}
        onEdit={setEditingProvider}
        onDelete={(provider) => setConfirmAction({ provider })}
        onDuplicate={handleDuplicateProvider}
        onConfigureUsage={setUsageProvider}
        onOpenWebsite={handleOpenWebsite}
        onCreate={() => {
          setIsAddOpen(true);
        }}
      />
    </div>
  );

  const accountPanelProps = {
    providers: Object.values(providers),
    currentProviderId: isCurrentUncertain ? "" : accountCurrentProviderId,
    isSwitching: isAccountSwitching,
    isLoadingProviders: isLoading,
    isProvidersError: hasProvidersError,
    onSwitchAccount: switchAccount,
  };

  const renderContent = () => {
    const content = (() => {
      switch (currentView) {
        case "settings":
          return (
            <SettingsPage
              open={true}
              onOpenChange={() => setCurrentView("providers")}
              onImportSuccess={handleImportSuccess}
              defaultTab={settingsDefaultTab}
              configurations={configurationContent}
              accountPanelProps={accountPanelProps}
            />
          );
        default:
          return (
            <div className="px-3 sm:px-6 flex flex-col flex-1 min-h-0 overflow-hidden">
              <div
                ref={providerScrollContainerRef}
                className="app-scroll flex-1 overflow-y-auto overflow-x-hidden pb-12 px-1"
              >
                <AnimatePresence mode="wait">
                  <motion.div
                    key={activeApp}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                    className="space-y-4"
                  >
                    {homeTab === "accounts" ? (
                      <div
                        role="tabpanel"
                        id="codex-home-accounts"
                        aria-labelledby="codex-tab-accounts"
                      >
                        <CodexAccountsPanel {...accountPanelProps} />
                      </div>
                    ) : (
                      <div
                        role="tabpanel"
                        id="codex-home-usage"
                        aria-labelledby="codex-tab-usage"
                      >
                        <HomeUsageDashboard />
                      </div>
                    )}
                  </motion.div>
                </AnimatePresence>
              </div>
            </div>
          );
      }
    })();

    return (
      <AnimatePresence mode="wait">
        <motion.div
          key={currentView}
          className="flex flex-1 min-h-0 flex-col"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          {content}
        </motion.div>
      </AnimatePresence>
    );
  };

  return (
    <div
      className="app-shell flex flex-col h-screen overflow-hidden text-foreground selection:bg-primary/30 pb-4"
      style={{ overflowX: "hidden", paddingTop: contentTopOffset }}
    >
      {(dragBarHeight > 0 || useAppWindowControls) && (
        <div
          className="fixed top-0 left-0 right-0 z-[70] flex items-center justify-end px-2"
          data-tauri-drag-region
          style={{ WebkitAppRegion: "drag", height: dragBarHeight } as any}
        >
          {useAppWindowControls && (
            <div
              className="flex items-center gap-1"
              style={{ WebkitAppRegion: "no-drag" } as any}
            >
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowMinimize()}
                title={t("header.windowMinimize")}
                className="h-7 w-7"
              >
                <Minus className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowToggleMaximize()}
                title={
                  isWindowMaximized
                    ? t("header.windowRestore")
                    : t("header.windowMaximize")
                }
                className="h-7 w-7"
              >
                {isWindowMaximized ? (
                  <Minimize2 className="w-4 h-4" />
                ) : (
                  <Maximize2 className="w-4 h-4" />
                )}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => void handleWindowClose()}
                title={t("header.windowClose")}
                className="h-7 w-7 hover:bg-red-500/15 hover:text-red-500"
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          )}
        </div>
      )}
      {showEnvBanner && envConflicts.length > 0 && (
        <EnvWarningBanner
          conflicts={envConflicts}
          onDismiss={() => {
            setShowEnvBanner(false);
            sessionStorage.setItem("env_banner_dismissed", "true");
          }}
          onDeleted={async () => {
            try {
              const flatConflicts = await checkEnvConflicts("codex");
              setEnvConflicts(flatConflicts);
              if (flatConflicts.length === 0) {
                setShowEnvBanner(false);
              }
            } catch (error) {
              console.error(
                "[App] Failed to re-check conflicts after deletion:",
                error,
              );
            }
          }}
        />
      )}

      <header
        className="fixed left-3 right-3 sm:left-6 sm:right-6 z-50 flex items-center gap-2 sm:gap-3"
        {...DRAG_REGION_ATTR}
        style={
          {
            ...DRAG_REGION_STYLE,
            top: dragBarHeight + 8,
            height: HEADER_HEIGHT,
          } as any
        }
      >
        <div
          className="glass-header flex h-full min-w-0 items-center px-3 sm:px-4"
          {...DRAG_REGION_ATTR}
          style={{ ...DRAG_REGION_STYLE } as any}
        >
          <RoutingActivationBrand
            active={isProxyRunning && isCurrentAppTakeoverActive}
            contextKey={activeApp}
            ready={proxyStatus !== undefined && takeoverStatus !== undefined}
          />
        </div>
        <nav
          className="glass-header app-navigation flex h-full shrink-0 items-center gap-1 p-2"
          aria-label={t("codexAccounts.homeTabs", "Codex management")}
          style={{ WebkitAppRegion: "no-drag" } as any}
        >
          <div
            role="tablist"
            aria-label={t("codexAccounts.homeTabs", "Codex management")}
            className="flex items-center gap-1"
          >
            {(["accounts", "usage"] as const).map((tab) => (
              <Button
                key={tab}
                role="tab"
                aria-selected={currentView === "providers" && homeTab === tab}
                tabIndex={homeTab === tab ? 0 : -1}
                aria-controls={`codex-home-${tab}`}
                id={`codex-tab-${tab}`}
                variant={
                  currentView === "providers" && homeTab === tab
                    ? "secondary"
                    : "ghost"
                }
                size="icon"
                aria-label={
                  tab === "accounts"
                    ? t("codexAccounts.accountsTab", "ChatGPT accounts")
                    : t("codexAccounts.localUsageTab", "本地用量")
                }
                title={
                  tab === "accounts"
                    ? t("codexAccounts.accountsTab", "ChatGPT accounts")
                    : t("codexAccounts.localUsageTab", "本地用量")
                }
                onClick={() => {
                  setHomeTab(tab);
                  setCurrentView("providers");
                }}
                onKeyDown={(event) => {
                  if (
                    !["ArrowLeft", "ArrowRight", "Home", "End"].includes(
                      event.key,
                    )
                  )
                    return;
                  event.preventDefault();
                  const nextTab =
                    event.key === "Home"
                      ? "accounts"
                      : event.key === "End"
                        ? "usage"
                        : tab === "accounts"
                          ? "usage"
                          : "accounts";
                  setHomeTab(nextTab);
                  setCurrentView("providers");
                  document.getElementById(`codex-tab-${nextTab}`)?.focus();
                }}
              >
                {tab === "accounts" ? (
                  <Users className="h-5 w-5" aria-hidden="true" />
                ) : (
                  <BarChart2 className="h-5 w-5" aria-hidden="true" />
                )}
              </Button>
            ))}
          </div>
          <Button
            variant={currentView === "settings" ? "secondary" : "ghost"}
            size="icon"
            aria-pressed={currentView === "settings"}
            onClick={() => {
              setSettingsDefaultTab("general");
              setCurrentView("settings");
            }}
            aria-label={t("common.settings")}
            title={t("common.settings")}
          >
            <Settings className="h-5 w-5" aria-hidden="true" />
          </Button>
        </nav>
        {currentView === "providers" && proxyAppId && (
          <div
            className="ml-auto flex shrink-0 items-center gap-1.5"
            style={{ WebkitAppRegion: "no-drag" } as any}
          >
            {settingsData?.enableLocalProxy && (
              <ProxyToggle activeApp={proxyAppId} />
            )}
            {settingsData?.enableFailoverToggle && (
              <FailoverToggle activeApp={proxyAppId} />
            )}
          </div>
        )}
      </header>

      <main
        ref={mainScrollRef}
        className="flex-1 min-h-0 flex flex-col overflow-y-auto animate-fade-in"
      >
        {renderContent()}
      </main>

      <AddProviderDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        appId={activeApp}
        onSubmit={addProvider}
        productShell
      />

      <EditProviderDialog
        productShell
        open={Boolean(editingProvider)}
        provider={effectiveEditingProvider}
        onOpenChange={(open) => {
          if (!open) {
            setEditingProvider(null);
          }
        }}
        onSubmit={handleEditProvider}
        appId={activeApp}
        isProxyTakeover={isCurrentAppTakeoverActive}
      />

      {effectiveUsageProvider && (
        <UsageScriptModal
          productShell
          key={effectiveUsageProvider.id}
          provider={effectiveUsageProvider}
          appId={activeApp}
          isOpen={Boolean(usageProvider)}
          onClose={() => setUsageProvider(null)}
          onSave={(script) => {
            if (usageProvider) {
              void saveUsageScript(usageProvider, script);
            }
          }}
        />
      )}

      <ConfirmDialog
        isOpen={Boolean(confirmAction)}
        title={t("confirm.deleteProvider")}
        message={confirmActionMessage}
        onConfirm={() => void handleConfirmAction()}
        onCancel={() => setConfirmAction(null)}
      />

      <DeepLinkImportDialog productShell />
      <FirstRunNoticeDialog />
    </div>
  );
}

export default App;
