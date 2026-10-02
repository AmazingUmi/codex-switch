import { parse as parseToml } from "smol-toml";
import type { Provider } from "@/types";
import { isOAuthProviderType } from "@/config/constants";
import { isCustomCodexModelProviderId } from "@/utils/providerConfigUtils";

export function isApiBalanceConnection(provider: Provider): boolean {
  return (
    !isOAuthProviderType(provider.meta?.providerType) &&
    provider.meta?.authBinding?.source !== "managed_account"
  );
}

const BALANCE_HOSTS = new Set([
  "api.deepseek.com",
  "api.stepfun.ai",
  "api.stepfun.com",
  "api.siliconflow.cn",
  "api.siliconflow.com",
  "openrouter.ai",
  "api.novita.ai",
]);

export function supportsApiBalance(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const authority = baseUrl.trim().split("://")[1]?.split(/[/?#]/)[0];
    if (!authority || authority.includes("@")) return false;
    const url = new URL(baseUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      BALANCE_HOSTS.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function apiBalanceProviderLabel(baseUrl: string | undefined) {
  if (!supportsApiBalance(baseUrl)) return undefined;
  const host = new URL(baseUrl!).hostname;
  if (host === "api.deepseek.com") return "DeepSeek";
  if (host.startsWith("api.stepfun.")) return "StepFun";
  if (host.startsWith("api.siliconflow.")) return "SiliconFlow";
  return host === "openrouter.ai" ? "OpenRouter" : "Novita AI";
}

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

/** Read only the saved API connection, never the website, notes or login auth. */
export function resolveApiBalanceCredentials(provider: Provider): {
  baseUrl: string;
  apiKey: string;
} {
  const settings = provider.settingsConfig;
  if (!isApiBalanceConnection(provider)) return { baseUrl: "", apiKey: "" };
  try {
    const config = parseToml(text(settings.config)) as Record<string, any>;
    const activeId = text(config.model_provider);
    const active = config.model_providers?.[activeId];
    const bearer =
      isCustomCodexModelProviderId(activeId) &&
      typeof active?.experimental_bearer_token === "string"
        ? text(active.experimental_bearer_token)
        : text(config.experimental_bearer_token);
    return {
      baseUrl:
        typeof active?.base_url === "string"
          ? text(active.base_url)
          : text(config.base_url),
      // Match the native Codex usage credential resolver's precedence.
      apiKey: text(settings.auth?.OPENAI_API_KEY) || bearer,
    };
  } catch {
    return { baseUrl: "", apiKey: "" };
  }
}
