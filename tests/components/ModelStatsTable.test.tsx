import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelStatsTable } from "@/components/usage/ModelStatsTable";

const stats = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/usage", () => ({ useModelStats: stats }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

describe("model statistics comparison", () => {
  it("uses the filtered table response for token and estimated-cost comparisons", () => {
    stats.mockReturnValue({
      data: [
        {
          model: "gpt-large",
          requestCount: 2,
          totalTokens: 1000,
          totalCost: "0.08",
          avgCostPerRequest: "0.04",
        },
        {
          model: "gpt-small",
          requestCount: 1,
          totalTokens: 500,
          totalCost: "0.01",
          avgCostPerRequest: "0.01",
        },
      ],
      isLoading: false,
    });
    render(
      <ModelStatsTable
        range={{ preset: "7d" }}
        providerId="api"
        model="gpt-large"
        refreshIntervalMs={0}
      />,
    );
    const table = within(screen.getByRole("table"));
    expect(table.getByText("gpt-large")).toBeVisible();
    expect(table.getByText("$0.0800")).toBeVisible();
    expect(
      screen.getByRole("img", { name: /gpt-large: 1,000 Tokens/ }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(
      screen.getByRole("img", { name: /gpt-large: \$0.080000/ }),
    ).toBeVisible();
    expect(stats).toHaveBeenLastCalledWith(
      { preset: "7d" },
      {
        appType: "codex",
        providerName: undefined,
        accountId: undefined,
        providerId: "api",
        model: "gpt-large",
      },
      { refetchInterval: false },
    );
  });
});
