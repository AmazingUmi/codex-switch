import { StrictMode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SubscriptionQuotaView } from "@/components/SubscriptionQuotaFooter";
import type { QuotaTier, SubscriptionQuota } from "@/types/subscription";
import en from "@/i18n/locales/en.json";
import type { QuotaBatteryThresholds } from "@/utils/quotaBatteryThresholds";

const i18n = createInstance();
const now = Date.parse("2026-10-02T12:00:00Z");
const resetIn = (hours: number) =>
  new Date(now + hours * 3600000).toISOString();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function quota(tiers: QuotaTier[]): SubscriptionQuota {
  return {
    tool: "codex_oauth",
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers,
    extraUsage: null,
    error: null,
    queriedAt: now,
  };
}

function renderBattery(
  initial: SubscriptionQuota | undefined,
  loading = false,
  batteryThresholds?: QuotaBatteryThresholds,
  strict = false,
) {
  const refresh = vi.fn();
  const parentClick = vi.fn();
  const view = (next: SubscriptionQuota | undefined, pending = false) => (
    <I18nextProvider i18n={i18n}>
      <div onClick={parentClick}>
        <SubscriptionQuotaView
          quota={next}
          loading={pending}
          refetch={refresh}
          appIdForExpiredHint="codex_oauth"
          expiredHint={en.codexAccounts.quotaExpiredHint}
          visualization="battery"
          batteryThresholds={batteryThresholds}
        />
      </div>
    </I18nextProvider>
  );
  const wrap = (node: React.ReactNode) =>
    strict ? <StrictMode>{node}</StrictMode> : node;
  const result = render(wrap(view(initial, loading)));
  return {
    ...result,
    refresh,
    parentClick,
    rerenderQuota: (next: SubscriptionQuota | undefined, pending = false) =>
      result.rerender(wrap(view(next, pending))),
  };
}

function controlEntryMotion(enabled = true) {
  const frames = new Map<number, FrameRequestCallback>();
  const listeners = new Set<() => void>();
  let nextFrame = 0;
  const motion = {
    matches: enabled,
    addEventListener: vi.fn((_event: string, listener: () => void) =>
      listeners.add(listener),
    ),
    removeEventListener: vi.fn((_event: string, listener: () => void) =>
      listeners.delete(listener),
    ),
  };
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  const cancelFrame = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => motion),
  );
  vi.stubGlobal("requestAnimationFrame", requestFrame);
  vi.stubGlobal("cancelAnimationFrame", cancelFrame);
  return {
    frames,
    requestFrame,
    cancelFrame,
    motion,
    tick: (timestamp: number) =>
      act(() => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(timestamp));
      }),
    reduceMotion: () =>
      act(() => {
        motion.matches = false;
        listeners.forEach((listener) => listener());
      }),
  };
}

describe("Codex account quota batteries", () => {
  it("drains from full charge and crosses green, warning and low tones while keeping accessible quota truthful", () => {
    const animation = controlEntryMotion();
    renderBattery(
      quota([{ name: "five_hour", utilization: 95, resetsAt: resetIn(2) }]),
    );
    const meter = screen.getByRole("meter");
    const row = meter.closest("[data-quota-tone]") as HTMLElement;
    const charge = () =>
      Number(row.style.getPropertyValue("--codex-quota-remaining"));
    expect(charge()).toBe(100);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-quota-tone", "available");
    expect(meter).toHaveAttribute("aria-valuenow", "5");
    expect(meter).toHaveAttribute("aria-valuetext", "5% Left");
    animation.tick(0);
    animation.tick(600);
    const middle = charge();
    expect(middle).toBeGreaterThan(10);
    expect(middle).toBeLessThan(50);
    expect(row).toHaveAttribute("data-quota-tone", "warning");
    animation.tick(1000);
    expect(charge()).toBeGreaterThan(5);
    expect(charge()).toBeLessThan(10);
    expect(row).toHaveAttribute("data-quota-tone", "low");
    animation.tick(1100);
    expect(charge()).toBe(5);
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(row).toHaveAttribute("data-entry-animating", "false");
    expect(screen.getByRole("meter")).toBe(meter);
    expect(animation.frames.size).toBe(0);
  });

  it("uses custom color thresholds during depletion instead of starting in the final color", () => {
    const animation = controlEntryMotion();
    renderBattery(
      quota([{ name: "five_hour", utilization: 95, resetsAt: null }]),
      false,
      { warning: 70, low: 20 },
    );
    const row = screen.getByRole("meter").closest("[data-quota-tone]");
    expect(row).toHaveAttribute("data-quota-tone", "available");
    animation.tick(0);
    animation.tick(450);
    expect(row).toHaveAttribute("data-quota-tone", "warning");
    animation.tick(900);
    expect(row).toHaveAttribute("data-quota-tone", "low");
  });

  it("depletes to zero and clears every filled cell at completion", () => {
    const animation = controlEntryMotion();
    renderBattery(
      quota([{ name: "five_hour", utilization: 100, resetsAt: null }]),
    );
    const meter = screen.getByRole("meter");
    expect(meter.querySelector(".codex-battery-fill")).not.toBeNull();
    animation.tick(0);
    animation.tick(1100);
    expect(screen.getByText("0%")).toBeInTheDocument();
    expect(meter.querySelector(".codex-battery-fill")).toBeNull();
  });

  it("waits for known quota and never animates unknown placeholders as full charge", () => {
    const animation = controlEntryMotion();
    const { rerenderQuota } = renderBattery(undefined, true);
    expect(screen.getAllByText("—")).toHaveLength(2);
    expect(animation.requestFrame).not.toHaveBeenCalled();
    rerenderQuota(
      quota([{ name: "five_hour", utilization: 95, resetsAt: null }]),
    );
    expect(screen.getByText("100%")).toBeInTheDocument();
    animation.tick(0);
    animation.tick(1100);
    expect(screen.getByText("5%")).toBeInTheDocument();
  });

  it("does not replay on countdown ticks or refreshed quota, but plays after a fresh page mount", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const animation = controlEntryMotion();
    const initial = quota([
      { name: "five_hour", utilization: 95, resetsAt: resetIn(2) },
    ]);
    const { rerenderQuota, unmount } = renderBattery(initial);
    const meter = screen.getByRole("meter");
    animation.tick(0);
    animation.tick(1100);
    const calls = animation.requestFrame.mock.calls.length;
    vi.mocked(Date.now).mockReturnValue(now + 30000);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByText(/Resets in 1h59m/)).toBeInTheDocument();
    rerenderQuota(
      quota([{ name: "five_hour", utilization: 96, resetsAt: resetIn(2) }]),
    );
    expect(screen.getByText("4%")).toBeInTheDocument();
    expect(screen.getByRole("meter")).toBe(meter);
    expect(animation.requestFrame).toHaveBeenCalledTimes(calls);
    unmount();
    renderBattery(initial);
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(animation.requestFrame).toHaveBeenCalledTimes(calls + 1);
  });

  it("keeps full initial quota static when a refresh later lowers it", () => {
    const animation = controlEntryMotion();
    const { rerenderQuota } = renderBattery(
      quota([{ name: "five_hour", utilization: 0, resetsAt: null }]),
    );
    rerenderQuota(
      quota([{ name: "five_hour", utilization: 40, resetsAt: null }]),
    );
    expect(screen.getByText("60%")).toBeInTheDocument();
    expect(animation.requestFrame).not.toHaveBeenCalled();
  });

  it("shows final charge immediately with reduced motion and stops an active animation when the preference changes", () => {
    const animation = controlEntryMotion(false);
    const { unmount } = renderBattery(
      quota([{ name: "five_hour", utilization: 95, resetsAt: null }]),
    );
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(animation.requestFrame).not.toHaveBeenCalled();
    unmount();
    const active = controlEntryMotion();
    renderBattery(
      quota([{ name: "five_hour", utilization: 95, resetsAt: null }]),
    );
    active.tick(0);
    active.tick(300);
    active.reduceMotion();
    expect(screen.getByText("5%")).toBeInTheDocument();
    expect(active.frames.size).toBe(0);
  });

  it("survives Strict Mode effect replay and cancels pending frames on unmount", () => {
    const animation = controlEntryMotion();
    const { unmount } = renderBattery(
      quota([{ name: "five_hour", utilization: 95, resetsAt: null }]),
      false,
      undefined,
      true,
    );
    expect(animation.frames.size).toBe(1);
    animation.tick(0);
    animation.tick(600);
    expect(
      screen.getByRole("meter").closest("[data-quota-tone]"),
    ).toHaveAttribute("data-quota-tone", "warning");
    unmount();
    expect(animation.frames.size).toBe(0);
    expect(animation.motion.removeEventListener).toHaveBeenCalled();
  });

  it("shows independent remaining quota with accessible meter values", () => {
    renderBattery(
      quota([
        { name: "five_hour", utilization: 32, resetsAt: resetIn(2) },
        { name: "seven_day", utilization: 64, resetsAt: resetIn(84) },
      ]),
    );
    const short = screen.getByRole("meter", { name: "5-Hour" });
    const weekly = screen.getByRole("meter", { name: "7-Day" });
    expect(short).toHaveAttribute("aria-valuemin", "0");
    expect(short).toHaveAttribute("aria-valuemax", "100");
    expect(short).toHaveAttribute("aria-valuenow", "68");
    expect(short).toHaveAttribute("aria-valuetext", "68% Left");
    expect(weekly).toHaveAttribute("aria-valuenow", "36");
    expect(weekly).toHaveAttribute("aria-valuetext", "36% Left");
    expect(screen.getByText("68%")).toBeInTheDocument();
    expect(screen.getByText("36%")).toBeInTheDocument();
    expect(screen.getByText(/Resets in 2h0m/)).toBeInTheDocument();
    expect(screen.getByText(/Resets in 3d12h/)).toBeInTheDocument();
    expect(screen.queryByText("32%")).not.toBeInTheDocument();
  });

  it.each([
    [0, 100],
    [100, 0],
    [65.4, 34.6],
  ])(
    "converts used %s to remaining %s without confusing zero with unknown",
    (used, remaining) => {
      renderBattery(
        quota([{ name: "five_hour", utilization: used, resetsAt: null }]),
      );
      const meter = screen.getByRole("meter", { name: "5-Hour" });
      expect(Number(meter.getAttribute("aria-valuenow"))).toBeCloseTo(
        remaining,
      );
      expect(meter).toHaveAttribute(
        "aria-valuetext",
        `${Math.round(remaining)}% Left`,
      );
      expect(screen.getByText(`${Math.round(remaining)}%`)).toBeInTheDocument();
      expect(screen.queryByText("—")).not.toBeInTheDocument();
      const fill = meter.querySelector(".codex-battery-fill");
      if (remaining === 0) expect(fill).toBeNull();
      else expect(fill).not.toBeNull();
    },
  );

  it.each([
    { remaining: 50.1, tone: "available" },
    { remaining: 50, tone: "warning" },
    { remaining: 10.1, tone: "warning" },
    { remaining: 10, tone: "low" },
    { remaining: 0, tone: "low" },
  ])(
    "uses the default 50/10 boundaries at $remaining% remaining",
    ({ remaining, tone }) => {
      renderBattery(
        quota([
          { name: "five_hour", utilization: 100 - remaining, resetsAt: null },
        ]),
      );
      expect(
        screen.getByRole("meter").closest("[data-quota-tone]"),
      ).toHaveAttribute("data-quota-tone", tone);
    },
  );

  it.each([
    { remaining: 70.1, tone: "available" },
    { remaining: 70, tone: "warning" },
    { remaining: 20.1, tone: "warning" },
    { remaining: 20, tone: "low" },
  ])(
    "applies custom 70/20 boundaries at $remaining% remaining",
    ({ remaining, tone }) => {
      renderBattery(
        quota([
          { name: "five_hour", utilization: 100 - remaining, resetsAt: null },
        ]),
        false,
        { warning: 70, low: 20 },
      );
      expect(
        screen.getByRole("meter").closest("[data-quota-tone]"),
      ).toHaveAttribute("data-quota-tone", tone);
    },
  );

  it("retains the reset text below the battery for a single window", () => {
    renderBattery(
      quota([{ name: "five_hour", utilization: 20, resetsAt: resetIn(2) }]),
    );
    const countdown = screen.getByText(
      i18n.t("subscription.resetsIn", { time: "2h0m" }),
    );
    expect(screen.getByRole("meter")).not.toContainElement(countdown);
    expect(countdown).toHaveAttribute(
      "title",
      new Date(resetIn(2)).toLocaleString(),
    );
  });

  it.each([NaN, Infinity, -1, 101])(
    "keeps invalid usage %s explicitly unknown",
    (utilization) => {
      renderBattery(
        quota([{ name: "five_hour", utilization, resetsAt: "invalid-reset" }]),
      );
      const unknown = screen.getByRole("img", {
        name: `5-Hour: ${en.codexAccounts.quotaUnknown}`,
      });
      expect(screen.queryByRole("meter")).not.toBeInTheDocument();
      for (const attribute of [
        "aria-valuenow",
        "aria-valuemin",
        "aria-valuemax",
        "aria-valuetext",
      ]) {
        expect(unknown).not.toHaveAttribute(attribute);
      }
      expect(screen.getByText("—")).toBeInTheDocument();
      expect(screen.queryByText(/^(0|100)%$/)).not.toBeInTheDocument();
      expect(
        screen.getByText(en.codexAccounts.quotaResetUnknown),
      ).toBeInTheDocument();
      expect(unknown.querySelector(".codex-battery-time-marker")).toBeNull();
      expect(unknown.querySelector(".codex-battery-fill")).toBeNull();
      expect(screen.queryByText(/NaN|Infinity/)).not.toBeInTheDocument();
    },
  );

  it.each([
    { name: "five_hour", hours: 2.5, windowDurationSeconds: 18000 },
    { name: "seven_day", hours: 84, windowDurationSeconds: 604800 },
    { name: "30_day", hours: 360, windowDurationSeconds: 2592000 },
  ])(
    "places the time marker using the explicit duration of $name",
    ({ name, hours, windowDurationSeconds }) => {
      renderBattery(
        quota([
          {
            name,
            utilization: 10,
            resetsAt: resetIn(hours),
            windowDurationSeconds,
          },
        ]),
      );
      const marker = screen
        .getByRole("meter")
        .querySelector(".codex-battery-time-marker");
      expect(marker).not.toBeNull();
      expect(marker).toHaveAttribute("aria-hidden", "true");
      expect(Number(marker!.getAttribute("data-time-remaining"))).toBeCloseTo(
        50,
      );
    },
  );

  it("uses a returned 30-day-plus-six-hour duration instead of the nominal label duration", () => {
    renderBattery(
      quota([
        {
          name: "30_day",
          utilization: 20,
          resetsAt: resetIn(363),
          windowDurationSeconds: 726 * 3600,
        },
      ]),
    );
    const marker = screen
      .getByRole("meter", { name: "30-Day" })
      .querySelector(".codex-battery-time-marker");
    expect(marker).not.toBeNull();
    expect(Number(marker!.getAttribute("data-time-remaining"))).toBeCloseTo(50);
  });

  it("shows a time marker for a custom window with an explicit duration", () => {
    renderBattery(
      quota([
        {
          name: "custom_window",
          utilization: 35,
          resetsAt: resetIn(2.5),
          windowDurationSeconds: 10 * 3600,
        },
      ]),
    );
    const meter = screen.getByRole("meter", { name: "custom_window" });
    const marker = meter.querySelector(".codex-battery-time-marker");
    expect(marker).not.toBeNull();
    expect(Number(marker!.getAttribute("data-time-remaining"))).toBeCloseTo(25);
    expect(meter).toHaveAttribute("aria-valuenow", "65");
    expect(screen.getByText(/Resets in 2h30m/)).toBeInTheDocument();
  });

  it.each([
    { name: "five_hour", hours: 2.5 },
    { name: "seven_day", hours: 84 },
  ])(
    "retains an exact-name duration fallback for $name when the field is absent",
    ({ name, hours }) => {
      renderBattery(
        quota([{ name, utilization: 20, resetsAt: resetIn(hours) }]),
      );
      const marker = screen
        .getByRole("meter")
        .querySelector(".codex-battery-time-marker");
      expect(marker).not.toBeNull();
      expect(Number(marker!.getAttribute("data-time-remaining"))).toBeCloseTo(
        50,
      );
    },
  );

  it.each([0, -1, NaN, Infinity])(
    "does not fall back from an explicit invalid duration %s",
    (windowDurationSeconds) => {
      renderBattery(
        quota([
          {
            name: "five_hour",
            utilization: 20,
            resetsAt: resetIn(2),
            windowDurationSeconds,
          },
        ]),
      );
      expect(
        screen.getByRole("meter").querySelector(".codex-battery-time-marker"),
      ).toBeNull();
      expect(screen.getByText("80%")).toBeInTheDocument();
      expect(screen.getByText(/Resets in 2h0m/)).toBeInTheDocument();
    },
  );

  it.each([-1, 10])(
    "bounds a valid 5h marker for reset offset %s hours",
    (hours) => {
      renderBattery(
        quota([
          { name: "five_hour", utilization: 10, resetsAt: resetIn(hours) },
        ]),
      );
      const marker = screen
        .getByRole("meter")
        .querySelector(".codex-battery-time-marker");
      expect(marker).not.toBeNull();
      expect(Number(marker!.getAttribute("data-time-remaining"))).toBe(
        hours < 0 ? 0 : 100,
      );
    },
  );

  it.each([null, "invalid-reset"])(
    "omits time markers when reset is %s",
    (resetsAt) => {
      renderBattery(quota([{ name: "five_hour", utilization: 20, resetsAt }]));
      expect(
        screen.getByRole("meter").querySelector(".codex-battery-time-marker"),
      ).toBeNull();
      expect(
        screen.getByText(en.codexAccounts.quotaResetUnknown),
      ).toBeInTheDocument();
      expect(screen.getByText("80%")).toBeInTheDocument();
    },
  );

  it.each([
    "weekly_limit",
    "seven_day_fable",
    "custom_window",
    "30_day",
    "constructor",
    "toString",
    "__proto__",
  ])(
    "does not guess a duration for %s while retaining quota and countdown",
    (name) => {
      renderBattery(quota([{ name, utilization: 35, resetsAt: resetIn(2) }]));
      const meter = screen.getByRole("meter");
      expect(meter).toHaveAttribute("aria-valuenow", "65");
      expect(meter.querySelector(".codex-battery-time-marker")).toBeNull();
      expect(screen.getByText("65%")).toBeInTheDocument();
      expect(screen.getByText(/Resets in 2h0m/)).toBeInTheDocument();
      if (
        ["custom_window", "constructor", "toString", "__proto__"].includes(name)
      ) {
        expect(meter).toHaveAccessibleName(name);
      }
    },
  );

  it("preserves meter DOM during countdown ticks and refreshed values", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const initial = quota([
      { name: "five_hour", utilization: 20, resetsAt: resetIn(2) },
    ]);
    const { rerenderQuota } = renderBattery(initial);
    const meter = screen.getByRole("meter", { name: "5-Hour" });
    vi.mocked(Date.now).mockReturnValue(now + 30000);
    act(() => vi.advanceTimersByTime(30000));
    expect(screen.getByRole("meter", { name: "5-Hour" })).toBe(meter);
    expect(screen.getByText(/Resets in 1h59m/)).toBeInTheDocument();
    rerenderQuota(
      quota([{ name: "five_hour", utilization: 40, resetsAt: resetIn(2) }]),
    );
    expect(screen.getByRole("meter", { name: "5-Hour" })).toBe(meter);
    expect(meter).toHaveAttribute("aria-valuenow", "60");
  });

  it("retains used/max USD and extra usage independently of remaining percentages", () => {
    renderBattery({
      ...quota([
        {
          name: "five_hour",
          utilization: 0,
          resetsAt: null,
          usedValueUsd: 0,
          maxValueUsd: 20,
        },
      ]),
      extraUsage: {
        isEnabled: true,
        usedCredits: 1.25,
        monthlyLimit: 10,
        utilization: 12.5,
        currency: "USD",
      },
    });
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("$0.00 / $20.00")).toBeInTheDocument();
    expect(screen.getByText(/\$1\.25.*\$10\.00/)).toBeInTheDocument();
  });

  it("preserves accessible unknown images and retry behavior across unavailable states", () => {
    const base = quota([
      { name: "five_hour", utilization: 32, resetsAt: null },
    ]);
    const { rerenderQuota, refresh } = renderBattery(base);
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
      rerenderQuota(next, next === undefined);
      const unknown = screen.getAllByRole("img");
      expect(unknown).toHaveLength(2);
      expect(screen.queryByRole("meter")).not.toBeInTheDocument();
      expect(unknown[0]).toHaveAccessibleName(
        `5-Hour: ${en.codexAccounts.quotaUnknown}`,
      );
      expect(unknown[1]).toHaveAccessibleName(
        `7-Day: ${en.codexAccounts.quotaUnknown}`,
      );
      for (const image of unknown) {
        for (const attribute of [
          "aria-valuenow",
          "aria-valuemin",
          "aria-valuemax",
          "aria-valuetext",
        ]) {
          expect(image).not.toHaveAttribute(attribute);
        }
      }
      expect(screen.getAllByText("—")).toHaveLength(2);
      expect(screen.queryByText(/^(0|100)%$/)).not.toBeInTheDocument();
      const button = screen.getByRole("button", {
        name: en.subscription.refresh,
      });
      if (next === undefined) expect(button).toBeDisabled();
      else expect(button).toBeEnabled();
      expect(screen.getByRole("status")).toBeInTheDocument();
    }
    expect(screen.getByText("HTTP 503: unavailable")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps help open through updates and prevents help/refresh clicks reaching the card", () => {
    const { rerenderQuota, refresh, parentClick } = renderBattery(
      quota([{ name: "five_hour", utilization: 35, resetsAt: null }]),
    );
    const help = screen.getByRole("button", {
      name: en.codexAccounts.helpLabel,
    });
    expect(help.parentElement).toHaveTextContent(en.subscription.title);
    fireEvent.click(help);
    const dialog = screen.getByRole("dialog", {
      name: en.codexAccounts.helpLabel,
    });
    expect(i18n.exists("codexAccounts.helpQuotaBattery")).toBe(true);
    expect(dialog).toHaveTextContent(i18n.t("codexAccounts.helpQuotaBattery"));
    rerenderQuota(
      quota([{ name: "five_hour", utilization: 45, resetsAt: null }]),
    );
    expect(
      screen.getByRole("dialog", { name: en.codexAccounts.helpLabel }),
    ).toBe(dialog);
    expect(screen.getByText("55%")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(refresh).toHaveBeenCalledOnce();
    expect(parentClick).not.toHaveBeenCalled();
  });
});
