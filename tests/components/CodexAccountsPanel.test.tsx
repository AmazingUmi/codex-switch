import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAccountsPanel } from "@/components/codex/CodexAccountsPanel";
import {
  getCodexAccountProviders,
  getCurrentCodexAccountId,
} from "@/components/codex/accountProviders";
import type { Provider } from "@/types";

const mocks = vi.hoisted(() => ({ useCodexOauth: vi.fn() }));
vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: mocks.useCodexOauth,
}));
vi.mock("@/components/CodexOauthAccountQuota", () => ({
  default: ({ accountId }: { accountId: string }) => (
    <div data-testid="account-quota">{accountId}</div>
  ),
}));

function provider(id: string, accountId: string): Provider {
  return {
    id,
    name: id,
    category: "official",
    settingsConfig: { auth: {}, config: "" },
    meta: {
      authBinding: {
        source: "managed_account",
        authProvider: "codex_oauth",
        accountId,
      },
    },
  };
}
const accounts = ["account-1", "account-2", "unbound"].map((id) => ({
  id,
  provider: "codex_oauth",
  login: `${id}@example.com`,
  avatar_url: null,
  authenticated_at: 0,
  is_default: id === "account-1",
  github_domain: "",
  reauth_required: false,
  requires_reauth: false,
}));

const card = (id: string) =>
  screen
    .getByText(`${id}@example.com`)
    .closest("[data-account-id]") as HTMLElement;

beforeEach(() => {
  mocks.useCodexOauth.mockReturnValue({
    accounts,
    defaultAccountId: "account-1",
    isStatusSuccess: true,
    isStatusError: false,
    hasAnyAccount: true,
    pollingState: "idle",
    deviceCode: null,
    error: null,
    isPolling: false,
    isAddingAccount: false,
    isRemovingAccount: false,
    isSettingDefaultAccount: false,
    addAccount: vi.fn(),
    reauthAccount: vi.fn(),
    retryAuth: vi.fn(),
    removeAccount: vi.fn(),
    setDefaultAccount: vi.fn(),
    cancelAuth: vi.fn(),
    logout: vi.fn(),
    refetchStatus: vi.fn(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Codex account provider mapping", () => {
  it("maps only explicit official managed identities and never native/default/API state", () => {
    const managed = provider("managed", " account-1 ");
    const native: Provider = {
      id: "codex-official",
      name: "native",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };
    const api: Provider = {
      id: "api",
      name: "api",
      category: "official",
      settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
    };
    const thirdParty = {
      ...provider("third", "account-1"),
      settingsConfig: {
        auth: {},
        config:
          'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://fixture.test/v1"',
      },
    };
    expect(
      getCodexAccountProviders([managed, native, api, thirdParty], "account-1"),
    ).toEqual([managed]);
    expect(getCurrentCodexAccountId([managed], "managed")).toBe("account-1");
    for (const current of [native, api, thirdParty])
      expect(getCurrentCodexAccountId([current], current.id)).toBeNull();
    expect(getCurrentCodexAccountId([managed], "")).toBeNull();
    expect(getCurrentCodexAccountId([managed], "missing")).toBeNull();
  });
});

describe("CodexAccountsPanel", () => {
  it("shows native/API current configuration without marking the OAuth default current", () => {
    const native: Provider = {
      id: "codex-official",
      name: "Native configuration",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };
    const api: Provider = {
      id: "api",
      name: "API configuration",
      category: "official",
      settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
    };
    const props = {
      providers: [native, api],
      onSwitchProvider: vi.fn(),
      onCreateConfiguration: vi.fn(),
    };
    const { rerender } = render(
      <CodexAccountsPanel {...props} currentProviderId={native.id} />,
    );
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "Native configuration",
    );
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "原生 Codex 登录",
    );
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
    rerender(<CodexAccountsPanel {...props} currentProviderId={api.id} />);
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "API configuration",
    );
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "OpenAI API",
    );
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
  });

  it("distinguishes loading configuration from unresolved routed current provider", () => {
    const props = {
      providers: [provider("configured", "account-1")],
      currentProviderId: "",
      onSwitchProvider: vi.fn(),
      onCreateConfiguration: vi.fn(),
    };
    const { rerender } = render(
      <CodexAccountsPanel {...props} isLoadingProviders />,
    );
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "正在加载配置…",
    );
    expect(
      screen.queryByRole("button", { name: "配置账号" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到此账号" }),
    ).not.toBeInTheDocument();
    rerender(<CodexAccountsPanel {...props} isLoadingProviders={false} />);
    expect(screen.getByTestId("current-codex-configuration")).toHaveTextContent(
      "当前配置不可用",
    );
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
    rerender(<CodexAccountsPanel {...props} isProvidersError />);
    expect(
      screen.queryByRole("button", { name: "配置账号" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "切换到此账号" }),
    ).not.toBeInTheDocument();
  });

  it("shows independent quotas, separate current/default accounts, and uses existing switch/create callbacks", async () => {
    const user = userEvent.setup();
    const first = provider("first", "account-1");
    const second = provider("second", "account-2");
    const onSwitchProvider = vi.fn();
    const onCreateConfiguration = vi.fn();
    render(
      <CodexAccountsPanel
        providers={[first, second]}
        currentProviderId="second"
        onSwitchProvider={onSwitchProvider}
        onCreateConfiguration={onCreateConfiguration}
      />,
    );
    expect(
      screen.getAllByTestId("account-quota").map((entry) => entry.textContent),
    ).toEqual(["account-1", "account-2", "unbound"]);
    expect(within(card("account-1")).getByText("默认")).toBeInTheDocument();
    expect(
      within(card("account-1")).queryByText("当前使用"),
    ).not.toBeInTheDocument();
    expect(
      within(card("account-2")).getByRole("button", { name: "当前使用" }),
    ).toBeDisabled();
    await user.click(
      within(card("account-1")).getByRole("button", { name: "切换到此账号" }),
    );
    expect(onSwitchProvider).toHaveBeenCalledWith(first);
    await user.click(
      within(card("unbound")).getByRole("button", { name: "配置账号" }),
    );
    expect(onCreateConfiguration).toHaveBeenCalledWith("unbound");
  });

  it("requires an explicit config choice when multiple bindings exist and none is current", async () => {
    const user = userEvent.setup();
    const onSwitchProvider = vi.fn();
    const first = provider("config-A", "account-1");
    const second = provider("config-B", "account-1");
    render(
      <CodexAccountsPanel
        providers={[first, second]}
        currentProviderId=""
        onSwitchProvider={onSwitchProvider}
        onCreateConfiguration={vi.fn()}
      />,
    );
    const switchButton = within(card("account-1")).getByRole("button", {
      name: "切换到此账号",
    });
    expect(switchButton).toBeDisabled();
    await user.click(within(card("account-1")).getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(switchButton);
    expect(onSwitchProvider).toHaveBeenCalledWith(second);
  });

  it("uses the current binding as the initial multiple-config choice", () => {
    render(
      <CodexAccountsPanel
        providers={[
          provider("config-A", "account-1"),
          provider("config-B", "account-1"),
        ]}
        currentProviderId="config-B"
        onSwitchProvider={vi.fn()}
        onCreateConfiguration={vi.fn()}
      />,
    );
    expect(within(card("account-1")).getByRole("combobox")).toHaveTextContent(
      "config-B",
    );
    expect(
      within(card("account-1")).getByRole("button", { name: "当前使用" }),
    ).toBeDisabled();
  });

  it("retains OAuth management actions and blocks switch/configure for incomplete credentials", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: accounts.map((account) => ({
        ...account,
        reauth_required: true,
      })),
    });
    render(
      <CodexAccountsPanel
        providers={[provider("first", "account-1")]}
        currentProviderId=""
        onSwitchProvider={vi.fn()}
        onCreateConfiguration={vi.fn()}
      />,
    );
    expect(
      within(card("account-1")).getByRole("button", { name: "切换到此账号" }),
    ).toBeDisabled();
    expect(
      within(card("unbound")).getByRole("button", { name: "配置账号" }),
    ).toBeDisabled();
    await user.click(
      within(card("account-1")).getByRole("button", { name: "重新登录" }),
    );
    expect(auth.reauthAccount).toHaveBeenCalledWith("account-1");
    await user.click(
      within(card("account-2")).getByRole("button", { name: "设为默认" }),
    );
    expect(auth.setDefaultAccount).toHaveBeenCalledWith("account-2");
    await user.click(
      within(card("unbound")).getByRole("button", {
        name: "移除账号: unbound@example.com",
      }),
    );
    expect(auth.removeAccount).toHaveBeenCalledWith("unbound");
    await user.click(screen.getByRole("button", { name: "添加其他账号" }));
    expect(auth.addAccount).toHaveBeenCalled();
  });

  it("does not render stale accounts/current/quota after status failure and offers status retry", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      isStatusSuccess: false,
      isStatusError: true,
    });
    render(
      <CodexAccountsPanel
        providers={[provider("first", "account-1")]}
        currentProviderId="first"
        onSwitchProvider={vi.fn()}
        onCreateConfiguration={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("account-quota")).not.toBeInTheDocument();
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(auth.refetchStatus).toHaveBeenCalled();
  });
});
