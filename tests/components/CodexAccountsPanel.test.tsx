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
    const help = screen.getByRole("button", { name: "账号与额度说明" });
    await user.tab();
    expect(help).toHaveFocus();
    await user.keyboard("{Enter}");
    const explanation = screen.getByRole("dialog", { name: "账号与额度说明" });
    expect(explanation).toHaveTextContent(/登录后的 ChatGPT 账号可以直接切换/);
    expect(explanation).toHaveTextContent(/百分比表示已使用额度/);
    await user.keyboard("{Escape}");
    expect(help).toHaveFocus();
    expect(
      within(card("account-2")).getByRole("button", {
        name: "编辑账号: account-2@example.com",
      }),
    ).toHaveAttribute("title", "编辑账号");
    expect(
      within(card("account-2")).queryByRole("button", { name: "设为默认" }),
    ).not.toBeVisible();
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

  it("preserves optional multiple advanced connections without blocking the ordinary account switch", async () => {
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
    expect(account.getByRole("button", { name: "切换到此账号" })).toBeEnabled();
    expect(account.getByRole("combobox")).not.toBeVisible();
    await user.click(account.getByText("高级连接"));
    await user.click(account.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "config-B" }));
    await user.click(account.getByRole("button", { name: "切换到此账号" }));
    expect(props.onSwitchAccount).toHaveBeenCalledWith("account-1", "config-B");
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
    await user.click(account.getByRole("button", { name: "重新登录" }));
    expect(auth.reauthAccount).toHaveBeenCalledWith("unbound");
    await user.click(
      account.getByRole("button", { name: "编辑账号: unbound@example.com" }),
    );
    expect(
      screen.getByRole("dialog", { name: "编辑账号" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("登录身份")).toHaveAttribute("readonly");
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
      await user.click(first.getByRole("button", { name: "重新登录" }));
      expect(auth.reauthAccount).toHaveBeenCalledWith("account-1");
      await user.click(
        first.getByRole("button", { name: "编辑账号: account-1@example.com" }),
      );
      expect(
        screen.getByRole("dialog", { name: "编辑账号" }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("登录身份")).toHaveAttribute("readonly");
      await user.click(screen.getByRole("button", { name: "取消" }));
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
