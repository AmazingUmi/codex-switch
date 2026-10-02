import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { usageApi } from "@/lib/api/usage";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("usage source API", () => {
  it("reads both effective and default roots from the dedicated backend command", async () => {
    const source = {
      directory: "/fixture/read-only-source",
      defaultDirectory: "/fixture/default",
    };
    vi.mocked(invoke).mockResolvedValueOnce(source);
    expect(await usageApi.getCodexUsageSource()).toEqual(source);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("get_codex_usage_source");
  });
});
