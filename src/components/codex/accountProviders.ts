import type { Provider } from "@/types";
import { resolveCodexOfficialIdentity } from "@/utils/providerCapabilities";

/** Legacy account rows are migrated natively; never render them as API providers. */
export function isCodexAccountProvider(provider: Provider): boolean {
  const auth = (provider.settingsConfig as Record<string, any>)?.auth;
  // An actual API credential wins over old account metadata during migration.
  if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim())
    return false;
  const identity = resolveCodexOfficialIdentity("codex", provider);
  return (
    Boolean(provider.meta?.codexAccountManaged) ||
    provider.meta?.providerType === "codex_oauth" ||
    provider.meta?.authBinding?.authProvider === "codex_oauth" ||
    identity === "managed_account" ||
    identity === "native_login"
  );
}
