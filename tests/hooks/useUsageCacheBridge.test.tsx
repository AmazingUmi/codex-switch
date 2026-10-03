import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { useUsageCacheBridge } from "@/hooks/useUsageCacheBridge";
import { usageKeys } from "@/lib/query/usage";
import type { SubscriptionQuota } from "@/types/subscription";

const listener = vi.hoisted(() => ({
  callback: null as null | ((event: any) => void),
}));
vi.mock("@/hooks/useTauriEvent", () => ({
  useTauriEvent: (_name: string, callback: (event: any) => void) => {
    listener.callback = callback;
  },
}));

const quota: SubscriptionQuota = {
  tool: "codex_oauth",
  credentialStatus: "valid",
  credentialMessage: null,
  success: true,
  tiers: [],
  extraUsage: null,
  error: null,
  queriedAt: 1,
};

function setup() {
  const client = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(useUsageCacheBridge, { wrapper });
  return client;
}

describe("usage cache event ownership", () => {
  it("ignores late account snapshots after removal even when quota cache is empty", () => {
    const client = setup();
    client.setQueryData(["managed-auth-status", "codex_oauth"], {
      accounts: [{ id: "kept" }],
    });
    act(() =>
      listener.callback!({
        kind: "codexOauth",
        accountId: "removed",
        data: quota,
      }),
    );
    expect(
      client.getQueryData(["codex_oauth", "quota", "removed"]),
    ).toBeUndefined();
    act(() =>
      listener.callback!({
        kind: "codexOauth",
        accountId: "kept",
        data: quota,
      }),
    );
    expect(client.getQueryData(["codex_oauth", "quota", "kept"])).toEqual(
      quota,
    );
  });

  it("ignores script events for a deleted API provider and Codex native subscription snapshots", () => {
    const client = setup();
    client.setQueryData(["providers", "codex"], {
      providers: { kept: { id: "kept" } },
    });
    act(() =>
      listener.callback!({
        kind: "script",
        appType: "codex",
        providerId: "removed",
        data: { success: true },
      }),
    );
    expect(
      client.getQueryData(usageKeys.script("removed", "codex")),
    ).toBeUndefined();
    act(() =>
      listener.callback!({
        kind: "subscription",
        appType: "codex",
        data: quota,
      }),
    );
    expect(
      client.getQueryData(["subscription", "quota", "codex"]),
    ).toBeUndefined();
  });
});
