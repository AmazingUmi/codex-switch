import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { AuthSettingsPanel } from "@/components/providers/AuthSettingsPanel";
import { useLiveEditConflict } from "@/components/providers/LiveEditConflictDialog";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { toastEditorViewFailed } from "@/components/providers/forms/hooks/useDraftEditorProjection";
import { Button } from "@/components/ui/button";
import { providersApi, type AppId, type ManagedAuthProvider } from "@/lib/api";
import type {
  EditorConflictPolicy,
  ProviderEditorSave,
  ProviderEditorView,
} from "@/lib/api/providers";
import type { Provider } from "@/types";
import { Loader2, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
interface EditProviderDialogProps {
  productShell?: boolean;
  open: boolean;
  provider: Provider | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (payload: {
    provider: Provider;
    originalId?: string;
    editorSave?: ProviderEditorSave;
  }) => Promise<void> | void;
  appId: AppId;
  onDelete?: (provider: Provider) => void;
  deleteDisabledReason?: string;
  deleteConfirmation?: {
    message: string;
    onConfirm: () => Promise<void> | void;
    onCancel: () => void;
  };
  isProxyTakeover?: boolean; // 代理接管模式下不读取 live（避免显示被接管后的代理配置）
}
const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
export function EditProviderDialog(props: EditProviderDialogProps) {
  if (props.appId !== "codex") return null;
  return <CodexEditProviderDialog {...props} />;
}
function CodexEditProviderDialog({
  productShell = false,
  open,
  provider,
  onOpenChange,
  onSubmit,
  appId,
  onDelete,
  deleteDisabledReason,
  deleteConfirmation,
  isProxyTakeover = false,
}: EditProviderDialogProps) {
  const { t } = useTranslation();
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  const [isDeleteSubmitting, setIsDeleteSubmitting] = useState(false);
  const deleteInFlight = useRef(false);
  const [authSettingsTarget, setAuthSettingsTarget] =
    useState<ManagedAuthProvider | null>(null);
  useEffect(() => {
    setAuthSettingsTarget(null);
  }, [appId, open, provider?.id]);
  const formReadyToken = useMemo(
    () => Symbol("provider-form-ready"),
    [appId, open, provider?.id],
  );
  const currentFormReadyToken = useRef(formReadyToken);
  currentFormReadyToken.current = formReadyToken;
  const [formReadyState, setFormReadyState] = useState({
    token: formReadyToken,
    ready: true,
  });
  const isFormReady =
    formReadyState.token === formReadyToken ? formReadyState.ready : true;
  const handleSubmitReadyChange = useCallback(
    (ready: boolean) => {
      if (currentFormReadyToken.current === formReadyToken) {
        setFormReadyState({ token: formReadyToken, ready });
      }
    },
    [formReadyToken],
  );
  // 默认使用传入的 provider.settingsConfig，若当前编辑对象是"当前生效供应商"，则尝试读取实时配置替换初始值
  const [liveSettings, setLiveSettings] = useState<Record<
    string,
    unknown
  > | null>(null);
  // 使用 ref 标记是否已经加载过，防止重复读取覆盖用户编辑
  const [hasLoadedLive, setHasLoadedLive] = useState(false);
  // Keep the displayed Codex projection as the save comparison base.
  const [editorView, setEditorView] = useState<ProviderEditorView | null>(null);
  const { submitWithConflictRetry, conflictDialog } = useLiveEditConflict();
  const closeDialog = useCallback(() => {
    setAuthSettingsTarget(null);
    onOpenChange(false);
  }, [onOpenChange]);
  const handlePanelClose = useCallback(() => {
    if (deleteInFlight.current) return;
    if (deleteConfirmation) {
      deleteConfirmation.onCancel();
      return;
    }
    if (authSettingsTarget) {
      setAuthSettingsTarget(null);
      return;
    }
    closeDialog();
  }, [authSettingsTarget, closeDialog, deleteConfirmation]);
  const handleConfirmDelete = async () => {
    if (
      !deleteConfirmation ||
      deleteDisabledReason ||
      isFormSubmitting ||
      deleteInFlight.current
    ) {
      return;
    }
    deleteInFlight.current = true;
    setIsDeleteSubmitting(true);
    try {
      await deleteConfirmation.onConfirm();
    } catch {
      // The existing delete mutation reports failures; keep the editor open.
    } finally {
      deleteInFlight.current = false;
      setIsDeleteSubmitting(false);
    }
  };
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!open || !provider) {
        setLiveSettings(null);
        setEditorView(null);
        setHasLoadedLive(false);
        return;
      }
      // 关键修复：只在首次打开时加载一次
      if (hasLoadedLive) {
        return;
      }
      try {
        const view = await providersApi.getEditorView(
          appId,
          asRecord(provider.settingsConfig) ?? {},
          provider.category,
          provider.id,
        );
        if (!cancelled) {
          setEditorView(view);
          setLiveSettings(view.settings);
        }
      } catch (error) {
        // 读不了配置文件（比如手改坏了）：退回显示保存的供应商配置。
        if (!cancelled) {
          setEditorView(null);
          setLiveSettings(null);
          toastEditorViewFailed(t, error);
        }
      } finally {
        if (!cancelled) {
          setHasLoadedLive(true);
        }
      }
      return;
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [open, provider?.id, appId, hasLoadedLive, isProxyTakeover]); // 只依赖 provider.id，不依赖整个 provider 对象
  const initialSettingsConfig = useMemo(
    () => liveSettings ?? asRecord(provider?.settingsConfig) ?? {},
    [liveSettings, provider?.settingsConfig],
  ); // 只依赖表单初始化所需字段，不依赖整个 provider
  // 固定 initialData，防止 provider 对象更新时重置表单
  const initialData = useMemo(() => {
    if (!provider) return null;
    return {
      name: provider.name,
      notes: provider.notes,
      websiteUrl: provider.websiteUrl,
      settingsConfig: initialSettingsConfig,
      category: provider.category,
      meta: provider.meta,
      icon: provider.icon,
      iconColor: provider.iconColor,
    };
  }, [
    open, // 修复：编辑保存后再次打开显示旧数据，依赖 open 确保每次打开时重新读取最新 provider 数据
    provider?.id, // 只依赖 ID，provider 对象更新不会触发重新计算
    provider?.meta, // 供应商元数据变化时重新初始化表单
    initialSettingsConfig,
  ]);
  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      if (!provider || deleteConfirmation || deleteInFlight.current) return;
      // 注意：values.settingsConfig 已经是最终的配置字符串
      // ProviderForm returns the assembled Codex configuration.
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      const nextProviderId = provider.id;
      const updatedProvider: Provider = {
        ...provider,
        id: nextProviderId,
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        // 保留或更新 meta 字段
        ...(values.meta ? { meta: values.meta } : {}),
      };
      const submit = async (onConflict: EditorConflictPolicy) => {
        await onSubmit({
          provider: updatedProvider,
          originalId: provider.id,
          ...(editorView
            ? { editorSave: { base: editorView.settings, onConflict } }
            : {}),
        });
        closeDialog();
      };
      await submitWithConflictRetry(submit);
    },
    [
      appId,
      onSubmit,
      closeDialog,
      provider,
      deleteConfirmation,
      editorView,
      submitWithConflictRetry,
    ],
  );
  if (!provider || !initialData) {
    return null;
  }
  const waitingForEditorView = !hasLoadedLive;
  return (
    <FullScreenPanel
      isOpen={open}
      title={t("provider.editProvider")}
      onClose={handlePanelClose}
      contentClassName={undefined}
      footer={
        deleteConfirmation ? (
          <div className="flex w-full flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-1 space-y-1 text-sm">
              <p role="alert">{deleteConfirmation.message}</p>
              {deleteDisabledReason && (
                <p className="text-xs text-muted-foreground">
                  {deleteDisabledReason}
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={isDeleteSubmitting}
                onClick={deleteConfirmation.onCancel}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={
                  isDeleteSubmitting ||
                  isFormSubmitting ||
                  !!deleteDisabledReason
                }
                onClick={() => void handleConfirmDelete()}
              >
                {isDeleteSubmitting ? (
                  <Loader2
                    className="mr-2 h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                )}
                {t("common.delete")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex w-full items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              {onDelete && (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={isFormSubmitting || !!deleteDisabledReason}
                    className="shrink-0 text-destructive hover:text-destructive"
                    onClick={() => onDelete(provider)}
                    aria-describedby={
                      deleteDisabledReason
                        ? "provider-delete-disabled"
                        : undefined
                    }
                  >
                    <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                    {t("common.delete")}
                  </Button>
                  {deleteDisabledReason && (
                    <p
                      id="provider-delete-disabled"
                      className="text-xs text-muted-foreground"
                    >
                      {deleteDisabledReason}
                    </p>
                  )}
                </>
              )}
            </div>
            <Button
              type="submit"
              form="provider-form"
              disabled={isFormSubmitting || !isFormReady}
              className="bg-primary text-primary-foreground hover:bg-primary/90"
            >
              <Save className="h-4 w-4 mr-2" />
              {t("common.save")}
            </Button>
          </div>
        )
      }
    >
      {waitingForEditorView ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          {t("common.loading")}
        </div>
      ) : (
        <ProviderForm
          productShell={productShell}
          appId={appId}
          providerId={provider.id}
          submitLabel={t("common.save")}
          onSubmit={handleSubmit}
          onCancel={closeDialog}
          onManageAuthAccounts={setAuthSettingsTarget}
          onSubmittingChange={setIsFormSubmitting}
          onSubmitReadyChange={handleSubmitReadyChange}
          initialData={initialData}
          showButtons={false}
          isProxyTakeover={isProxyTakeover}
          inactiveFields={editorView?.inactive}
        />
      )}
      {conflictDialog}
      <AuthSettingsPanel
        target={authSettingsTarget}
        onClose={() => setAuthSettingsTarget(null)}
      />
    </FullScreenPanel>
  );
}
