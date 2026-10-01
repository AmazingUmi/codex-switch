import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
import CodexOauthAccountQuota from "@/components/CodexOauthAccountQuota";
import { subscriptionApi } from "@/lib/api/subscription";
import type { SubscriptionQuota } from "@/types/subscription";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
const now = Date.parse("2026-09-30T12:00:00Z");
const quota = (
  fiveHour: number,
  weekly: number,
  resetHours: number,
): SubscriptionQuota => ({
  tool: "codex",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [
    {
      name: "five_hour",
      utilization: fiveHour,
      resetsAt: new Date(now + resetHours * 3600000).toISOString(),
    },
    {
      name: "weekly_limit",
      utilization: weekly,
      resetsAt: new Date(now + (resetHours + 48) * 3600000).toISOString(),
    },
  ],
  extraUsage: null,
  error: null,
  queriedAt: now,
});

beforeAll(async () => {
  await i18n
    .use(initReactI18next)
    .init({ lng: "en", resources: { en: { translation: en } } });
});
beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(now));
afterEach(() => vi.restoreAllMocks());

function renderAccounts(accountId = "account-a") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const view = (id: string) => (
    <QueryClientProvider client={client}>
      <I18nextProvider i18n={i18n}>
        <section aria-label="First account">
          <CodexOauthAccountQuota accountId={id} />
        </section>
        <section aria-label="Second account">
          <CodexOauthAccountQuota accountId="account-b" />
        </section>
      </I18nextProvider>
    </QueryClientProvider>
  );
  const result = render(view(accountId));
  return {
    ...result,
    switchFirstAccount: (id: string) => result.rerender(view(id)),
  };
}

describe("Codex account quota isolation", () => {
  it("directs expired managed accounts to reauthentication in the app", async () => {
    vi.spyOn(subscriptionApi, "getCodexOauthQuota").mockResolvedValue({
      ...quota(0, 0, 2),
      credentialStatus: "expired",
      success: false,
      tiers: [],
    });
    renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    expect(
      await first.findByText(en.codexAccounts.quotaExpiredHint),
    ).toBeInTheDocument();
    expect(first.queryByText(/codex_oauth/)).not.toBeInTheDocument();
  });

  it("keeps each account's 5h, weekly and reset values independent when refreshing", async () => {
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockImplementation(async (id) =>
        id === "account-a" ? quota(12, 34, 2) : quota(56, 78, 4),
      );
    renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    const second = within(
      screen.getByRole("region", { name: "Second account" }),
    );
    expect(await first.findByText("12%")).toBeInTheDocument();
    expect(await second.findByText("56%")).toBeInTheDocument();
    expect(first.getByText("34%")).toBeInTheDocument();
    expect(second.getByText("78%")).toBeInTheDocument();
    expect(first.getByText(/2h0m/)).toBeInTheDocument();
    expect(first.getByText(/2d2h/)).toBeInTheDocument();
    expect(second.getByText(/4h0m/)).toBeInTheDocument();
    expect(second.getByText(/2d4h/)).toBeInTheDocument();
    getQuota.mockResolvedValueOnce(quota(13, 35, 1));
    fireEvent.click(
      first.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(await first.findByText("13%")).toBeInTheDocument();
    expect(second.getByText("56%")).toBeInTheDocument();
    expect(getQuota.mock.calls.map(([id]) => id)).toEqual([
      "account-a",
      "account-b",
      "account-a",
    ]);
  });

  it("does not display a previous account's quota while another account is loading", async () => {
    let resolveNewAccount!: (value: SubscriptionQuota) => void;
    vi.spyOn(subscriptionApi, "getCodexOauthQuota").mockImplementation((id) =>
      id === "account-c"
        ? new Promise((resolve) => {
            resolveNewAccount = resolve;
          })
        : Promise.resolve(
            id === "account-a" ? quota(12, 34, 2) : quota(56, 78, 4),
          ),
    );
    const { switchFirstAccount } = renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    await first.findByText("12%");
    switchFirstAccount("account-c");
    expect(first.queryByText("12%")).not.toBeInTheDocument();
    expect(first.queryByText("34%")).not.toBeInTheDocument();
    await waitFor(() => expect(resolveNewAccount).toBeTypeOf("function"));
    resolveNewAccount(quota(90, 91, 3));
    expect(await first.findByText("90%")).toBeInTheDocument();
    expect(
      within(screen.getByRole("region", { name: "Second account" })).getByText(
        "56%",
      ),
    ).toBeInTheDocument();
  });

  it("refreshes one account independently and labels a temporary failure as stale", async () => {
    let finishRefresh!: (value: SubscriptionQuota) => void;
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockImplementation(async (id) =>
        id === "account-a" ? quota(12, 34, 2) : quota(56, 78, 4),
      );
    renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    const second = within(
      screen.getByRole("region", { name: "Second account" }),
    );
    await first.findByText("12%");
    await second.findByText("56%");
    getQuota.mockImplementationOnce(
      () => new Promise((resolve) => (finishRefresh = resolve)),
    );
    const firstRefresh = first.getByRole("button", {
      name: en.subscription.refresh,
    });
    fireEvent.click(firstRefresh);
    await waitFor(() => expect(firstRefresh).toBeDisabled());
    expect(
      second.getByRole("button", { name: en.subscription.refresh }),
    ).toBeEnabled();
    finishRefresh({
      ...quota(0, 0, 0),
      success: false,
      tiers: [],
      error: "API error (HTTP 503): unavailable",
    });
    expect(await first.findByRole("status")).toHaveTextContent(
      i18n.t("codexAccounts.quotaRefreshFailed", "刷新失败，显示上次成功数据"),
    );
    expect(first.getByText("12%")).toBeInTheDocument();
    expect(first.queryByText("0%")).not.toBeInTheDocument();
    expect(second.queryByRole("status")).not.toBeInTheDocument();
    expect(second.getByText("56%")).toBeInTheDocument();
    fireEvent.click(firstRefresh);
    await waitFor(() =>
      expect(first.queryByRole("status")).not.toBeInTheDocument(),
    );
  });

  it("does not retain an expired account's successful quota even with network error text", async () => {
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue(quota(12, 34, 2));
    renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    await first.findByText("12%");
    getQuota.mockResolvedValueOnce({
      ...quota(0, 0, 0),
      credentialStatus: "expired",
      success: false,
      tiers: [],
      error: "Codex OAuth token unavailable: Network error",
    });
    fireEvent.click(
      first.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(
      await first.findByText(en.codexAccounts.quotaExpiredHint),
    ).toBeInTheDocument();
    expect(first.queryByText("12%")).not.toBeInTheDocument();
    expect(first.queryByText("0%")).not.toBeInTheDocument();
  });

  it("renders first-query failure with a retry action and no invented usage", async () => {
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue({
        ...quota(0, 0, 0),
        success: false,
        tiers: [],
        error: "API error (HTTP 401): rejected",
      });
    renderAccounts();
    const first = within(screen.getByRole("region", { name: "First account" }));
    expect(
      await first.findByText("API error (HTTP 401): rejected"),
    ).toBeInTheDocument();
    expect(first.queryByText("0%")).not.toBeInTheDocument();
    getQuota.mockResolvedValueOnce(quota(15, 35, 2));
    fireEvent.click(
      first.getByRole("button", { name: en.subscription.refresh }),
    );
    expect(await first.findByText("15%")).toBeInTheDocument();
  });
});
