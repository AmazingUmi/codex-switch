import { useState, useCallback, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { authApi, settingsApi } from "@/lib/api";
import {
  CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR,
  getCodexActiveSelection,
  type ManagedAuthAccount,
  type CodexActiveSelection,
} from "@/lib/api/auth";
import { copyText } from "@/lib/clipboard";
import type { ProvidersQueryData } from "@/lib/query/queries";
import type { SubscriptionQuota } from "@/types/subscription";
import type {
  ManagedAuthProvider,
  ManagedAuthStatus,
  ManagedAuthDeviceCodeResponse,
} from "@/lib/api";

type AccountAppearance = {
  display_name: string | null;
  notes: string | null;
  icon: string | null;
  color: string | null;
};

type PollingState = "idle" | "polling" | "success" | "error";
type LoginRequest = {
  targetAccountId?: string;
  generation: number;
};

export function useManagedAuth(
  authProvider: ManagedAuthProvider,
  githubDomain?: string,
) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const queryKey = ["managed-auth-status", authProvider];

  const [pollingState, setPollingState] = useState<PollingState>("idle");
  const [deviceCode, setDeviceCode] =
    useState<ManagedAuthDeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(
    null,
  );
  const pollingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flowGenerationRef = useRef(0);
  const activeDeviceCodeRef = useRef<string | null>(null);
  const retryTargetAccountIdRef = useRef<string | undefined>(undefined);
  const flowTransitionRef = useRef<Promise<void>>(Promise.resolve());

  const {
    data: authStatus,
    isLoading: isLoadingStatus,
    isSuccess: isStatusSuccess,
    isError: isStatusError,
    refetch: refetchStatus,
  } = useQuery<ManagedAuthStatus>({
    queryKey,
    queryFn: () => authApi.authGetStatus(authProvider),
    staleTime: 30000,
    // A rejected xAI refresh token is persisted as `requires_reauth` by the
    // proxy hot path. Periodically refresh local status so an already-open Auth
    // Center stops showing the account as logged in without requiring a reload.
    refetchInterval: authProvider === "xai_oauth" ? 15_000 : false,
  });

  const stopPolling = useCallback(() => {
    if (pollingIntervalRef.current) {
      clearInterval(pollingIntervalRef.current);
      pollingIntervalRef.current = null;
    }
    if (pollingTimeoutRef.current) {
      clearTimeout(pollingTimeoutRef.current);
      pollingTimeoutRef.current = null;
    }
  }, []);

  const cancelBackendFlow = useCallback(
    async (deviceCode: string | null): Promise<boolean> => {
      if (authProvider !== "codex_oauth" || !deviceCode) return true;
      try {
        const cancelled = await authApi.authCancelLogin(
          authProvider,
          deviceCode,
        );
        if (!cancelled) {
          await queryClient.invalidateQueries({
            queryKey: ["managed-auth-status", authProvider],
          });
        }
        return cancelled;
      } catch (e) {
        console.debug("[ManagedAuth] Failed to cancel device flow:", e);
        await queryClient.invalidateQueries({
          queryKey: ["managed-auth-status", authProvider],
        });
        return false;
      }
    },
    [authProvider, queryClient],
  );

  const queueBackendCancellation = useCallback(
    (deviceCode: string | null) => {
      const transition = flowTransitionRef.current.then(async () => {
        await cancelBackendFlow(deviceCode);
      });
      flowTransitionRef.current = transition;
      return transition;
    },
    [cancelBackendFlow],
  );

  useEffect(() => {
    return () => {
      flowGenerationRef.current += 1;
      void cancelBackendFlow(activeDeviceCodeRef.current);
      activeDeviceCodeRef.current = null;
      stopPolling();
    };
  }, [cancelBackendFlow, stopPolling]);

  const startLoginMutation = useMutation({
    mutationFn: ({ targetAccountId }: LoginRequest) =>
      authApi.authStartLogin(authProvider, githubDomain, targetAccountId),
    onSuccess: async (response, request) => {
      if (request.generation !== flowGenerationRef.current) {
        void cancelBackendFlow(response.device_code);
        return;
      }
      activeDeviceCodeRef.current = response.device_code;
      setDeviceCode(response);
      setPollingState("polling");
      setError(null);

      try {
        await copyText(response.user_code);
      } catch (e) {
        console.debug("[ManagedAuth] Failed to copy user code:", e);
      }
      if (request.generation !== flowGenerationRef.current) return;

      try {
        await settingsApi.openExternal(response.verification_uri);
      } catch (e) {
        console.debug("[ManagedAuth] Failed to open browser:", e);
      }
      if (request.generation !== flowGenerationRef.current) return;

      // Add a small buffer on top of GitHub's suggested interval to avoid
      // hitting slow_down responses too aggressively during device polling.
      const interval = Math.max((response.interval || 5) + 3, 8) * 1000;
      const expiresAt = Date.now() + response.expires_in * 1000;

      const pollOnce = async () => {
        if (request.generation !== flowGenerationRef.current) return;
        if (Date.now() > expiresAt) {
          stopPolling();
          activeDeviceCodeRef.current = null;
          void cancelBackendFlow(response.device_code);
          flowGenerationRef.current += 1;
          setPollingState("error");
          setError(
            t("managedAuth.deviceCodeExpired", {
              defaultValue: "登录验证码已过期，请重试。",
            }),
          );
          return;
        }

        try {
          const newAccount = await authApi.authPollForAccount(
            authProvider,
            response.device_code,
            githubDomain,
          );
          if (request.generation !== flowGenerationRef.current) return;
          if (newAccount) {
            stopPolling();
            activeDeviceCodeRef.current = null;
            flowGenerationRef.current += 1;
            const completionGeneration = flowGenerationRef.current;
            setPollingState("success");
            await refetchStatus();
            await queryClient.invalidateQueries({ queryKey });
            if (authProvider === "codex_oauth") {
              // New credentials supersede this account's cached expiry result.
              // Quota retrieval remains independent of a committed login.
              try {
                const quotaKey = ["codex_oauth", "quota", newAccount.id];
                const previousQuota =
                  queryClient.getQueryData<SubscriptionQuota>(quotaKey);
                const filters = { queryKey: quotaKey, exact: true };
                if (
                  previousQuota?.credentialStatus === "expired" ||
                  previousQuota?.credentialStatus === "not_found"
                ) {
                  // A transport failure must not retain the old credentials' block.
                  await queryClient.resetQueries(filters);
                } else {
                  await queryClient.invalidateQueries(filters);
                }
              } catch (quotaError) {
                console.debug(
                  "[ManagedAuth] Failed to refresh account quota:",
                  quotaError,
                );
              }
            }
            if (completionGeneration !== flowGenerationRef.current) return;
            setPollingState("idle");
            setDeviceCode(null);
          }
        } catch (e) {
          if (request.generation !== flowGenerationRef.current) return;
          const errorMessage = e instanceof Error ? e.message : String(e);
          if (
            !errorMessage.includes("pending") &&
            !errorMessage.includes("slow_down")
          ) {
            stopPolling();
            activeDeviceCodeRef.current = null;
            void cancelBackendFlow(response.device_code);
            flowGenerationRef.current += 1;
            setPollingState("error");
            setError(
              authProvider === "codex_oauth" &&
                errorMessage === CODEX_OAUTH_DUPLICATE_ACCOUNT_ERROR
                ? t("codexOauth.duplicateAccount", {
                    defaultValue: "该 ChatGPT 账号已添加，请直接使用现有账号。",
                  })
                : errorMessage,
            );
          }
        }
      };

      pollingIntervalRef.current = setInterval(pollOnce, interval);
      pollingTimeoutRef.current = setTimeout(() => {
        if (request.generation !== flowGenerationRef.current) return;
        stopPolling();
        activeDeviceCodeRef.current = null;
        void cancelBackendFlow(response.device_code);
        flowGenerationRef.current += 1;
        setPollingState("error");
        setError(
          t("managedAuth.deviceCodeExpired", {
            defaultValue: "登录验证码已过期，请重试。",
          }),
        );
      }, response.expires_in * 1000);
      void pollOnce();
    },
    onError: (e, request) => {
      if (request.generation !== flowGenerationRef.current) return;
      setPollingState("error");
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const clearAccountQuota = async (accountId?: string) => {
    if (authProvider !== "codex_oauth") return;
    await queryClient.cancelQueries({ queryKey });
    await queryClient.cancelQueries({ queryKey: ["providers", "codex"] });
    await queryClient.cancelQueries({ queryKey: ["codex-active-selection"] });
    queryClient.setQueryData<CodexActiveSelection>(
      ["codex-active-selection"],
      (selection) => {
        if (
          selection?.kind !== "account" ||
          (accountId && selection.accountId !== accountId)
        )
          return selection;
        return null;
      },
    );
    queryClient.setQueryData<ProvidersQueryData>(
      ["providers", "codex"],
      (previous) => {
        if (
          previous?.activeSelection?.kind !== "account" ||
          (accountId && previous.activeSelection.accountId !== accountId)
        )
          return previous;
        return { ...previous, activeSelection: null, currentProviderId: "" };
      },
    );
    await clearOwnedAccountQuota(accountId);
  };

  const clearOwnedAccountQuota = async (accountId?: string) => {
    const quotaKey = accountId
      ? ["codex_oauth", "quota", accountId]
      : ["codex_oauth", "quota"];
    await queryClient.cancelQueries({ queryKey: quotaKey });
    queryClient.removeQueries({ queryKey: quotaKey });
    // Legacy native-login quota is no longer owned by any API provider.
    await queryClient.cancelQueries({
      queryKey: ["subscription", "quota", "codex"],
    });
    queryClient.removeQueries({ queryKey: ["subscription", "quota", "codex"] });
  };

  const reconcileAccountRemovalError = async (accountId?: string) => {
    if (authProvider !== "codex_oauth") return;
    const previousAccounts =
      queryClient.getQueryData<ManagedAuthStatus>(queryKey)?.accounts ?? [];
    await Promise.all([
      queryClient.cancelQueries({ queryKey }),
      queryClient.cancelQueries({ queryKey: ["codex-active-selection"] }),
    ]);
    const [statusRead] = await Promise.allSettled([
      queryClient.fetchQuery({
        queryKey,
        queryFn: () => authApi.authGetStatus(authProvider),
        staleTime: 0,
        retry: false,
      }),
      queryClient.fetchQuery({
        queryKey: ["codex-active-selection"],
        queryFn: getCodexActiveSelection,
        staleTime: 0,
        retry: false,
      }),
      queryClient.invalidateQueries({
        queryKey: ["providers", "codex"],
        refetchType: "none",
      }),
    ]);
    if (statusRead.status !== "fulfilled") return;
    const retained = statusRead.value.accounts;
    if (accountId) {
      if (!retained.some((account) => account.id === accountId))
        await clearOwnedAccountQuota(accountId);
    } else if (!retained.length) {
      await clearOwnedAccountQuota();
    } else {
      for (const account of previousAccounts) {
        if (!retained.some((entry) => entry.id === account.id))
          await clearOwnedAccountQuota(account.id);
      }
    }
  };

  const logoutMutation = useMutation({
    mutationFn: () => authApi.authLogout(authProvider),
    onSuccess: async () => {
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, {
        activeSelection: null,
        provider: authProvider,
        authenticated: false,
        default_account_id: null,
        accounts: [],
      });
      await clearAccountQuota();
      await queryClient.invalidateQueries({ queryKey });
      if (authProvider === "codex_oauth") {
        await queryClient.invalidateQueries({
          queryKey: ["codex-active-selection"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
      }
    },
    onError: async (e) => {
      console.error("[ManagedAuth] Failed to logout:", e);
      setError(e instanceof Error ? e.message : String(e));
      if (authProvider === "codex_oauth") await reconcileAccountRemovalError();
      else await refetchStatus();
    },
  });

  const removeAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      authApi.authRemoveAccount(authProvider, accountId),
    onSuccess: async (_, accountId) => {
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData<ManagedAuthStatus>(queryKey, (previous) =>
        previous
          ? {
              ...previous,
              accounts: previous.accounts.filter(
                (account) => account.id !== accountId,
              ),
              activeSelection:
                previous.activeSelection?.kind === "account" &&
                previous.activeSelection.accountId === accountId
                  ? null
                  : previous.activeSelection,
            }
          : previous,
      );
      await clearAccountQuota(accountId);
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      toast.success(
        t("managedAuth.accountRemoved", {
          defaultValue: "账号已移除",
        }),
      );
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
      if (authProvider === "codex_oauth") {
        await queryClient.invalidateQueries({
          queryKey: ["codex-active-selection"],
        });
        await queryClient.invalidateQueries({
          queryKey: ["providers", "codex"],
        });
      }
    },
    onError: async (e, accountId) => {
      console.error("[ManagedAuth] Failed to remove account:", e);
      setError(e instanceof Error ? e.message : String(e));
      await reconcileAccountRemovalError(accountId);
    },
  });

  const setDefaultAccountMutation = useMutation({
    mutationFn: (accountId: string) =>
      authApi.authSetDefaultAccount(authProvider, accountId),
    onSuccess: async () => {
      await refetchStatus();
      await queryClient.invalidateQueries({ queryKey });
    },
    onError: (e) => {
      console.error("[ManagedAuth] Failed to set default account:", e);
      setError(e instanceof Error ? e.message : String(e));
    },
  });

  const updateAccountMutation = useMutation({
    mutationFn: ({
      accountId,
      appearance,
    }: {
      accountId: string;
      appearance: AccountAppearance;
    }) => authApi.authUpdateAccount(authProvider, accountId, appearance),
    onSuccess: async (account: ManagedAuthAccount) => {
      // Synchronize all account surfaces only after the local store accepts the edit.
      queryClient.setQueryData<ManagedAuthStatus>(queryKey, (status) =>
        status
          ? {
              ...status,
              accounts: status.accounts.map((entry) =>
                entry.id === account.id ? account : entry,
              ),
            }
          : status,
      );
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  const updateAccount = (accountId: string, appearance: AccountAppearance) =>
    updateAccountMutation.mutateAsync({ accountId, appearance });

  const beginLogin = useCallback(
    (targetAccountId?: string) => {
      const previousDeviceCode = activeDeviceCodeRef.current;
      activeDeviceCodeRef.current = null;
      const generation = flowGenerationRef.current + 1;
      flowGenerationRef.current = generation;
      retryTargetAccountIdRef.current = targetAccountId;
      setPollingState("idle");
      setDeviceCode(null);
      setError(null);
      stopPolling();
      void queueBackendCancellation(previousDeviceCode).then(() => {
        if (generation !== flowGenerationRef.current) return;
        startLoginMutation.mutate({ targetAccountId, generation });
      });
    },
    [queueBackendCancellation, startLoginMutation, stopPolling],
  );

  const startAuth = useCallback(() => beginLogin(), [beginLogin]);

  const reauthAccount = useCallback(
    (accountId: string) => {
      beginLogin(accountId);
    },
    [beginLogin],
  );

  const retryAuth = useCallback(
    () => beginLogin(retryTargetAccountIdRef.current),
    [beginLogin],
  );

  const cancelAuth = useCallback(() => {
    flowGenerationRef.current += 1;
    const previousDeviceCode = activeDeviceCodeRef.current;
    activeDeviceCodeRef.current = null;
    retryTargetAccountIdRef.current = undefined;
    stopPolling();
    setPollingState("idle");
    setDeviceCode(null);
    setError(null);
    void queueBackendCancellation(previousDeviceCode);
  }, [queueBackendCancellation, stopPolling]);

  const logout = useCallback(() => {
    logoutMutation.mutate();
  }, [logoutMutation]);

  const removeAccount = useCallback(
    (accountId: string) => {
      removeAccountMutation.mutate(accountId);
    },
    [removeAccountMutation],
  );

  const setDefaultAccount = useCallback(
    (accountId: string) => {
      setDefaultAccountMutation.mutate(accountId);
    },
    [setDefaultAccountMutation],
  );

  const accounts = authStatus?.accounts ?? [];

  return {
    authStatus,
    isLoadingStatus,
    // Distinguish "status loaded successfully" from "loading / failed" so
    // callers don't treat a failed query's empty `accounts` as authoritative.
    isStatusSuccess,
    isStatusError,
    accounts,
    hasAnyAccount: accounts.length > 0,
    isAuthenticated: authStatus?.authenticated ?? false,
    defaultAccountId: authStatus?.default_account_id ?? null,
    migrationError: authStatus?.migration_error ?? null,
    pollingState,
    deviceCode,
    error,
    isPolling: pollingState === "polling",
    isAddingAccount: startLoginMutation.isPending || pollingState === "polling",
    isRemovingAccount: removeAccountMutation.isPending,
    isSettingDefaultAccount: setDefaultAccountMutation.isPending,
    isUpdatingAccount: updateAccountMutation.isPending,
    updateAccount,
    startAuth,
    addAccount: startAuth,
    reauthAccount,
    retryAuth,
    cancelAuth,
    logout,
    removeAccount,
    setDefaultAccount,
    refetchStatus,
  };
}
