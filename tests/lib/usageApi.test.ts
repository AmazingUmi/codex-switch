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

describe("usage records and attribution API", () => {
  it("passes grouping to the backend before pagination and keeps tag scopes independent of visible IDs", async () => {
    vi.mocked(invoke).mockClear();
    await usageApi.getUsageRecords(
      { accountId: "a1", startDate: 1, endDate: 10 },
      "hour",
      2,
      20,
      "UTC",
    );
    expect(invoke).toHaveBeenLastCalledWith("get_usage_records", {
      filters: { accountId: "a1", startDate: 1, endDate: 10 },
      view: "hour",
      page: 2,
      pageSize: 20,
      timeZone: "UTC",
    });
    await usageApi.previewUsageAttribution({ startDate: 1, endDate: 10 });
    expect(invoke).toHaveBeenLastCalledWith("preview_usage_attribution", {
      selector: { startDate: 1, endDate: 10 },
      onlyUntagged: true,
    });
    await usageApi.setUsageAttribution({ sessionId: "s1" }, "c1", false);
    expect(invoke).toHaveBeenLastCalledWith("set_usage_attribution", {
      selector: { sessionId: "s1" },
      choiceId: "c1",
      onlyUntagged: false,
    });
    await usageApi.undoUsageAttribution(7);
    expect(invoke).toHaveBeenLastCalledWith("undo_usage_attribution", {
      actionId: 7,
    });
  });
});

describe("dashboard source scope API", () => {
  it("passes account and API identities to every statistics command", async () => {
    vi.mocked(invoke).mockClear();
    const calls = [
      ["get_usage_summary", usageApi.getUsageSummary],
      ["get_usage_trends", usageApi.getUsageTrends],
      ["get_provider_stats", usageApi.getProviderStats],
      ["get_model_stats", usageApi.getModelStats],
    ] as const;
    for (const [command, query] of calls) {
      await query(1, 10, "codex", undefined, "model", "account-a", "api-p");
      expect(invoke).toHaveBeenLastCalledWith(command, {
        startDate: 1,
        endDate: 10,
        appType: "codex",
        providerName: undefined,
        model: "model",
        accountId: "account-a",
        providerId: "api-p",
      });
    }
    await usageApi.getUsageSummaryByApp(1, 10, undefined, "model", "account-b");
    expect(invoke).toHaveBeenLastCalledWith("get_usage_summary_by_app", {
      startDate: 1,
      endDate: 10,
      providerName: undefined,
      model: "model",
      accountId: "account-b",
      providerId: undefined,
    });
  });
});
