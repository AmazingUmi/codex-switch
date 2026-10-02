import { useQuery } from "@tanstack/react-query";
import { subscriptionApi } from "@/lib/api/subscription";
import type { Provider } from "@/types";
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

export function useApiBalance(provider: Provider) {
  const { baseUrl, apiKey } = resolveApiBalanceCredentials(provider);
  const supported = supportsApiBalance(baseUrl);
  const enabled = supported && Boolean(apiKey);
  const revision = credentialRevision(provider.id, baseUrl, apiKey);
  const query = useQuery({
    queryKey: ["api-balance", provider.id, revision],
    queryFn: () => subscriptionApi.getBalance(baseUrl, apiKey),
    enabled,
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  return { ...query, supported, enabled };
}
