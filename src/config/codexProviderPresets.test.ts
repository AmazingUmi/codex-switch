import { describe, expect, it } from "vitest";
import {
  codexProviderPresets,
  generateThirdPartyConfig,
  getCodexDirectPresetEntries,
} from "./codexProviderPresets";

describe("codexProviderPresets managed OAuth snapshots", () => {
  // 托管 OAuth 卡无静态 key：requires_openai_auth = true 会被后端 keyless
  // 安全闸拒绝切换（provider.codex.config.official_auth_fallback）。后端
  // 写入层对存量卡会强制归一为 false，预设从源头就不能再带 true。
  it("OAuth presets never declare the auth.json fallback", () => {
    const oauthPresets = codexProviderPresets.filter(
      (preset) => preset.requiresOAuth,
    );
    expect(oauthPresets.length).toBeGreaterThan(0);
    for (const preset of oauthPresets) {
      expect(preset.config, preset.name).toContain(
        "requires_openai_auth = false",
      );
    }
  });

  it("key-based third-party template keeps the fallback flag by default", () => {
    expect(
      generateThirdPartyConfig("acme", "https://api.acme.dev/v1", "m1"),
    ).toContain("requires_openai_auth = true");
  });
});

describe("Codex direct creation presets", () => {
  it("offers Official and DeepSeek using their original preset identities", () => {
    const entries = getCodexDirectPresetEntries();
    expect(entries.map(({ preset }) => preset.name)).toEqual([
      "OpenAI Official",
      "DeepSeek",
    ]);
    for (const entry of entries) {
      expect(entry.id).toBe(
        `codex-${codexProviderPresets.indexOf(entry.preset)}`,
      );
    }
    expect(entries[0].id).toBe("codex-0");
    expect(entries[1].preset.config).toContain(
      'base_url = "https://api.deepseek.com"',
    );
    expect(entries[1].preset.config).toContain('wire_api = "responses"');
    expect(entries[1].preset.modelCatalog?.[0].model).toBe("deepseek-flash");
  });
});
