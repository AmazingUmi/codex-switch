import { fireEvent, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SubscriptionQuotaView } from "@/components/SubscriptionQuotaFooter";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});

function renderRings(tiers: QuotaTier[], inline = false) {
  const refresh = vi.fn();
  const parentClick = vi.fn();
  const quota: SubscriptionQuota = {
    tool: "codex",
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers,
    extraUsage: null,
    error: null,
    queriedAt: Date.now(),
  };
  const view = (nextTiers: QuotaTier[]) => (
    <I18nextProvider i18n={i18n}>
      <div onClick={parentClick}>
        <SubscriptionQuotaView
          quota={{ ...quota, tiers: nextTiers }}
          loading={false}
          refetch={refresh}
          appIdForExpiredHint="codex"
          visualization="rings"
          inline={inline}
        />
      </div>
    </I18nextProvider>
  );
  const result = render(view(tiers));
  return {
    ...result,
    refresh,
    parentClick,
    rerenderQuota: (nextTiers: QuotaTier[]) => result.rerender(view(nextTiers)),
  };
}

describe("Codex ring quotas", () => {
  it("keeps labels beside their values with a larger account gauge", () => {
    renderRings([
      { name: "five_hour", utilization: 32, resetsAt: null },
      { name: "seven_day", utilization: 64, resetsAt: null },
    ]);
    expect(screen.getByRole("img")).toHaveClass(
      "w-[160px]",
      "min-w-[140px]",
      "max-w-full",
    );
    const valueRow = screen.getByText("32%").parentElement!;
    expect(valueRow).toHaveTextContent("5-Hour");
    expect(valueRow).not.toHaveClass("justify-between");
    expect(valueRow).toHaveClass("justify-end");
    expect(valueRow.parentElement!.parentElement).toHaveClass(
      "justify-self-end",
      "text-right",
    );
    expect(screen.getByRole("img").parentElement).toHaveClass("justify-center");
    expect(screen.getByRole("img").parentElement!.parentElement).toHaveClass(
      "grid",
      "grid-cols-[minmax(140px,1fr)_minmax(100px,auto)]",
    );
    expect(valueRow.parentElement).toHaveTextContent(
      en.codexAccounts.quotaResetUnknown,
    );
  });

  it("keeps the compact inline gauge without the account two-column layout", () => {
    renderRings([{ name: "five_hour", utilization: 32, resetsAt: null }], true);
    expect(screen.getByRole("img")).toHaveClass("h-[76px]", "w-[76px]");
    expect(screen.getByRole("img").parentElement!.parentElement).toHaveClass(
      "flex",
      "flex-wrap",
    );
    expect(screen.getByText("32%").parentElement).not.toHaveClass(
      "justify-end",
    );
  });

  it("retains unknown gauges and retry actions across unavailable states", () => {
    const base: SubscriptionQuota = {
      tool: "codex",
      credentialStatus: "valid",
      credentialMessage: null,
      success: true,
      tiers: [
        { name: "five_hour", utilization: 32, resetsAt: null },
        { name: "seven_day", utilization: 64, resetsAt: null },
      ],
      extraUsage: null,
      error: null,
      queriedAt: Date.now(),
    };
    const refresh = vi.fn();
    const view = (quota: SubscriptionQuota | undefined, loading = false) => (
      <I18nextProvider i18n={i18n}>
        <SubscriptionQuotaView
          quota={quota}
          loading={loading}
          refetch={refresh}
          appIdForExpiredHint="codex"
          visualization="rings"
        />
      </I18nextProvider>
    );
    const result = render(view(base));
    const states = [
      undefined,
      { ...base, tiers: [] },
      { ...base, credentialStatus: "not_found" as const, tiers: [] },
      {
        ...base,
        credentialStatus: "parse_error" as const,
        success: false,
        tiers: [],
      },
      {
        ...base,
        credentialStatus: "expired" as const,
        success: false,
        tiers: [],
      },
      { ...base, success: false, tiers: [], error: "HTTP 503: unavailable" },
    ];
    for (const next of states) {
      result.rerender(view(next, next === undefined));
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.queryByText("0%")).not.toBeInTheDocument();
      // Only the pending request disables refresh; each terminal state is retryable.
      if (next === undefined) {
        expect(
          screen.getByRole("button", { name: en.subscription.refresh }),
        ).toBeDisabled();
      } else {
        expect(
          screen.getByRole("button", { name: en.subscription.refresh }),
        ).toBeEnabled();
      }
    }
    expect(screen.getByText("HTTP 503: unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("retains an explicit unknown state and refresh action when no windows are returned", () => {
    const { refresh } = renderRings([]);
    expect(screen.getByRole("status")).toHaveTextContent(
      en.codexAccounts.quotaUnknown,
    );
    expect(screen.queryByText("0%")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("preserves a returned window with an unfamiliar name rather than discarding it", () => {
    renderRings([{ name: "unknown", utilization: 35, resetsAt: null }]);
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("35%")).toBeInTheDocument();
  });

  it.each([true, false])(
    "preserves independent window usage, reset and USD values in inline=%s",
    (inline) => {
      const reset = new Date(Date.now() + 2 * 3600000).toISOString();
      const { refresh, parentClick } = renderRings(
        [
          {
            name: "five_hour",
            utilization: 0,
            resetsAt: reset,
            usedValueUsd: 0,
            maxValueUsd: 20,
          },
          { name: "30_day", utilization: 100, resetsAt: null },
        ],
        inline,
      );
      expect(screen.getByText("0%")).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
      expect(screen.getByText("30-Day")).toBeInTheDocument();
      expect(
        screen.getByText(/Resets in 1h59m|Resets in 2h0m/),
      ).toBeInTheDocument();
      expect(screen.getByText("$0.00 / $20.00")).toBeInTheDocument();
      const gauge = screen.getByRole("img", {
        name: "5-Hour: 0% Used; 30-Day: 100% Used",
      });
      // A true zero has no arc, while 100% draws a closed circle without cap overlap.
      const arcs = gauge.querySelectorAll("circle[data-quota-value]");
      expect(arcs).toHaveLength(1);
      expect(arcs[0]).toHaveAttribute("stroke-dasharray", "100 100");
      expect(arcs[0]).toHaveAttribute("stroke-linecap", "butt");
      fireEvent.click(
        screen.getByRole("button", { name: en.subscription.refresh }),
      );
      expect(refresh).toHaveBeenCalledOnce();
      expect(parentClick).not.toHaveBeenCalled();
    },
  );

  it.each([NaN, Infinity, -1, 101])(
    "does not present invalid usage %s as 0%% or draw a valid arc",
    (utilization) => {
      renderRings([
        { name: "five_hour", utilization, resetsAt: "invalid-reset" },
      ]);
      expect(screen.queryByText("0%")).not.toBeInTheDocument();
      expect(
        screen.getByLabelText(en.codexAccounts.quotaUnknown),
      ).toHaveTextContent("—");
      expect(
        screen.getByText(en.codexAccounts.quotaResetUnknown),
      ).toBeInTheDocument();
      const gauge = screen.getByRole("img", {
        name: `5-Hour: ${en.codexAccounts.quotaUnknown}`,
      });
      expect(gauge.querySelectorAll("circle[data-quota-value]")).toHaveLength(
        0,
      );
      expect(gauge.querySelector("circle")).toHaveAttribute(
        "stroke-dasharray",
        "3 5",
      );
      expect(screen.queryByText(/NaN/)).not.toBeInTheDocument();
    },
  );

  it("opens quota help beside the title and retains it when quota updates", () => {
    const { container, parentClick, rerenderQuota } = renderRings([
      { name: "five_hour", utilization: 35, resetsAt: null },
    ]);
    expect(container.querySelector("details")).toBeNull();
    const help = screen.getByRole("button", {
      name: en.codexAccounts.helpLabel,
    });
    expect(help.parentElement).toHaveTextContent(en.subscription.title);
    expect(
      screen.queryByText(en.codexAccounts.helpQuota),
    ).not.toBeInTheDocument();
    fireEvent.click(help);
    expect(
      screen.getByRole("dialog", { name: en.codexAccounts.helpLabel }),
    ).toHaveTextContent(en.codexAccounts.helpQuota);
    expect(parentClick).not.toHaveBeenCalled();
    rerenderQuota([{ name: "five_hour", utilization: 45, resetsAt: null }]);
    expect(screen.getByText("45%")).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: en.codexAccounts.helpLabel }),
    ).toHaveTextContent(en.codexAccounts.helpQuota);
  });
});
