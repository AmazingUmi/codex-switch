import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { usageApi } from "@/lib/api/usage";
import {
  useModelStats,
  useProviderStats,
  useUsageSummary,
  useUsageSummaryByApp,
  useUsageTrends,
} from "@/lib/query/usage";
import type { UsageScopeFilters } from "@/types/usage";

describe("dashboard source query isolation", () => {
  it("fetches each statistics scope when switching accounts, API and unknown sources", async () => {
    const summary = vi.spyOn(usageApi, "getUsageSummary").mockResolvedValue({
      totalRequests: 0,
      totalCost: "0",
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      successRate: 0,
      realTotalTokens: 0,
      cacheHitRate: 0,
    });
    const byApp = vi
      .spyOn(usageApi, "getUsageSummaryByApp")
      .mockResolvedValue([]);
    const trends = vi.spyOn(usageApi, "getUsageTrends").mockResolvedValue([]);
    const providers = vi
      .spyOn(usageApi, "getProviderStats")
      .mockResolvedValue([]);
    const models = vi.spyOn(usageApi, "getModelStats").mockResolvedValue([]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    const scopes: UsageScopeFilters[] = [
      { appType: "codex", accountId: "account-a" },
      { appType: "codex", accountId: "account-b" },
      { appType: "codex", providerId: "deepseek" },
      {
        appType: "codex",
        accountId: "__unassigned__",
        providerId: "__unassigned__",
      },
    ];
    const range = {
      preset: "custom" as const,
      customStartDate: 1,
      customEndDate: 10,
    };
    const options = { refetchInterval: false as const };
    const { result, rerender, unmount } = renderHook(
      ({ filters }: { filters: UsageScopeFilters }) => [
        useUsageSummary(range, filters, options),
        useUsageSummaryByApp(range, filters, options),
        useUsageTrends(range, filters, options),
        useProviderStats(range, filters, options),
        useModelStats(range, filters, options),
      ],
      {
        initialProps: { filters: scopes[0] },
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={client}>{children}</QueryClientProvider>
        ),
      },
    );
    for (const [index, filters] of scopes.entries()) {
      if (index > 0) rerender({ filters });
      await waitFor(() =>
        expect(result.current.every((query) => query.isSuccess)).toBe(true),
      );
      for (const query of [summary, trends, providers, models]) {
        expect(query).toHaveBeenLastCalledWith(
          1,
          10,
          "codex",
          undefined,
          undefined,
          filters.accountId,
          filters.providerId,
        );
      }
      expect(byApp).toHaveBeenLastCalledWith(
        1,
        10,
        undefined,
        undefined,
        filters.accountId,
        filters.providerId,
      );
    }
    unmount();
    client.clear();
    vi.restoreAllMocks();
  });
});
