import { describe, expect, it } from "vitest";
import {
  supportsApiBalance,
  resolveApiBalanceCredentials,
} from "@/utils/apiBalance";
import type { Provider } from "@/types";

describe("API balance connection resolution", () => {
  it("does not fall back from explicitly empty active URL or use built-in table tokens", () => {
    const p: Provider = {
      id: "edge",
      name: "Edge",
      settingsConfig: {
        auth: {},
        config:
          'model_provider = "custom"\nbase_url = "https://api.deepseek.com"\n[model_providers.custom]\nbase_url = ""',
      },
    };
    expect(resolveApiBalanceCredentials(p).baseUrl).toBe("");
    p.settingsConfig.config =
      'model_provider = "openai"\n[model_providers.openai]\nbase_url = "https://api.deepseek.com"\nexperimental_bearer_token = "unused-token"';
    expect(resolveApiBalanceCredentials(p).apiKey).toBe("");
    p.settingsConfig.config =
      'experimental_bearer_token = "top-token"\n' + p.settingsConfig.config;
    expect(resolveApiBalanceCredentials(p).apiKey).toBe("top-token");
  });

  it.each(["codex_oauth", "xai_oauth", "github_copilot"] as const)(
    "excludes residual static credentials on %s rows",
    (providerType) => {
      const p: Provider = {
        id: "oauth",
        name: "OAuth",
        meta: { providerType },
        settingsConfig: {
          auth: { OPENAI_API_KEY: "stale-key" },
          config: 'base_url = "https://api.deepseek.com"',
        },
      };
      expect(resolveApiBalanceCredentials(p)).toEqual({
        baseUrl: "",
        apiKey: "",
      });
      p.meta = {
        authBinding: {
          source: "managed_account",
          authProvider: "codex_oauth",
          accountId: "managed",
        },
      };
      expect(resolveApiBalanceCredentials(p)).toEqual({
        baseUrl: "",
        apiKey: "",
      });
    },
  );
  it.each([
    "api.deepseek.com",
    "api.stepfun.ai",
    "api.stepfun.com",
    "api.siliconflow.cn",
    "api.siliconflow.com",
    "openrouter.ai",
    "api.novita.ai",
  ])("supports the official HTTPS host %s", (host) => {
    expect(supportsApiBalance(`https://${host}:443/v1`)).toBe(true);
  });
  it.each([
    undefined,
    "",
    "api.deepseek.com",
    "https:api.deepseek.com",
    "http://api.deepseek.com",
    "https://api.deepseek.com:8080",
    "https://api.deepseek.com.evil.test",
    "https://evil.test/?q=api.deepseek.com",
    "https://evil.test/api.deepseek.com",
    "https://api.deepseek.com@evil.test",
    "https://user@api.deepseek.com",
    "https://@api.deepseek.com",
  ])("rejects unsupported/ambiguous target %s", (url) =>
    expect(supportsApiBalance(url)).toBe(false),
  );
  it("reads only the selected saved provider, with native credential precedence", () => {
    const provider: Provider = {
      id: "selected",
      name: "DeepSeek",
      websiteUrl: "https://api.deepseek.com",
      notes: "https://api.deepseek.com",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "auth-key" },
        config:
          'model_provider = "selected"\n[model_providers.unused]\nbase_url = "https://api.deepseek.com"\nexperimental_bearer_token = "unused"\n[model_providers.selected]\nbase_url = "https://api.siliconflow.cn/v1"\nexperimental_bearer_token = "bearer-key"',
      },
    };
    expect(resolveApiBalanceCredentials(provider)).toEqual({
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "auth-key",
    });
    provider.settingsConfig.auth.OPENAI_API_KEY = "";
    expect(resolveApiBalanceCredentials(provider).apiKey).toBe("bearer-key");
    provider.settingsConfig.config =
      'model_provider = "missing"\n[model_providers.unused]\nbase_url = "https://api.deepseek.com"';
    expect(resolveApiBalanceCredentials(provider).baseUrl).toBe("");
    provider.settingsConfig.config = 'model_provider = "';
    expect(resolveApiBalanceCredentials(provider)).toEqual({
      baseUrl: "",
      apiKey: "",
    });
  });
});
