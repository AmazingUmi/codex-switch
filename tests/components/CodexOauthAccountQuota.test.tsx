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
});
