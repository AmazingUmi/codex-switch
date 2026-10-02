import { describe, expect, it } from "vitest";
import { codexProviderPresets } from "@/config/codexProviderPresets";

describe("Codex provider links", () => {
  it("retains provider links without upstream tracking or partnership claims", () => {
    for (const preset of codexProviderPresets) {
      expect(preset.isPartner, preset.name).toBeUndefined();
      expect(preset.primePartner, preset.name).toBeUndefined();
      expect(preset.partnerPromotionKey, preset.name).toBeUndefined();
      for (const link of [preset.websiteUrl, preset.apiKeyUrl]) {
        if (!link) continue;
        const url = new URL(link);
        expect(url.protocol, preset.name).toMatch(/^https?:$/);
        expect(url.search, preset.name).toBe("");
        expect(link, preset.name).not.toMatch(/cc[\W_]?switch/i);
      }
    }
  });
});
