import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  useCodexActiveSelectionQuery,
  useProvidersQuery,
} from "@/lib/query/queries";
import { useCodexAccountSwitch } from "@/hooks/useCodexAccountSwitch";

const api = vi.hoisted(() => ({
  getSelection: vi.fn(),
  switchAccount: vi.fn(),
}));
vi.mock("@/lib/api/auth", () => ({
  getCodexActiveSelection: api.getSelection,
  authSwitchCodexAccount: api.switchAccount,
}));
vi.mock("@/lib/api", () => ({
  providersApi: {
    getAll: vi.fn().mockRejectedValue(new Error("API list unavailable")),
    getCurrent: vi.fn().mockResolvedValue(""),
  },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe("independent subscription account selection", () => {
  it("keeps account activation available when API provider loading fails", async () => {
    api.getSelection.mockResolvedValue({ kind: "account", accountId: "first" });
    api.switchAccount.mockImplementation(async (accountId: string) => {
      api.getSelection.mockResolvedValue({ kind: "account", accountId });
      return { accountId, warnings: [] };
    });
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => ({
        providers: useProvidersQuery("codex"),
        selection: useCodexActiveSelectionQuery(),
        switching: useCodexAccountSwitch(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.providers.isError).toBe(true));
    expect(result.current.selection.data).toEqual({
      kind: "account",
      accountId: "first",
    });
    await act(async () => {
      await result.current.switching.switchAccount("second");
    });
    expect(api.switchAccount).toHaveBeenCalledWith("second");
    await waitFor(() =>
      expect(result.current.selection.data).toEqual({
        kind: "account",
        accountId: "second",
      }),
    );
    expect(result.current.switching.isCurrentUncertain).toBe(false);
  });
});
