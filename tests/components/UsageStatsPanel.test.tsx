import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UsageStatsPanel } from "@/components/usage/UsageStatsPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback,
    i18n: { language: "en", resolvedLanguage: "en" },
  }),
}));

const items = [
  { id: "alpha", label: "Alpha", totalTokens: 800, totalCost: "3.000000" },
  { id: "beta", label: "Beta", totalTokens: 1200, totalCost: "1.000000" },
];
const panel = (data = items) => (
  <UsageStatsPanel items={data} comparisonTitle="Source comparison">
    <div>Table</div>
  </UsageStatsPanel>
);

describe("usage comparison", () => {
  it("switches metric, ranking and pie shares while retaining each source color", () => {
    const view = render(panel());
    expect(
      screen.getAllByRole("img").map((bar) => bar.getAttribute("aria-label")),
    ).toEqual(["Beta: 1,200 Tokens (60.0%)", "Alpha: 800 Tokens (40.0%)"]);
    const beta = view.container.querySelector('[data-slice-id="beta"]')!;
    const betaColor = beta.getAttribute("fill");
    expect(beta).toHaveAttribute("data-share", "0.6");
    expect(beta.getAttribute("d")).toContain("A 90 90 0 1 1");
    expect(screen.getByTitle("2,000 Tokens")).toHaveTextContent("2.0K");

    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(
      screen.getAllByRole("img").map((bar) => bar.getAttribute("aria-label")),
    ).toEqual(["Alpha: $3.000000 (75.0%)", "Beta: $1.000000 (25.0%)"]);
    expect(screen.getByTitle("$4.000000")).toHaveTextContent("$4.0000");
    expect(
      view.container.querySelector('[data-slice-id="alpha"]'),
    ).toHaveAttribute("data-share", "0.75");
    expect(beta).toHaveAttribute("data-share", "0.25");
    expect(beta).toHaveAttribute("fill", betaColor);
    expect(beta.getAttribute("d")).toContain("A 90 90 0 0 1");

    fireEvent.focus(screen.getByRole("img", { name: /Alpha:/ }));
    expect(beta).toHaveAttribute("data-dimmed", "true");
    fireEvent.blur(screen.getByRole("img", { name: /Alpha:/ }));
    expect(beta).toHaveAttribute("data-dimmed", "false");

    fireEvent.keyDown(screen.getByRole("button", { name: "Cost" }), {
      key: "ArrowRight",
    });
    expect(screen.getByRole("button", { name: "Tokens" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("rebuilds the comparison and total after filters change while keeping the metric", () => {
    const view = render(panel());
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    view.rerender(panel([items[1]]));
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByRole("img", { name: "Beta: $1.000000 (100.0%)" }),
    ).toBeVisible();
    expect(screen.getByTitle("$1.000000")).toHaveTextContent("$1.0000");
    expect(
      view.container.querySelector('[data-slice-id="beta"]')?.tagName,
    ).toBe("circle");
    expect(
      screen.queryByRole("img", { name: /Alpha:/ }),
    ).not.toBeInTheDocument();
  });

  it("preserves zero and small costs without treating invalid values as zero", () => {
    const view = render(
      panel([
        { id: "zero", label: "Zero", totalTokens: 0, totalCost: "0" },
        { id: "tiny", label: "Tiny", totalTokens: 1, totalCost: "0.000009" },
        {
          id: "unknown",
          label: "Unknown",
          totalTokens: NaN,
          totalCost: "invalid",
        },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cost" }));
    expect(
      within(screen.getByRole("img", { name: /Tiny:/ })).getByText("$0.000009"),
    ).toBeVisible();
    expect(
      screen.getByRole("img", { name: "Zero: $0.000000 (0.0%)" }),
    ).toBeVisible();
    expect(view.container.querySelectorAll("[data-slice-id]")).toHaveLength(1);
    expect(
      view.container.querySelector('[data-slice-id="tiny"]'),
    ).toHaveAttribute("data-share", "1");
    expect(screen.getByRole("img", { name: "Unknown: —" })).toBeVisible();
    view.rerender(
      panel([{ id: "zero", label: "Zero", totalTokens: 0, totalCost: "0" }]),
    );
    expect(screen.getByRole("img", { name: "Zero: $0.000000" })).toBeVisible();
    expect(view.container.querySelectorAll("[data-slice-id]")).toHaveLength(0);
    view.rerender(
      panel([
        {
          id: "unknown",
          label: "Unknown",
          totalTokens: NaN,
          totalCost: "invalid",
        },
      ]),
    );
    expect(screen.getByTitle("—")).toHaveTextContent("—");
    expect(view.container.querySelectorAll("[data-slice-id]")).toHaveLength(0);
  });

  it("shows an empty comparison when the selected range has no records", () => {
    render(panel([]));
    expect(screen.getByText("No data")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });
});
