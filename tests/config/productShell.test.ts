import { describe, expect, it } from "vitest";
import { APP_IDS, MCP_APP_IDS } from "@/config/appConfig";
import {
  isProductImportAllowed,
  normalizeProductApp,
  normalizeProductView,
} from "@/config/productShell";

describe("Codex product shell boundaries", () => {
  it("keeps the shared capability registry intact", () => {
    expect(APP_IDS).toContain("claude");
    expect(MCP_APP_IDS).toContain("opencode");
  });

  it("normalizes stale navigation without hiding Codex", () => {
    for (const app of [...APP_IDS, null, "invalid"])
      expect(normalizeProductApp(app)).toBe("codex");
    expect(normalizeProductView("settings")).toBe("settings");
    expect(normalizeProductView("skills")).toBe("providers");
  });

  it("only accepts Codex provider imports including legacy provider links", () => {
    expect(isProductImportAllowed({ app: "codex", resource: "provider" })).toBe(
      true,
    );
    expect(
      isProductImportAllowed({ app: "codex", resource: undefined } as any),
    ).toBe(true);
    for (const resource of ["skill", "prompt", "mcp"] as const) {
      expect(isProductImportAllowed({ app: "codex", resource })).toBe(false);
    }
    expect(
      isProductImportAllowed({ app: "claude", resource: "provider" }),
    ).toBe(false);
    expect(isProductImportAllowed({ resource: "provider" })).toBe(false);
  });
});
