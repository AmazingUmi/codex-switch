import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UsageHero } from "@/components/usage/UsageHero";
import type { UsageSummary } from "@/types/usage";

const useUsageSummaryMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: { resolvedLanguage: "en", language: "en" },
  }),
}));

vi.mock("@/lib/query/usage", () => ({
  useUsageSummary: (...args: unknown[]) => useUsageSummaryMock(...args),
}));

const summary: UsageSummary = {
  totalRequests: 12,
  totalCost: "1.2345",
  totalInputTokens: 900000,
  totalOutputTokens: 200000,
  totalCacheCreationTokens: 0,
  totalCacheReadTokens: 134567,
  realTotalTokens: 1234567,
  cacheHitRate: 0.13,
  successRate: 1,
};

const renderHero = () =>
  render(<UsageHero range={{ preset: "today" }} refreshIntervalMs={30000} />);

describe("UsageHero", () => {
  beforeEach(() => {
    useUsageSummaryMock.mockReturnValue({ data: summary, isLoading: false });
  });

  it("shows one compact total with the full count available on hover and to assistive technology", () => {
    renderHero();
    const total = screen.getByText("1.23M");
    expect(total).toHaveAttribute("title", "1,234,567");
    expect(total).toHaveAttribute("aria-label", "1,234,567");
    expect(screen.queryByText("1,234,567")).not.toBeInTheDocument();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(screen.getByText("$1.2345")).toBeInTheDocument();
    expect(useUsageSummaryMock).toHaveBeenCalledWith(
      { preset: "today" },
      { appType: "codex", providerName: undefined, model: undefined },
      { refetchInterval: 30000 },
    );
  });

  it("preserves the unavailable-cost placeholder", () => {
    useUsageSummaryMock.mockReturnValue({
      data: { ...summary, totalCost: "not available" },
      isLoading: false,
    });
    renderHero();
    expect(screen.getByText("Estimated cost")).toBeInTheDocument();
    expect(screen.getByText("--")).toBeInTheDocument();
  });
});
