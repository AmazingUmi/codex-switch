import { FullScreenPanel } from "@/components/common/FullScreenPanel";
import { useLiveEditConflict } from "@/components/providers/LiveEditConflictDialog";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { codexProviderPresets } from "@/config/codexProviderPresets";
import type { AppId } from "@/lib/api";
import type {
  EditorConflictPolicy,
  ProviderEditorSave,
} from "@/lib/api/providers";
import type { CustomEndpoint, Provider } from "@/types";
import { extractCodexBaseUrl } from "@/utils/providerConfigUtils";
import { Loader2, Plus } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
interface AddProviderDialogProps {
  productShell?: boolean;
  apiKeyOnly?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: AppId;
  onSubmit: (
    provider: Omit<Provider, "id"> & {
      editorSave?: ProviderEditorSave;
    },
  ) => Promise<void> | void;
}
export function AddProviderDialog(props: AddProviderDialogProps) {
  // Closing discards the creation draft immediately, including pending live projections.
  if (props.appId !== "codex" || !props.open) return null;
  return <CodexAddProviderDialog {...props} />;
}
function CodexAddProviderDialog({
  open,
  onOpenChange,
  appId,
  onSubmit,
  productShell = false,
  apiKeyOnly = false,
}: AddProviderDialogProps) {
  const { t } = useTranslation();
  const [isFormSubmitting, setIsFormSubmitting] = useState(false);
  // The displayed Codex projection and its original draft form the save comparison base.
  const [draftEditorBase, setDraftEditorBase] = useState<{
    base: Record<string, unknown>;
    draft?: Record<string, unknown>;
  } | null>(null);
  const handleDraftEditorBase = useCallback(
    (base: Record<string, unknown> | null, draft?: Record<string, unknown>) =>
      setDraftEditorBase(base ? { base, draft } : null),
    [],
  );
  const { submitWithConflictRetry, conflictDialog } = useLiveEditConflict();
  const closeDialog = useCallback(() => {
    // 表单每次打开都会重新投影；这里清掉，免得下次打开时先用上一次的底。
    setDraftEditorBase(null);
    onOpenChange(false);
  }, [onOpenChange]);
  const handlePanelClose = useCallback(() => {
    closeDialog();
  }, [closeDialog]);
  const formReadyToken = useMemo(
    () => Symbol("provider-form-ready"),
    [appId, open],
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
  const handleSubmit = useCallback(
    async (values: ProviderFormValues) => {
      const parsedConfig = JSON.parse(values.settingsConfig) as Record<
        string,
        unknown
      >;
      // 构造基础提交数据
      const providerData: Omit<Provider, "id"> & {} = {
        name: values.name.trim(),
        notes: values.notes?.trim() || undefined,
        websiteUrl: values.websiteUrl?.trim() || undefined,
        settingsConfig: parsedConfig,
        icon: values.icon?.trim() || undefined,
        iconColor: values.iconColor?.trim() || undefined,
        ...(values.presetCategory ? { category: values.presetCategory } : {}),
        ...(values.meta ? { meta: values.meta } : {}),
      };
      const hasCustomEndpoints =
        providerData.meta?.custom_endpoints &&
        Object.keys(providerData.meta.custom_endpoints).length > 0;
      if (!productShell && !hasCustomEndpoints) {
        const urlSet = new Set<string>();
        const addUrl = (rawUrl?: string) => {
          const url = (rawUrl || "").trim().replace(/\/+$/, "");
          if (url && url.startsWith("http")) {
            urlSet.add(url);
          }
        };
        if (values.presetId) {
          const presets = codexProviderPresets;
          const presetIndex = parseInt(values.presetId.replace("codex-", ""));
          if (
            !isNaN(presetIndex) &&
            presetIndex >= 0 &&
            presetIndex < presets.length
          ) {
            const preset = presets[presetIndex];
            if (Array.isArray(preset.endpointCandidates)) {
              preset.endpointCandidates.forEach(addUrl);
            }
          }
        }
        const config = parsedConfig.config as string | undefined;
        if (config) {
          const extractedBaseUrl = extractCodexBaseUrl(config);
          if (extractedBaseUrl) {
            addUrl(extractedBaseUrl);
          }
        }
        const urls = Array.from(urlSet);
        if (urls.length > 0) {
          const now = Date.now();
          const customEndpoints: Record<string, CustomEndpoint> = {};
          urls.forEach((url) => {
            customEndpoints[url] = {
              url,
              addedAt: now,
              lastUsed: undefined,
            };
          });
          providerData.meta = {
            ...(providerData.meta ?? {}),
            custom_endpoints: customEndpoints,
          };
        }
      }
      const editorBase = draftEditorBase;
      const submit = async (onConflict: EditorConflictPolicy) => {
        await onSubmit({
          ...providerData,
          ...(editorBase ? { editorSave: { ...editorBase, onConflict } } : {}),
        });
        closeDialog();
      };
      await submitWithConflictRetry(submit);
    },
    [
      appId,
      onSubmit,
      closeDialog,
      draftEditorBase,
      submitWithConflictRetry,
      productShell,
    ],
  );
  const footer = (
    <>
      <div className="mr-auto">
        <HelpButton
          label={t("providerForm.connectionHelp", "Connection setup help")}
        >
          {t("provider.addFooterHint")}
        </HelpButton>
      </div>
      <Button
        variant="outline"
        onClick={closeDialog}
        className="border-border/20 hover:bg-accent hover:text-accent-foreground"
      >
        {t("common.cancel")}
      </Button>
      <Button
        type="submit"
        form="provider-form"
        disabled={isFormSubmitting || !isFormReady}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {isFormSubmitting ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <Plus className="mr-2 h-4 w-4" />
        )}
        {t("common.add")}
      </Button>
    </>
  );
  return (
    <FullScreenPanel
      isOpen={open}
      title={
        apiKeyOnly
          ? t("codexAccounts.addApiConnectionTitle", "添加 API Key 连接")
          : productShell
            ? t("codexAccounts.addConnectionTitle", "添加连接配置")
            : t("provider.addNewProvider")
      }
      onClose={handlePanelClose}
      footer={footer}
      contentClassName={"pt-3"}
    >
      <ProviderForm
        key="new-provider"
        productShell={productShell}
        apiKeyOnly={apiKeyOnly}
        restrictCodexCreation={productShell}
        appId={appId}
        submitLabel={t("common.add")}
        onSubmit={handleSubmit}
        onCancel={closeDialog}
        onSubmittingChange={setIsFormSubmitting}
        onSubmitReadyChange={handleSubmitReadyChange}
        showButtons={false}
        onEditorBaseChange={handleDraftEditorBase}
      />
      {conflictDialog}
    </FullScreenPanel>
  );
}
