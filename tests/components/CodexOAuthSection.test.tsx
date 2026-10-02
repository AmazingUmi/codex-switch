import { useState } from "react";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";

const mocks = vi.hoisted(() => ({
  useCodexOauth: vi.fn(),
  renderAccountQuota: vi.fn(),
}));

vi.mock("@/components/providers/forms/hooks/useCodexOauth", () => ({
  useCodexOauth: mocks.useCodexOauth,
}));

vi.mock("@/components/CodexOauthAccountQuota", () => ({
  default: ({
    accountId,
    enabled,
    children,
  }: {
    accountId: string;
    enabled: boolean;
    children: (
      query: { isFetching: boolean; refetch: () => void },
      view: React.ReactNode,
    ) => React.ReactNode;
  }) => {
    if (enabled) mocks.renderAccountQuota(accountId);
    return children(
      { isFetching: false, refetch: vi.fn() },
      enabled ? <div data-testid="account-quota">{accountId}</div> : null,
    );
  },
}));

vi.mock("@/components/providers/forms/CopilotAuthSection", () => ({
  CopilotAuthSection: () => <div />,
}));

vi.mock("@/components/providers/forms/XaiOAuthSection", () => ({
  XaiOAuthSection: () => <div />,
}));

describe("CodexOAuthSection", () => {
  let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    mocks.useCodexOauth.mockReturnValue({
      accounts: [
        {
          id: "account-1",
          provider: "codex_oauth",
          login: "user@example.com",
          avatar_url: null,
          authenticated_at: 0,
          is_default: true,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
        {
          id: "account-2",
          provider: "codex_oauth",
          login: "second@example.com",
          avatar_url: null,
          authenticated_at: 1,
          is_default: false,
          github_domain: "",
          reauth_required: false,
          requires_reauth: false,
        },
      ],
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
  });

  afterEach(() => {
    if (scrollIntoViewDescriptor) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        scrollIntoViewDescriptor,
      );
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("does not render account quota by default", () => {
    render(<CodexOAuthSection />);

    expect(mocks.renderAccountQuota).not.toHaveBeenCalled();
    expect(screen.queryByTestId("account-quota")).not.toBeInTheDocument();
  });

  it.each(["ready", "loading", "failed"])(
    "routes the shared home add entry to the chooser while OAuth status is %s",
    async (state) => {
      const user = userEvent.setup();
      const auth = mocks.useCodexOauth();
      const onAddAccount = vi.fn();
      mocks.useCodexOauth.mockReturnValue({
        ...auth,
        isStatusSuccess: state === "ready",
        isStatusError: state === "failed",
      });
      render(
        <CodexOAuthSection presentation="cards" onAddAccount={onAddAccount} />,
      );
      await user.click(screen.getByRole("button", { name: "添加" }));
      expect(onAddAccount).toHaveBeenCalledWith(auth.addAccount);
      expect(auth.addAccount).not.toHaveBeenCalled();
      onAddAccount.mock.calls[0][0]();
      expect(auth.addAccount).toHaveBeenCalledOnce();
    },
  );

  it("keeps the direct login action when no shared chooser is provided", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    render(<CodexOAuthSection presentation="cards" />);
    await user.click(screen.getByRole("button", { name: "添加其他账号" }));
    expect(auth.addAccount).toHaveBeenCalledOnce();
  });

  it("opens bulk logout from the account header and invokes the existing logout action", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    render(<CodexOAuthSection presentation="cards" showLogoutAll />);
    expect(screen.queryByText("注销所有账号")).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "更多账号操作" });
    await user.click(more);
    await user.click(screen.getByRole("menuitem", { name: "注销所有账号" }));
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(auth.removeAccount).not.toHaveBeenCalled();
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });

  it("allows keyboard dismissal of bulk logout without logging out", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    render(<CodexOAuthSection presentation="cards" showLogoutAll />);
    const more = screen.getByRole("button", { name: "更多账号操作" });
    more.focus();
    await user.keyboard("{Enter}");
    expect(
      screen.getByRole("menuitem", { name: "注销所有账号" }),
    ).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
    expect(auth.logout).not.toHaveBeenCalled();
    await waitFor(() => expect(more).toHaveFocus());
  });

  it.each(["isAddingAccount", "isRemovingAccount", "isSettingDefaultAccount"])(
    "disables bulk logout while %s is active",
    async (pendingFlag) => {
      const user = userEvent.setup();
      const auth = mocks.useCodexOauth();
      mocks.useCodexOauth.mockReturnValue({ ...auth, [pendingFlag]: true });
      render(<CodexOAuthSection presentation="cards" showLogoutAll />);
      await user.click(screen.getByRole("button", { name: "更多账号操作" }));
      const logout = screen.getByRole("menuitem", { name: "注销所有账号" });
      expect(logout).toHaveAttribute("aria-disabled", "true");
      await user.click(logout);
      expect(auth.logout).not.toHaveBeenCalled();
    },
  );

  it.each(["loading", "failed", "empty", "hidden"])(
    "hides the bulk menu when account state is %s",
    (state) => {
      const auth = mocks.useCodexOauth();
      mocks.useCodexOauth.mockReturnValue({
        ...auth,
        isStatusSuccess: state !== "loading" && state !== "failed",
        isStatusError: state === "failed",
        accounts: state === "empty" ? [] : auth.accounts,
        hasAnyAccount: state !== "empty",
      });
      render(
        <CodexOAuthSection
          presentation="cards"
          showLogoutAll={state !== "hidden"}
        />,
      );
      expect(
        screen.queryByRole("button", { name: "更多账号操作" }),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("注销所有账号")).not.toBeInTheDocument();
      const header = screen.getByRole("heading", {
        name: "订阅账户",
      }).parentElement!;
      if (state === "loading" || state === "failed") {
        expect(within(header).queryByText("2 个账号")).not.toBeInTheDocument();
        expect(
          within(header).getByText(
            state === "loading" ? "正在加载..." : "状态不可用",
          ),
        ).toBeInTheDocument();
      }
    },
  );

  it("shows the loaded account count as neutral header text", () => {
    render(<CodexOAuthSection presentation="cards" />);
    const count = screen.getByText("2 个账号");
    expect(count).toHaveClass("text-muted-foreground");
    expect(count).not.toHaveClass("bg-green-500");
  });

  it("stretches home account cards into equal grid rows despite differing metadata", () => {
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: [
        {
          ...auth.accounts[0],
          display_name: "Primary",
          notes: "A long note ".repeat(40).trim(),
        },
        auth.accounts[1],
      ],
    });
    const { container } = render(
      <CodexOAuthSection presentation="cards" showAccountQuota />,
    );
    const cards = container.querySelectorAll("[data-account-id]");
    expect(cards).toHaveLength(2);
    expect(cards[0].parentElement).toHaveClass("auto-rows-fr", "items-stretch");
    for (const card of cards) {
      expect(card).toHaveClass("h-full", "flex-col");
    }
    expect(screen.getByText("Primary")).toBeInTheDocument();
    expect(
      screen.getByTitle("A long note ".repeat(40).trim()),
    ).toBeInTheDocument();
    expect(mocks.renderAccountQuota).toHaveBeenCalledWith("account-1");
    expect(mocks.renderAccountQuota).toHaveBeenCalledWith("account-2");
  });

  it("renders account quota in Auth Center", () => {
    render(<AuthCenterPanel />);

    expect(mocks.renderAccountQuota).toHaveBeenCalledWith("account-1");
    expect(mocks.renderAccountQuota).toHaveBeenCalledWith("account-2");
    expect(
      screen.getAllByTestId("account-quota").map((quota) => quota.textContent),
    ).toEqual(["account-1", "account-2"]);
  });

  it("exposes Settings bulk logout with a single remaining account", async () => {
    const user = userEvent.setup();
    const auth = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...auth,
      accounts: [auth.accounts[0]],
    });
    render(<AuthCenterPanel />);
    await user.click(screen.getByRole("button", { name: "注销所有账号" }));
    expect(auth.logout).toHaveBeenCalledOnce();
    expect(auth.removeAccount).not.toHaveBeenCalled();
  });

  it("reauthenticates the selected legacy account in place", async () => {
    const user = userEvent.setup();
    const authResult = mocks.useCodexOauth();
    const reauthAccount = vi.fn();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      reauthAccount,
      accounts: [
        {
          ...authResult.accounts[0],
          reauth_required: true,
        },
      ],
    });

    render(<CodexOAuthSection />);
    await user.click(
      screen.getByRole("button", { name: "编辑账号: user@example.com" }),
    );
    await user.click(screen.getByRole("button", { name: "重新登录" }));

    expect(reauthAccount).toHaveBeenCalledWith("account-1");
    expect(authResult.addAccount).not.toHaveBeenCalled();
  });

  it("allows an existing account to reauthenticate in place", async () => {
    const user = userEvent.setup();
    const authResult = mocks.useCodexOauth();
    const reauthAccount = vi.fn();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      reauthAccount,
      accounts: [authResult.accounts[0]],
    });

    render(<CodexOAuthSection />);
    await user.click(
      screen.getByRole("button", { name: "编辑账号: user@example.com" }),
    );
    await user.click(screen.getByRole("button", { name: "重新登录" }));

    expect(reauthAccount).toHaveBeenCalledWith("account-1");
  });

  it("selects a specific account when multiple accounts are managed", async () => {
    const user = userEvent.setup();
    const onAccountSelect = vi.fn();
    const ControlledSection = () => {
      const [selectedAccountId, setSelectedAccountId] = useState<string | null>(
        "account-1",
      );
      return (
        <CodexOAuthSection
          mode="select"
          selectedAccountId={selectedAccountId}
          onAccountSelect={(accountId) => {
            onAccountSelect(accountId);
            setSelectedAccountId(accountId);
          }}
        />
      );
    };
    render(<ControlledSection />);

    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: /second@example\.com/ }),
    );

    expect(onAccountSelect).toHaveBeenCalledWith("account-2");
    expect(screen.getByRole("combobox")).toHaveTextContent(
      "second@example.com",
    );
  });

  it("locks the native card to the current Codex login", async () => {
    const user = userEvent.setup();
    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId={null}
        onAccountSelect={vi.fn()}
        noneOptionLabel="Use Codex current login"
        nativeLoginOnly
      />,
    );

    const selector = screen.getByRole("combobox");
    expect(selector).toBeDisabled();
    expect(selector).toHaveTextContent("Use Codex current login");
    await user.click(selector);
    expect(
      screen.queryByRole("option", { name: /user@example\.com/ }),
    ).not.toBeInTheDocument();
  });

  it("requires a managed account on managed Official cards", async () => {
    const user = userEvent.setup();
    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId="account-1"
        onAccountSelect={vi.fn()}
        noneOptionLabel="Use Codex current login"
        allowUnboundSelection={false}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    expect(
      screen.queryByRole("option", { name: "Use Codex current login" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /second@example\.com/ }),
    ).toBeInTheDocument();
  });

  it("shows a disabled account prompt before a managed account is selected", () => {
    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId={null}
        onAccountSelect={vi.fn()}
        allowUnboundSelection={false}
      />,
    );

    const accountPlaceholder = screen.getByText("请选择登录方式");
    expect(accountPlaceholder.parentElement).toHaveClass(
      "text-sm",
      "font-normal",
      "text-muted-foreground",
    );
  });

  it("does not default a new Official card to the current Codex login", async () => {
    const user = userEvent.setup();
    const onAccountSelect = vi.fn();
    const onSelectionConfirmed = vi.fn();
    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId={null}
        onAccountSelect={onAccountSelect}
        onSelectionConfirmed={onSelectionConfirmed}
        noneOptionLabel="Follow Codex login"
        noneOptionDescription="The account changes with the current Codex CLI login"
        allowUnboundSelection
        requireExplicitSelection
        onManageAccounts={vi.fn()}
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("请选择登录方式");

    await user.click(screen.getByRole("combobox"));
    const optionLabels = (await screen.findAllByRole("option")).map(
      (option) => option.textContent,
    );
    const manageOptionIndex = optionLabels.findIndex((label) =>
      label?.includes("添加或管理 ChatGPT 账号"),
    );
    const nativeOptionIndex = optionLabels.findIndex((label) =>
      label?.includes("Follow Codex login"),
    );

    expect(optionLabels.indexOf("user@example.com")).toBeLessThan(
      manageOptionIndex,
    );
    expect(manageOptionIndex).toBeLessThan(nativeOptionIndex);
    expect(nativeOptionIndex).toBe(optionLabels.length - 1);
    expect(
      document.querySelectorAll('[data-account-divider="true"]'),
    ).toHaveLength(2);

    await user.click(
      await screen.findByRole("option", { name: /Follow Codex login/ }),
    );

    expect(onSelectionConfirmed).toHaveBeenCalledTimes(1);
    expect(onAccountSelect).toHaveBeenCalledWith(null);
  });

  it("keeps an offline unbound choice available when account status fails", async () => {
    const user = userEvent.setup();
    const authResult = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: [],
      isStatusSuccess: false,
      isStatusError: true,
      hasAnyAccount: false,
    });
    const onAccountSelect = vi.fn();
    const onSelectionConfirmed = vi.fn();

    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId={null}
        onAccountSelect={onAccountSelect}
        onSelectionConfirmed={onSelectionConfirmed}
        noneOptionLabel="Follow Codex login"
        allowUnboundSelection
        allowUnboundSelectionWithoutStatus
        requireExplicitSelection
      />,
    );

    expect(screen.getByRole("alert")).toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "Follow Codex login" }),
    );
    expect(onAccountSelect).toHaveBeenCalledWith(null);
    expect(onSelectionConfirmed).toHaveBeenCalledOnce();
  });

  it("does not label a retained managed binding as native login when status fails", () => {
    const authResult = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: [],
      isStatusSuccess: false,
      isStatusError: true,
      hasAnyAccount: false,
    });

    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId="account-1"
        onAccountSelect={vi.fn()}
        noneOptionLabel="Follow Codex login"
        allowUnboundSelection
        allowUnboundSelectionWithoutStatus
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("无法读取账号信息");
    expect(screen.getByRole("combobox")).not.toHaveTextContent(
      "Follow Codex login",
    );
  });

  it("keeps a retained managed binding in loading state while status is pending", () => {
    const authResult = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: [],
      isStatusSuccess: false,
      isStatusError: false,
      hasAnyAccount: false,
    });

    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId="account-1"
        onAccountSelect={vi.fn()}
        noneOptionLabel="Follow Codex login"
        allowUnboundSelection
        allowUnboundSelectionWithoutStatus
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("正在加载账号…");
    expect(screen.getByRole("combobox")).not.toHaveTextContent(
      "Follow Codex login",
    );
  });

  it("labels a missing managed binding as unavailable after status loads", () => {
    const authResult = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: [],
      isStatusSuccess: true,
      isStatusError: false,
      hasAnyAccount: false,
    });

    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId="account-1"
        onAccountSelect={vi.fn()}
        noneOptionLabel="Follow Codex login"
        allowUnboundSelection
      />,
    );

    expect(screen.getByRole("combobox")).toHaveTextContent("绑定的账号不可用");
    expect(screen.getByRole("combobox")).not.toHaveTextContent(
      "Follow Codex login",
    );
  });

  it("truncates a long account login while preserving its full text", async () => {
    const user = userEvent.setup();
    const longLogin =
      "a-very-long-personal-account-name-that-must-not-expand-the-card@example.com";
    const authResult = mocks.useCodexOauth();
    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: [
        {
          ...authResult.accounts[0],
          id: "long-account",
          login: longLogin,
        },
      ],
      defaultAccountId: "long-account",
    });

    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId="long-account"
        onAccountSelect={vi.fn()}
      />,
    );

    expect(screen.getByTitle(longLogin)).toHaveClass("truncate");
    expect(screen.getByRole("combobox")).toHaveTextContent(longLogin);

    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", { name: longLogin });
    expect(screen.getByRole("listbox")).toHaveClass(
      "w-[var(--radix-select-trigger-width)]",
      "max-w-[var(--radix-select-content-available-width)]",
    );
    expect(option.querySelector(`[title="${longLogin}"]`)).toHaveClass(
      "truncate",
    );
  });

  it("does not attach Codex CLI guidance to a generic unbound choice", async () => {
    const user = userEvent.setup();
    render(
      <CodexOAuthSection
        mode="select"
        selectedAccountId={null}
        onAccountSelect={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    const option = await screen.findByRole("option", {
      name: "使用默认账号",
    });
    expect(option).not.toHaveTextContent("Codex CLI");
  });

  it("reports automatic invalidation separately from a user choice", async () => {
    const user = userEvent.setup();
    const authResult = mocks.useCodexOauth();
    const onAccountSelect = vi.fn();
    const onSelectionConfirmed = vi.fn();
    const onSelectionInvalidated = vi.fn();
    const props = {
      mode: "select" as const,
      selectedAccountId: "account-1",
      onAccountSelect,
      onSelectionConfirmed,
      onSelectionInvalidated,
    };
    const { rerender } = render(<CodexOAuthSection {...props} />);

    mocks.useCodexOauth.mockReturnValue({
      ...authResult,
      accounts: authResult.accounts.filter(
        (account: { id: string }) => account.id !== "account-1",
      ),
    });
    rerender(<CodexOAuthSection {...props} />);

    await waitFor(() => expect(onSelectionInvalidated).toHaveBeenCalledOnce());
    expect(onAccountSelect).toHaveBeenCalledWith(null);
    expect(onSelectionConfirmed).not.toHaveBeenCalled();

    rerender(<CodexOAuthSection {...props} selectedAccountId={null} />);
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "second@example.com" }),
    );
    expect(onAccountSelect).toHaveBeenLastCalledWith("account-2");
    expect(onSelectionConfirmed).toHaveBeenCalledOnce();
  });
});
