import {
  render as rtlRender,
  act,
  screen,
  waitFor,
  within,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, PropsWithChildren } from "react";
import type { SubscriptionQuota } from "@/types/subscription";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
import { CodexAccountsPanel } from "@/components/codex/CodexAccountsPanel";
import {
  getCodexAccountProviders,
  getCurrentCodexAccountId,
} from "@/components/codex/accountProviders";
import type { Provider } from "@/types";

const mocks = vi.hoisted(() => ({
  useCodexOauth: vi.fn(),
  getCodexOauthQuota: vi.fn(),
}));
vi.mock("@/lib/api/subscription", () => ({
  subscriptionApi: { getCodexOauthQuota: mocks.getCodexOauthQuota },
}));

let queryClient: QueryClient;
const render = (ui: ReactElement) =>
  rtlRender(ui, {
    wrapper: ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    ),
  });

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
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  mocks.getCodexOauthQuota.mockClear();
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
    updateAccount: vi.fn().mockResolvedValue(undefined),
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
  const commonProps = () => ({
    providers: [
      provider("first", "account-1"),
      provider("second", "account-2"),
    ],
    currentProviderId: "second",
    onSwitchAccount: vi.fn().mockResolvedValue(undefined),
  });

  it("removes the configuration strip and keeps instructions in accessible nearby help", async () => {
    const user = userEvent.setup();
    render(<CodexAccountsPanel {...commonProps()} />);
    expect(
      screen.queryByTestId("current-codex-configuration"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("当前配置不可用")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "ChatGPT 账号" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("3 个账号")).toBeInTheDocument();
    const help = screen.getByRole("button", { name: "账号说明" });
    await user.tab();
    expect(help).toHaveFocus();
    await user.keyboard("{Enter}");
    const explanation = screen.getByRole("dialog", { name: "账号说明" });
    expect(explanation).toHaveTextContent(/登录后的 ChatGPT 账号可以直接切换/);
    expect(explanation).not.toHaveTextContent(/百分比表示已使用额度/);
    await user.keyboard("{Escape}");
    expect(help).toHaveFocus();
    expect(
      within(card("account-2")).getByRole("button", {
        name: "编辑账号: account-2@example.com",
      }),
    ).toHaveAttribute("title", "编辑账号");
    expect(
      within(card("account-2")).queryByRole("button", { name: "设为默认" }),
    ).not.toBeInTheDocument();
  });

  it("shows only a concise connection name when API Key is current", () => {
    const api: Provider = {
      id: "api",
      name: "Work API",
      category: "official",
      settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
    };
    const props = {
      providers: [api],
      currentProviderId: "api",
      onSwitchAccount: vi.fn(),
    };
    const { rerender } = render(<CodexAccountsPanel {...props} />);
    expect(screen.getByTestId("current-api-connection")).toHaveTextContent(
      "Work API",
    );
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
    const custom: Provider = {
      ...api,
      id: "custom",
      name: "Team API",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "fixture" },
        config:
          'model_provider = "team"\n[model_providers.team]\nbase_url = "https://fixture.test/v1"',
      },
    };
    rerender(
      <CodexAccountsPanel
        {...props}
        providers={[custom]}
        currentProviderId="custom"
      />,
    );
    expect(screen.getByTestId("current-api-connection")).toHaveTextContent(
      /^Team API$/,
    );
    rerender(<CodexAccountsPanel {...props} currentProviderId="" />);
    expect(
      screen.queryByTestId("current-api-connection"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("当前配置不可用")).not.toBeInTheDocument();
  });

  it("switches existing accounts directly without asking users to create configurations", async () => {
    const user = userEvent.setup();
    const props = commonProps();
    render(<CodexAccountsPanel {...props} />);
    expect(
      screen.getAllByTestId("account-quota").map((entry) => entry.textContent),
    ).toEqual(["account-1", "account-2", "unbound"]);
    expect(
      within(card("account-1")).queryByText("当前使用"),
    ).not.toBeInTheDocument();
    expect(
      within(card("account-2")).getByRole("button", { name: "当前使用" }),
    ).toBeDisabled();
    await user.click(
      within(card("account-1")).getByRole("button", { name: "切换到此账号" }),
    );
    expect(props.onSwitchAccount).toHaveBeenCalledWith("account-1", undefined);
    await user.click(
      within(card("unbound")).getByRole("button", { name: "切换到此账号" }),
    );
    expect(props.onSwitchAccount).toHaveBeenCalledWith("unbound", undefined);
    expect(
      screen.queryByRole("button", { name: "配置账号" }),
    ).not.toBeInTheDocument();
    expect(
      within(card("account-2")).getByRole("button", { name: "当前使用" }),
    ).toBeDisabled();
  });

  it("keeps the old account current during a switch and after a rejected switch", async () => {
    const user = userEvent.setup();
    let rejectSwitch!: (error: Error) => void;
    const switchPromise = new Promise((_, reject) => {
      rejectSwitch = reject;
    });
    const props = {
      ...commonProps(),
      onSwitchAccount: vi.fn().mockReturnValue(switchPromise),
    };
    render(<CodexAccountsPanel {...props} />);
    const switchButton = within(card("account-1")).getByRole("button", {
      name: "切换到此账号",
    });
    await user.click(switchButton);
    expect(switchButton).toBeDisabled();
    expect(card("account-1")).toHaveAttribute("data-current", "false");
    expect(card("account-2")).toHaveAttribute("data-current", "true");
    rejectSwitch(new Error("auth.json is read-only"));
    expect(
      await within(card("account-1")).findByRole("alert"),
    ).toHaveTextContent("auth.json is read-only");
    expect(card("account-1")).toHaveAttribute("data-current", "false");
    expect(card("account-2")).toHaveAttribute("data-current", "true");
    expect(switchButton).toBeEnabled();
  });

  it("updates the current marker only when refreshed effective provider changes", () => {
    const props = commonProps();
    const { rerender } = render(<CodexAccountsPanel {...props} />);
    expect(card("account-2")).toHaveAttribute("data-current", "true");
    rerender(<CodexAccountsPanel {...props} currentProviderId="first" />);
    expect(card("account-1")).toHaveAttribute("data-current", "true");
    expect(card("account-2")).toHaveAttribute("data-current", "false");
  });

  it("applies saved connection choices and discards cancelled changes", async () => {
    const user = userEvent.setup();
    const props = {
      ...commonProps(),
      providers: [
        provider("config-A", "account-1"),
        provider("config-B", "account-1"),
      ],
    };
    render(<CodexAccountsPanel {...props} />);
    const account = within(card("account-1"));
    const edit = () =>
      user.click(
        account.getByRole("button", {
          name: "编辑账号: account-1@example.com",
        }),
      );
    expect(account.getByRole("button", { name: "切换到此账号" })).toBeEnabled();
    expect(account.queryByRole("combobox")).not.toBeInTheDocument();
    await edit();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenLastCalledWith(
      "account-1",
      undefined,
    );
    await edit();
    expect(screen.getByRole("combobox")).toHaveTextContent("自动选择");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenLastCalledWith(
      "account-1",
      "config-B",
    );
    await edit();
    expect(screen.getByRole("combobox")).toHaveTextContent("config-B");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-A" }));
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenLastCalledWith(
      "account-1",
      "config-B",
    );
  });

  it("retains the previous connection choice when saving the editor fails", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      updateAccount: vi
        .fn()
        .mockRejectedValue(new Error("Store is not writable")),
    });
    const props = {
      ...commonProps(),
      providers: [
        provider("config-A", "account-1"),
        provider("config-B", "account-1"),
      ],
    };
    render(<CodexAccountsPanel {...props} />);
    const account = within(card("account-1"));
    await user.click(
      account.getByRole("button", { name: "编辑账号: account-1@example.com" }),
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Store is not writable",
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("config-B");
    await user.click(screen.getByRole("button", { name: "取消" }));
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenCalledWith("account-1", undefined);
  });

  it("allows an expired account to edit and reauthenticate while blocking switching", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: accounts.map((account) => ({
        ...account,
        reauth_required: true,
      })),
    });
    render(<CodexAccountsPanel {...commonProps()} currentProviderId="" />);
    const account = within(card("unbound"));
    expect(
      account.getByRole("button", { name: "切换到此账号" }),
    ).toBeDisabled();
    expect(
      account.queryByRole("button", { name: "重新登录" }),
    ).not.toBeInTheDocument();
    await user.click(
      account.getByRole("button", { name: "编辑账号: unbound@example.com" }),
    );
    expect(
      screen.getByRole("dialog", { name: "编辑账号" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("登录身份")).toHaveAttribute("readonly");
    expect(screen.queryByText("高级连接")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重新登录" }));
    expect(auth.reauthAccount).toHaveBeenCalledWith("unbound");
    expect(
      screen.queryByRole("dialog", { name: "编辑账号" }),
    ).not.toBeInTheDocument();
  });

  it.each(["expired", "not_found"] as const)(
    "disables only the account with cached %s credentials while preserving edit and reauthentication",
    async (credentialStatus) => {
      const user = userEvent.setup();
      const auth = mocks.useCodexOauth();
      const unavailable: SubscriptionQuota = {
        tool: "codex_oauth",
        credentialStatus,
        credentialMessage: "Please sign in again",
        success: false,
        tiers: [],
        extraUsage: null,
        error: null,
        queriedAt: Date.now(),
      };
      const key = ["codex_oauth", "quota", "account-1"];
      queryClient.setQueryData(key, unavailable);
      queryClient.setQueryData(["codex_oauth", "quota", "account-2"], {
        ...unavailable,
        credentialStatus: "valid",
        success: true,
      });
      render(<CodexAccountsPanel {...commonProps()} currentProviderId="" />);
      const first = within(card("account-1"));
      const second = within(card("account-2"));
      expect(
        first.getByRole("button", { name: "切换到此账号" }),
      ).toBeDisabled();
      expect(
        second.getByRole("button", { name: "切换到此账号" }),
      ).toBeEnabled();
      expect(
        within(card("unbound")).getByRole("button", { name: "切换到此账号" }),
      ).toBeEnabled();
      expect(
        first.queryByRole("button", { name: "重新登录" }),
      ).not.toBeInTheDocument();
      await user.click(
        first.getByRole("button", { name: "编辑账号: account-1@example.com" }),
      );
      expect(
        screen.getByRole("dialog", { name: "编辑账号" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("登录身份")).toHaveAttribute("readonly");
      await user.click(screen.getByRole("button", { name: "重新登录" }));
      expect(auth.reauthAccount).toHaveBeenCalledWith("account-1");
      act(() =>
        queryClient.setQueryData(key, {
          ...unavailable,
          credentialStatus: "valid",
          success: true,
        }),
      );
      await waitFor(() =>
        expect(
          first.getByRole("button", { name: "切换到此账号" }),
        ).toBeEnabled(),
      );
      expect(mocks.getCodexOauthQuota).not.toHaveBeenCalled();
    },
  );

  it("does not treat a quota transport failure as expired credentials", () => {
    queryClient.setQueryData(["codex_oauth", "quota", "account-1"], {
      tool: "codex_oauth",
      credentialStatus: "valid",
      credentialMessage: null,
      success: false,
      tiers: [],
      extraUsage: null,
      error: "HTTP 503",
      queriedAt: Date.now(),
    } satisfies SubscriptionQuota);
    render(<CodexAccountsPanel {...commonProps()} currentProviderId="" />);
    expect(
      within(card("account-1")).getByRole("button", { name: "切换到此账号" }),
    ).toBeEnabled();
    expect(mocks.getCodexOauthQuota).not.toHaveBeenCalled();
  });

  it("keeps the OAuth default independent of the current account and manages it in the editor", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    const props = commonProps();
    const { rerender } = render(<CodexAccountsPanel {...props} />);
    expect(within(card("account-2")).getByText("当前使用")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "设为默认" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "移除账号" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("高级选项")).not.toBeInTheDocument();
    await user.click(
      within(card("account-2")).getByRole("button", {
        name: "编辑账号: account-2@example.com",
      }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "编辑账号" }));
    await user.type(dialog.getByLabelText("显示名称"), "Draft");
    await user.click(dialog.getByRole("button", { name: "设为默认" }));
    expect(auth.setDefaultAccount).toHaveBeenCalledWith("account-2");
    expect(props.onSwitchAccount).not.toHaveBeenCalled();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      isSettingDefaultAccount: true,
    });
    rerender(<CodexAccountsPanel {...props} />);
    expect(dialog.getByRole("button", { name: "设为默认" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      error: "Default account could not be saved",
    });
    rerender(<CodexAccountsPanel {...props} />);
    expect(dialog.getByRole("alert")).toHaveTextContent(
      "Default account could not be saved",
    );
    expect(dialog.getByLabelText("显示名称")).toHaveValue("Draft");
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      defaultAccountId: "account-2",
    });
    rerender(<CodexAccountsPanel {...props} />);
    expect(dialog.getByText("默认")).toBeInTheDocument();
    expect(
      dialog.queryByRole("button", { name: "设为默认" }),
    ).not.toBeInTheDocument();
  });

  it("removes only the edited account, retains failures, and closes after status confirms removal", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    const props = commonProps();
    const { rerender } = render(<CodexAccountsPanel {...props} />);
    await user.click(
      within(card("account-1")).getByRole("button", {
        name: "编辑账号: account-1@example.com",
      }),
    );
    const dialog = within(screen.getByRole("dialog", { name: "编辑账号" }));
    await user.click(dialog.getByRole("button", { name: "移除账号" }));
    expect(auth.removeAccount).toHaveBeenCalledWith("account-1");
    expect(auth.logout).not.toHaveBeenCalled();
    mocks.useCodexOauth.mockReturnValue({ ...auth, isRemovingAccount: true });
    rerender(<CodexAccountsPanel {...props} />);
    expect(dialog.getByRole("button", { name: "移除账号" })).toBeDisabled();
    expect(dialog.getByRole("button", { name: "保存" })).toBeDisabled();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      error: "Account could not be removed",
    });
    rerender(<CodexAccountsPanel {...props} />);
    expect(dialog.getByRole("alert")).toHaveTextContent(
      "Account could not be removed",
    );
    expect(dialog.getByRole("button", { name: "移除账号" })).toBeEnabled();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: accounts.filter((account) => account.id !== "account-1"),
    });
    rerender(<CodexAccountsPanel {...props} />);
    expect(
      screen.queryByRole("dialog", { name: "编辑账号" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("account-1@example.com")).not.toBeInTheDocument();
    expect(card("account-2")).toHaveAttribute("data-current", "true");
  });

  it("keeps bulk logout exclusively in Settings Authentication, outside the account editor", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    const props = commonProps();
    const { rerender } = render(<CodexAccountsPanel {...props} />);
    expect(
      screen.queryByRole("button", { name: "注销所有账号" }),
    ).not.toBeInTheDocument();
    await user.click(
      within(card("account-1")).getByRole("button", {
        name: "编辑账号: account-1@example.com",
      }),
    );
    expect(
      screen.queryByRole("button", { name: "注销所有账号" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "取消" }));
    rerender(<AuthCenterPanel accountPanelProps={props} />);
    expect(
      screen.queryByRole("button", { name: "注销所有账号" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "更多账号操作" }));
    await user.click(screen.getByRole("menuitem", { name: "注销所有账号" }));
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(auth.removeAccount).not.toHaveBeenCalled();
  });

  it.each([
    { isLoadingProviders: true, reason: "正在加载..." },
    { isProvidersError: true, reason: "无法读取连接，请刷新后重试。" },
    { isSwitching: true, reason: "正在切换账号…" },
  ])(
    "keeps switching disabled and explains the reason for %j",
    async ({ reason, ...state }) => {
      const user = userEvent.setup();
      const props = { ...commonProps(), ...state };
      render(<CodexAccountsPanel {...props} />);
      const account = within(card("account-1"));
      const switchButton = account.getByRole("button", {
        name: "切换到此账号",
      });
      expect(switchButton).toBeDisabled();
      expect(switchButton).toHaveAttribute("title", reason);
      await user.click(account.getByRole("button", { name: "为何无法切换" }));
      expect(
        screen.getByRole("dialog", { name: "为何无法切换" }),
      ).toHaveTextContent(reason);
      expect(props.onSwitchAccount).not.toHaveBeenCalled();
    },
  );

  it("restores automatic connection choice and uses the effective provider for the current marker", async () => {
    const user = userEvent.setup();
    const props = {
      ...commonProps(),
      providers: [
        provider("config-A", "account-1"),
        provider("config-B", "account-1"),
      ],
      currentProviderId: "config-A",
    };
    render(<CodexAccountsPanel {...props} />);
    const account = within(card("account-1"));
    expect(account.getByRole("button", { name: "当前使用" })).toBeDisabled();
    await user.click(
      account.getByRole("button", { name: "编辑账号: account-1@example.com" }),
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(card("account-1")).toHaveAttribute("data-current", "true");
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenLastCalledWith(
      "account-1",
      "config-B",
    );
    await user.click(
      account.getByRole("button", { name: "编辑账号: account-1@example.com" }),
    );
    expect(screen.getByRole("combobox")).toHaveTextContent("config-B");
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "自动选择" }));
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(account.getByRole("button", { name: "当前使用" })).toBeDisabled();
    expect(props.onSwitchAccount).toHaveBeenCalledTimes(1);
  });

  it("saves only account appearance and restores it when reopening an editor", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    const { rerender } = render(<CodexAccountsPanel {...commonProps()} />);
    await user.click(
      within(card("account-1")).getByRole("button", {
        name: "编辑账号: account-1@example.com",
      }),
    );
    await user.type(screen.getByLabelText("显示名称"), "Work account");
    await user.type(screen.getByLabelText("备注"), "For projects");
    await user.click(
      within(screen.getByRole("group", { name: "图标" })).getAllByRole(
        "button",
      )[1],
    );
    await user.click(screen.getByRole("checkbox", { name: "自定义颜色" }));
    fireEvent.change(screen.getByLabelText("颜色"), {
      target: { value: "#cc8844" },
    });
    await user.click(screen.getByRole("button", { name: "保存" }));
    const appearance = {
      display_name: "Work account",
      notes: "For projects",
      icon: "star",
      color: "#cc8844",
    };
    expect(auth.updateAccount).toHaveBeenCalledWith("account-1", appearance);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(auth.setDefaultAccount).not.toHaveBeenCalled();
    expect(auth.reauthAccount).not.toHaveBeenCalled();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: accounts.map((account) =>
        account.id === "account-1" ? { ...account, ...appearance } : account,
      ),
    });
    rerender(<CodexAccountsPanel {...commonProps()} />);
    expect(screen.getByText("Work account")).toBeInTheDocument();
    expect(screen.getByText("For projects")).toBeInTheDocument();
    await user.click(
      within(card("account-1")).getByRole("button", {
        name: "编辑账号: account-1@example.com",
      }),
    );
    expect(screen.getByLabelText("显示名称")).toHaveValue("Work account");
    expect(screen.getByLabelText("备注")).toHaveValue("For projects");
    expect(screen.getByLabelText("颜色")).toHaveValue("#cc8844");
    expect(screen.getByLabelText("登录身份")).toHaveValue(
      "account-1@example.com",
    );
  });

  it("retains the edit dialog and unsaved values when saving fails", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      updateAccount: vi
        .fn()
        .mockRejectedValue(new Error("Store is not writable")),
    });
    render(<CodexAccountsPanel {...commonProps()} />);
    await user.click(
      within(card("account-1")).getByRole("button", {
        name: "编辑账号: account-1@example.com",
      }),
    );
    await user.type(screen.getByLabelText("显示名称"), "Draft");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Store is not writable",
    );
    expect(screen.getByLabelText("显示名称")).toHaveValue("Draft");
    expect(
      screen.getByRole("dialog", { name: "编辑账号" }),
    ).toBeInTheDocument();
    expect(card("account-2")).toHaveAttribute("data-current", "true");
  });

  it("hides stale account/quota state on status failure and offers retry", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      isStatusSuccess: false,
      isStatusError: true,
    });
    render(<CodexAccountsPanel {...commonProps()} />);
    expect(screen.queryByTestId("account-quota")).not.toBeInTheDocument();
    expect(screen.queryByText("当前使用")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(auth.refetchStatus).toHaveBeenCalled();
  });
});
