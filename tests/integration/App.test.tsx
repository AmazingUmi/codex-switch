import { Suspense, type ComponentType } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { usageKeys } from "@/lib/query/usage";
import type { Provider } from "@/types";
import { providersApi } from "@/lib/api/providers";
import * as authApi from "@/lib/api/auth";
import {
  resetProviderState,
  setCurrentProviderId,
  setProviders,
  setSettings,
} from "../msw/state";
import { emitTauriEvent } from "../msw/tauriMocks";
import { server } from "../msw/server";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
const startAccountLoginMock = vi.fn();
let nativeSettingsPending = false;
let nativeSettingsDrainCount = 0;
vi.mock("@/components/settings/SettingsPage", () => ({
  SettingsPage: ({ onOpenChange, defaultTab }: any) => (
    <div>
      <output data-testid="settings-tab">{defaultTab}</output>
      <button onClick={() => onOpenChange(false)}>close-settings</button>
    </div>
  ),
}));

vi.mock("@/components/usage/HomeUsageDashboard", () => ({
  HomeUsageDashboard: () => <div data-testid="usage-dashboard" />,
}));

vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
    warning: vi.fn(),
  },
}));

vi.mock("@/components/codex/CodexAccountsPanel", () => ({
  CodexAccountsPanel: ({
    providers,
    currentProviderId,
    onSwitchAccount,
    isSwitching,
    onAddAccount,
  }: any) => (
    <div data-testid="accounts-panel">
      <output>{JSON.stringify(providers)}</output>
      <output data-testid="account-current-provider">
        {currentProviderId}
      </output>
      <button onClick={() => onAddAccount(startAccountLoginMock)}>
        add-account-or-connection
      </button>
      <button
        disabled={isSwitching}
        onClick={() => {
          void onSwitchAccount("acct-selected").catch(() => {});
        }}
      >
        switch-account
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
  }: any) => (
    <div>
      <div data-testid="provider-list">{JSON.stringify(providers)}</div>
      <div data-testid="current-provider">{currentProviderId}</div>
      <button onClick={() => onSwitch(providers[currentProviderId])}>
        switch
      </button>
      <button
        onClick={() =>
          onSwitch(
            Object.values<Provider>(providers).find(
              (provider) => provider.id !== currentProviderId,
            ),
          )
        }
      >
        switch-other-connection
      </button>
      <button onClick={() => onEdit(providers[currentProviderId])}>edit</button>
      <button
        onClick={() =>
          onEdit(
            Object.values<Provider>(providers).find(
              (provider) => provider.id !== currentProviderId,
            ),
          )
        }
      >
        edit-other-connection
      </button>
      <button onClick={() => onDuplicate(providers[currentProviderId])}>
        duplicate
      </button>
      <button onClick={() => onConfigureUsage(providers[currentProviderId])}>
        usage
      </button>
      <button onClick={() => onOpenWebsite("https://example.com")}>
        open-website
      </button>
      {onCreate && <button onClick={onCreate}>create</button>}
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
    apiKeyOnly,
  }: any) =>
    open ? (
      <div data-testid="add-provider-dialog">
        <output data-testid="api-key-only">{String(apiKeyOnly)}</output>
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
  EditProviderDialog: ({
    open,
    provider,
    onSubmit,
    onOpenChange,
    onDelete,
    deleteDisabledReason,
    deleteConfirmation,
  }: any) =>
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
        <button
          disabled={!!deleteDisabledReason}
          onClick={() => onDelete(provider)}
        >
          delete-connection
        </button>
        {deleteDisabledReason && (
          <p data-testid="delete-disabled-reason">{deleteDisabledReason}</p>
        )}
        {deleteConfirmation && (
          <div data-testid="editor-delete-confirmation">
            <p>{deleteConfirmation.message}</p>
            <button onClick={() => void deleteConfirmation.onConfirm()}>
              confirm-editor-delete
            </button>
            <button onClick={deleteConfirmation.onCancel}>
              cancel-editor-delete
            </button>
          </div>
        )}
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
    nativeSettingsPending = false;
    nativeSettingsDrainCount = 0;
    server.use(
      http.post("http://tauri.local/take_pending_settings_navigation", () => {
        const pending = nativeSettingsPending;
        nativeSettingsPending = false;
        nativeSettingsDrainCount += 1;
        return HttpResponse.json(pending);
      }),
    );
    resetProviderState();
    setSettings({ firstRunNoticeConfirmed: true });
    toastSuccessMock.mockReset();
    toastErrorMock.mockReset();
    startAccountLoginMock.mockReset();
    localStorage.removeItem("codex-switch-last-view");
    localStorage.removeItem("codex-switch-last-app");
    localStorage.removeItem("cc-switch-last-view");
    localStorage.removeItem("cc-switch-last-app");
  });

  it.each([
    [null, "settings"],
    ["providers", "providers"],
  ])(
    "migrates visible legacy navigation without replacing %s",
    async (newView, expectedView) => {
      localStorage.setItem("cc-switch-last-view", "settings");
      localStorage.setItem("cc-switch-last-app", "claude");
      if (newView) localStorage.setItem("codex-switch-last-view", newView);
      const { default: App } = await import("@/App");
      renderApp(App);
      if (expectedView === "settings") {
        expect(await screen.findByTestId("settings-tab")).toBeInTheDocument();
      } else {
        expect(await screen.findByTestId("accounts-panel")).toBeInTheDocument();
      }
      expect(localStorage.getItem("codex-switch-last-view")).toBe(expectedView);
      expect(localStorage.getItem("codex-switch-last-app")).toBe("codex");
      expect(localStorage.getItem("cc-switch-last-view")).toBeNull();
      expect(localStorage.getItem("cc-switch-last-app")).toBeNull();
    },
  );

  it("covers basic provider flows via real hooks", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);

    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel").textContent).toContain(
        "codex-1",
      ),
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

    expect(screen.queryByText("create")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("add-account-or-connection"));
    fireEvent.click(screen.getByRole("button", { name: /API Key 连接/ }));
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

    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
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

  it("refreshes profile caches after a profile is applied", async () => {
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
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ["profiles"] }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["profiles"] });
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ["proxyStatus"] });
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
      fireEvent.click(await screen.findByText("edit-other-connection"));
      fireEvent.click(screen.getByText("delete-connection"));
      expect(
        screen.getByTestId("editor-delete-confirmation"),
      ).toHaveTextContent("confirm.deleteProviderMessage");
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("cancel-editor-delete"));
      expect(deleteProvider).not.toHaveBeenCalled();
      expect(screen.getByTestId("edit-provider-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("provider-list")).toHaveTextContent("codex-1");
      fireEvent.click(screen.getByText("delete-connection"));
      fireEvent.click(screen.getByText("confirm-editor-delete"));
      await waitFor(() =>
        expect(
          screen.queryByTestId("edit-provider-dialog"),
        ).not.toBeInTheDocument(),
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

  it("keeps current connection deletion disabled in the editor and clears a cancelled confirmation on close", async () => {
    const deleteProvider = vi.spyOn(providersApi, "delete");
    try {
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("provider-list")).toHaveTextContent(
          "codex-1",
        ),
      );
      fireEvent.click(screen.getByText("edit"));
      expect(screen.getByText("delete-connection")).toBeDisabled();
      expect(screen.getByTestId("delete-disabled-reason")).toHaveTextContent(
        "当前使用的连接无法删除，请先切换到其他连接。",
      );
      fireEvent.click(screen.getByText("delete-connection"));
      expect(
        screen.queryByTestId("editor-delete-confirmation"),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByText("close-edit"));
      fireEvent.click(screen.getByText("edit-other-connection"));
      fireEvent.click(screen.getByText("delete-connection"));
      expect(
        screen.getByTestId("editor-delete-confirmation"),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByText("close-edit"));
      expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
      expect(deleteProvider).not.toHaveBeenCalled();
    } finally {
      deleteProvider.mockRestore();
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
      localStorage.setItem("codex-switch-last-app", savedApp);
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
          "codex-1",
        ),
      );
      expect(localStorage.getItem("codex-switch-last-app")).toBe("codex");
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
    localStorage.setItem("codex-switch-last-view", savedView);
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent("codex-1"),
    );
    expect(localStorage.getItem("codex-switch-last-view")).toBe("providers");
    expect(screen.queryByTitle("skills.manage")).not.toBeInTheDocument();
    expect(screen.queryByTitle("mcp.title")).not.toBeInTheDocument();
    expect(screen.queryByTitle("sessionManager.title")).not.toBeInTheDocument();
  });

  it.each(["metaKey", "ctrlKey"])(
    "keeps %s Settings keyboard navigation and resets provider scroll on return",
    async (modifier) => {
      const { default: App } = await import("@/App");
      const { container } = renderApp(App);
      await screen.findByTestId("accounts-panel");
      const main = container.querySelector("main")!;
      main.scrollTop = 320;
      fireEvent.keyDown(window, { key: ",", [modifier]: true });
      expect(await screen.findByText("close-settings")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(await screen.findByTestId("accounts-panel")).toBeInTheDocument();
      expect(main.scrollTop).toBe(0);
    },
  );

  it("opens general Settings from a native menu event in an active window", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    await waitFor(() => expect(nativeSettingsDrainCount).toBe(1));
    nativeSettingsPending = true;
    act(() => emitTauriEvent("native-menu-open-settings", null));
    expect(await screen.findByTestId("settings-tab")).toHaveTextContent(
      "general",
    );
    expect(nativeSettingsPending).toBe(false);
  });

  it("opens general Settings when the recreated webview consumes a queued request", async () => {
    nativeSettingsPending = true;
    const { default: App } = await import("@/App");
    renderApp(App);
    expect(await screen.findByTestId("settings-tab")).toHaveTextContent(
      "general",
    );
    expect(nativeSettingsPending).toBe(false);
  });
  it("foregrounds accounts and keeps API and advanced connection configuration actions accessible", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    expect(await screen.findByTestId("accounts-panel")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "账户" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(
      screen.getByRole("heading", { name: "Provider" }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab")).not.toBeInTheDocument();
    expect(await screen.findByTestId("provider-list")).toHaveTextContent(
      "codex-1",
    );
    fireEvent.click(screen.getByText("add-account-or-connection"));
    fireEvent.click(screen.getByRole("button", { name: /API Key 连接/ }));
    expect(screen.getByTestId("initial-codex-account")).toBeEmptyDOMElement();
    expect(screen.getByTestId("api-key-only")).toHaveTextContent("true");
  });

  it("starts ChatGPT login from the unified chooser without opening an API Key form", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    fireEvent.click(await screen.findByText("add-account-or-connection"));
    expect(
      screen.getByRole("dialog", { name: "添加账号或连接" }),
    ).toBeVisible();
    expect(startAccountLoginMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /ChatGPT 登录/ }));
    expect(startAccountLoginMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("add-provider-dialog")).not.toBeInTheDocument();
  });

  it("opens API Key creation directly from its section without starting login", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    fireEvent.click(screen.getByRole("button", { name: "添加 API Key" }));
    expect(screen.getByTestId("add-provider-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("api-key-only")).toHaveTextContent("true");
    expect(screen.getByTestId("initial-codex-account")).toBeEmptyDOMElement();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(startAccountLoginMock).not.toHaveBeenCalled();
  });

  it("opens and saves an API Key connection from the unified chooser without logging in", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveTextContent("codex-1"),
    );
    fireEvent.click(screen.getByText("add-account-or-connection"));
    fireEvent.click(screen.getByRole("button", { name: /API Key 连接/ }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("api-key-only")).toHaveTextContent("true");
    expect(screen.getByTestId("initial-codex-account")).toBeEmptyDOMElement();
    fireEvent.click(screen.getByText("confirm-add"));
    await waitFor(() =>
      expect(screen.getByTestId("provider-list")).toHaveTextContent(
        "New codex Provider",
      ),
    );
    expect(startAccountLoginMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
      "codex-1",
    );
  });

  it("cancels the unified chooser without starting login or creating a connection", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    fireEvent.click(await screen.findByText("add-account-or-connection"));
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(startAccountLoginMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("add-provider-dialog")).not.toBeInTheDocument();
  });

  it("keeps connection guidance available through its heading help button", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    const description =
      "在这里管理 API Key 连接和已保存的高级配置。ChatGPT 订阅额度显示在对应账号卡片中。";
    expect(screen.queryByText(description)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接配置用途" }));
    expect(await screen.findByText(description)).toBeVisible();
    expect(
      screen.getByRole("button", { name: "add-account-or-connection" }),
    ).toBeInTheDocument();
  });

  it("offers Usage without requiring local proxy takeover", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    fireEvent.click(screen.getByRole("tab", { name: "用量" }));
    expect(await screen.findByTestId("usage-dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-tab")).not.toBeInTheDocument();
  });

  it("keeps account and usage navigation available from Settings", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    const settings = screen.getByRole("button", { name: "设置" });
    const accounts = screen.getByRole("tab", {
      name: "账户",
    });
    const usage = screen.getByRole("tab", { name: "用量" });

    fireEvent.click(settings);
    await screen.findByTestId("settings-tab");
    expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(accounts).toHaveAttribute("aria-selected", "false");
    fireEvent.click(usage);
    await screen.findByTestId("usage-dashboard");
    expect(settings).toHaveAttribute("aria-pressed", "false");
    expect(usage).toHaveAttribute("aria-selected", "true");

    fireEvent.click(settings);
    await screen.findByTestId("settings-tab");
    fireEvent.click(accounts);
    await screen.findByTestId("accounts-panel");
    expect(accounts).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByTestId("settings-tab")).not.toBeInTheDocument();
  });

  it("switches an existing account without opening a connection form and updates current from readback", async () => {
    setCurrentProviderId("codex", "codex-2");
    const switchSpy = vi
      .spyOn(authApi, "authSwitchCodexAccount")
      .mockImplementation(async () => {
        setCurrentProviderId("codex", "codex-1");
        return { providerId: "codex-1", warnings: [] };
      });
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-2",
      ),
    );
    fireEvent.click(screen.getByText("switch-account"));
    await waitFor(() =>
      expect(switchSpy).toHaveBeenCalledWith("acct-selected", undefined),
    );
    await waitFor(() =>
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-1",
      ),
    );
    expect(screen.queryByTestId("add-provider-dialog")).not.toBeInTheDocument();
    switchSpy.mockRestore();
  });

  it("switches a saved connection directly from the homepage and updates the current account", async () => {
    const switchConnection = vi.spyOn(providersApi, "switch");
    try {
      const { default: App } = await import("@/App");
      renderApp(App);
      await waitFor(() =>
        expect(screen.getByTestId("provider-list")).toHaveTextContent(
          "codex-2",
        ),
      );
      fireEvent.click(screen.getByText("switch-other-connection"));
      await waitFor(() =>
        expect(switchConnection).toHaveBeenCalledWith("codex-2", "codex"),
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("account-current-provider"),
        ).toHaveTextContent("codex-2"),
      );
      expect(screen.getByTestId("current-provider")).toHaveTextContent(
        "codex-2",
      );
      expect(startAccountLoginMock).not.toHaveBeenCalled();
      expect(
        screen.queryByTestId("add-provider-dialog"),
      ).not.toBeInTheDocument();
    } finally {
      switchConnection.mockRestore();
    }
  });

  it("preserves current on failed account switch and explains the failure", async () => {
    setCurrentProviderId("codex", "codex-2");
    const switchSpy = vi
      .spyOn(authApi, "authSwitchCodexAccount")
      .mockRejectedValue(new Error("login expired"));
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-2",
      ),
    );
    fireEvent.click(screen.getByText("switch-account"));
    await waitFor(() =>
      expect(toastErrorMock).toHaveBeenCalledWith(
        expect.stringContaining("login expired"),
      ),
    );
    expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
      "codex-2",
    );
    switchSpy.mockRestore();
  });

  it("keeps automatically generated account connections out of advanced configuration lists", async () => {
    setProviders("codex", {
      internal: {
        id: "internal",
        name: "Internal account",
        settingsConfig: {},
        meta: { codexAccountManaged: true },
      },
      advanced: {
        id: "advanced",
        name: "Existing advanced",
        settingsConfig: { config: "custom = true" },
      },
    });
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("accounts-panel")).toHaveTextContent(
        "internal",
      ),
    );
    expect(screen.getByTestId("provider-list")).toHaveTextContent("advanced");
    expect(screen.getByTestId("provider-list")).not.toHaveTextContent(
      "internal",
    );
  });
  it("uses the native configured provider as the current account", async () => {
    const { default: App } = await import("@/App");
    renderApp(App);
    await waitFor(() =>
      expect(screen.getByTestId("account-current-provider")).toHaveTextContent(
        "codex-1",
      ),
    );
  });
  it("supports keyboard navigation across accounts, usage and settings", async () => {
    setSettings({ firstRunNoticeConfirmed: true });
    const { default: App } = await import("@/App");
    renderApp(App);
    await screen.findByTestId("accounts-panel");
    const accounts = screen.getByRole("tab", {
      name: "账户",
    });
    const usage = screen.getByRole("tab", {
      name: "用量",
    });
    const settings = screen.getByRole("button", { name: "设置" });
    expect(accounts).toHaveAttribute("tabindex", "0");
    expect(usage).toHaveAttribute("tabindex", "-1");
    fireEvent.keyDown(accounts, { key: "ArrowRight" });
    expect(usage).toHaveAttribute("aria-selected", "true");
    expect(usage).toHaveFocus();
    fireEvent.keyDown(usage, { key: "Home" });
    expect(accounts).toHaveAttribute("aria-selected", "true");
    expect(accounts).toHaveFocus();
    fireEvent.keyDown(accounts, { key: "End" });
    expect(settings).toHaveFocus();
    expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(await screen.findByTestId("settings-tab")).toBeInTheDocument();
    fireEvent.keyDown(settings, { key: "ArrowLeft" });
    expect(usage).toHaveFocus();
    fireEvent.keyDown(usage, { key: "ArrowLeft" });
    expect(accounts).toHaveFocus();
  });
});
