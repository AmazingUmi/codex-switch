import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { UsageHero } from "./UsageHero";
import { UsageTrendChart } from "./UsageTrendChart";
import { UsageRecordsTable } from "./UsageRecordsTable";
import { ProviderStatsTable } from "./ProviderStatsTable";
import { ModelStatsTable } from "./ModelStatsTable";
import { type UsageRangeSelection } from "@/types/usage";
import { motion } from "framer-motion";
import {
  BarChart3,
  ListFilter,
  Activity,
  RefreshCw,
  Coins,
  DatabaseBackup,
  Loader2,
  ScanSearch,
  Settings,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useQueryClient } from "@tanstack/react-query";
import {
  usageKeys,
  useModelStats,
  useUsageAttributionChoices,
} from "@/lib/query/usage";
import {
  UNASSIGNED_SOURCE,
  sourceIdentity,
  sourceFilters,
  flatSourceChoices,
  sourceOptionLabel,
} from "@/lib/usageSource";
import { useUsageEventBridge } from "@/hooks/useUsageEventBridge";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { PricingConfigPanel } from "@/components/usage/PricingConfigPanel";
import { formatUsageDateTime, getLocaleFromLanguage } from "./format";
import { getUsageRangePresetLabel, resolveUsageRange } from "@/lib/usageRange";
import { UsageDateRangePicker } from "./UsageDateRangePicker";
import { UsageSessionSourceDialog } from "./UsageSessionSourceDialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { Switch } from "@/components/ui/switch";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { usageApi } from "@/lib/api/usage";
import { toast } from "sonner";

const DEFAULT_REFRESH_INTERVAL_MS = 30000;
const REFRESH_INTERVAL_OPTIONS_MS = [0, 5000, 10000, 30000, 60000] as const;
type RefreshIntervalOption = (typeof REFRESH_INTERVAL_OPTIONS_MS)[number];

const isRefreshIntervalOption = (
  value: number | undefined,
): value is RefreshIntervalOption =>
  REFRESH_INTERVAL_OPTIONS_MS.includes(value as RefreshIntervalOption);

const normalizeRefreshInterval = (value: number | undefined) =>
  isRefreshIntervalOption(value) ? value : DEFAULT_REFRESH_INTERVAL_MS;

// Select 的 "all" 哨兵和模型名称同处一个值域——真有模型叫 "all"
// 就会撞名（重复 value、选中即清空筛选）。动态选项统一加前缀编码隔离值域。
const DYNAMIC_OPTION_PREFIX = "v:";
const encodeOptionValue = (name: string) => `${DYNAMIC_OPTION_PREFIX}${name}`;
const decodeOptionValue = (value: string) =>
  value === "all" ? undefined : value.slice(DYNAMIC_OPTION_PREFIX.length);

interface UsageDashboardProps {
  refreshIntervalMs?: number;
  onRefreshIntervalChange?: (next: number) => Promise<boolean> | boolean | void;
  sessionAutoSyncEnabled?: boolean;
  onSessionAutoSyncEnabledChange?: (
    next: boolean,
  ) => Promise<boolean> | boolean | void;
  codexUsageSourceDir?: string;
  onCodexUsageSourceDirChange?: (next?: string) => Promise<boolean>;
}

export function UsageDashboard({
  refreshIntervalMs: savedRefreshIntervalMs,
  onRefreshIntervalChange,
  sessionAutoSyncEnabled = true,
  onSessionAutoSyncEnabledChange,
  codexUsageSourceDir,
  onCodexUsageSourceDirChange,
}: UsageDashboardProps = {}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<UsageRangeSelection>({ preset: "today" });
  const appType = "codex";
  const [sourceId, setSourceId] = useState("");
  const { accountId, providerId } = sourceFilters(sourceId);
  const { data: attributionChoices } = useUsageAttributionChoices();
  const sourceChoices = useMemo(
    () => flatSourceChoices(attributionChoices ?? []),
    [attributionChoices],
  );
  const sourceLabel = (choice: (typeof sourceChoices)[number]) =>
    sourceOptionLabel(
      choice,
      sourceChoices,
      t("usage.records.accountType", "Account"),
      t("usage.records.apiType", "API"),
    );
  const selectedSource = sourceChoices.find(
    (choice) =>
      sourceIdentity(choice.accountId, choice.providerId) === sourceId,
  );
  const selectedSourceLabel = selectedSource
    ? sourceLabel(selectedSource)
    : sourceId === UNASSIGNED_SOURCE
      ? t("usage.records.untagged", "Unassigned")
      : t("usage.allSources");
  const [model, setModel] = useState<string | undefined>(undefined);
  const [refreshIntervalMs, setRefreshIntervalMs] = useState(() =>
    normalizeRefreshInterval(savedRefreshIntervalMs),
  );
  const [showRebuildConfirm, setShowRebuildConfirm] = useState(false);
  const [rebuildingCodex, setRebuildingCodex] = useState(false);
  const [syncingSession, setSyncingSession] = useState(false);
  const [showSessionSource, setShowSessionSource] = useState(false);

  useEffect(() => {
    setRefreshIntervalMs(normalizeRefreshInterval(savedRefreshIntervalMs));
  }, [savedRefreshIntervalMs]);

  const changeSource = (next: string) => {
    setSourceId(next);
    if (next !== sourceId) {
      setModel(undefined);
    }
  };

  // 后端写入新日志时 emit `usage-log-recorded`，本 hook 立刻 invalidate 所有
  // usage 查询，实现实时刷新（仅在 Dashboard 挂载时生效，离开页面自动取消监听）
  useUsageEventBridge();

  const changeRefreshInterval = async (next: number) => {
    const normalized = normalizeRefreshInterval(next);
    const previous = refreshIntervalMs;
    setRefreshIntervalMs(normalized);
    queryClient.invalidateQueries({ queryKey: usageKeys.all });
    try {
      const saved = await onRefreshIntervalChange?.(normalized);
      if (saved === false) {
        setRefreshIntervalMs(previous);
      }
    } catch (error) {
      console.error(
        "[UsageDashboard] Failed to persist refresh interval",
        error,
      );
      setRefreshIntervalMs(previous);
    }
  };

  const rebuildCodexUsage = async () => {
    setShowRebuildConfirm(false);
    setRebuildingCodex(true);
    try {
      const result = await usageApi.rebuildCodexUsage();
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
      const message = t("usage.rebuildCodex.completed", {
        imported: result.imported,
        errors: result.errors.length,
        suspected: result.suspectedDuplicates,
        deferred: result.deferredFiles,
      });
      if (result.errors.length > 0 || result.deferredFiles > 0) {
        toast.warning(message);
      } else {
        toast.success(message);
      }
    } catch (error) {
      toast.error(
        t("usage.rebuildCodex.failed", {
          error: String(error),
        }),
      );
    } finally {
      setRebuildingCodex(false);
    }
  };

  // Keep explicit sync available in automatic mode to verify a changed source.
  const runManualSessionSync = async () => {
    setSyncingSession(true);
    try {
      const result = await usageApi.syncSessionUsage();
      await queryClient.invalidateQueries({ queryKey: usageKeys.all });
      const message = t("usage.sessionSync.syncCompleted", {
        imported: result.imported,
        files: result.filesScanned,
        errors: result.errors.length,
      });
      if (result.errors.length > 0) {
        toast.warning(message);
      } else {
        toast.success(message);
      }
    } catch (error) {
      toast.error(
        t("usage.sessionSync.syncFailed", {
          error: String(error),
        }),
      );
    } finally {
      setSyncingSession(false);
    }
  };

  const language = i18n.resolvedLanguage || i18n.language || "en";
  const locale = getLocaleFromLanguage(language);
  const resolvedRange = useMemo(() => resolveUsageRange(range), [range]);
  const rangeLabel = useMemo(() => {
    if (range.preset !== "custom") {
      return getUsageRangePresetLabel(range.preset, t);
    }

    const startStr = formatUsageDateTime(
      new Date(resolvedRange.startDate * 1000),
      locale,
      { includeYear: true, includeTimeZone: true },
    );

    if (range.liveEndTime) {
      return `${startStr} → ${t("usage.liveEndTimeNow", "现在")}`;
    }

    const endStr = formatUsageDateTime(
      new Date(resolvedRange.endDate * 1000),
      locale,
      { includeYear: true, includeTimeZone: true },
    );
    return `${startStr} - ${endStr}`;
  }, [locale, range, resolvedRange.endDate, resolvedRange.startDate, t]);

  // Sources include configured accounts/providers even before any usage exists.
  // Model options follow the selected canonical source and time range.
  const optionsRefetch = {
    refetchInterval:
      refreshIntervalMs > 0 ? refreshIntervalMs : (false as const),
  };
  const { data: modelOptionsData } = useModelStats(
    range,
    { appType, accountId, providerId },
    optionsRefetch,
  );

  const modelOptions = useMemo(() => {
    const names = new Set<string>();
    for (const stat of modelOptionsData ?? []) {
      names.add(stat.model);
    }
    if (model) names.add(model);
    return Array.from(names);
  }, [modelOptionsData, model]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-8 pb-8"
    >
      <div className="flex flex-col lg:flex-row lg:items-end justify-between gap-4 mb-2">
        <div className="flex items-center gap-2">
          <h2 className="text-2xl font-bold tracking-tight">
            {t("usage.title")}
          </h2>
          <HelpButton
            label={t("codexAccounts.localUsageScopeLabel", "Statistics scope")}
          >
            {t(
              "codexAccounts.localUsageScope",
              "统计本机记录的 Codex 请求及扫描到的会话，按所选时间、连接来源和模型筛选；不会汇总账号在其他设备的用量，也不代表订阅额度。费用按本地价格表估算。",
            )}
          </HelpButton>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={sourceId || "all"}
            onValueChange={(value) =>
              changeSource(value === "all" ? "" : value)
            }
          >
            <SelectTrigger
              className="h-9 w-[160px] max-w-full gap-2 px-4 text-xs font-medium [&>span]:min-w-0 [&>span]:truncate [&>svg]:h-3.5 [&>svg]:w-3.5"
              title={selectedSourceLabel}
              aria-label={t("usage.filterBySource")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[280px]">
              <SelectItem value="all">{t("usage.allSources")}</SelectItem>
              <SelectItem value={UNASSIGNED_SOURCE}>
                {t("usage.records.untagged", "Unassigned")}
              </SelectItem>
              {sourceChoices.map((choice) => (
                <SelectItem
                  key={sourceIdentity(choice.accountId, choice.providerId)}
                  value={sourceIdentity(choice.accountId, choice.providerId)}
                  title={sourceLabel(choice)}
                  className="[&>span]:min-w-0 [&>span]:truncate"
                >
                  {sourceLabel(choice)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={model != null ? encodeOptionValue(model) : "all"}
            onValueChange={(v) => setModel(decodeOptionValue(v))}
          >
            <SelectTrigger
              className="h-9 w-[144px] bg-background text-xs focus:border-border-default [&>span]:min-w-0 [&>span]:truncate"
              title={model ?? t("usage.filterByModel")}
              aria-label={t("usage.filterByModel")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-w-[280px]">
              <SelectItem value="all">{t("usage.allModels")}</SelectItem>
              {modelOptions.map((name) => (
                <SelectItem
                  key={name}
                  value={encodeOptionValue(name)}
                  title={name}
                  className="[&>span]:min-w-0 [&>span]:truncate"
                >
                  {name === "Unassigned"
                    ? t("usage.records.untagged", "Unassigned")
                    : name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2 ml-auto lg:ml-0">
            <Select
              value={String(refreshIntervalMs)}
              onValueChange={(v) => changeRefreshInterval(Number(v))}
            >
              <SelectTrigger
                className="h-9 w-[120px] bg-background text-xs focus:border-border-default"
                title={t("usage.refreshInterval")}
                aria-label={t("usage.refreshInterval")}
              >
                <span className="flex items-center gap-2">
                  <RefreshCw className="h-3.5 w-3.5 shrink-0" />
                  <SelectValue />
                </span>
              </SelectTrigger>
              <SelectContent>
                {REFRESH_INTERVAL_OPTIONS_MS.map((ms) => (
                  <SelectItem key={ms} value={String(ms)}>
                    {ms > 0 ? `${ms / 1000}s` : t("usage.refreshOff")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <UsageDateRangePicker
              selection={range}
              triggerLabel={rangeLabel}
              onApply={(nextRange) => setRange(nextRange)}
            />
          </div>
        </div>
      </div>

      <UsageHero
        range={range}
        appType={appType}
        accountId={accountId}
        providerId={providerId}
        model={model}
        refreshIntervalMs={refreshIntervalMs}
      />

      <UsageTrendChart
        range={range}
        rangeLabel={rangeLabel}
        appType={appType}
        accountId={accountId}
        providerId={providerId}
        model={model}
        refreshIntervalMs={refreshIntervalMs}
      />

      <div className="space-y-4">
        <Tabs defaultValue="logs" className="w-full">
          <div className="flex items-center justify-between mb-4">
            <TabsList>
              <TabsTrigger value="logs" className="gap-2">
                <ListFilter className="h-4 w-4" />
                {t("usage.records.title", "Usage records")}
              </TabsTrigger>
              <TabsTrigger value="providers" className="gap-2">
                <Activity className="h-4 w-4" />
                {t("usage.sourceStats")}
              </TabsTrigger>
              <TabsTrigger value="models" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                {t("usage.modelStats")}
              </TabsTrigger>
            </TabsList>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 }}
          >
            <TabsContent value="logs" className="mt-0">
              <UsageRecordsTable
                range={range}
                rangeLabel={rangeLabel}
                appType={appType}
                sourceId={sourceId}
                onSourceChange={changeSource}
                model={model}
                refreshIntervalMs={refreshIntervalMs}
                onRangeChange={setRange}
              />
            </TabsContent>

            <TabsContent value="providers" className="mt-0">
              <ProviderStatsTable
                range={range}
                appType={appType}
                accountId={accountId}
                providerId={providerId}
                model={model}
                refreshIntervalMs={refreshIntervalMs}
              />
            </TabsContent>

            <TabsContent value="models" className="mt-0">
              <ModelStatsTable
                range={range}
                appType={appType}
                accountId={accountId}
                providerId={providerId}
                model={model}
                refreshIntervalMs={refreshIntervalMs}
              />
            </TabsContent>
          </motion.div>
        </Tabs>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl glass-card px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ScanSearch className="h-5 w-5 text-sky-500" />
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">
                {t("usage.sessionSync.title")}
              </h3>
              <HelpButton
                label={t(
                  "usage.sessionSync.help",
                  "About automatic session scanning",
                )}
              >
                {t("usage.sessionSync.description")}
              </HelpButton>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-full text-muted-foreground"
                aria-label={t(
                  "usage.sessionSource.configure",
                  "Configure session source",
                )}
                disabled={
                  !onCodexUsageSourceDirChange ||
                  syncingSession ||
                  rebuildingCodex
                }
                onClick={() => setShowSessionSource(true)}
              >
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <Button
              variant="outline"
              size="sm"
              disabled={syncingSession || rebuildingCodex || showSessionSource}
              onClick={() => void runManualSessionSync()}
            >
              {syncingSession ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              {t("usage.sessionSync.syncNow")}
            </Button>
            <Switch
              checked={sessionAutoSyncEnabled}
              onCheckedChange={(value) =>
                void onSessionAutoSyncEnabledChange?.(value)
              }
              aria-label={t("usage.sessionSync.title")}
            />
          </div>
        </div>

        {showSessionSource && onCodexUsageSourceDirChange && (
          <UsageSessionSourceDialog
            value={codexUsageSourceDir}
            onSave={onCodexUsageSourceDirChange}
            onClose={() => setShowSessionSource(false)}
          />
        )}

        <Accordion
          type="multiple"
          defaultValue={[]}
          className="w-full space-y-4"
        >
          <AccordionItem
            value="pricing"
            className="rounded-xl glass-card overflow-hidden"
          >
            <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
              <div className="flex items-center gap-3">
                <Coins className="h-5 w-5 text-yellow-500" />
                <div className="text-left">
                  <h3 className="text-base font-semibold">
                    {t("settings.advanced.pricing.title")}
                  </h3>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-6 pb-6 pt-4 border-t border-border/50">
              <PricingConfigPanel />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem
            value="maintenance"
            className="rounded-xl glass-card overflow-hidden"
          >
            <AccordionTrigger className="px-6 py-4 hover:no-underline hover:bg-muted/50 data-[state=open]:bg-muted/50">
              <div className="flex items-center gap-3">
                <DatabaseBackup className="h-5 w-5 text-orange-500" />
                <div className="text-left">
                  <h3 className="text-base font-semibold">
                    {t("usage.rebuildCodex.title")}
                  </h3>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-6 pb-6 pt-4 border-t border-border/50">
              <div className="flex items-center justify-between gap-4 rounded-lg border border-destructive/20 bg-destructive/5 p-4">
                <p className="text-sm text-muted-foreground">
                  {t("usage.rebuildCodex.warning")}
                </p>
                <Button
                  variant="destructive"
                  disabled={rebuildingCodex}
                  onClick={() => setShowRebuildConfirm(true)}
                  className="shrink-0"
                >
                  {rebuildingCodex ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <DatabaseBackup className="mr-2 h-4 w-4" />
                  )}
                  {t("usage.rebuildCodex.action")}
                </Button>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <ConfirmDialog
        isOpen={showRebuildConfirm}
        title={t("usage.rebuildCodex.confirmTitle")}
        message={t("usage.rebuildCodex.confirmMessage")}
        confirmText={t("usage.rebuildCodex.confirmAction")}
        variant="destructive"
        onConfirm={() => void rebuildCodexUsage()}
        onCancel={() => setShowRebuildConfirm(false)}
      />
    </motion.div>
  );
}
