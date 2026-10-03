import type { PropsWithChildren } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useCodexOauthQuotaByAccountId } from "@/lib/query/subscription";
import { subscriptionApi } from "@/lib/api/subscription";
import type { SubscriptionQuota } from "@/types/subscription";
import type { ManagedAuthStatus } from "@/lib/api/auth";
import { settingsApi } from "@/lib/api";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { emitTauriEvent } from "../msw/tauriMocks";

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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("managed Codex quota cache identity", () => {
  it("applies a native refresh and failure to the same account without a second request", async () => {
    const { client, wrapper } = setup();
    client.setQueryData<ManagedAuthStatus>(
      ["managed-auth-status", "codex_oauth"],
      {
        provider: "codex_oauth",
        authenticated: true,
        default_account_id: "account-a",
        accounts: ["account-a", "account-b"].map((id) => ({
          id,
          provider: "codex_oauth",
          login: `${id}@example.com`,
          avatar_url: null,
          authenticated_at: 1,
          is_default: id === "account-a",
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        })),
      },
    );
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue(successfulQuota(12));
    const { result } = renderHook(
      () => {
        useUsageCacheBridge();
        return useCodexOauthQuotaByAccountId("account-a");
      },
      { wrapper },
    );
    await waitFor(() => expect(result.current.data?.success).toBe(true));
    client.setQueryData(
      ["codex_oauth", "quota", "account-b"],
      successfulQuota(70),
    );
    const good = successfulQuota(24);
    const shared = {
      ...good,
      refreshState: {
        status: "stale" as const,
        refreshFailed: true,
        error: "Network error: offline",
        freshUntil: Date.now() + 120_000,
        validUntil: Date.now() + 600_000,
        generation: 2,
        attemptedAt: Date.now(),
      },
    };
    act(() =>
      emitTauriEvent("usage-cache-updated", {
        kind: "codexOauth",
        accountId: "account-a",
        data: shared,
      }),
    );
    await waitFor(() => expect(result.current.refreshFailed).toBe(true));
    expect(result.current.data?.tiers[0].utilization).toBe(24);
    expect(result.current.data?.queriedAt).toBe(good.queriedAt);
    expect(result.current.refreshError).toBe("Network error: offline");
    expect(getQuota).toHaveBeenCalledOnce();
    expect(
      client.getQueryData(["codex_oauth", "quota", "account-b"]),
    ).toMatchObject({ tiers: [{ utilization: 70 }] });
    act(() =>
      emitTauriEvent("usage-cache-updated", {
        kind: "codexOauth",
        accountId: "account-a",
        data: {
          ...successfulQuota(99),
          refreshState: { ...shared.refreshState, generation: 1 },
        },
      }),
    );
    expect(client.getQueryData(["codex_oauth", "quota", "account-a"])).toEqual(
      shared,
    );
    const success = {
      ...successfulQuota(30),
      refreshState: {
        ...shared.refreshState,
        status: "ready",
        refreshFailed: false,
        error: null,
        attemptedAt: (shared.refreshState.attemptedAt ?? 0) + 1,
      },
    };
    act(() =>
      emitTauriEvent("usage-cache-updated", {
        kind: "codexOauth",
        accountId: "account-a",
        data: success,
      }),
    );
    await waitFor(() => expect(result.current.refreshFailed).toBe(false));
    expect(result.current.data?.tiers[0].utilization).toBe(30);
  });

  it("uses the configured interval, stops polling when disabled, and forces a manual refresh", async () => {
    const { client, wrapper } = setup();
    const settings = {
      showInTray: true,
      minimizeToTrayOnClose: true,
      quotaRefreshIntervalSeconds: 30,
    };
    vi.spyOn(settingsApi, "get").mockResolvedValue(settings);
    client.setQueryData(["settings"], settings);
    vi.useFakeTimers();
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue(successfulQuota(12));
    const { result } = renderHook(
      () => useCodexOauthQuotaByAccountId("account-a"),
      { wrapper },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current.data?.success).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getQuota).toHaveBeenLastCalledWith("account-a", false);
    expect(getQuota.mock.calls.length).toBeGreaterThan(1);
    await act(async () => {
      client.setQueryData(["settings"], {
        ...settings,
        quotaRefreshIntervalSeconds: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
    });
    const calls = getQuota.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getQuota).toHaveBeenCalledTimes(calls);
    await act(async () => {
      await result.current.refetch();
    });
    expect(getQuota).toHaveBeenLastCalledWith("account-a", true);
  });

  it("does not revive an expired shared snapshot after remounting or receiving cached values", async () => {
    const { client, wrapper } = setup();
    const quota = {
      ...successfulQuota(12),
      refreshState: {
        status: "stale" as const,
        refreshFailed: true,
        error: "offline",
        freshUntil: Date.now() - 1000,
        validUntil: Date.now() - 1,
        generation: 0,
        attemptedAt: Date.now(),
      },
    };
    client.setQueryData(["codex_oauth", "quota", "account-a"], quota);
    const getQuota = vi
      .spyOn(subscriptionApi, "getCodexOauthQuota")
      .mockResolvedValue(quota);
    const { result } = renderHook(
      () => useCodexOauthQuotaByAccountId("account-a"),
      { wrapper },
    );
    expect(result.current.data?.success).toBe(false);
    expect(result.current.data?.tiers).toEqual([]);
    expect(getQuota).not.toHaveBeenCalled();
  });

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
    await waitFor(() =>
      expect(getQuota).toHaveBeenCalledWith("account-b", false),
    );
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
