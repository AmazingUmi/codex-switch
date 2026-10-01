import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCodexOauthQuotaByAccountId } from "@/lib/query/subscription";
import { subscriptionApi } from "@/lib/api/subscription";
import type { SubscriptionQuota } from "@/types/subscription";

const successfulQuota = (utilization: number): SubscriptionQuota => ({
  tool: "codex_oauth",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [{ name: "five_hour", utilization, resetsAt: null }],
  extraUsage: null,
  error: null,
  queriedAt: Date.now(),
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 60_000 } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => vi.restoreAllMocks());

describe("managed Codex quota cache identity", () => {
  it("resolves default bindings into account IDs and ignores the legacy default cache", async () => {
    const { client, wrapper } = setup();
    const statusKey = ["managed-auth-status", "codex_oauth"];
    const status = {
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "account-a",
      accounts: [],
    };
    client.setQueryData(statusKey, status);
    client.setQueryData(
      ["codex_oauth", "quota", "default"],
      successfulQuota(99),
    );
    let finishSecond!: (quota: SubscriptionQuota) => void;
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockImplementation((id) =>
        id === "account-b"
          ? new Promise((resolve) => (finishSecond = resolve))
          : Promise.resolve(successfulQuota(12)),
      );
    const { result } = renderHook(() => useCodexOauthQuotaByAccountId(null), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.data?.tiers[0]?.utilization).toBe(12),
    );
    act(() =>
      client.setQueryData(statusKey, {
        ...status,
        default_account_id: "account-b",
      }),
    );
    await waitFor(() => expect(getQuota).toHaveBeenCalledWith("account-b"));
    expect(result.current.data).toBeUndefined();
    act(() =>
      finishSecond({
        ...successfulQuota(0),
        success: false,
        tiers: [],
        error: "API error (HTTP 503)",
      }),
    );
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    expect(result.current.refreshFailed).toBe(false);
    expect(getQuota.mock.calls.map(([id]) => id)).toEqual([
      "account-a",
      "account-b",
    ]);
    expect(
      client.getQueryData(["codex_oauth", "quota", "account-a"]),
    ).toMatchObject({ tiers: [{ utilization: 12 }] });
  });

  it("stops presenting stale quota once its successful snapshot exceeds the retention window", async () => {
    const { client, wrapper } = setup();
    const started = Date.now();
    client.setQueryData(
      ["codex_oauth", "quota", "account-a"],
      successfulQuota(12),
      { updatedAt: started },
    );
    vi.spyOn(Date, "now").mockReturnValue(started + 11 * 60_000);
    vi.spyOn(subscriptionApi, "getCodexOauthQuota").mockResolvedValue({
      ...successfulQuota(0),
      success: false,
      tiers: [],
      error: "API error (HTTP 503)",
    });
    const { result } = renderHook(
      () => useCodexOauthQuotaByAccountId("account-a"),
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.success).toBe(false));
    expect(result.current.data?.tiers).toEqual([]);
    expect(result.current.refreshFailed).toBe(false);
  });
});
