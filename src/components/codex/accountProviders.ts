import type { Provider } from "@/types";
import { resolveManagedAccountId } from "@/lib/authBinding";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";

/** Only configurations whose existing switch workflow writes this account. */
export function getCodexAccountProviders(
  providers: Provider[],
  accountId: string,
) {
  return providers.filter(
    (provider) =>
      resolveCodexOfficialIdentity("codex", provider) === "managed_account" &&
      resolveManagedAccountId(provider.meta, "codex_oauth")?.trim() ===
        accountId,
  );
}

export function getCurrentCodexAccountId(
  providers: Provider[],
  currentProviderId: string,
): string | null {
  const provider = providers.find((entry) => entry.id === currentProviderId);
  if (
    !provider ||
    resolveCodexOfficialIdentity("codex", provider) !== "managed_account"
  ) {
    return null;
  }
  return resolveManagedAccountId(provider.meta, "codex_oauth")?.trim() || null;
}
