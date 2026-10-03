import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCodexAccountSwitch } from "@/hooks/useCodexAccountSwitch";

const mocks = vi.hoisted(() => ({
  switchAccount: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  authSwitchCodexAccount: mocks.switchAccount,
}));
vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, warning: mocks.warning },
}));

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["providers", "codex"], {
    currentProviderId: "first",
    providers: {},
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    ...renderHook(useCodexAccountSwitch, { wrapper }),
    client,
    invalidate,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("committed Codex account switches", () => {
  it("leaves current unchanged during a request and on rejection, reports the reason", async () => {
    let reject!: (error: Error) => void;
    mocks.switchAccount.mockImplementation(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const { result, client, invalidate } = setup();
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.switchAccount("second");
    });
    await waitFor(() => expect(mocks.switchAccount).toHaveBeenCalledTimes(1));
    expect(client.getQueryData(["providers", "codex"])).toMatchObject({
      currentProviderId: "first",
    });
    await act(async () => {
      reject(new Error("account needs reauthentication"));
      await expect(request).rejects.toThrow("reauthentication");
    });
    expect(invalidate).not.toHaveBeenCalled();
    expect(client.getQueryData(["providers", "codex"])).toMatchObject({
      currentProviderId: "first",
    });
    expect(mocks.error.mock.calls[0][0]).toContain(
      "account needs reauthentication",
    );
    expect(mocks.success).not.toHaveBeenCalled();
  });

  it("deduplicates clicks before render and refreshes both direct and routed state only after success", async () => {
    let resolve!: (value: unknown) => void;
    mocks.switchAccount.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result, invalidate } = setup();
    let request!: Promise<unknown>;
    act(() => {
      request = result.current.switchAccount("second");
      expect(result.current.switchAccount("third")).toBe(request);
    });
    await waitFor(() => expect(mocks.switchAccount).toHaveBeenCalledTimes(1));
    expect(mocks.switchAccount).toHaveBeenCalledTimes(1);
    expect(mocks.switchAccount).toHaveBeenCalledWith("second");
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => {
      resolve({ accountId: "second", warnings: [] });
      await request;
    });
    for (const key of [
      ["codex-active-selection"],
      ["managed-auth-status", "codex_oauth"],
    ]) {
      expect(invalidate).toHaveBeenCalledWith(
        { queryKey: key },
        { throwOnError: true },
      );
    }
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });

  it("reports a post-commit readback failure as a refresh problem", async () => {
    mocks.switchAccount.mockResolvedValue({
      accountId: "second",
      warnings: [],
    });
    const { result, invalidate } = setup();
    invalidate.mockRejectedValue(new Error("read failed"));
    await act(async () => {
      await result.current.switchAccount("second");
    });
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.warning.mock.calls[0][0]).toContain("账号已切换");
    expect(result.current.isCurrentUncertain).toBe(true);
  });

  it("suppresses a current-account claim when interrupted publication cannot be recovered", async () => {
    mocks.switchAccount.mockRejectedValue(
      new Error("codex_account_switch_uncertain: disk unavailable"),
    );
    const { result } = setup();
    await act(async () => {
      await expect(result.current.switchAccount("second")).rejects.toThrow(
        "disk unavailable",
      );
    });
    expect(result.current.isCurrentUncertain).toBe(true);
    expect(mocks.error.mock.calls[0][0]).toContain("无法确认切换状态");
    expect(mocks.error.mock.calls[0][0]).not.toContain("保留原账号");
  });
  it("resolves uncertainty only after a newer successful native selection fetch, never an optimistic cache update", async () => {
    mocks.switchAccount.mockRejectedValue(
      new Error("codex_account_switch_uncertain: pending publication"),
    );
    const { result, client } = setup();
    await act(async () => {
      await expect(result.current.switchAccount("second")).rejects.toThrow(
        "pending publication",
      );
    });
    expect(result.current.isCurrentUncertain).toBe(true);
    act(() => {
      client.setQueryData(["codex-active-selection"], {
        kind: "provider",
        providerId: "optimistic",
      });
    });
    expect(result.current.isCurrentUncertain).toBe(true);
    await act(async () => {
      await client.fetchQuery({
        queryKey: ["codex-active-selection"],
        queryFn: async () => ({ kind: "provider", providerId: "confirmed" }),
      });
    });
    expect(result.current.isCurrentUncertain).toBe(false);
  });
});
