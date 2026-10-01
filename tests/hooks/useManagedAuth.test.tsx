import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useManagedAuth } from "@/components/providers/forms/hooks/useManagedAuth";
import { CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR } from "@/lib/api/auth";

const apiMocks = vi.hoisted(() => ({
  authGetStatus: vi.fn(),
  authStartLogin: vi.fn(),
  authPollForAccount: vi.fn(),
  authCancelLogin: vi.fn(),
  authRemoveAccount: vi.fn(),
  authUpdateAccount: vi.fn(),
}));
const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  authApi: {
    authGetStatus: (...args: unknown[]) => apiMocks.authGetStatus(...args),
    authStartLogin: (...args: unknown[]) => apiMocks.authStartLogin(...args),
    authPollForAccount: (...args: unknown[]) =>
      apiMocks.authPollForAccount(...args),
    authCancelLogin: (...args: unknown[]) => apiMocks.authCancelLogin(...args),
    authRemoveAccount: (...args: unknown[]) =>
      apiMocks.authRemoveAccount(...args),
    authUpdateAccount: (...args: unknown[]) =>
      apiMocks.authUpdateAccount(...args),
  },
  settingsApi: {
    openExternal: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/lib/clipboard", () => ({
  copyText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: {
    success: toastMocks.success,
  },
}));

function createWrapper(
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  }),
) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe("useManagedAuth", () => {
  beforeEach(() => {
    apiMocks.authGetStatus.mockReset().mockResolvedValue({
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "acct-1",
      accounts: [
        {
          id: "acct-1",
          provider: "codex_oauth",
          login: "user@example.com",
          avatar_url: null,
          authenticated_at: 1,
          is_default: true,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
      ],
    });
    apiMocks.authStartLogin
      .mockReset()
      .mockImplementation(() => new Promise(() => {}));
    apiMocks.authPollForAccount.mockReset().mockResolvedValue(null);
    apiMocks.authCancelLogin.mockReset().mockResolvedValue(true);
    apiMocks.authRemoveAccount.mockReset().mockResolvedValue(undefined);
    apiMocks.authUpdateAccount.mockReset();
  });

  it("updates shared account data only after metadata is persisted and preserves authentication state", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const quotaKey = ["codex_oauth", "quota", "acct-1"];
    const quota = {
      credentialStatus: "valid",
      success: true,
      tiers: [{ utilization: 12 }],
    };
    queryClient.setQueryData(quotaKey, quota);
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(queryClient),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));
    const original = result.current.accounts[0];
    const appearance = {
      display_name: "Work",
      notes: "Team projects",
      icon: "star",
      color: "#cc8844",
    };
    const updated = { ...original, ...appearance };
    let finishSave!: (account: typeof updated) => void;
    apiMocks.authUpdateAccount.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    let save!: Promise<unknown>;
    act(() => {
      save = result.current.updateAccount(original.id, appearance);
    });
    await waitFor(() => expect(result.current.isUpdatingAccount).toBe(true));
    expect(result.current.accounts[0]).toEqual(original);
    apiMocks.authGetStatus.mockResolvedValue({
      ...result.current.authStatus,
      accounts: [updated],
    });
    await act(async () => {
      finishSave(updated);
      await save;
    });
    expect(apiMocks.authUpdateAccount).toHaveBeenCalledWith(
      "codex_oauth",
      original.id,
      appearance,
    );
    await waitFor(() => expect(result.current.accounts[0]).toEqual(updated));
    expect(result.current.defaultAccountId).toBe("acct-1");
    expect(result.current.isAuthenticated).toBe(true);
    expect(apiMocks.authStartLogin).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(quotaKey)).toEqual(quota);
    expect(queryClient.getQueryState(quotaKey)?.isInvalidated).toBe(false);
  });

  it("rejects failed edits without modifying the cached account or authentication", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));
    const original = result.current.accounts[0];
    apiMocks.authUpdateAccount.mockRejectedValue(
      new Error("Store unavailable"),
    );
    await act(async () => {
      await expect(
        result.current.updateAccount(original.id, {
          display_name: "Draft",
          notes: null,
          icon: null,
          color: null,
        }),
      ).rejects.toThrow("Store unavailable");
    });
    expect(result.current.accounts[0]).toEqual(original);
    expect(result.current.defaultAccountId).toBe("acct-1");
  });

  it.each(["add", "reauth"] as const)(
    "refreshes only the returned account quota after successful %s login",
    async (mode) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const targetId = mode === "add" ? "acct-new" : "acct-1";
      const targetKey = ["codex_oauth", "quota", targetId];
      const otherKey = ["codex_oauth", "quota", "acct-other"];
      const oldQuota = { credentialStatus: "expired", success: false };
      const freshQuota = { credentialStatus: "valid", success: true };
      queryClient.setQueryData(targetKey, oldQuota);
      queryClient.setQueryData(otherKey, freshQuota);
      const refreshTarget = vi.fn().mockResolvedValue(freshQuota);
      const refreshOther = vi.fn().mockResolvedValue(freshQuota);
      const { result } = renderHook(
        () => {
          const auth = useManagedAuth("codex_oauth");
          useQuery({
            queryKey: targetKey,
            queryFn: refreshTarget,
            staleTime: Infinity,
          });
          useQuery({
            queryKey: otherKey,
            queryFn: refreshOther,
            staleTime: Infinity,
          });
          return auth;
        },
        { wrapper: createWrapper(queryClient) },
      );
      await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));
      expect(refreshTarget).not.toHaveBeenCalled();
      apiMocks.authStartLogin.mockResolvedValue({
        provider: "codex_oauth",
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://example.com/device",
        expires_in: 600,
        interval: 5,
      });
      apiMocks.authPollForAccount.mockResolvedValue({ id: targetId });
      act(() =>
        mode === "add"
          ? result.current.addAccount()
          : result.current.reauthAccount(targetId),
      );
      await waitFor(() => expect(refreshTarget).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.pollingState).toBe("idle"));
      expect(queryClient.getQueryData(targetKey)).toEqual(freshQuota);
      expect(refreshOther).not.toHaveBeenCalled();
      expect(result.current.error).toBeNull();
      expect(result.current.deviceCode).toBeNull();
    },
  );

  it.each(["expired", "not_found", "valid"] as const)(
    "handles cached %s credentials after successful reauthentication when quota refresh fails",
    async (credentialStatus) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const quotaKey = ["codex_oauth", "quota", "acct-1"];
      const cachedQuota = {
        credentialStatus,
        success: credentialStatus === "valid",
      };
      queryClient.setQueryData(quotaKey, cachedQuota);
      const otherKey = ["codex_oauth", "quota", "acct-other"];
      queryClient.setQueryData(otherKey, {
        credentialStatus: "expired",
        success: false,
      });
      const refreshQuota = vi
        .fn()
        .mockRejectedValue(new Error("Quota network unavailable"));
      const { result } = renderHook(
        () => {
          const auth = useManagedAuth("codex_oauth");
          const quota = useQuery({
            queryKey: quotaKey,
            queryFn: refreshQuota,
            staleTime: Infinity,
          });
          return { auth, quota };
        },
        { wrapper: createWrapper(queryClient) },
      );
      await waitFor(() =>
        expect(result.current.auth.isStatusSuccess).toBe(true),
      );
      apiMocks.authStartLogin.mockResolvedValue({
        provider: "codex_oauth",
        device_code: "device-1",
        user_code: "ABCD-EFGH",
        verification_uri: "https://example.com/device",
        expires_in: 600,
        interval: 5,
      });
      apiMocks.authPollForAccount.mockResolvedValue({ id: "acct-1" });
      act(() => result.current.auth.reauthAccount("acct-1"));
      await waitFor(() => expect(refreshQuota).toHaveBeenCalledTimes(1));
      await waitFor(() => expect(result.current.quota.isError).toBe(true));
      await waitFor(() =>
        expect(result.current.auth.pollingState).toBe("idle"),
      );
      expect(result.current.auth.error).toBeNull();
      expect(result.current.auth.deviceCode).toBeNull();
      expect(result.current.auth.isAuthenticated).toBe(true);
      expect(result.current.auth.accounts[0].id).toBe("acct-1");
      if (credentialStatus === "valid") {
        expect(queryClient.getQueryData(quotaKey)).toEqual(cachedQuota);
        expect(result.current.quota.data).toEqual(cachedQuota);
      } else {
        expect(queryClient.getQueryData(quotaKey)).toBeUndefined();
        expect(result.current.quota.data).toBeUndefined();
      }
      expect(queryClient.getQueryData(otherKey)).toEqual({
        credentialStatus: "expired",
        success: false,
      });
      expect(queryClient.getQueryState(otherKey)?.isInvalidated).toBe(false);
    },
  );

  it("starts reauthentication for the selected account", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledWith(
        "codex_oauth",
        undefined,
        "acct-1",
      ),
    );
  });

  it("retries reauthentication for the same target account", async () => {
    apiMocks.authStartLogin.mockRejectedValue(new Error("start failed"));
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.pollingState).toBe("error"));
    act(() => result.current.retryAuth());

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(2),
    );
    expect(apiMocks.authStartLogin).toHaveBeenNthCalledWith(
      2,
      "codex_oauth",
      undefined,
      "acct-1",
    );
  });

  it("localizes a duplicate Codex account error", async () => {
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockRejectedValue(
      new Error(CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });

    act(() => result.current.addAccount());

    await waitFor(() => expect(result.current.pollingState).toBe("error"));
    expect(result.current.error).toBe(
      "该 ChatGPT 账号已添加，请直接使用现有账号。",
    );
  });

  it("cancels the active Codex device flow in the backend", async () => {
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.deviceCode).not.toBeNull());

    act(() => result.current.cancelAuth());

    await waitFor(() =>
      expect(apiMocks.authCancelLogin).toHaveBeenCalledWith(
        "codex_oauth",
        "device-1",
      ),
    );
    expect(result.current.pollingState).toBe("idle");
  });

  it("refreshes status when login committed before cancellation", async () => {
    let resolvePoll!: (account: object) => void;
    let resolveCancel!: (cancelled: boolean) => void;
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(
      () => new Promise((resolve) => (resolvePoll = resolve)),
    );
    apiMocks.authCancelLogin.mockImplementation(
      () => new Promise((resolve) => (resolveCancel = resolve)),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(apiMocks.authPollForAccount).toHaveBeenCalled());
    apiMocks.authGetStatus.mockResolvedValue({
      provider: "codex_oauth",
      authenticated: true,
      default_account_id: "acct-1",
      accounts: [
        ...result.current.accounts,
        {
          id: "acct-2",
          provider: "codex_oauth",
          login: "other@example.com",
          avatar_url: null,
          authenticated_at: 2,
          is_default: false,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
      ],
    });

    act(() => result.current.cancelAuth());
    await waitFor(() => expect(apiMocks.authCancelLogin).toHaveBeenCalled());
    act(() => {
      resolvePoll({ id: "acct-2" });
      resolveCancel(false);
    });

    await waitFor(() => expect(result.current.accounts).toHaveLength(2));
  });

  it("waits for active-flow cancellation before starting another login", async () => {
    let resolveCancel!: (cancelled: boolean) => void;
    apiMocks.authStartLogin.mockResolvedValue({
      provider: "codex_oauth",
      device_code: "device-1",
      user_code: "ABCD-EFGH",
      verification_uri: "https://example.com/device",
      expires_in: 600,
      interval: 5,
    });
    apiMocks.authPollForAccount.mockImplementation(() => new Promise(() => {}));
    apiMocks.authCancelLogin.mockImplementation(
      () => new Promise((resolve) => (resolveCancel = resolve)),
    );
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });

    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(result.current.deviceCode).not.toBeNull());
    act(() => result.current.reauthAccount("acct-1"));
    await waitFor(() => expect(apiMocks.authCancelLogin).toHaveBeenCalled());
    expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(1);

    act(() => resolveCancel(true));

    await waitFor(() =>
      expect(apiMocks.authStartLogin).toHaveBeenCalledTimes(2),
    );
  });

  it("shows a success toast after removing an account", async () => {
    const { result } = renderHook(() => useManagedAuth("codex_oauth"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isStatusSuccess).toBe(true));

    act(() => result.current.removeAccount("acct-1"));

    await waitFor(() =>
      expect(apiMocks.authRemoveAccount).toHaveBeenCalledWith(
        "codex_oauth",
        "acct-1",
      ),
    );
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith("账号已移除"),
    );
  });
});
