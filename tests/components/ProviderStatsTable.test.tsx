import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderStatsTable } from "@/components/usage/ProviderStatsTable";
import type { ProviderStats } from "@/types/usage";

const query = vi.hoisted(() => ({ stats: vi.fn(), choices: vi.fn() }));
vi.mock("@/lib/query/usage", () => ({
  useProviderStats: (...args: unknown[]) => query.stats(...args),
  useUsageAttributionChoices: () => query.choices(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

describe("source statistics table", () => {
  it("shows separate subscription rows with current nicknames, API and unknown sources", () => {
    const base = {
      providerId: "official",
      providerName: "OpenAI",
      requestCount: 3,
      totalTokens: 1000,
      totalCost: "0.01",
      successRate: 100,
      avgLatencyMs: 25,
    };
    const data: ProviderStats[] = [
      {
        ...base,
        sourceId: "account:one",
        accountId: "one",
        accountName: "old name",
      },
      {
        ...base,
        sourceId: "account:two",
        accountId: "two",
        accountName: "second old name",
        requestCount: 4,
      },
      {
        ...base,
        sourceId: "provider:deepseek",
        accountId: null,
        accountName: null,
        providerId: "deepseek",
        providerName: "old API name",
        requestCount: 5,
      },
      {
        ...base,
        sourceId: "__unassigned__",
        accountId: null,
        accountName: null,
        providerId: "_codex_session",
        providerName: "Unassigned",
        requestCount: 6,
      },
    ];
    query.stats.mockReturnValue({ data, isLoading: false });
    query.choices.mockReturnValue({
      data: [
        {
          id: "one",
          label: "umi",
          accountId: "one",
          accountName: "umi",
          providerId: "official",
          providerName: "OpenAI",
        },
        {
          id: "two",
          label: "work",
          accountId: "two",
          accountName: "work",
          providerId: "official",
          providerName: "OpenAI",
        },
        {
          id: "api",
          label: "DeepSeek",
          accountId: "api:deepseek",
          accountName: "API credentials",
          providerId: "deepseek",
          providerName: "DeepSeek",
        },
      ],
    });
    render(
      <ProviderStatsTable
        range={{ preset: "today" }}
        accountId="one"
        refreshIntervalMs={0}
      />,
    );
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeVisible();
    const table = within(screen.getByRole("table"));
    for (const [label, count] of [
      ["umi", "3"],
      ["work", "4"],
      ["DeepSeek", "5"],
      ["Unassigned", "6"],
    ]) {
      const row = table.getByText(label).closest("tr")!;
      expect(within(row).getByText(count)).toBeVisible();
      expect(within(row).getByText("1,000")).toBeVisible();
      expect(within(row).getByText("$0.0100")).toBeVisible();
    }
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
    expect(screen.getAllByRole("img")).toHaveLength(4);
    expect(
      screen.getByRole("img", { name: /umi: 1,000 Tokens/ }),
    ).toBeVisible();
    expect(query.stats).toHaveBeenLastCalledWith(
      { preset: "today" },
      {
        appType: "codex",
        accountId: "one",
        providerId: undefined,
        providerName: undefined,
        model: undefined,
      },
      { refetchInterval: false },
    );
  });
});
