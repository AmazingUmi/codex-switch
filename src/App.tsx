import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import { useQueryClient } from "@tanstack/react-query";
import { Minus, Maximize2, Minimize2, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Provider, VisibleApps } from "@/types";
import type { EnvConflict } from "@/types/env";
import { useProvidersQuery, useSettingsQuery } from "@/lib/query";
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
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { useTauriEvent } from "@/hooks/useTauriEvent";
import { useNativeSettingsNavigation } from "@/hooks/useNativeSettingsNavigation";
import { useLastValidValue } from "@/hooks/useLastValidValue";
import { extractErrorMessage } from "@/utils/errorUtils";
import { isTextEditableTarget } from "@/utils/domUtils";
import { deepClone } from "@/utils/deepClone";
import {
  isWindows,
  isLinux,
  DRAG_REGION_ATTR,
  DRAG_REGION_STYLE,
} from "@/lib/platform";
import { CodexSwitchMark } from "@/components/branding/CodexSwitchMark";
import { CodexAccountsPanel } from "@/components/codex/CodexAccountsPanel";
import { CodexNavigation } from "@/components/codex/CodexNavigation";
import { ApiKeyConnectionsSection } from "@/components/codex/ApiKeyConnectionsSection";
import { AddCodexConnectionDialog } from "@/components/codex/AddCodexConnectionDialog";
import { AddProviderDialog } from "@/components/providers/AddProviderDialog";
import { EditProviderDialog } from "@/components/providers/EditProviderDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { HomeUsageDashboard } from "@/components/usage/HomeUsageDashboard";
import { EnvWarningBanner } from "@/components/env/EnvWarningBanner";
import UsageScriptModal from "@/components/UsageScriptModal";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { FirstRunNoticeDialog } from "@/components/FirstRunNoticeDialog";
import { Button } from "@/components/ui/button";
import { APP_IDS } from "@/config/appConfig";
import { migrateBrowserPreferences } from "@/lib/browserStorage";

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

const STORAGE_KEY = "codex-switch-last-app";
const getInitialApp = (): AppId => {
  migrateBrowserPreferences();
  try {
    return normalizeProductApp(localStorage.getItem(STORAGE_KEY));
  } catch {
    return normalizeProductApp(null);
  }
};

const VIEW_STORAGE_KEY = "codex-switch-last-view";
const getInitialView = (): ProductView => {
  migrateBrowserPreferences();
  try {
    return normalizeProductView(localStorage.getItem(VIEW_STORAGE_KEY));
  } catch {
    return normalizeProductView(null);
  }
};

function App() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const [activeApp, setRequestedApp] = useState<AppId>(getInitialApp);
  const setActiveApp = useCallback((app: AppId) => {
    if (isProductApp(app)) setRequestedApp(app);
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, activeApp);
    } catch {
      // Navigation remains available when preferences cannot be persisted.
    }
  }, [activeApp]);
  const [currentView, setRequestedView] = useState<ProductView>(getInitialView);
  const setCurrentView = useCallback((view: ProductView) => {
    setRequestedView(normalizeProductView(view));
  }, []);
  const [settingsDefaultTab, setSettingsDefaultTab] = useState("general");
  const openSettings = useCallback(() => {
    setSettingsDefaultTab("general");
    setCurrentView("settings");
  }, [setCurrentView]);
  useNativeSettingsNavigation(openSettings);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isAddChoiceOpen, setIsAddChoiceOpen] = useState(false);
  const startAccountLoginRef = useRef<(() => void) | null>(null);
  const [homeTab, setHomeTab] = useState<"accounts" | "usage">("accounts");
  const {
    switchAccount,
    isSwitching: isAccountSwitching,
    isCurrentUncertain,
  } = useCodexAccountSwitch();
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_STORAGE_KEY, currentView);
    } catch {
      // Navigation remains available when preferences cannot be persisted.
    }
  }, [currentView]);

  const { data: settingsData } = useSettingsQuery();
  const useAppWindowControls =
    isLinux() && (settingsData?.useAppWindowControls ?? false);
  const dragBarHeight = useAppWindowControls ? 32 : DEFAULT_DRAG_BAR_HEIGHT;
  const contentTopOffset = dragBarHeight + 8 + HEADER_HEIGHT + 24;
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

  const {
    data,
    isLoading,
    isError: hasProvidersError,
    refetch,
  } = useProvidersQuery(activeApp);
  const providers = useMemo(() => data?.providers ?? {}, [data]);
  const currentProviderId = data?.currentProviderId ?? "";
  const {
    addProvider,
    updateProvider,
    switchProvider,
    deleteProvider,
    saveUsageScript,
  } = useProviderActions(activeApp);
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

  // Refresh dependent caches after applying a project.
  useTauriEvent("profile-applied", async () => {
    await queryClient.invalidateQueries({ queryKey: ["profiles"] });
    await queryClient.invalidateQueries({ queryKey: ["mcp", "all"] });
    await queryClient.invalidateQueries({ queryKey: ["skills"] });
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
        openSettings();
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
  }, [openSettings, setCurrentView]);

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
    <ApiKeyConnectionsSection
      providers={Object.fromEntries(
        Object.entries(providers).filter(
          ([, provider]) => !provider.meta?.codexAccountManaged,
        ),
      )}
      currentProviderId={currentProviderId}
      isLoading={isLoading}
      onSwitch={switchProvider}
      onEdit={setEditingProvider}
      onDelete={(provider) => setConfirmAction({ provider })}
      onDuplicate={handleDuplicateProvider}
      onConfigureUsage={setUsageProvider}
      onOpenWebsite={handleOpenWebsite}
      onAddApiKey={() => setIsAddOpen(true)}
    />
  );

  const accountPanelProps = {
    providers: Object.values(providers),
    currentProviderId: isCurrentUncertain ? "" : currentProviderId,
    isSwitching: isAccountSwitching,
    isLoadingProviders: isLoading,
    isProvidersError: hasProvidersError,
    onSwitchAccount: switchAccount,
    showLogoutAll: true,
    onAddAccount: (startLogin: () => void) => {
      startAccountLoginRef.current = startLogin;
      setIsAddChoiceOpen(true);
    },
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
            />
          );
        default:
          return (
            <div className="page-frame flex flex-col flex-1 min-h-0 overflow-hidden">
              <div
                ref={providerScrollContainerRef}
                className="app-scroll page-shadow-scroll flex-1 overflow-y-auto overflow-x-hidden"
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
                        <div className="space-y-5">
                          <CodexAccountsPanel {...accountPanelProps} />
                          {configurationContent}
                        </div>
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
        <CodexNavigation
          activeView={currentView === "settings" ? "settings" : homeTab}
          onNavigate={(view) => {
            if (view === "settings") {
              openSettings();
            } else {
              setHomeTab(view);
              setCurrentView("providers");
            }
          }}
        />
        <div className="ml-auto flex h-full min-w-0 items-center gap-2 sm:gap-3">
          <Button
            type="button"
            variant="outline"
            className="h-full min-w-0 px-3 sm:px-4"
            data-tauri-no-drag
            style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
            title="GitHub · Codex Switch"
            onClick={() => {
              void settingsApi
                .openExternal("https://github.com/AmazingUmi/codex-switch")
                .catch((error) => {
                  toast.error(t("provider.openLinkFailed"), {
                    description: extractErrorMessage(error),
                  });
                });
            }}
          >
            <span
              className="inline-flex min-w-0 items-center gap-2 text-base font-semibold text-blue-500 dark:text-blue-400"
              aria-label="Codex Switch"
            >
              <CodexSwitchMark className="h-7 w-7 shrink-0" />
              <span className="truncate">Codex Switch</span>
            </span>
          </Button>
        </div>
      </header>

      <main
        ref={mainScrollRef}
        className="flex-1 min-h-0 flex flex-col overflow-y-auto animate-fade-in"
      >
        {renderContent()}
      </main>

      <AddCodexConnectionDialog
        open={isAddChoiceOpen}
        onOpenChange={setIsAddChoiceOpen}
        onLogin={() => {
          setIsAddChoiceOpen(false);
          startAccountLoginRef.current?.();
        }}
        onAddApiKey={() => {
          setIsAddChoiceOpen(false);
          setIsAddOpen(true);
        }}
      />
      <AddProviderDialog
        open={isAddOpen}
        onOpenChange={setIsAddOpen}
        appId={activeApp}
        onSubmit={addProvider}
        productShell
        apiKeyOnly
      />

      <EditProviderDialog
        productShell
        open={Boolean(editingProvider)}
        provider={effectiveEditingProvider}
        onOpenChange={(open) => {
          if (!open) {
            if (confirmAction?.provider.id === editingProvider?.id) {
              setConfirmAction(null);
            }
            setEditingProvider(null);
          }
        }}
        onSubmit={handleEditProvider}
        onDelete={(provider) => {
          if (provider.id !== currentProviderId) setConfirmAction({ provider });
        }}
        deleteDisabledReason={
          editingProvider?.id === currentProviderId
            ? t(
                "provider.deleteCurrentDisabled",
                "当前使用的连接无法删除，请先切换到其他连接。",
              )
            : undefined
        }
        deleteConfirmation={
          confirmAction && confirmAction.provider.id === editingProvider?.id
            ? {
                message: confirmActionMessage,
                onConfirm: async () => {
                  if (confirmAction.provider.id === currentProviderId) return;
                  await handleConfirmAction();
                  setEditingProvider(null);
                },
                onCancel: () => setConfirmAction(null),
              }
            : undefined
        }
        appId={activeApp}
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
        isOpen={Boolean(confirmAction) && !editingProvider}
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
