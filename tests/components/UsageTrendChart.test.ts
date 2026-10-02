import { describe, expect, it, vi } from "vitest";
import { cloneElement, createElement } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import {
  buildUsageTrendChartData,
  createUsageTrendTokenTickFormatter,
  formatUsageTrendTokenTickLabel,
  formatUsageTrendTickLabel,
  formatUsageTrendCostTickLabel,
  UsageTrendChart,
} from "@/components/usage/UsageTrendChart";

// Supply deterministic chart dimensions; render the actual Recharts axes and areas.
vi.mock("recharts", async () => {
  const actual = await vi.importActual<typeof import("recharts")>("recharts");
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement }) =>
      createElement(
        "div",
        null,
        cloneElement(children, { width: 480, height: 280 } as object),
      ),
  };
});

const usageTrendsMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/usage", () => ({
  useUsageTrends: (...args: unknown[]) => usageTrendsMock(...args),
}));

const day = (isoDate: string) =>
  ({
    date: `${isoDate}T12:00:00.000Z`,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalCost: "0.01",
  }) as const;

describe("buildUsageTrendChartData (#6302)", () => {
  it("uses 00:00 hourly ticks and includes the UTC offset in tooltips", () => {
    const midnight = new Date(2026, 9, 1, 0, 0);
    const startDate = midnight.getTime() / 1000;
    const points = buildUsageTrendChartData(
      [{ ...day("2026-10-01"), date: midnight.toISOString() }],
      {
        isHourly: true,
        dateLocale: "en-US",
        startDate,
        endDate: startDate + 3600,
      },
    );

    expect(points[0].label).toBe("00:00");
    expect(points[0].tooltipLabel).toContain("2026");
    expect(points[0].tooltipLabel).toContain("00:00");
    expect(points[0].tooltipLabel).toMatch(/GMT(?:[+-]\d{2}:\d{2})?/);
  });

  it("keeps date and 24-hour time on short hourly ranges crossing midnight", () => {
    const points = buildUsageTrendChartData(
      [
        { ...day("2026-10-01"), date: "2026-10-01T23:00:00-07:00" },
        { ...day("2026-10-02"), date: "2026-10-02T00:00:00-07:00" },
      ],
      {
        isHourly: true,
        dateLocale: "en-US",
        startDate: Date.parse("2026-10-01T22:00:00-07:00") / 1000,
        endDate: Date.parse("2026-10-02T02:00:00-07:00") / 1000,
        timeZone: "America/Los_Angeles",
      },
    );
    expect(points[0].label).toBe("10/01, 23:00");
    expect(points[1].label).toBe("10/02, 00:00");
  });

  it("keeps repeated DST hours separate with unique timestamps and offsets in tooltips", () => {
    const repeated = ["2026-11-01T01:00:00-07:00", "2026-11-01T01:00:00-08:00"];
    const points = buildUsageTrendChartData(
      repeated.map((date) => ({ ...day("2026-11-01"), date })),
      {
        isHourly: true,
        dateLocale: "en-US",
        startDate: Date.parse("2026-11-01T00:00:00-07:00") / 1000,
        endDate: Date.parse("2026-11-01T03:00:00-08:00") / 1000,
        timeZone: "America/Los_Angeles",
      },
    );
    expect(points.map((point) => point.label)).toEqual(["01:00", "01:00"]);
    expect(points.map((point) => point.xKey)).toEqual(repeated);
    expect(points[0].tooltipLabel).toContain("GMT-07:00");
    expect(points[1].tooltipLabel).toContain("GMT-08:00");
    expect(points[0].tooltipLabel).toContain("2026");
  });

  it("omits unusable timestamps and preserves invalid cost as missing rather than zero", () => {
    const points = buildUsageTrendChartData(
      [
        { ...day("2026-10-01"), date: "invalid" },
        { ...day("2026-10-01"), totalCost: "invalid" },
      ],
      {
        isHourly: false,
        dateLocale: "en-US",
        startDate: Date.parse("2026-10-01T00:00:00Z") / 1000,
        endDate: Date.parse("2026-10-03T00:00:00Z") / 1000,
      },
    );
    expect(points).toHaveLength(1);
    expect(points[0].cost).toBeNull();
  });

  it("keeps unique x-axis keys when the same MM/DD appears in multiple years", () => {
    // 2025-04-27 and 2026-04-27 share the same MM/DD tick text in single-year
    // formatting. Using that text as the Recharts category key made activeDots
    // jump to the earlier year's point while the tooltip followed the cursor.
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData(
      [day("2025-04-27"), day("2026-04-27")],
      {
        isHourly: false,
        dateLocale: "en-US",
        startDate,
        endDate,
      },
    );

    expect(points).toHaveLength(2);
    expect(points[0].xKey).not.toBe(points[1].xKey);
    expect(points[0].xKey).toContain("2025-04-27");
    expect(points[1].xKey).toContain("2026-04-27");
    // Tooltip always carries a year so the user can tell which April it is.
    expect(points[0].tooltipLabel).toMatch(/2025/);
    expect(points[1].tooltipLabel).toMatch(/2026/);
  });

  it("includes a year in the axis tick when the selected range spans years", () => {
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData([day("2026-04-27")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });

    expect(points[0].label).toMatch(/26|2026/);
  });

  it("keeps short MM/DD ticks for single-year ranges", () => {
    const startDate = Math.floor(Date.parse("2026-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);

    const points = buildUsageTrendChartData([day("2026-04-27")], {
      isHourly: false,
      dateLocale: "en-US",
      startDate,
      endDate,
    });

    // en-US 2-digit month/day — should not need a year prefix inside one year.
    expect(points[0].label).not.toMatch(/2026/);
    expect(points[0].tooltipLabel).toMatch(/2026/);
  });
});

describe("formatUsageTrendTickLabel", () => {
  it("resolves labels by xKey even when the tick index is thinned", () => {
    const startDate = Math.floor(Date.parse("2025-01-01T00:00:00Z") / 1000);
    const endDate = Math.floor(Date.parse("2026-08-10T00:00:00Z") / 1000);
    const points = buildUsageTrendChartData(
      [
        {
          date: "2025-01-01T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
        {
          date: "2025-04-27T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
        {
          date: "2026-04-27T12:00:00.000Z",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheCreationTokens: 0,
          totalCacheReadTokens: 0,
          totalCost: "0",
        },
      ],
      { isHourly: false, dateLocale: "en-US", startDate, endDate },
    );

    // Simulate Recharts passing a later category as the only visible tick
    // (filtered index 0 would wrongly map to the first chart row).
    const last = points[2];
    expect(formatUsageTrendTickLabel(last.xKey, points)).toBe(last.label);
    expect(formatUsageTrendTickLabel(last.xKey, points)).not.toBe(
      points[0].label,
    );
  });
});

describe("formatUsageTrendTokenTickLabel", () => {
  it("uses localized compact units for large token axis ticks", () => {
    const zhFormatter = createUsageTrendTokenTickFormatter("zh-CN");
    const zhTwFormatter = createUsageTrendTokenTickFormatter("zh-TW");
    const enFormatter = createUsageTrendTokenTickFormatter("en-US");

    expect(formatUsageTrendTokenTickLabel(600_000_000, zhFormatter)).toBe(
      "6亿",
    );
    expect(formatUsageTrendTokenTickLabel(1_950_000_000, zhFormatter)).toBe(
      "19.5亿",
    );
    expect(formatUsageTrendTokenTickLabel(65_000_000, zhTwFormatter)).toBe(
      "6500萬",
    );
    expect(formatUsageTrendTokenTickLabel(600_000_000, enFormatter)).toBe(
      "600M",
    );
  });

  it("keeps zero and small-thousand token ticks readable", () => {
    expect(
      formatUsageTrendTokenTickLabel(
        0,
        createUsageTrendTokenTickFormatter("zh-CN"),
      ),
    ).toBe("0");
    expect(
      formatUsageTrendTokenTickLabel(
        1500,
        createUsageTrendTokenTickFormatter("en-US"),
      ),
    ).toBe("1.5K");
  });
});

describe("cost axis formatting", () => {
  it("rounds floating-point tails, uses compact large amounts and preserves zero", () => {
    expect(formatUsageTrendCostTickLabel(0)).toBe("$0");
    expect(formatUsageTrendCostTickLabel(0.30000000000000004)).toBe("$0.3");
    expect(formatUsageTrendCostTickLabel(1500)).toBe("$1.5K");
    expect(formatUsageTrendCostTickLabel(0.001)).not.toBe("$0");
  });
  it("does not round tiny nonzero axis or tooltip amounts to zero", () => {
    expect(formatUsageTrendCostTickLabel(0.00000012)).toBe("$1.2e-7");
    expect(formatUsageTrendCostTickLabel(0.00000012, "en-US", false)).toBe(
      "$1.20e-7",
    );
    for (const value of [NaN, Infinity, "invalid", undefined, null])
      expect(formatUsageTrendCostTickLabel(value)).toBe("—");
  });
});

describe("trend empty state", () => {
  it("shows existing no-data text in the glass card and retains source query scope", () => {
    usageTrendsMock.mockReturnValue({ data: [], isLoading: false });
    const view = render(
      createElement(UsageTrendChart, {
        range: { preset: "today" },
        rangeLabel: "Today",
        accountId: "account-one",
        refreshIntervalMs: 0,
      }),
    );
    expect(screen.getByText("usage.noData")).toBeVisible();
    expect(view.container.firstChild).toHaveClass("glass-card");
    expect(usageTrendsMock).toHaveBeenCalledWith(
      { preset: "today" },
      expect.objectContaining({
        appType: "codex",
        accountId: "account-one",
        providerId: undefined,
      }),
      { refetchInterval: false },
    );
  });
});

describe("trend single point rendering", () => {
  it("renders a visible marker with animations and unique gradients for each mounted chart", async () => {
    usageTrendsMock.mockReturnValue({
      data: [day("2026-10-01")],
      isLoading: false,
    });
    const props = {
      range: { preset: "today" as const },
      rangeLabel: "Today",
      refreshIntervalMs: 0,
    };
    const view = render(
      createElement(
        "div",
        null,
        createElement(UsageTrendChart, props),
        createElement(UsageTrendChart, props),
      ),
    );
    const gradients = [
      ...view.container.querySelectorAll("linearGradient"),
    ].map((gradient) => gradient.id);
    expect(gradients).toHaveLength(8);
    expect(new Set(gradients).size).toBe(8);
    await waitFor(
      () =>
        expect(
          view.container.querySelectorAll("circle.recharts-dot").length,
        ).toBeGreaterThanOrEqual(2),
      { timeout: 3000 },
    );
    expect(view.container.querySelectorAll(".recharts-area")).toHaveLength(10);
  });
});
