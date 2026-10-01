import { Suspense, useState, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { proxyKeys } from "@/lib/query/proxy";
import { usageKeys } from "@/lib/query/usage";
import type { Provider } from "@/types";
import { providersApi } from "@/lib/api/providers";
import {
  resetProviderState,
  setCurrentProviderId,
  setProviders,
  setSettings,
} from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const routedAccountState = vi.hoisted(() => ({
  enabled: false,
  failover: undefined as boolean | undefined,
  loading: false,
  error: false,
}));
vi.mock("@/hooks/useProxyStatus", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useProxyStatus")>();
  return {
    ...actual,
    useProxyStatus: () =>
      routedAccountState.enabled
        ? {
            isRunning: true,
            takeoverStatus: { codex: true },
            status: {
              active_targets: [{ app_type: "codex", provider_id: "codex-2" }],
            },
          }
        : actual.useProxyStatus(),
  };
});
vi.mock("@/lib/query/failover", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query/failover")>();
  return {
    ...actual,
    useAutoFailoverEnabled: (
      ...args: Parameters<typeof actual.useAutoFailoverEnabled>
    ) =>
      routedAccountState.enabled
        ? {
            data: routedAccountState.failover,
            isPlaceholderData: routedAccountState.loading,
            isError: routedAccountState.error,
          }
        : actual.useAutoFailoverEnabled(...args),
  };
});

vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: ({ onOpenChange, defaultTab, configurations }: any) => {
    const [tab, setTab] = useState(defaultTab);
    return (
      <div>
        <output data-testid="settings-tab">{tab}</output>
        <button
          role="tab"
          aria-label="Connection configurations"
          onClick={() => setTab("configurations")}
        />
        {tab === "configurations" && configurations}
        <button onClick={() => onOpenChange(false)}>close-settings</button>
      </div>
    );
  },
}));

vi.mock("@/components/usage/HomeUsageDashboard", () => ({
  HomeUsageDashboard: () => <div data-testid="usage-dashboard" />,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

vi.mock("@/components/codex/CodexAccountsPanel", () => ({
  CodexAccountsPanel: ({
    providers,
    currentProviderId,
    onSwitchProvider,
    onCreateConfiguration,
  }: any) => (
    <div data-testid="accounts-panel">
      <output>{JSON.stringify(providers)}</output>
      <output data-testid="account-current-provider">
        {currentProviderId}
      </output>
      <button onClick={() => onSwitchProvider(providers[0])}>
        switch-account-configuration
      </button>
      <button onClick={() => onCreateConfiguration("acct-selected")}>
        create-account-configuration
      </button>
    </div>
  ),
}));

vi.mock("@/components/providers/ProviderList", () => ({
  ProviderList: ({
    providers,
    currentProviderId,
    onSwitch,
    onEdit,
    onDuplicate,
    onConfigureUsage,
    onOpenWebsite,
    onCreate,
    onDelete,
  }: any) => (
    <div>
      <div data-testid="provider-list">{JSON.stringify(providers)}</div>
      <div data-testid="current-provider">{currentProviderId}</div>
      <button onClick={() => onSwitch(providers[currentProviderId])}>
        switch
      </button>
      <button onClick={() => onEdit(providers[currentProviderId])}>edit</button>
      <button onClick={() => onDuplicate(providers[currentProviderId])}>
        duplicate
      </button>
      <button onClick={() => onConfigureUsage(providers[currentProviderId])}>
        usage
      </button>
      <button onClick={() => onOpenWebsite("https://example.com")}>
        open-website
      </button>
      <button onClick={() => onDelete(Object.values(providers)[0])}>
        delete
      </button>
      <button onClick={() => onCreate?.()}>create</button>
    </div>
  ),
}));

vi.mock("@/components/providers/AddProviderDialog", () => ({
  AddProviderDialog: ({
    open,
    onOpenChange,
    onSubmit,
    appId,
    initialCodexAccountId,
  }: any) =>
    open ? (
      <div data-testid="add-provider-dialog">
        <output data-testid="initial-codex-account">
          {initialCodexAccountId}
        </output>
        <button
          onClick={() =>
            onSubmit({
              name: `New ${appId} Provider`,
              settingsConfig: {},
              category: "custom",
              sortIndex: 99,
            })
          }
        >
          confirm-add
        </button>
        <button onClick={() => onOpenChange(false)}>close-add</button>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/EditProviderDialog", () => ({
  EditProviderDialog: ({ open, provider, onSubmit, onOpenChange }: any) =>
    open ? (
      <div data-testid="edit-provider-dialog">
        <button
          onClick={() =>
            onSubmit({
              provider: {
                ...provider,
                name: `${provider.name}-edited`,
              },
              originalId: provider.id,
            })
          }
        >
          confirm-edit
        </button>
        <button onClick={() => onOpenChange(false)}>close-edit</button>
      </div>
    ) : null,
}));

vi.mock("@/components/UsageScriptModal", () => ({
  default: ({ isOpen, provider, onSave, onClose }: any) =>
    isOpen ? (
      <div data-testid="usage-modal">
        <span data-testid="usage-provider">{provider?.id}</span>
        <button onClick={() => onSave("script-code")}>save-script</button>
        <button onClick={() => onClose()}>close-usage</button>
      </div>
    ) : null,
}));

vi.mock("@/components/ConfirmDialog", () => ({
  ConfirmDialog: ({ isOpen, message, onConfirm, onCancel }: any) =>
    isOpen ? (
      <div data-testid="confirm-dialog">
        <div data-testid="confirm-message">{message}</div>
        <button onClick={() => onConfirm()}>confirm-delete</button>
        <button onClick={() => onCancel()}>cancel-delete</button>
      </div>
    ) : null,
}));

vi.mock("@/components/UpdateBadge", () => ({
  UpdateBadge: ({ onClick }: any) => (
    <button onClick={onClick}>update-badge</button>
  ),
}));

const renderApp = (AppComponent: ComponentType, client = new QueryClient()) => {
  return render(
    <QueryClientProvider client={client}>
      <Suspense fallback={<div data-testid="loading">loading</div>}>
        <AppComponent />
      </Suspense>
    </QueryClientProvider>,
  );
};

describe("App integration with MSW", () => {
  beforeEach(() => {
    routedAccountState.enabled = false;
    routedAccountState.failover = undefined;
    routedAccountState.loading = false;
    routedAccountState.error = false;
    resetProviderState();
    setSettings({ firstRunNoticeConfirmed: true });
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    localStorage.removeItem("cc-switch-last-view");
    localStorage.removeItem("cc-switch-last-app");
  });

  it("covers basic provider flows via real hooks", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel").textContent).toContain(
        "codex-1",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "common.settings" }));
    fireEvent.click(
      await screen.findByRole("tab", { name: "Connection configurations" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toContain(
        "codex-1",
      ),
    );

    fireEvent.click(screen.getByText("usage"));
    expect(screen.getByTestId("usage-modal")).toBeInTheDocument();
    fireEvent.click(screen.getByText("save-script"));
    fireEvent.click(screen.getByText("close-usage"));

    fireEvent.click(screen.getByText("create"));
    expect(screen.getByTestId("add-provider-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("confirm-add"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(
        /New codex Provider/,
      ),
    );

    fireEvent.click(screen.getByText("edit"));
    expect(screen.getByTestId("edit-provider-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByText("confirm-edit"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(
        /-edited/,
      ),
    );

    fireEvent.click(screen.getByText("switch"));
    fireEvent.click(screen.getByText("duplicate"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list").textContent).toMatch(/copy/),
    );

    fireEvent.click(screen.getByText("open-website"));

    emitTauriEvent("provider-switched", {
      appType: "codex",
      providerId: "codex-2",
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).toHaveBeenCalled();
  }, 10_000);

  it("resets provider view scroll when changing home tabs", async () => {
    const { default: App } = await import("@/App");
    const { container } = renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel").textContent).toContain(
        "codex-1",
      ),
    );

    const mainScrollContainer = container.querySelector("main") as HTMLElement;
    const providerScrollContainer = Array.from(
      container.querySelectorAll<HTMLElement>(".overflow-y-auto"),
    ).find(
      (element) =>
        element !== mainScrollContainer && element.className.includes("pb-12"),
    );

    expect(mainScrollContainer).not.toBeNull();
    expect(providerScrollContainer).toBeDefined();

    mainScrollContainer.scrollTop = 320;
    mainScrollContainer.scrollLeft = 12;
    providerScrollContainer!.scrollTop = 640;
    providerScrollContainer!.scrollLeft = 24;

    fireEvent.click(screen.getByRole("tab", { name: "Usage Statistics" }));
    expect(await screen.findByTestId("usage-dashboard")).toBeInTheDocument();

    expect(mainScrollContainer.scrollTop).toBe(0);
    expect(mainScrollContainer.scrollLeft).toBe(0);
    expect(providerScrollContainer!.scrollTop).toBe(0);
    expect(providerScrollContainer!.scrollLeft).toBe(0);
  }, 10_000);

  it("shows toast when auto sync fails in background", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel").textContent).toContain(
        "codex-1",
      ),
    );

    expect(() => {
      emitTauriEvent("webdav-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("webdav-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "network timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });

    toastErrorMock.mockReset();
    expect(() => {
      emitTauriEvent("s3-sync-status-updated", null);
    }).not.toThrow();
    expect(toastErrorMock).not.toHaveBeenCalled();

    emitTauriEvent("s3-sync-status-updated", {
      source: "auto",
      status: "error",
      error: "s3 timeout",
    });

    await waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalled();
    });
  });

  it("refetches Codex switches, ignores other apps, and unsubscribes on unmount", async () => {
    const getProviders = vi.spyOn(providersApi, "getAll");
    try {
      const { default: App } = await import("@/App");
      const { unmount } = renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "codex-1",
        ),
      );
      getProviders.mockClear();
      setCurrentProviderId("codex", "codex-2");

      await act(async () => {
        emitTauriEvent("provider-switched", {
          appType: "claude",
          providerId: "claude-2",
        });
      });
      expect(getProviders).not.toHaveBeenCalled();
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-1",
      );

      emitTauriEvent("provider-switched", {
        appType: "codex",
        providerId: "codex-2",
      });
      await waitFor(() =>
        expect(
          screen.getByTestId("account-current-provider"),
        ).toHaveTextContent("codex-2"),
      );
      expect(getProviders).toHaveBeenCalledWith("codex");

      unmount();
      getProviders.mockClear();
      await act(async () => {
        emitTauriEvent("provider-switched", {
          appType: "codex",
          providerId: "codex-1",
        });
      });
      expect(getProviders).not.toHaveBeenCalled();
    } finally {
      getProviders.mockRestore();
    }
  });

  it("refreshes profile and proxy caches after a profile is applied", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const { default: App } = await import("@/App");
    renderApp(App, client);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1"),
    );
    invalidate.mockClear();

    emitTauriEvent("profile-applied", {});
    await waitFor(() =>
      expect(invalidate).toHaveBeenCalledWith({ queryKey: proxyKeys.status }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["profiles"] });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: proxyKeys.takeoverStatus,
    });
  });

  it("refreshes providers and tray after a shared provider sync", async () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const updateTray = vi.spyOn(providersApi, "updateTrayMenu");
    try {
      const { default: App } = await import("@/App");
      renderApp(App, client);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "codex-1",
        ),
      );
      invalidate.mockClear();
      updateTray.mockClear();
      setProviders("codex", {
        synced: {
          id: "synced",
          name: "Synced configuration",
          settingsConfig: {},
        },
      });

      emitTauriEvent("universal-provider-synced", {});
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "Synced configuration",
        ),
      );
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["providers"] });
      await waitFor(() => expect(updateTray).toHaveBeenCalledTimes(1));
    } finally {
      updateTray.mockRestore();
    }
  });

  it("deletes a Codex configuration through the existing provider service", async () => {
    setCurrentProviderId("codex", "codex-2");
    const deleteProvider = vi.spyOn(providersApi, "delete");
    const removeFromLiveConfig = vi.spyOn(providersApi, "removeFromLiveConfig");
    try {
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "codex-1",
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "common.settings" }));
      fireEvent.click(
        await screen.findByRole("tab", { name: "Connection configurations" }),
      );
      fireEvent.click(await screen.findByText("delete"));
      expect(screen.getByTestId("confirm-message")).toHaveTextContent(
        "confirm.deleteProviderMessage",
      );
      fireEvent.click(screen.getByText("cancel-delete"));
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(screen.getByTestId("provider-list")).toHaveTextContent("codex-1");
      fireEvent.click(screen.getByText("delete"));
      fireEvent.click(screen.getByText("confirm-delete"));
      await waitFor(() =>
        expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument(),
      );
      expect(deleteProvider).toHaveBeenCalledWith("codex-1", "codex");
      expect(removeFromLiveConfig).not.toHaveBeenCalled();
      expect(screen.getByTestId("provider-list")).not.toHaveTextContent(
        "codex-1",
      );
      expect(screen.getByTestId("provider-list")).toHaveTextContent("codex-2");
    } finally {
      deleteProvider.mockRestore();
      removeFromLiveConfig.mockRestore();
    }
  });

  it("duplicates Codex bindings and settings while preserving configuration order", async () => {
    const original: Provider = {
      id: "bound",
      name: "Bound account",
      category: "custom",
      sortIndex: 0,
      settingsConfig: {
        config: 'model = "codex-test"',
        auth: { profile: "test" },
      },
      meta: {
        authBinding: {
          source: "managed_account",
          authProvider: "codex_oauth",
          accountId: "acct-fixture",
        },
        codexFastMode: true,
      },
    };
    setProviders("codex", {
      bound: original,
      later: { id: "later", name: "Later", settingsConfig: {}, sortIndex: 1 },
    });
    setCurrentProviderId("codex", original.id);
    const add = vi.spyOn(providersApi, "add");
    const sort = vi.spyOn(providersApi, "updateSortOrder");
    try {
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          original.name,
        ),
      );
      fireEvent.click(screen.getByRole("button", { name: "common.settings" }));
      fireEvent.click(
        await screen.findByRole("tab", { name: "Connection configurations" }),
      );
      fireEvent.click(await screen.findByText("duplicate"));
      await waitFor(() =>
        expect(screen.getByTestId("provider-list")).toHaveTextContent(
          "Bound account copy",
        ),
      );
      expect(sort).toHaveBeenCalledWith(
        [{ id: "later", sortIndex: 2 }],
        "codex",
      );
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Bound account copy",
          settingsConfig: original.settingsConfig,
          meta: original.meta,
          sortIndex: 1,
        }),
        "codex",
        undefined,
        undefined,
      );
      const saved = JSON.parse(
        screen.getByTestId("provider-list").textContent!,
      );
      expect(saved.bound.sortIndex).toBe(0);
      expect(saved.later.sortIndex).toBe(2);
      expect(
        Object.values<Provider>(saved).find(
          (p) => p.name === "Bound account copy",
        )?.id,
      ).not.toBe(original.id);
    } finally {
      add.mockRestore();
      sort.mockRestore();
    }
  });

  it("bridges tray usage refreshes into the Codex provider cache", async () => {
    const client = new QueryClient();
    const { default: App } = await import("@/App");
    renderApp(App, client);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1"),
    );
    const updatedUsage = { success: true, data: [{ remaining: 42 }] };
    emitTauriEvent("usage-cache-updated", {
      kind: "script",
      appType: "codex",
      providerId: "codex-2",
      data: updatedUsage,
    });
    expect(client.getQueryData(usageKeys.script("codex-2", "codex"))).toEqual(
      updatedUsage,
    );
    expect(
      client.getQueryData(usageKeys.script("codex-1", "codex")),
    ).toBeUndefined();
  });

  it.each(["claude", "opencode", "openclaw", "pi", "mcode", "invalid"])(
    "restores only Codex when the saved app is %s",
    async (savedApp) => {
      localStorage.setItem("cc-switch-last-app", savedApp);
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "codex-1",
        ),
      );
      expect(localStorage.getItem("cc-switch-last-app")).toBe("codex");
      expect(screen.queryByTestId("app-switcher")).not.toBeInTheDocument();
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1");
      emitTauriEvent("provider-switched", {
        appType: "claude",
        providerId: "claude-2",
      });
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1");
    },
  );

  it.each([
    "prompts",
    "skills",
    "skillsDiscovery",
    "mcp",
    "agents",
    "universal",
    "sessions",
    "workspace",
    "openclawEnv",
    "openclawTools",
    "openclawAgents",
    "hermesMemory",
    "invalid",
  ])("does not reopen the hidden %s view", async (savedView) => {
    localStorage.setItem("cc-switch-last-view", savedView);
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1"),
    );
    expect(localStorage.getItem("cc-switch-last-view")).toBe("providers");
    expect(screen.queryByTitle("skills.manage")).not.toBeInTheDocument();
    expect(screen.queryByTitle("mcp.title")).not.toBeInTheDocument();
    expect(screen.queryByTitle("sessionManager.title")).not.toBeInTheDocument();
  });

  it("keeps Settings keyboard navigation and resets provider scroll on return", async () => {
    const { default: App } = await import("@/App");
    const { container } = renderApp(App);
    await screen.findByTestId("accounts-panel");
    const main = container.querySelector("main")!;
    main.scrollTop = 320;
    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(await screen.findByText("close-settings")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(await screen.findByTestId("accounts-panel")).toBeInTheDocument();
    expect(main.scrollTop).toBe(0);
  });
  it("foregrounds accounts and keeps connection configuration actions accessible", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    expect(await screen.findByTestId("accounts-panel")).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: "ChatGPT accounts" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("provider-list")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("create-account-configuration"));
    expect(screen.getByTestId("initial-codex-account")).toHaveTextContent(
      "acct-selected",
    );
    fireEvent.click(screen.getByText("close-add"));
    expect(await screen.findByTestId("settings-tab")).toHaveTextContent(
      "configurations",
    );
    expect(await screen.findByTestId("provider-list")).toHaveTextContent(
      "codex-1",
    );
    fireEvent.click(screen.getByText("create"));
    expect(screen.getByTestId("initial-codex-account")).toBeEmptyDOMElement();
  });

  it("offers Usage without requiring local proxy takeover", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    fireEvent.click(screen.getByRole("tab", { name: "Usage Statistics" }));
    expect(await screen.findByTestId("usage-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab")).not.toBeInTheDocument();
  });

  it("switches an account through the existing provider action", async () => {
    setCurrentProviderId("codex", "codex-2");
    const switchSpy = vi.spyOn(providersApi, "switch");
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-2",
      ),
    );
    fireEvent.click(screen.getByText("switch-account-configuration"));
    await waitFor(() =>
      expect(switchSpy).toHaveBeenCalledWith("codex-1", "codex"),
    );
    switchSpy.mockRestore();
  });
  it.each([
    { failover: undefined, loading: true, error: false, expected: "" },
    { failover: false, loading: true, error: false, expected: "" },
    { failover: undefined, loading: false, error: true, expected: "" },
    { failover: true, loading: false, error: false, expected: "codex-2" },
    { failover: false, loading: false, error: false, expected: "codex-1" },
  ])("resolves routed current account conservatively: %j", async (state) => {
    Object.assign(routedAccountState, state, { enabled: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1"),
    );
    const current = screen.getByTestId("account-current-provider");
    if (state.expected) expect(current).toHaveTextContent(state.expected);
    else expect(current).toBeEmptyDOMElement();
  });
  it("supports keyboard navigation between account and usage tabs", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    const accounts = screen.getByRole("tab", { name: "ChatGPT accounts" });
    const usage = screen.getByRole("tab", {
      name: "Usage Statistics",
    });
    expect(accounts).toHaveAttribute("tabindex", "0");
    expect(usage).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(accounts, { key: "ArrowRight" });
    expect(usage).toHaveAttribute("aria-selected", "true");
    expect(usage).toHaveFocus();
    fireEvent.keyDown(usage, { key: "Home" });
    expect(accounts).toHaveAttribute("aria-selected", "true");
    expect(accounts).toHaveFocus();
    fireEvent.keyDown(accounts, { key: "End" });
    expect(usage).toHaveFocus();
    fireEvent.keyDown(usage, { key: "ArrowLeft" });
    expect(accounts).toHaveFocus();
  });
});
