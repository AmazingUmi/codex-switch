import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { Form, FormField, FormItem, FormMessage } from "@/components/ui/form";
import {
  codexProviderPresets,
  generateThirdPartyConfig,
  getCodexDirectPresetEntries,
  type CodexProviderPreset,
} from "@/config/codexProviderPresets";
import { getCodexCustomTemplate } from "@/config/codexTemplates";
import { type AppId } from "@/lib/api";
import type { ProviderEditorInactiveField } from "@/lib/api/providers";
import {
  buildLocalProxyRequestOverrides,
  formatRequestOverrideObject,
} from "@/lib/requestOverrides";
import { providerSchema, type ProviderFormData } from "@/lib/schemas/provider";
import type {
  ClaudeApiKeyField,
  CodexApiFormat,
  CodexCatalogModel,
  CodexChatReasoning,
  PromptCacheRoutingMode,
  ProviderCategory,
  ProviderMeta,
} from "@/types";
import { providerSupportsDirectConnection } from "@/utils/providerCapabilities";
import {
  codexApiFormatFromWireApi,
  extractCodexModelName,
  extractCodexWireApi,
  setCodexModelName as setCodexModelNameInConfig,
  setCodexWireApi,
} from "@/utils/providerConfigUtils";
import { mergeProviderMeta } from "@/utils/providerMetaUtils";
import { zodResolver } from "@hookform/resolvers/zod";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BasicFormFields } from "./BasicFormFields";
import CodexConfigEditor from "./CodexConfigEditor";
import { CodexFormFields } from "./CodexFormFields";
import { CODEX_DEFAULT_CONFIG } from "./helpers/opencodeFormUtils";
import {
  useApiKeyLink,
  useCodexConfigState,
  useCodexTomlValidation,
  useDraftEditorProjection,
  useProviderCategory,
  useSpeedTestEndpoints,
  type EditorBaseChange,
} from "./hooks";
import { ProviderPresetSelector } from "./ProviderPresetSelector";
type PresetEntry = {
  id: string;
  preset: CodexProviderPreset;
};
function getPresetProviderType(
  preset: PresetEntry["preset"] | null | undefined,
): "codex_oauth" | "xai_oauth" | undefined {
  if (!preset || !("providerType" in preset)) return undefined;
  return preset.providerType === "codex_oauth" ||
    preset.providerType === "xai_oauth"
    ? preset.providerType
    : undefined;
}
export const normalizeCodexCatalogModelsForSave = (
  models: CodexCatalogModel[],
): CodexCatalogModel[] => {
  const seen = new Set<string>();
  const normalized: CodexCatalogModel[] = [];
  for (const item of models) {
    const model = item.model.trim();
    if (!model || seen.has(model)) continue;
    seen.add(model);
    const displayName = item.displayName?.trim();
    const rawContextWindow = String(item.contextWindow ?? "").replace(
      /[^\d]/g,
      "",
    );
    const contextWindow = rawContextWindow
      ? Number.parseInt(rawContextWindow, 10)
      : undefined;
    const inputModalities = item.inputModalities?.filter(
      (m) => typeof m === "string" && m.trim(),
    );
    const baseInstructions = item.baseInstructions?.trim();
    const reasoningLevels = item.reasoningLevels
      ?.filter((level) => typeof level === "string" && level.trim())
      .map((level) => level.trim());
    const defaultReasoningLevel = item.defaultReasoningLevel?.trim();
    normalized.push({
      model,
      ...(displayName ? { displayName } : {}),
      ...(contextWindow && contextWindow > 0 ? { contextWindow } : {}),
      // Native Responses profile overrides.
      ...(typeof item.supportsParallelToolCalls === "boolean"
        ? { supportsParallelToolCalls: item.supportsParallelToolCalls }
        : {}),
      ...(inputModalities && inputModalities.length > 0
        ? { inputModalities }
        : {}),
      ...(baseInstructions ? { baseInstructions } : {}),
      ...(reasoningLevels && reasoningLevels.length > 0
        ? { reasoningLevels }
        : {}),
      ...(defaultReasoningLevel ? { defaultReasoningLevel } : {}),
    });
  }
  return normalized;
};
const normalizeCodexChatReasoningForSave = (
  value?: CodexChatReasoning,
): CodexChatReasoning | undefined => {
  const supportsEffort = value?.supportsEffort === true;
  const supportsThinking = value?.supportsThinking === true || supportsEffort;
  const hasExplicitConfig = value && Object.keys(value).length > 0;
  if (!supportsThinking && !supportsEffort) {
    return hasExplicitConfig
      ? {
          supportsThinking: false,
          supportsEffort: false,
          thinkingParam: "none",
          effortParam: "none",
          outputFormat: value?.outputFormat ?? "auto",
        }
      : undefined;
  }
  return {
    supportsThinking,
    supportsEffort,
    thinkingParam: supportsThinking
      ? (value?.thinkingParam ?? "thinking")
      : "none",
    effortParam: supportsEffort
      ? (value?.effortParam ?? "reasoning_effort")
      : "none",
    effortValueMode: supportsEffort
      ? (value?.effortValueMode ?? "passthrough")
      : undefined,
    outputFormat: value?.outputFormat ?? "auto",
  };
};
type LocalProxyRequestOverridesBuildResult = ReturnType<
  typeof buildLocalProxyRequestOverrides
>;
export interface ProviderFormProps {
  productShell?: boolean;
  /** API Key creation branch; existing managed and native login editors stay available. */
  apiKeyOnly?: boolean;
  /** Account chosen explicitly on the homepage when creating an official configuration. */
  /** Restrict the product's new-provider chooser; existing providers keep their full editor. */
  restrictCodexCreation?: boolean;
  appId: AppId;
  providerId?: string;
  submitLabel: string;
  onSubmit: (values: ProviderFormValues) => Promise<void> | void;
  onCancel: () => void;
  onSubmittingChange?: (isSubmitting: boolean) => void;
  onSubmitReadyChange?: (isReady: boolean) => void;
  initialData?: {
    name?: string;
    websiteUrl?: string;
    notes?: string;
    settingsConfig?: Record<string, unknown>;
    category?: ProviderCategory;
    meta?: ProviderMeta;
    icon?: string;
    iconColor?: string;
  };
  showButtons?: boolean;
  isProxyTakeover?: boolean;
  /** Stored fields that do not follow provider switching. */
  inactiveFields?: ProviderEditorInactiveField[];
  /** The displayed Codex projection and original draft used for three-way save comparison. */
  onEditorBaseChange?: EditorBaseChange;
}
export function ProviderForm(props: ProviderFormProps) {
  if (props.appId !== "codex") return null;
  return <ProviderFormFull {...props} />;
}
function ProviderFormFull({
  appId,
  providerId,
  submitLabel,
  onSubmit,
  onCancel,
  onSubmittingChange,
  onSubmitReadyChange,
  initialData,
  showButtons = true,
  isProxyTakeover = false,
  inactiveFields,
  onEditorBaseChange,
  restrictCodexCreation = false,
  productShell = false,
  apiKeyOnly = false,
}: ProviderFormProps) {
  const { t } = useTranslation();
  const isEditMode = Boolean(initialData);
  const isLegacyUnsupportedConnection =
    Boolean(initialData) &&
    !providerSupportsDirectConnection(appId, {
      id: providerId ?? "",
      name: initialData?.name ?? "",
      settingsConfig: initialData?.settingsConfig ?? {},
      category: initialData?.category,
      meta: initialData?.meta,
    });
  // Editing a stored unsupported record must not require a working upstream login.
  const preserveLegacyConnection =
    productShell && isLegacyUnsupportedConnection;
  const useApiKeyCreation = (apiKeyOnly || productShell) && !initialData;
  const useDirectCreation =
    (productShell || restrictCodexCreation || useApiKeyCreation) &&
    !initialData;
  const getCreationTemplate = useCallback(
    () =>
      useDirectCreation
        ? {
            auth: { OPENAI_API_KEY: "" },
            config: generateThirdPartyConfig(
              "OpenAI API",
              "https://api.openai.com/v1",
            ),
          }
        : getCodexCustomTemplate(),
    [useDirectCreation],
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(
    initialData ? null : "custom",
  );
  const [activePreset, setActivePreset] = useState<{
    id: string;
    category?: ProviderCategory;
    isPartner?: boolean;
    partnerPromotionKey?: string;
  } | null>(null);
  const [isCodexEndpointModalOpen, setIsCodexEndpointModalOpen] =
    useState(false);
  const [draftCustomEndpoints, setDraftCustomEndpoints] = useState<string[]>(
    () => {
      if (initialData) return [];
      return [];
    },
  );
  const [endpointAutoSelect, setEndpointAutoSelect] = useState<boolean>(
    () => initialData?.meta?.endpointAutoSelect ?? true,
  );
  const [localIsFullUrl, setLocalIsFullUrl] = useState<boolean>(() => {
    return initialData?.meta?.isFullUrl ?? false;
  });
  const { category } = useProviderCategory({
    appId,
    selectedPresetId,
    isEditMode,
    initialCategory: initialData?.category ?? undefined,
  });
  useEffect(() => {
    setSelectedPresetId(initialData ? null : "custom");
    setActivePreset(null);
    if (!initialData) {
      setDraftCustomEndpoints([]);
    }
    setEndpointAutoSelect(initialData?.meta?.endpointAutoSelect ?? true);
    setLocalIsFullUrl(initialData?.meta?.isFullUrl ?? false);
    setCodexChatReasoning(initialData?.meta?.codexChatReasoning ?? {});
    setPromptCacheRouting(initialData?.meta?.promptCacheRouting ?? "auto");
    setCustomUserAgent(initialData?.meta?.customUserAgent ?? "");
    setLocalProxyHeadersOverride(
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.headers,
      ),
    );
    setLocalProxyBodyOverride(
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.body,
      ),
    );
  }, [appId, initialData]);
  const defaultValues: ProviderFormData = useMemo(
    () => ({
      name:
        initialData?.name ??
        (useApiKeyCreation ? t("productShell.openAiApi", "OpenAI API") : ""),
      websiteUrl: initialData?.websiteUrl ?? "",
      notes: initialData?.notes ?? "",
      settingsConfig: initialData?.settingsConfig
        ? JSON.stringify(initialData.settingsConfig, null, 2)
        : CODEX_DEFAULT_CONFIG,
      icon: initialData?.icon ?? "",
      iconColor: initialData?.iconColor ?? "",
    }),
    [initialData, useApiKeyCreation, t],
  );
  const form = useForm<ProviderFormData>({
    resolver: zodResolver(providerSchema),
    defaultValues,
    mode: "onSubmit",
  });
  const { isSubmitting } = form.formState;
  // 软校验：收集"业务约束"类问题（空值/缺项），由用户决定是否仍要保存
  const [softIssues, setSoftIssues] = useState<string[] | null>(null);
  const [pendingFormValues, setPendingFormValues] =
    useState<ProviderFormData | null>(null);
  const [
    pendingLocalProxyRequestOverridesResult,
    setPendingLocalProxyRequestOverridesResult,
  ] = useState<LocalProxyRequestOverridesBuildResult | null>(null);
  // 确认框走的提交路径绕过了 react-hook-form 的 isSubmitting，单独追踪
  const [isConfirmSubmitting, setIsConfirmSubmitting] = useState(false);
  useEffect(() => {
    onSubmittingChange?.(isSubmitting || isConfirmSubmitting);
  }, [isSubmitting, isConfirmSubmitting, onSubmittingChange]);
  const [codexChatReasoning, setCodexChatReasoning] =
    useState<CodexChatReasoning>(
      () => initialData?.meta?.codexChatReasoning ?? {},
    );
  const [promptCacheRouting, setPromptCacheRouting] =
    useState<PromptCacheRoutingMode>(
      () => initialData?.meta?.promptCacheRouting ?? "auto",
    );
  const [customUserAgent, setCustomUserAgent] = useState<string>(
    () => initialData?.meta?.customUserAgent ?? "",
  );
  const [localProxyHeadersOverride, setLocalProxyHeadersOverride] =
    useState<string>(() =>
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.headers,
      ),
    );
  const [localProxyBodyOverride, setLocalProxyBodyOverride] = useState<string>(
    () =>
      formatRequestOverrideObject(
        initialData?.meta?.localProxyRequestOverrides?.body,
      ),
  );
  const {
    codexAuth,
    codexConfig,
    codexApiKey,
    codexBaseUrl,
    codexModel,
    codexCatalogModels,
    codexAuthError,
    setCodexAuth,
    setCodexConfig,
    setCodexCatalogModels,
    handleCodexApiKeyChange,
    handleCodexBaseUrlChange,
    handleCodexModelChange,
    handleCodexConfigChange: originalHandleCodexConfigChange,
    resetCodexConfig,
  } = useCodexConfigState({ initialData });
  const initialCodexApiFormat: CodexApiFormat =
    initialData?.meta?.apiFormat === "openai_chat"
      ? "openai_chat"
      : initialData?.meta?.apiFormat === "anthropic"
        ? "anthropic"
        : initialData?.meta?.apiFormat === "openai_responses"
          ? "openai_responses"
          : (codexApiFormatFromWireApi(
              extractCodexWireApi(
                typeof initialData?.settingsConfig?.config === "string"
                  ? initialData.settingsConfig.config
                  : "",
              ),
            ) ?? "openai_responses");
  const [localCodexApiFormat, setLocalCodexApiFormat] =
    useState<CodexApiFormat>(initialCodexApiFormat);
  // Stored legacy Anthropic authentication metadata.
  const initialCodexAnthropicAuthField: ClaudeApiKeyField =
    initialData?.meta?.apiKeyField === "ANTHROPIC_API_KEY"
      ? "ANTHROPIC_API_KEY"
      : "ANTHROPIC_AUTH_TOKEN";
  const [localCodexAnthropicAuthField, setLocalCodexAnthropicAuthField] =
    useState<ClaudeApiKeyField>(initialCodexAnthropicAuthField);
  // Preserve legacy client metadata without exposing conversion controls.
  const [localCodexImpersonateClaudeCode, setLocalCodexImpersonateClaudeCode] =
    useState<boolean>(initialData?.meta?.impersonateClaudeCode === true);
  // Stored legacy output ceiling.
  // Kept as a string so the numeric input can be cleared; parsed on save.
  const [localCodexMaxOutputTokens, setLocalCodexMaxOutputTokens] =
    useState<string>(
      typeof initialData?.meta?.maxOutputTokens === "number" &&
        initialData.meta.maxOutputTokens > 0
        ? String(initialData.meta.maxOutputTokens)
        : "",
    );
  const { configError: codexConfigError, debouncedValidate } =
    useCodexTomlValidation();
  const handleCodexConfigChange = useCallback(
    (value: string) => {
      originalHandleCodexConfigChange(value);
      debouncedValidate(value);
    },
    [originalHandleCodexConfigChange, debouncedValidate],
  );
  const handleCodexApiFormatChange = useCallback(
    (format: CodexApiFormat) => {
      setLocalCodexApiFormat(format);
      // Legacy protocol state is retained by old callers; native creation uses Responses.
      setCodexConfig((prev) => {
        const updated = setCodexWireApi(prev, "responses");
        debouncedValidate(updated);
        return updated;
      });
    },
    [setCodexConfig, debouncedValidate],
  );
  // 新增：预设或模板投影到当前配置文件上显示。每次重置显示内容都要重新投影，否则保存时
  // 三方比较的底和显示内容对不上。
  const { projectDraft, clearDraftProjection } = useDraftEditorProjection(
    appId,
    onEditorBaseChange,
  );
  const needsDraftProjection = useRef(true);
  const [isDraftProjectionPending, setIsDraftProjectionPending] =
    useState(false);
  const restartDraftProjection = useCallback(() => {
    needsDraftProjection.current = true;
    clearDraftProjection();
  }, [clearDraftProjection]);
  useEffect(() => {
    onSubmitReadyChange?.(!isDraftProjectionPending);
  }, [onSubmitReadyChange, isDraftProjectionPending]);
  useEffect(() => {
    if (!initialData && selectedPresetId === "custom") {
      const template = getCreationTemplate();
      restartDraftProjection();
      resetCodexConfig(template.auth, template.config);
      setCodexChatReasoning({});
      setPromptCacheRouting("auto");
    }
  }, [
    appId,
    initialData,
    selectedPresetId,
    resetCodexConfig,
    restartDraftProjection,
    getCreationTemplate,
  ]);
  useEffect(() => {
    form.reset(defaultValues);
  }, [defaultValues, form]);
  const presetCategoryLabels: Record<string, string> = useMemo(
    () => ({
      official: t("providerForm.categoryOfficial", {
        defaultValue: "官方",
      }),
      cn_official: t("providerForm.categoryCnOfficial", {
        defaultValue: "国内官方",
      }),
      aggregator: t("providerForm.categoryAggregation", {
        defaultValue: "聚合服务",
      }),
      third_party: t("providerForm.categoryThirdParty", {
        defaultValue: "第三方",
      }),
    }),
    [t],
  );
  const presetEntries = useMemo(() => {
    const entries = useDirectCreation
      ? getCodexDirectPresetEntries()
      : codexProviderPresets.map<PresetEntry>((preset, index) => ({
          id: `codex-${index}`,
          preset,
        }));
    return useApiKeyCreation || productShell
      ? entries.filter(
          ({ preset }) =>
            !getPresetProviderType(preset) && !preset.requiresOAuth,
        )
      : entries;
  }, [useDirectCreation, useApiKeyCreation, productShell]);
  const selectedPresetEntry = useMemo(
    () =>
      selectedPresetId && selectedPresetId !== "custom"
        ? (presetEntries.find((entry) => entry.id === selectedPresetId) ?? null)
        : null,
    [presetEntries, selectedPresetId],
  );
  const presetProviderType = getPresetProviderType(selectedPresetEntry?.preset);
  const initialProviderType = initialData?.meta?.providerType;
  const isXaiOauthProvider =
    presetProviderType === "xai_oauth" || initialProviderType === "xai_oauth";
  const isCodexOfficialProvider = false;
  const shouldApplyLocalProxyRequestOverrides =
    category !== "official" && !productShell;
  useEffect(() => {
    if (initialData || !onEditorBaseChange || !needsDraftProjection.current)
      return;
    // Empty API-key templates are unfinished drafts, not broken live files. The
    // backend's strict credential guard still runs once the draft is complete.
    let auth: Record<string, unknown>;
    try {
      auth = JSON.parse(codexAuth || "{}");
      if (!auth || typeof auth !== "object" || Array.isArray(auth))
        throw new Error("Incomplete auth draft");
    } catch {
      clearDraftProjection();
      setIsDraftProjectionPending(false);
      return;
    }
    if (
      !isCodexOfficialProvider &&
      !isXaiOauthProvider &&
      (!codexApiKey.trim() || !codexBaseUrl.trim())
    ) {
      clearDraftProjection();
      setIsDraftProjectionPending(false);
      return;
    }
    let active = true;
    let settled = false;
    setIsDraftProjectionPending(true);
    // Wait for input to settle; edits and preset changes invalidate both the
    // timer and any request before an older projection can overwrite them.
    const timer = setTimeout(() => {
      void projectDraft({ auth, config: codexConfig }, category, (shown) => {
        needsDraftProjection.current = false;
        settled = true;
        setIsDraftProjectionPending(false);
        setCodexConfig(typeof shown.config === "string" ? shown.config : "");
      }).then(() => {
        if (!active) return;
        settled = true;
        needsDraftProjection.current = false;
        setIsDraftProjectionPending(false);
      });
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
      if (!settled) clearDraftProjection();
    };
  }, [
    initialData,
    onEditorBaseChange,
    codexAuth,
    codexConfig,
    codexApiKey,
    codexBaseUrl,
    category,
    isCodexOfficialProvider,
    isXaiOauthProvider,
    projectDraft,
    clearDraftProjection,
    setCodexConfig,
  ]);
  const handleSubmit = async (values: ProviderFormData) => {
    if (isDraftProjectionPending) return;
    const overridesResult = shouldApplyLocalProxyRequestOverrides
      ? buildLocalProxyRequestOverrides(
          localProxyHeadersOverride,
          localProxyBodyOverride,
        )
      : {};
    if (overridesResult.error) {
      toast.error(
        t("providerForm.localProxyRequestOverridesInvalid", {
          defaultValue: `本地代理请求覆盖格式错误：${overridesResult.error}`,
          error: overridesResult.error,
        }),
      );
      return;
    }
    // 软性问题（业务约束，用户可选择仍要保存）
    const issues: string[] = [];
    // 供应商名空：A 类
    if (!values.name.trim()) {
      issues.push(
        t("providerForm.fillSupplierName", {
          defaultValue: "请填写供应商名称",
        }),
      );
    }
    // 非官方供应商端点 / API Key 空：A 类
    // cloud_provider（如 Bedrock）通过模板变量处理认证，跳过通用校验
    if (category !== "official" && category !== "cloud_provider") {
      // Saved managed OAuth records do not require a static API key to remain editable.
      if (!isXaiOauthProvider && !codexBaseUrl.trim()) {
        issues.push(
          t("providerForm.endpointRequired", {
            defaultValue: "非官方供应商请填写 API 端点",
          }),
        );
      }
      if (!isXaiOauthProvider && !codexApiKey.trim()) {
        issues.push(
          t("providerForm.apiKeyRequired", {
            defaultValue: "非官方供应商请填写 API Key",
          }),
        );
      }
    }
    if (issues.length > 0) {
      // 弹确认框让用户决定是否仍要保存
      setSoftIssues(issues);
      setPendingFormValues(values);
      setPendingLocalProxyRequestOverridesResult(overridesResult);
      return;
    }
    await performSubmit(values, overridesResult);
  };
  const performSubmit = async (
    values: ProviderFormData,
    overridesResult: LocalProxyRequestOverridesBuildResult,
  ) => {
    if (overridesResult.error) {
      toast.error(
        t("providerForm.localProxyRequestOverridesInvalid", {
          defaultValue: `本地代理请求覆盖格式错误：${overridesResult.error}`,
          error: overridesResult.error,
        }),
      );
      return;
    }
    let settingsConfig: string;
    try {
      const authJson = JSON.parse(codexAuth);
      const codexConfigForSave = codexConfig ?? "";
      let normalizedCodexConfig =
        !isEditMode && category !== "official" && codexConfigForSave.trim()
          ? setCodexWireApi(codexConfigForSave, "responses")
          : codexConfigForSave;
      // Native Responses catalogs persist per-model customizations. Legacy catalogs
      // remain editable without converting their saved protocol.
      const normalizedCatalogModels =
        category !== "official" ||
        preserveLegacyConnection ||
        Boolean(codexApiKey.trim())
          ? normalizeCodexCatalogModelsForSave(codexCatalogModels)
          : [];
      // The default-model field writes the top-level `model` into the TOML
      // as the user types; only when it was left empty fall back to the
      // first catalog row so "fill mapping only" keeps its old behavior.
      if (
        normalizedCatalogModels.length > 0 &&
        !extractCodexModelName(normalizedCodexConfig)
      ) {
        normalizedCodexConfig = setCodexModelNameInConfig(
          normalizedCodexConfig,
          normalizedCatalogModels[0].model,
        );
      }
      const configObj = {
        // Preserve raw legacy protocol flags and future native settings when editing.
        ...(isEditMode ? (initialData?.settingsConfig ?? {}) : {}),
        auth: authJson,
        config: normalizedCodexConfig,
      } as {
        auth: unknown;
        config: string;
        modelCatalog?: {
          models: CodexCatalogModel[];
        };
      };
      if (normalizedCatalogModels.length > 0) {
        configObj.modelCatalog = { models: normalizedCatalogModels };
      } else {
        delete configObj.modelCatalog;
      }
      settingsConfig = JSON.stringify(configObj);
    } catch (err) {
      settingsConfig = values.settingsConfig.trim();
    }
    const payload: ProviderFormValues = {
      ...values,
      name: values.name.trim(),
      websiteUrl: values.websiteUrl?.trim() ?? "",
      settingsConfig,
    };
    if (isCodexOfficialProvider) {
      payload.presetCategory = "official";
    }
    if (activePreset) {
      payload.presetId = activePreset.id;
      if (activePreset.category) {
        payload.presetCategory = activePreset.category;
      }
      if (activePreset.isPartner) {
        payload.isPartner = activePreset.isPartner;
      }
    }
    if (!isEditMode && draftCustomEndpoints.length > 0) {
      const customEndpointsToSave: Record<
        string,
        import("@/types").CustomEndpoint
      > = draftCustomEndpoints.reduce(
        (acc, url) => {
          const now = Date.now();
          acc[url] = { url, addedAt: now, lastUsed: undefined };
          return acc;
        },
        {} as Record<string, import("@/types").CustomEndpoint>,
      );
      const hadEndpoints =
        initialData?.meta?.custom_endpoints &&
        Object.keys(initialData.meta.custom_endpoints).length > 0;
      const needsClearEndpoints =
        hadEndpoints && draftCustomEndpoints.length === 0;
      let mergedMeta = needsClearEndpoints
        ? mergeProviderMeta(initialData?.meta, {})
        : mergeProviderMeta(initialData?.meta, customEndpointsToSave);
      if (activePreset?.isPartner) {
        mergedMeta = {
          ...(mergedMeta ?? {}),
          isPartner: true,
        };
      }
      if (activePreset?.partnerPromotionKey) {
        mergedMeta = {
          ...(mergedMeta ?? {}),
          partnerPromotionKey: activePreset.partnerPromotionKey,
        };
      }
      if (mergedMeta !== undefined) {
        payload.meta = mergedMeta;
      }
    }
    const metaSource = payload.meta ?? initialData?.meta;
    const baseMeta: ProviderMeta | undefined = metaSource
      ? { ...metaSource }
      : undefined;
    // Existing-provider edits never own endpoint membership. The backend
    // rejects endpoint-bearing update payloads; add/remove/touch use their
    // dedicated commands and remain safe from stale form snapshots.
    if (isEditMode && baseMeta) {
      delete baseMeta.custom_endpoints;
    }
    const nextMeta: ProviderMeta = {
      ...(baseMeta ?? {}),
      // Preserve the existing frozen common-config marker; new rows use the backend default.
      commonConfigEnabled: initialData?.meta?.commonConfigEnabled,
      endpointAutoSelect: productShell
        ? initialData?.meta?.endpointAutoSelect
        : endpointAutoSelect,
      claudeDesktopMode: undefined,
      // API providers never own subscription credentials or account bindings.
      providerType: isXaiOauthProvider ? "xai_oauth" : undefined,
      codexAccountManaged: undefined,
      authBinding: undefined,
      // Keep the existing Codex save behavior for unsupported legacy client metadata.
      githubAccountId: undefined,
      codexFastMode: undefined,
      codexChatReasoning:
        category !== "official" && localCodexApiFormat === "openai_chat"
          ? normalizeCodexChatReasoningForSave(codexChatReasoning)
          : undefined,
      promptCacheRouting:
        category !== "official" &&
        localCodexApiFormat === "openai_chat" &&
        promptCacheRouting !== "auto"
          ? promptCacheRouting
          : undefined,
      customUserAgent: productShell
        ? initialData?.meta?.customUserAgent
        : category !== "official"
          ? customUserAgent.trim() || undefined
          : undefined,
      localProxyRequestOverrides: productShell
        ? initialData?.meta?.localProxyRequestOverrides
        : shouldApplyLocalProxyRequestOverrides
          ? overridesResult.overrides
          : undefined,
      apiFormat:
        category !== "official"
          ? isXaiOauthProvider
            ? "openai_responses"
            : localCodexApiFormat
          : undefined,
      apiKeyField:
        category !== "official" &&
        localCodexApiFormat === "anthropic" &&
        localCodexAnthropicAuthField !== "ANTHROPIC_AUTH_TOKEN"
          ? localCodexAnthropicAuthField
          : undefined,
      // Persist the existing Anthropic client option only when explicitly enabled.
      impersonateClaudeCode:
        category !== "official" &&
        localCodexApiFormat === "anthropic" &&
        localCodexImpersonateClaudeCode
          ? true
          : undefined,
      // Persist only for codex+anthropic when a positive value was entered
      maxOutputTokens:
        category !== "official" &&
        localCodexApiFormat === "anthropic" &&
        localCodexMaxOutputTokens.trim() !== "" &&
        Number(localCodexMaxOutputTokens) > 0
          ? Number(localCodexMaxOutputTokens)
          : undefined,
      isFullUrl:
        category !== "official" && !isXaiOauthProvider && localIsFullUrl
          ? true
          : undefined,
    };
    if ("codexFastMode" in nextMeta) {
      delete nextMeta.codexFastMode;
    }
    if (!isXaiOauthProvider && "providerType" in nextMeta) {
      delete nextMeta.providerType;
    }
    if (!nextMeta.authBinding && "authBinding" in nextMeta) {
      delete nextMeta.authBinding;
    }
    if (!nextMeta.githubAccountId && "githubAccountId" in nextMeta) {
      delete nextMeta.githubAccountId;
    }
    // Hidden legacy protocol/auth/request fields retain their exact stored values.
    payload.meta = preserveLegacyConnection ? baseMeta : nextMeta;
    await onSubmit(payload);
  };
  const shouldShowSpeedTest =
    category !== "official" && category !== "cloud_provider";
  const {
    shouldShowApiKeyLink: shouldShowCodexApiKeyLink,
    websiteUrl: codexWebsiteUrl,
    isPartner: isCodexPartner,
    partnerPromotionKey: codexPartnerPromotionKey,
  } = useApiKeyLink({
    appId: "codex",
    category,
    selectedPresetId,
    presetEntries,
    formWebsiteUrl: form.watch("websiteUrl") || "",
  });
  // 使用端点测速候选 hook
  const speedTestEndpoints = useSpeedTestEndpoints({
    appId,
    selectedPresetId,
    presetEntries,
    baseUrl: "",
    codexBaseUrl,
    initialData,
  });
  const handlePresetChange = (value: string) => {
    restartDraftProjection();
    setSelectedPresetId(value);
    if (value === "custom") {
      setActivePreset(null);
      form.reset(defaultValues);
      const template = getCreationTemplate();
      resetCodexConfig(template.auth, template.config);
      setCodexChatReasoning({});
      setPromptCacheRouting("auto");
      setLocalCodexApiFormat(
        codexApiFormatFromWireApi(extractCodexWireApi(template.config)) ??
          "openai_responses",
      );
      return;
    }
    const entry = presetEntries.find((item) => item.id === value);
    if (!entry) {
      return;
    }
    setActivePreset({
      id: value,
      category: entry.preset.category,
      isPartner: entry.preset.isPartner,
      partnerPromotionKey: entry.preset.partnerPromotionKey,
    });
    const preset = entry.preset as CodexProviderPreset;
    const auth = preset.auth ?? {};
    const config = preset.config ?? "";
    resetCodexConfig(auth, config, preset.modelCatalog ?? []);
    setCodexChatReasoning(preset.codexChatReasoning ?? {});
    setPromptCacheRouting(preset.promptCacheRouting ?? "auto");
    setLocalCodexApiFormat(
      preset.apiFormat ??
        codexApiFormatFromWireApi(extractCodexWireApi(config)) ??
        "openai_responses",
    );
    form.reset({
      name: preset.nameKey ? t(preset.nameKey) : preset.name,
      websiteUrl: preset.websiteUrl ?? "",
      settingsConfig: JSON.stringify({ auth, config }, null, 2),
      icon: preset.icon ?? "",
      iconColor: preset.iconColor ?? "",
    });
    return;
  };
  const settingsConfigErrorField = (
    <FormField
      control={form.control}
      name="settingsConfig"
      render={() => (
        <FormItem className="space-y-0">
          <FormMessage />
        </FormItem>
      )}
    />
  );
  return (
    <>
      <Form {...form}>
        <form
          id="provider-form"
          onSubmit={form.handleSubmit(handleSubmit)}
          className="space-y-6 glass rounded-xl p-6 border border-white/10"
        >
          {!initialData && (
            <ProviderPresetSelector
              customLabel={
                useDirectCreation
                  ? t("productShell.openAiApi", "OpenAI API")
                  : undefined
              }
              selectedPresetId={selectedPresetId}
              presetEntries={presetEntries}
              presetCategoryLabels={presetCategoryLabels}
              onPresetChange={handlePresetChange}
              category={category === "official" ? "custom" : category}
              categoryHint={
                <HelpButton
                  label={t(
                    "providerForm.connectionHelp",
                    "Connection setup help",
                  )}
                >
                  {t("provider.addFooterHint")}
                </HelpButton>
              }
            />
          )}

          <BasicFormFields form={form} />

          <CodexFormFields
            productShell={productShell}
            isLegacyUnsupported={isLegacyUnsupportedConnection}
            providerId={providerId}
            isXaiOauthPreset={isXaiOauthProvider}
            codexApiKey={codexApiKey}
            onApiKeyChange={handleCodexApiKeyChange}
            category={category === "official" ? "custom" : category}
            shouldShowApiKeyLink={shouldShowCodexApiKeyLink}
            websiteUrl={codexWebsiteUrl}
            isPartner={isCodexPartner}
            partnerPromotionKey={codexPartnerPromotionKey}
            shouldShowSpeedTest={shouldShowSpeedTest}
            codexBaseUrl={codexBaseUrl}
            onBaseUrlChange={handleCodexBaseUrlChange}
            isFullUrl={localIsFullUrl}
            onFullUrlChange={setLocalIsFullUrl}
            isEndpointModalOpen={isCodexEndpointModalOpen}
            onEndpointModalToggle={setIsCodexEndpointModalOpen}
            onCustomEndpointsChange={
              isEditMode ? undefined : setDraftCustomEndpoints
            }
            autoSelect={endpointAutoSelect}
            onAutoSelectChange={setEndpointAutoSelect}
            codexModel={codexModel}
            onModelChange={handleCodexModelChange}
            apiFormat={localCodexApiFormat}
            onApiFormatChange={handleCodexApiFormatChange}
            anthropicAuthField={localCodexAnthropicAuthField}
            onAnthropicAuthFieldChange={setLocalCodexAnthropicAuthField}
            impersonateClaudeCode={localCodexImpersonateClaudeCode}
            onImpersonateClaudeCodeChange={setLocalCodexImpersonateClaudeCode}
            maxOutputTokens={localCodexMaxOutputTokens}
            onMaxOutputTokensChange={setLocalCodexMaxOutputTokens}
            codexChatReasoning={codexChatReasoning}
            onCodexChatReasoningChange={setCodexChatReasoning}
            promptCacheRouting={promptCacheRouting}
            onPromptCacheRoutingChange={setPromptCacheRouting}
            catalogModels={codexCatalogModels}
            onCatalogModelsChange={setCodexCatalogModels}
            speedTestEndpoints={speedTestEndpoints}
            customUserAgent={customUserAgent}
            onCustomUserAgentChange={setCustomUserAgent}
            localProxyHeadersOverride={localProxyHeadersOverride}
            onLocalProxyHeadersOverrideChange={setLocalProxyHeadersOverride}
            localProxyBodyOverride={localProxyBodyOverride}
            onLocalProxyBodyOverrideChange={setLocalProxyBodyOverride}
            advancedContent={
              <CodexConfigEditor
                authValue={codexAuth}
                configValue={codexConfig}
                providerName={form.watch("name")}
                showRemoteCompaction={category !== "official"}
                isProxyTakeover={isProxyTakeover}
                onAuthChange={setCodexAuth}
                onConfigChange={handleCodexConfigChange}
                authError={codexAuthError}
                configError={codexConfigError}
                inactiveFields={inactiveFields}
              />
            }
          />
          {settingsConfigErrorField}

          {showButtons && (
            <div className="flex justify-end gap-2">
              <Button variant="outline" type="button" onClick={onCancel}>
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={
                  isSubmitting ||
                  isConfirmSubmitting ||
                  isDraftProjectionPending
                }
              >
                {submitLabel}
              </Button>
            </div>
          )}
        </form>
      </Form>

      <ConfirmDialog
        isOpen={softIssues !== null && softIssues.length > 0}
        variant="info"
        title={t("providerForm.softValidation.title", {
          defaultValue: "配置存在以下问题",
        })}
        message={
          (softIssues ?? []).map((issue) => `• ${issue}`).join("\n") +
          "\n\n" +
          t("providerForm.softValidation.hint", {
            defaultValue:
              "仍要保存吗？保存后切换此供应商时可能失败，可以之后再补全。",
          })
        }
        confirmText={t("providerForm.softValidation.saveAnyway", {
          defaultValue: "仍要保存",
        })}
        cancelText={t("common.cancel")}
        onConfirm={async () => {
          if (isConfirmSubmitting) return;
          const values = pendingFormValues;
          const overridesResult = pendingLocalProxyRequestOverridesResult;
          if (!values || !overridesResult) {
            setSoftIssues(null);
            setPendingFormValues(null);
            setPendingLocalProxyRequestOverridesResult(null);
            return;
          }
          setIsConfirmSubmitting(true);
          try {
            await performSubmit(values, overridesResult);
            setSoftIssues(null);
            setPendingFormValues(null);
            setPendingLocalProxyRequestOverridesResult(null);
          } catch (error) {
            console.error("[ProviderForm] soft-confirm submit failed:", error);
          } finally {
            setIsConfirmSubmitting(false);
          }
        }}
        onCancel={() => {
          if (isConfirmSubmitting) return;
          setSoftIssues(null);
          setPendingFormValues(null);
          setPendingLocalProxyRequestOverridesResult(null);
        }}
      />
    </>
  );
}
export type ProviderFormValues = ProviderFormData & {
  presetId?: string;
  presetCategory?: ProviderCategory;
  isPartner?: boolean;
  meta?: ProviderMeta;
};
