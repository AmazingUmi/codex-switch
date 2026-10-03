// 使用统计相关类型定义

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface RequestLog {
  requestId: string;
  providerId: string;
  providerName?: string;
  appType: string;
  model: string;
  requestModel?: string;
  /** 写入时实际用于计价的模型名；路由接管 + request 计价模式下可能与 model 不同 */
  pricingModel?: string;
  costMultiplier: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  inputCostUsd: string;
  outputCostUsd: string;
  cacheReadCostUsd: string;
  cacheCreationCostUsd: string;
  totalCostUsd: string;
  isStreaming: boolean;
  latencyMs: number;
  firstTokenMs?: number;
  durationMs?: number;
  statusCode: number;
  errorMessage?: string;
  createdAt: number;
  dataSource?: string;
}

export interface SessionSyncResult {
  imported: number;
  skipped: number;
  filesScanned: number;
  suspectedDuplicates: number;
  deferredFiles: number;
  errors: string[];
}

export interface DataSourceSummary {
  dataSource: string;
  requestCount: number;
  totalCostUsd: string;
}

export interface PaginatedLogs {
  data: RequestLog[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ModelPricing {
  modelId: string;
  displayName: string;
  inputCostPerMillion: string;
  outputCostPerMillion: string;
  cacheReadCostPerMillion: string;
  cacheCreationCostPerMillion: string;
}

export interface ModelsDevSyncConfig {
  autoSyncEnabled: boolean;
  includeCommonModels: boolean;
  selectedModelKeys: string[];
  excludedCommonModelKeys: string[];
  lastSyncAt: number | null;
  lastSyncError: string | null;
}

export interface ModelsDevSyncState {
  config: ModelsDevSyncConfig;
  configPath: string;
}

export interface UsageSummary {
  totalRequests: number;
  totalCost: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
  successRate: number;
  /** input + output + cache_creation + cache_read, all cache-normalized */
  realTotalTokens: number;
  /** cache_read / (input + cache_creation + cache_read), range 0–1 */
  cacheHitRate: number;
}

export interface UsageSummaryByApp {
  appType: string;
  summary: UsageSummary;
}

export interface DailyStats {
  date: string;
  requestCount: number;
  totalCost: string;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheCreationTokens: number;
  totalCacheReadTokens: number;
}

export interface ProviderStats {
  sourceId: string;
  accountId: string | null;
  accountName: string | null;
  providerId: string;
  providerName: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  successRate: number;
  avgLatencyMs: number;
}

export interface ModelStats {
  model: string;
  requestCount: number;
  totalTokens: number;
  totalCost: string;
  avgCostPerRequest: string;
}

export interface LogFilters {
  appType?: string;
  providerName?: string;
  model?: string;
  statusCode?: number;
  startDate?: number;
  endDate?: number;
}

/**
 * Dashboard 顶栏的全局筛选维度，作用于 Hero / 趋势图 / 三个统计 Tab。
 *
 * - `accountId` / `providerId` 按来源身份筛选，未知来源使用
 *   `__unassigned__`；`providerName` 可组合展示名筛选；
 * - `model` 按「有效计价模型」匹配（pricing_model 优先、回落 model，
 *   与模型统计的分组口径一致）。
 */
export interface UsageScopeFilters {
  appType?: string;
  providerName?: string;
  model?: string;
  /** Subscription account identity; independent of provider configuration. */
  accountId?: string;
  /** API source identity; independent of its display name. */
  providerId?: string;
}

export interface ProviderLimitStatus {
  providerId: string;
  dailyUsage: string;
  dailyLimit?: string;
  dailyExceeded: boolean;
  monthlyUsage: string;
  monthlyLimit?: string;
  monthlyExceeded: boolean;
}

export type UsageRangePreset = "today" | "1d" | "7d" | "14d" | "30d" | "custom";

export interface UsageRangeSelection {
  preset: UsageRangePreset;
  customStartDate?: number;
  customEndDate?: number;
  /** When true (custom mode only), endDate resolves to "now" instead of the
   *  fixed customEndDate snapshot, and the end-time field becomes read-only. */
  liveEndTime?: boolean;
}

/**
 * App types surfaced as dashboard filter buttons.
 *
 * `claude-desktop` is intentionally NOT listed: the Desktop gateway's proxy
 * traffic is still recorded under its own `app_type` (preserving route-takeover
 * billing audit — the request detail panel shows the real value), but the
 * dashboard folds it into `claude` for display. It is the embedded Claude Code
 * runtime running inside the Desktop shell, and Desktop *chat* usage never
 * passes through this app at all, so a separate "Claude Desktop" bucket would
 * only ever show a partial number and mislead users into reading it as the
 * Desktop's full usage. The backend collapses `claude-desktop → claude` in
 * every dashboard query (see `folded_app_type_sql`).
 * `opencode` and `pi` have no proxy handler; their usage reaches this
 * dashboard through session importers. `openclaw` / `hermes` appear only as
 * managed apps elsewhere.
 */
export type AppType =
  | "claude"
  | "codex"
  | "gemini"
  | "grokbuild"
  | "opencode"
  | "pi"
  | "mcode";

export type AppTypeFilter = "all" | AppType;

export const KNOWN_APP_TYPES: ReadonlyArray<AppType> = [
  "claude",
  "codex",
  "gemini",
  "grokbuild",
  "opencode",
  "pi",
  "mcode",
];

/**
 * App types whose proxy uses an OpenAI-style protocol. Two consequences:
 *
 * 1. `inputTokens` already includes the cached portion (must subtract
 *    `cacheReadTokens` to get fresh-input semantics — see
 *    [getFreshInputTokens]).
 * 2. The protocol does not report cache _creation_ separately, only cache
 *    _reads_. So `cacheCreationTokens` is always 0 for these app types and
 *    the UI should label it as N/A rather than 0.
 *
 * Mirror of the Rust `CACHE_INCLUSIVE_APP_TYPES` whitelist.
 */
export const CACHE_INCLUSIVE_APP_TYPES: ReadonlySet<string> = new Set([
  "codex",
  "gemini",
  "grokbuild",
]);

// Pi sessions can mix Anthropic and OpenAI APIs, but the dashboard aggregates
// only by app type. Treat cache-write coverage as partial without changing
// Pi's fresh-input token semantics.
const PARTIAL_CACHE_WRITE_APP_TYPES: ReadonlySet<string> = new Set([
  "pi",
  "mcode",
]);

export type CacheWriteAvailability = "ok" | "partial" | "na";

export function getCacheWriteAvailability(
  appTypes: readonly string[],
): CacheWriteAvailability {
  if (appTypes.length === 0) return "ok";
  const unavailable = appTypes.filter((appType) =>
    CACHE_INCLUSIVE_APP_TYPES.has(appType),
  ).length;
  if (unavailable === appTypes.length) return "na";
  const partial = appTypes.some((appType) =>
    PARTIAL_CACHE_WRITE_APP_TYPES.has(appType),
  );
  return unavailable === 0 && !partial ? "ok" : "partial";
}

/** Subset of request-log fields needed to derive cache-normalized input. */
export interface CacheNormalizableLog {
  appType: string;
  inputTokens: number;
  cacheReadTokens: number;
}

/**
 * For a single request log, return the input token count with cache reads
 * removed. Anthropic-style providers already report `inputTokens` without
 * cache, so they pass through unchanged.
 */
export function getFreshInputTokens(log: CacheNormalizableLog): number {
  if (
    CACHE_INCLUSIVE_APP_TYPES.has(log.appType) &&
    log.inputTokens >= log.cacheReadTokens
  ) {
    return log.inputTokens - log.cacheReadTokens;
  }
  return log.inputTokens;
}

export const NON_NEGATIVE_DECIMAL_REGEX = /^\d+(?:\.\d+)?$/;

export function isNonNegativeDecimalString(value: string): boolean {
  const trimmed = value.trim();
  if (!NON_NEGATIVE_DECIMAL_REGEX.test(trimmed)) return false;
  return Number.isFinite(Number(trimmed));
}

type UsageCostLog = Pick<
  RequestLog,
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cacheCreationTokens"
  | "totalCostUsd"
  | "statusCode"
> &
  Partial<Pick<RequestLog, "costMultiplier">>;

export function hasUsageTokens(log: UsageCostLog): boolean {
  return (
    log.inputTokens > 0 ||
    log.outputTokens > 0 ||
    log.cacheReadTokens > 0 ||
    log.cacheCreationTokens > 0
  );
}

export function isUnpricedUsage(log: UsageCostLog): boolean {
  const totalCost = Number.parseFloat(log.totalCostUsd);
  const multiplier =
    log.costMultiplier == null
      ? undefined
      : Number.parseFloat(log.costMultiplier);
  return (
    log.statusCode >= 200 &&
    log.statusCode < 300 &&
    hasUsageTokens(log) &&
    Number.isFinite(totalCost) &&
    (!Number.isFinite(multiplier) || multiplier !== 0) &&
    totalCost === 0
  );
}

export interface StatsFilters {
  timeRange: UsageRangePreset;
  providerId?: string;
  appType?: string;
}

/** Attribution is held only in Switch; imported source records remain read-only. */
export type UsageAttributionMethod = "untagged" | "auto" | "manual" | "mixed";
export type UsageRecordsView = "session" | "hour" | "day" | "details";
export interface UsageRecordFilters {
  appType?: string;
  providerId?: string;
  providerName?: string;
  accountId?: string;
  model?: string;
  startDate?: number;
  endDate?: number;
  sessionId?: string;
  attribution?: "all" | "untagged" | "auto" | "manual";
}
export interface UsageRecordRow {
  id: string;
  sessionId?: string | null;
  requestId?: string | null;
  appType: string;
  startAt: number;
  endAt: number;
  bucketStartAt?: number | null;
  bucketEndAt?: number | null;
  recordCount: number;
  accountName?: string | null;
  providerName?: string | null;
  accountIds: string[];
  providerIds: string[];
  accountNames: string[];
  providerNames: string[];
  models: string[];
  method: UsageAttributionMethod;
  /** Fresh input tokens: the backend has already removed cache reads. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: string;
  unpricedCount: number;
  breakdown?: UsageRecordRow[];
}
export interface PaginatedUsageRecords {
  legacyRollupCount?: number;
  data: UsageRecordRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface UsageAttributionChoice {
  id: string;
  label: string;
  accountId?: string | null;
  accountName?: string | null;
  providerId?: string | null;
  providerName?: string | null;
}
export type UsageAttributionSelector = Omit<UsageRecordFilters, "appType"> & {
  requestIds?: string[];
};
export interface UsageAttributionResult {
  actionId: number;
  count: number;
}
