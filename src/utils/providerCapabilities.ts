import type { AppId } from "@/lib/api";
import type { Provider } from "@/types";
import { parse as parseToml } from "smol-toml";
import { isOAuthProviderType } from "@/config/constants";
import { resolveManagedAccountId } from "@/lib/authBinding";
import {
  extractCodexBaseUrl,
  extractCodexExperimentalBearerToken,
  extractCodexWireApi,
  hasExplicitNonOpenAiCodexModelProvider,
  isCodexAnthropicWireApi,
  isCodexChatWireApi,
} from "@/utils/providerConfigUtils";

export const CODEX_OFFICIAL_PROVIDER_ID = "codex-official";
export const GROKBUILD_OFFICIAL_PROVIDER_ID = "grokbuild-official";

export type CodexOfficialIdentity =
  | "native_login"
  | "managed_account"
  | "api_key";

const nonEmptyString = (value: unknown): boolean =>
  typeof value === "string" && value.trim().length > 0;

function hasExplicitCodexThirdPartyUpstream(
  settings: Record<string, unknown>,
): boolean {
  const config = typeof settings.config === "string" ? settings.config : "";

  return (
    nonEmptyString(settings.baseUrl) ||
    nonEmptyString(settings.baseURL) ||
    nonEmptyString(settings.base_url) ||
    Boolean(extractCodexExperimentalBearerToken(config)) ||
    Boolean(extractCodexBaseUrl(config)) ||
    hasExplicitNonOpenAiCodexModelProvider(config)
  );
}

function hasStoredCodexApiKey(settings: Record<string, unknown>): boolean {
  const auth = settings.auth as Record<string, unknown> | undefined;
  return nonEmptyString(auth?.OPENAI_API_KEY);
}

export function resolveCodexOfficialIdentity(
  appId: AppId,
  provider: Pick<Provider, "id" | "category" | "meta" | "settingsConfig">,
): CodexOfficialIdentity | null {
  if (appId !== "codex") return null;

  const managedAccountId = resolveManagedAccountId(
    provider.meta,
    "codex_oauth",
  )?.trim();
  const hasFixedOfficialId = provider.id === CODEX_OFFICIAL_PROVIDER_ID;
  if (hasFixedOfficialId && provider.category === "official") {
    return managedAccountId ? "managed_account" : "native_login";
  }

  const settings = provider.settingsConfig as Record<string, unknown>;
  const auth = settings?.auth;
  const config = settings?.config;
  if (
    !auth ||
    typeof auth !== "object" ||
    Array.isArray(auth) ||
    (config != null && typeof config !== "string")
  ) {
    return null;
  }

  if (hasExplicitCodexThirdPartyUpstream(settings)) {
    return null;
  }

  if (managedAccountId) {
    return "managed_account";
  }
  if (hasStoredCodexApiKey(settings)) {
    return provider.category === "official" ? "api_key" : null;
  }
  return hasFixedOfficialId || provider.category === "official"
    ? "native_login"
    : null;
}

/** Direct connections cannot depend on the removed local protocol converter. */
export function providerSupportsDirectConnection(
  appId: AppId,
  provider: Provider,
): boolean {
  const settings = provider.settingsConfig as Record<string, unknown>;
  const config = settings?.config;
  const wireApi =
    typeof config === "string" ? extractCodexWireApi(config) : undefined;
  if (appId === "codex") {
    if (
      provider.meta?.isFullUrl === true ||
      ["isFullUrl", "is_full_url", "fullURL", "fullUrl"].some(
        (key) => settings?.[key] === true,
      ) ||
      provider.meta?.providerType === "github_copilot" ||
      provider.meta?.providerType === "xai_oauth"
    )
      return false;
    const formats = [
      provider.meta?.apiFormat,
      settings?.api_format,
      settings?.apiFormat,
    ];
    if (
      formats.some(
        (format) =>
          typeof format === "string" &&
          !["", "responses", "openai_responses", "openai-responses"].includes(
            format.trim().toLowerCase(),
          ),
      )
    )
      return false;
    let document: Record<string, any>;
    try {
      document = parseToml(typeof config === "string" ? config : "");
    } catch {
      return false;
    }
    const selected =
      typeof document.model_provider === "string"
        ? document.model_providers?.[document.model_provider]
        : undefined;
    const auth = settings?.auth as Record<string, unknown> | undefined;
    if (
      [
        auth?.OPENAI_API_KEY,
        document.experimental_bearer_token,
        selected?.experimental_bearer_token,
      ].some(
        (token) =>
          typeof token === "string" && token.trim() === "PROXY_MANAGED",
      )
    )
      return false;
    if (
      [document.wire_api, selected?.wire_api].some(
        (wire) =>
          wire !== undefined &&
          (typeof wire !== "string" ||
            wire.trim().toLowerCase() !== "responses"),
      )
    )
      return false;
    return ![
      document.openai_base_url,
      selected?.base_url,
      settings?.base_url,
      settings?.baseURL,
    ].some(
      (url) =>
        typeof url === "string" &&
        url.replace(/\/+$/, "").toLowerCase().endsWith("/chat/completions"),
    );
  }
  if (appId === "grokbuild") {
    if (
      provider.meta?.isFullUrl === true ||
      provider.meta?.apiFormat === "openai_chat" ||
      provider.meta?.apiFormat === "anthropic" ||
      isCodexChatWireApi(wireApi) ||
      isCodexAnthropicWireApi(wireApi)
    )
      return false;
    return !isOAuthProviderType(provider.meta?.providerType);
  }
  if (appId === "claude-desktop") {
    return (
      !isOAuthProviderType(provider.meta?.providerType) &&
      provider.meta?.claudeDesktopMode !== "proxy"
    );
  }
  if (appId === "claude") {
    return (
      !isOAuthProviderType(provider.meta?.providerType) &&
      provider.meta?.isFullUrl !== true &&
      (!provider.meta?.apiFormat || provider.meta.apiFormat === "anthropic")
    );
  }
  return true;
}

/** Compatibility predicate for legacy configuration editors. */
export function providerNeedsRouting(
  appId: AppId,
  provider: Provider,
): boolean {
  return !providerSupportsDirectConnection(appId, provider);
}
