import { useQuery, useQueryClient } from "@tanstack/react-query";
import { subscriptionApi } from "@/lib/api/subscription";
import type { Provider, UsageResult } from "@/types";
import {
  resolveApiBalanceCredentials,
  supportsApiBalance,
} from "@/utils/apiBalance";

// Opaque session revisions isolate changed credentials without putting secrets
// in query keys (which are visible in tooling and can be persisted by clients).
const revisions = new Map<
  string,
  { baseUrl: string; apiKey: string; revision: number }
>();
let nextRevision = 0;
function credentialRevision(id: string, baseUrl: string, apiKey: string) {
  const previous = revisions.get(id);
  if (previous?.baseUrl === baseUrl && previous.apiKey === apiKey)
    return previous.revision;
  const revision = ++nextRevision;
  revisions.set(id, { baseUrl, apiKey, revision });
  return revision;
}

/** Forget credential revisions when a provider is removed. */
export function forgetApiBalanceCredentials(providerId: string) {
  revisions.delete(providerId);
}

export function useApiBalance(provider: Provider) {
  const queryClient = useQueryClient();
  const { baseUrl, apiKey } = resolveApiBalanceCredentials(provider);
  const supported = supportsApiBalance(baseUrl);
  const enabled = supported && Boolean(apiKey);
  const revision = credentialRevision(provider.id, baseUrl, apiKey);
  const queryKey = ["api-balance", provider.id, revision] as const;
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await subscriptionApi.getBalance(baseUrl, apiKey);
      // Declared API failures resolve normally, so dataUpdatedAt would advance.
      // Keep the last successful time with this credential revision's cache.
      const previous = queryClient.getQueryData<
        UsageResult & { lastSuccessfulUpdatedAt: number }
      >(queryKey);
      return {
        ...result,
        lastSuccessfulUpdatedAt: result.success
          ? Date.now()
          : (previous?.lastSuccessfulUpdatedAt ?? 0),
      };
    },
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return {
    ...query,
    supported,
    enabled,
    lastSuccessfulUpdatedAt: query.data?.lastSuccessfulUpdatedAt ?? 0,
  };
}
