import { useEffect, useRef, useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { subscriptionApi } from "@/lib/api/subscription";
import type { AppId } from "@/lib/api/types";
import type { ProviderMeta } from "@/types";
import type { SubscriptionQuota } from "@/types/subscription";
import { resolveManagedAccountId } from "@/lib/authBinding";
import { PROVIDER_TYPES } from "@/config/constants";
import {
  resolveDisplayUsage,
  type LastGoodSnapshot,
  useSettingsQuery,
} from "./queries";
import { extractErrorMessage } from "@/utils/errorUtils";
import { authGetStatus } from "@/lib/api/auth";

const REFETCH_INTERVAL = 5 * 60 * 1000; // 5 minutes

export const subscriptionKeys = {
  all: ["subscription"] as const,
  quota: (appId: AppId) => [...subscriptionKeys.all, "quota", appId] as const,
};

/**
 * reject 且无可展示值时的失败占位：首次查询就失败（data 为 undefined），或
 * react-query 保留的旧成功已超出 keep-last-good 窗口——合成一个失败结果，让
 * 订阅视图仍渲染「查询失败」+ 刷新按钮，而不是 footer 整体消失、无从手动重查。
 */
const QUERY_REJECTED_PLACEHOLDER: SubscriptionQuota = {
  tool: "",
  credentialStatus: "valid",
  credentialMessage: null,
  success: false,
  tiers: [],
  extraUsage: null,
  error: null,
  queriedAt: null,
};

/**
 * Keep-last-good：与 useUsageQuery 同一策略（resolveDisplayUsage）。
 *
 * Codex uses the backend's shared projection and original successful timestamp.
 * Other tools and IPC errors keep the existing frontend retention policy.
 * Deterministic authentication failures never revive a previous successful value.
 *
 * `scopeKey` 标识查询身份（appId / 绑定的账号 id）：身份变化时丢弃旧快照，
 * 避免用上一个账号的额度掩盖新账号的瞬时失败。
 */
function useQuotaKeepLastGood(
  query: UseQueryResult<SubscriptionQuota>,
  scopeKey: string,
) {
  const [now, setNow] = useState(Date.now);
  const sharedState = query.data?.refreshState;
  const failed =
    query.isError ||
    query.data?.success === false ||
    Boolean(sharedState?.refreshFailed);
  useEffect(() => {
    if (!failed && !sharedState) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [failed, Boolean(sharedState)]);
  const lastGoodRef = useRef<{
    key: string;
    snap: LastGoodSnapshot<SubscriptionQuota> | null;
  }>({ key: scopeKey, snap: null });
  if (lastGoodRef.current.key !== scopeKey) {
    lastGoodRef.current = { key: scopeKey, snap: null };
  }
  const { data, lastGood } = resolveDisplayUsage(
    query.data,
    query.dataUpdatedAt,
    query.data && query.data.credentialStatus !== "valid"
      ? null
      : lastGoodRef.current.snap,
    Math.max(now, Date.now()),
    { rejected: query.isError },
  );
  lastGoodRef.current.snap = lastGood;
  if (sharedState && query.data) {
    const refreshFailed = sharedState.refreshFailed || query.isError;
    const expired =
      query.data.success &&
      sharedState.validUntil != null &&
      Date.now() > sharedState.validUntil;
    const sharedData = expired
      ? {
          ...query.data,
          success: false,
          tiers: [],
          extraUsage: null,
          error: sharedState.error ?? "Quota unavailable",
        }
      : query.data;
    return {
      ...query,
      data: sharedData,
      refreshFailed: Boolean(refreshFailed && sharedData.success),
      refreshError: query.isError
        ? extractErrorMessage(query.error) || null
        : sharedState.refreshFailed
          ? sharedState.error
          : null,
    };
  }
  return {
    ...query,
    // Keep useful old values through a short outage, but identify them as stale.
    refreshError:
      failed && data?.success
        ? query.isError
          ? extractErrorMessage(query.error) || null
          : query.data?.error || null
        : null,
    refreshFailed: failed && Boolean(data?.success),
    data:
      data ??
      (query.isError
        ? {
            ...QUERY_REJECTED_PLACEHOLDER,
            error: extractErrorMessage(query.error) || null,
          }
        : undefined),
  };
}

export function useSubscriptionQuota(
  appId: AppId,
  enabled: boolean,
  autoQuery = false,
  autoQueryIntervalMinutes = 5,
) {
  const { data: settings } = useSettingsQuery();
  const intervalSeconds = settings?.quotaRefreshIntervalSeconds ?? 60;
  const manualRefresh = useRef(false);
  const refetchInterval =
    appId === "codex"
      ? autoQuery && intervalSeconds > 0
        ? intervalSeconds * 1000
        : false
      : autoQuery && autoQueryIntervalMinutes > 0
        ? Math.max(autoQueryIntervalMinutes, 1) * 60 * 1000
        : false;

  const query = useQuery({
    queryKey: subscriptionKeys.quota(appId),
    queryFn: () =>
      subscriptionApi.getQuota(
        appId,
        appId === "codex" ? manualRefresh.current : true,
      ),
    enabled:
      enabled && ["claude", "codex", "gemini", "grokbuild"].includes(appId),
    refetchInterval,
    refetchIntervalInBackground:
      appId === "codex" ? false : Boolean(refetchInterval),
    refetchOnWindowFocus: Boolean(refetchInterval),
    staleTime:
      appId === "codex"
        ? intervalSeconds > 0
          ? intervalSeconds * 1000
          : Infinity
        : autoQueryIntervalMinutes > 0
          ? Math.max(autoQueryIntervalMinutes, 1) * 60 * 1000
          : REFETCH_INTERVAL,
    retry: appId === "codex" ? false : 1,
  });

  const previousInterval = useRef(intervalSeconds);
  useEffect(() => {
    if (previousInterval.current !== intervalSeconds) {
      previousInterval.current = intervalSeconds;
      if (appId === "codex" && enabled)
        void query.refetch({ cancelRefetch: false });
    }
  }, [appId, intervalSeconds, enabled, query.refetch]);
  const display = useQuotaKeepLastGood(query, appId);
  return {
    ...display,
    refetch: async (options?: Parameters<typeof query.refetch>[0]) => {
      manualRefresh.current = true;
      try {
        return await query.refetch({ ...options, cancelRefetch: false });
      } finally {
        manualRefresh.current = false;
      }
    },
  };
}

export interface UseCodexOauthQuotaOptions {
  enabled?: boolean;
  /** 是否启用自动轮询与窗口 focus 重取 */
  autoQuery?: boolean;
}

/**
 * Codex OAuth 订阅额度查询 hook（按账号 ID）
 *
 * 直接以 codex-switch 自管的 ChatGPT 账号 ID 查询额度，供认证中心里逐个账号
 * 展示用量时复用。Query key 与 `useCodexOauthQuota` 一致，绑定到同一账号的
 * 供应商卡片与账号列表会自动去重共享同一份请求缓存。
 * 未指定账号时先解析默认账号的真实 ID，再按 ID 查询，避免默认账号变更时
 * 复用固定 "default" 缓存，也确保正在进行的请求归属于原账号。
 */
export function useCodexOauthQuotaByAccountId(
  accountId: string | null,
  options: UseCodexOauthQuotaOptions = {},
) {
  const { enabled = true, autoQuery = true } = options;
  const { data: settings } = useSettingsQuery();
  const intervalSeconds = settings?.quotaRefreshIntervalSeconds ?? 60;
  const manualRefresh = useRef(false);
  const defaultStatus = useQuery({
    queryKey: ["managed-auth-status", "codex_oauth"],
    queryFn: () => authGetStatus("codex_oauth"),
    enabled: enabled && accountId == null,
    staleTime: 30_000,
  });
  const resolvedId =
    accountId ?? defaultStatus.data?.default_account_id ?? null;
  const refetchInterval =
    autoQuery && intervalSeconds > 0 ? intervalSeconds * 1000 : false;
  const query = useQuery({
    queryKey: ["codex_oauth", "quota", resolvedId],
    queryFn: () => {
      if (!resolvedId) throw new Error("No managed Codex account selected");
      return subscriptionApi.getCodexOauthQuota(
        resolvedId,
        manualRefresh.current,
      );
    },
    enabled: enabled && Boolean(resolvedId),
    refetchInterval: (query) =>
      query.state.data?.credentialStatus === "expired"
        ? false
        : refetchInterval,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: Boolean(refetchInterval),
    staleTime: intervalSeconds > 0 ? intervalSeconds * 1000 : Infinity,
    retry: false,
  });

  const previousInterval = useRef(intervalSeconds);
  useEffect(() => {
    if (previousInterval.current !== intervalSeconds) {
      previousInterval.current = intervalSeconds;
      if (enabled && resolvedId) void query.refetch({ cancelRefetch: false });
    }
  }, [intervalSeconds, enabled, resolvedId, query.refetch]);
  const display = useQuotaKeepLastGood(query, resolvedId ?? "unresolved");
  return {
    ...display,
    refetch: async (options?: Parameters<typeof query.refetch>[0]) => {
      manualRefresh.current = true;
      try {
        return await query.refetch({ ...options, cancelRefetch: false });
      } finally {
        manualRefresh.current = false;
      }
    },
  };
}

/**
 * Codex OAuth (ChatGPT Plus/Pro 反代) 订阅额度查询 hook
 *
 * 与 `useSubscriptionQuota` 平行：数据走 codex-switch 自管的 OAuth token，
 * 而不是 Codex CLI 的 ~/.codex/auth.json。账号 ID 从供应商 meta 的
 * authBinding 中解析，再委托给 `useCodexOauthQuotaByAccountId`。
 */
export function useCodexOauthQuota(
  meta: ProviderMeta | undefined,
  options: UseCodexOauthQuotaOptions = {},
) {
  const accountId = resolveManagedAccountId(meta, PROVIDER_TYPES.CODEX_OAUTH);
  return useCodexOauthQuotaByAccountId(accountId, options);
}

/**
 * xAI OAuth (SuperGrok 反代) 订阅额度查询 hook
 *
 * 与 `useCodexOauthQuota` 平行：数据走 codex-switch 自管的 xAI OAuth token，
 * 而不是 Grok CLI 的 ~/.grok/auth.json；后端复用同一个 grok.com 账单端点，
 * 因此与 Grok Build 分区的官方订阅显示同一份额度。
 */
export function useXaiOauthQuota(
  meta: ProviderMeta | undefined,
  options: UseCodexOauthQuotaOptions = {},
) {
  const { enabled = true, autoQuery = false } = options;
  const accountId = resolveManagedAccountId(meta, PROVIDER_TYPES.XAI_OAUTH);
  const query = useQuery({
    queryKey: ["xai_oauth", "quota", accountId ?? "default"],
    queryFn: () => subscriptionApi.getXaiOauthQuota(accountId),
    enabled,
    refetchInterval: autoQuery ? REFETCH_INTERVAL : false,
    refetchIntervalInBackground: autoQuery,
    refetchOnWindowFocus: autoQuery,
    staleTime: REFETCH_INTERVAL,
    retry: 1,
  });

  return useQuotaKeepLastGood(query, accountId ?? "default");
}
