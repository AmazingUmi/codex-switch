import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountsPanel } from "@/components/codex/CodexAccountsPanel";
import { subscriptionApi } from "@/lib/api/subscription";
import en from "@/i18n/locales/en.json";
import type { SubscriptionQuota } from "@/types/subscription";
import type { Settings } from "@/types";

const i18n = createInstance();
const getQuota = vi.spyOn(subscriptionApi, "getCodexOauthQuota");
const accounts = ["first", "second"].map((id) => ({
  id,
  provider: "codex_oauth",
  login: `${id}@example.test`,
  avatar_url: null,
  authenticated_at: 0,
  is_default: id === "first",
  github_domain: "",
  reauth_required: false,
  requires_reauth: false,
}));

vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: () => ({
    accounts,
    defaultAccountId: "first",
    isStatusSuccess: true,
    isStatusError: false,
    hasAnyAccount: true,
    pollingState: "idle",
    isPolling: false,
    isAddingAccount: false,
    isRemovingAccount: false,
    isSettingDefaultAccount: false,
    error: null,
  }),
}));

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});
beforeEach(() => getQuota.mockReset());

function quota(used: number, queriedAt = Date.now()): SubscriptionQuota {
  return {
    tool: "codex_oauth",
    credentialStatus: "valid",
    credentialMessage: null,
    success: true,
    tiers: [
      { name: "five_hour", utilization: used, resetsAt: null },
      { name: "seven_day", utilization: 50, resetsAt: null },
    ],
    extraUsage: null,
    error: null,
    queriedAt,
  };
}

function setup(settings: Partial<Settings> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  client.setQueryDefaults(["settings"], { staleTime: Infinity });
  client.setQueryData(["settings"], {
    showInTray: true,
    minimizeToTrayOnClose: true,
    quotaBatteryWarningThresholdPercent: 50,
    quotaBatteryLowThresholdPercent: 10,
    ...settings,
  });
  const first = quota(20, Date.now() - 120000);
  client.setQueryData(["codex_oauth", "quota", "first"], first);
  client.setQueryData(["codex_oauth", "quota", "second"], {
    ...quota(70),
    tiers: [{ name: "seven_day", utilization: 70, resetsAt: null }],
  });
  const onSwitchAccount = vi.fn();
  const result = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <CodexAccountsPanel
          currentAccountId={null}
          onSwitchAccount={onSwitchAccount}
        />
      </QueryClientProvider>
    </I18nextProvider>,
  );
  const card = (id: string) =>
    result.container.querySelector(`[data-account-id="${id}"]`) as HTMLElement;
  return { ...result, client, first, card, onSwitchAccount };
}

describe("Account quota header controls", () => {
  it("reacts to saved threshold changes without querying or changing quota", async () => {
    const { client, card } = setup();
    const battery = within(card("first")).getByRole("meter", {
      name: "5-Hour",
    });
    expect(battery.closest("[data-quota-tone]")).toHaveAttribute(
      "data-quota-tone",
      "available",
    );
    expect(getQuota).not.toHaveBeenCalled();
    act(() =>
      client.setQueryData<Settings>(["settings"], (saved) => ({
        ...saved!,
        quotaBatteryWarningThresholdPercent: 90,
        quotaBatteryLowThresholdPercent: 10,
      })),
    );
    await waitFor(() =>
      expect(battery.closest("[data-quota-tone]")).toHaveAttribute(
        "data-quota-tone",
        "warning",
      ),
    );
    expect(battery).toHaveAttribute("aria-valuenow", "80");
    expect(within(card("first")).getByRole("meter", { name: "5-Hour" })).toBe(
      battery,
    );
    expect(getQuota).not.toHaveBeenCalled();
  });
  it("refreshes the owning account with one observer and keeps update time in the quota title row", async () => {
    let resolve!: (value: SubscriptionQuota) => void;
    getQuota.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { client, first, card } = setup();
    const firstCard = within(card("first"));
    const refresh = firstCard.getByRole("button", {
      name: en.subscription.refresh,
    });
    const edit = firstCard.getByRole("button", { name: /Edit account:/ });
    const switchAccount = firstCard.getByRole("button", {
      name: en.codexAccounts.switch,
    });
    expect(firstCard.getByRole("meter", { name: "5-Hour" })).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    expect(firstCard.getAllByRole("meter")).toHaveLength(2);
    const secondCard = within(card("second"));
    expect(secondCard.getAllByRole("meter")).toHaveLength(1);
    expect(secondCard.getByRole("meter", { name: "7-Day" })).toHaveAttribute(
      "aria-valuenow",
      "30",
    );
    expect(secondCard.queryByRole("meter", { name: "5-Hour" })).toBeNull();
    expect(refresh.nextElementSibling).toBe(edit);
    expect(edit.nextElementSibling).toBe(switchAccount);
    expect(refresh.parentElement).toBe(edit.parentElement);
    expect(switchAccount.parentElement).toBe(refresh.parentElement);
    expect(refresh.parentElement?.parentElement).toContainElement(
      firstCard.getByText("first@example.test"),
    );
    expect(refresh).toHaveClass("glass-button", "h-7", "w-7", "rounded-full");
    expect(refresh.querySelector("svg")).toHaveClass("h-3.5", "w-3.5");
    expect(
      firstCard.getAllByRole("button", { name: en.subscription.refresh }),
    ).toHaveLength(1);
    const timestamp = firstCard.getByTitle(
      new Date(first.queriedAt!).toLocaleString(),
    );
    expect(timestamp.parentElement?.parentElement).toHaveTextContent(
      en.subscription.title,
    );
    expect(timestamp).toHaveClass("text-[10px]", "text-muted-foreground");
    expect(
      client
        .getQueryCache()
        .find({ queryKey: ["codex_oauth", "quota", "first"] })
        ?.getObserversCount(),
    ).toBe(1);
    expect(getQuota).not.toHaveBeenCalled();

    await userEvent.setup().click(refresh);
    expect(refresh).toBeDisabled();
    expect(refresh).toHaveAttribute("aria-busy", "true");
    expect(getQuota).toHaveBeenCalledTimes(1);
    expect(getQuota).toHaveBeenCalledWith("first", true);
    expect(within(card("second")).getByText("30%")).toBeInTheDocument();
    await act(async () => resolve(quota(36)));
    expect(await firstCard.findByText("64%")).toBeInTheDocument();
    expect(refresh).toBeEnabled();
    expect(firstCard.queryByText("80%")).not.toBeInTheDocument();
    expect(within(card("second")).getByText("30%")).toBeInTheDocument();
  });

  it("retains the last success time through a transient refresh failure and exposes expired credentials", async () => {
    const { first, card, onSwitchAccount } = setup();
    const firstCard = within(card("first"));
    const refresh = firstCard.getByRole("button", {
      name: en.subscription.refresh,
    });
    getQuota.mockResolvedValueOnce({
      ...quota(0),
      success: false,
      error: "API error (HTTP 503)",
      tiers: [],
    });
    await userEvent.setup().click(refresh);
    expect(
      await firstCard.findByText(en.codexAccounts.quotaRefreshFailed),
    ).toHaveAttribute("title", "API error (HTTP 503)");
    expect(firstCard.getByText("80%")).toBeInTheDocument();
    expect(
      firstCard.getByTitle(new Date(first.queriedAt!).toLocaleString()),
    ).toBeInTheDocument();
    expect(refresh).toBeEnabled();

    getQuota.mockResolvedValueOnce({
      ...quota(0),
      credentialStatus: "expired",
      success: false,
      tiers: [],
    });
    await userEvent.setup().click(refresh);
    expect(
      await firstCard.findByText(en.subscription.expired),
    ).toBeInTheDocument();
    expect(firstCard.queryByText("80%")).not.toBeInTheDocument();
    expect(
      firstCard.getByRole("button", { name: en.codexAccounts.switch }),
    ).toBeDisabled();
    expect(
      firstCard.getByRole("button", { name: /Edit account:/ }),
    ).toBeEnabled();
    expect(onSwitchAccount).not.toHaveBeenCalled();
    expect(
      within(card("second")).getByRole("button", {
        name: en.codexAccounts.switch,
      }),
    ).toBeEnabled();
  });
});
