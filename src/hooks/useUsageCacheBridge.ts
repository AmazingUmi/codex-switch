import { useQueryClient } from "@tanstack/react-query";
import type { ManagedAuthStatus } from "@/lib/api/auth";
import type { ProvidersQueryData } from "@/lib/query/queries";
import type { AppId } from "@/lib/api/types";
import type { UsageResult } from "@/types";
import type { SubscriptionQuota } from "@/types/subscription";
import { usageKeys } from "@/lib/query/usage";
import { subscriptionKeys } from "@/lib/query/subscription";
import { useTauriEvent } from "./useTauriEvent";

type UsageCacheUpdatedPayload =
  | {
      kind: "codexOauth";
      accountId: string;
      data: SubscriptionQuota;
    }
  | {
      kind: "script";
      appType: AppId;
      providerId: string;
      data: UsageResult;
    }
  | {
      kind: "subscription";
      appType: AppId;
      data: SubscriptionQuota;
    };

/**
 * 后端 `UsageCache` 写入后会 emit `usage-cache-updated`，本 hook 把 payload 同步到
 * React Query 缓存，让托盘触发的刷新（不经前端）也能立刻反映到主界面，避免
 * React Query 与 Rust 侧两份缓存各自为战。
 */
export function useUsageCacheBridge() {
  const queryClient = useQueryClient();

  useTauriEvent<UsageCacheUpdatedPayload>("usage-cache-updated", (payload) => {
    if (payload.kind === "codexOauth") {
      // An event may have been queued before credentials were removed. Account
      // membership outlives the quota query, so it also guards an empty cache.
      const status = queryClient.getQueryData<ManagedAuthStatus>([
        "managed-auth-status",
        "codex_oauth",
      ]);
      if (!status?.accounts.some((account) => account.id === payload.accountId))
        return;
      queryClient.setQueryData<SubscriptionQuota>(
        ["codex_oauth", "quota", payload.accountId],
        (previous) => {
          const oldState = previous?.refreshState;
          const newState = payload.data.refreshState;
          if (
            oldState &&
            newState &&
            (oldState.generation > newState.generation ||
              (oldState.generation === newState.generation &&
                (oldState.attemptedAt ?? 0) > (newState.attemptedAt ?? 0)))
          ) {
            return previous;
          }
          return payload.data;
        },
      );
    } else if (payload.kind === "script") {
      if (payload.appType === "codex") {
        const providers = queryClient.getQueryData<ProvidersQueryData>([
          "providers",
          "codex",
        ]);
        if (!providers?.providers[payload.providerId]) return;
      }
      queryClient.setQueryData<UsageResult>(
        usageKeys.script(payload.providerId, payload.appType),
        payload.data,
      );
    } else if (payload.kind === "subscription") {
      if (payload.appType === "codex") return;
      queryClient.setQueryData<SubscriptionQuota>(
        subscriptionKeys.quota(payload.appType),
        payload.data,
      );
    }
  });
}
