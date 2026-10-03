import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDeleteProviderMutation } from "@/lib/query/mutations";

const mocks = vi.hoisted(() => ({
  delete: vi.fn(),
  updateTrayMenu: vi.fn(),
  getAll: vi.fn(),
  getCodexActiveSelection: vi.fn(),
}));
vi.mock("@/lib/api/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/auth")>()),
  getCodexActiveSelection: mocks.getCodexActiveSelection,
}));
vi.mock("@/lib/api", () => ({ providersApi: mocks, settingsApi: {} }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(["providers", "codex"], {
    providers: { current: { id: "current" }, other: { id: "other" } },
    currentProviderId: "current",
    activeSelection: { kind: "provider", providerId: "current" },
  });
  client.setQueryData(["codex-active-selection"], {
    kind: "provider",
    providerId: "current",
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(() => useDeleteProviderMutation("codex"), { wrapper }),
  };
}

beforeEach(() => {
  mocks.delete.mockReset().mockResolvedValue(true);
  mocks.updateTrayMenu.mockReset().mockResolvedValue(true);
  mocks.getAll.mockReset().mockResolvedValue({
    current: {
      id: "current",
      name: "Current API",
      settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
    },
    other: {
      id: "other",
      name: "Other API",
      settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
    },
  });
  mocks.getCodexActiveSelection
    .mockReset()
    .mockResolvedValue({ kind: "provider", providerId: "current" });
});

describe("API provider removal", () => {
  it("removes the current provider and cancels late balance without selecting another provider", async () => {
    const { client, result } = setup();
    const key = ["api-balance", "current", 1];
    client.setQueryData(key, { success: true, remaining: 40 });
    client.setQueryData(["api-balance", "other", 2], {
      success: true,
      remaining: 80,
    });
    let finish!: (value: unknown) => void;
    const pending = client
      .fetchQuery({
        queryKey: key,
        queryFn: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      })
      .catch(() => {});
    await act(async () => {
      await result.current.mutateAsync("current");
    });
    await act(async () => {
      finish({ success: true, remaining: 100 });
      await pending;
    });
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(["codex-active-selection"])).toBeNull();
    expect(client.getQueryData(["providers", "codex"])).toEqual({
      providers: { other: { id: "other" } },
      currentProviderId: "",
      activeSelection: null,
    });
    expect(client.getQueryData(["api-balance", "other", 2])).toEqual({
      success: true,
      remaining: 80,
    });
  });

  it("retains saved provider, current selection and balance when native deletion fails", async () => {
    const { client, result } = setup();
    client.setQueryData(["api-balance", "current", 1], {
      success: true,
      remaining: 40,
    });
    mocks.delete.mockRejectedValue(new Error("disk is unavailable"));
    await act(async () => {
      await expect(result.current.mutateAsync("current")).rejects.toThrow(
        "disk is unavailable",
      );
    });
    expect(client.getQueryData(["providers", "codex"])).toMatchObject({
      currentProviderId: "current",
      activeSelection: { kind: "provider", providerId: "current" },
    });
    expect(client.getQueryData(["api-balance", "current", 1])).toEqual({
      success: true,
      remaining: 40,
    });
  });
  it("reconciles a delete error after native DB publication and preserves native selection uncertainty", async () => {
    const { client, result } = setup();
    const key = ["api-balance", "current", 1];
    client.setQueryData(key, { success: true, remaining: 40 });
    mocks.getAll.mockResolvedValue({
      other: {
        id: "other",
        name: "Other API",
        settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
      },
    });
    mocks.getCodexActiveSelection.mockRejectedValue(
      new Error("codex_account_switch_uncertain: state publication blocked"),
    );
    mocks.delete.mockRejectedValue(
      new Error("DB deletion committed, state publication blocked"),
    );
    await act(async () => {
      await expect(result.current.mutateAsync("current")).rejects.toThrow(
        "state publication blocked",
      );
    });
    expect(client.getQueryData(key)).toBeUndefined();
    expect(client.getQueryData(["providers", "codex"])).toMatchObject({
      currentProviderId: "",
      providers: { other: { id: "other" } },
    });
    expect(
      (client.getQueryData(["providers", "codex"]) as any).providers.current,
    ).toBeUndefined();
    expect(client.getQueryState(["codex-active-selection"])?.status).toBe(
      "error",
    );
  });
});
