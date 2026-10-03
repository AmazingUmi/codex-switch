import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { createTestQueryClient } from "../utils/testQueryClient";

const authState = vi.hoisted(() => ({
  codexReauthRequired: false,
  codexStatusSuccess: true,
  xaiAuthenticated: false,
}));
const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: {
    error: toastMocks.error,
    success: vi.fn(),
  },
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: ({
    selectedAccountId,
    onAccountSelect,
    onSelectionConfirmed,
    onSelectionInvalidated,
    allowUnboundSelection = true,
    allowUnboundSelectionWithoutStatus = false,
  }: {
    selectedAccountId?: string | null;
    onAccountSelect?: (accountId: string | null) => void;
    onSelectionConfirmed?: () => void;
    onSelectionInvalidated?: () => void;
    allowUnboundSelection?: boolean;
    allowUnboundSelectionWithoutStatus?: boolean;
  }) => (
    <div>
      <output data-testid="selected-managed-account">
        {selectedAccountId}
      </output>
      <output data-testid="allow-unbound-selection">
        {allowUnboundSelection ? "true" : "false"}
      </output>
      <output data-testid="allow-unbound-without-status">
        {allowUnboundSelectionWithoutStatus ? "true" : "false"}
      </output>
      <button
        type="button"
        onClick={() => {
          onSelectionConfirmed?.();
          onAccountSelect?.("acct-managed");
        }}
      >
        select-managed-account
      </button>
      {allowUnboundSelection && (
        <button
          type="button"
          onClick={() => {
            onSelectionConfirmed?.();
            onAccountSelect?.(null);
          }}
        >
          select-native-login
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          onSelectionInvalidated?.();
          onAccountSelect?.(null);
        }}
      >
        invalidate-selected-account
      </button>
    </div>
  ),
}));

vi.mock("@/components/providers/forms/CodexConfigEditor", () => ({
  default: () => <div data-testid="codex-config-editor" />,
}));

vi.mock("@/components/providers/forms/ProviderAdvancedConfig", () => ({
  ProviderAdvancedConfig: () => <div data-testid="advanced-config" />,
}));

vi.mock("@/components/providers/forms/hooks", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/providers/forms/hooks")>();
  return {
    ...actual,
    useCopilotAuth: () => ({
      isAuthenticated: false,
      isStatusSuccess: true,
      isStatusError: false,
      accounts: [],
    }),
    useCodexOauth: () => ({
      isAuthenticated: true,
      isStatusSuccess: authState.codexStatusSuccess,
      isStatusError: false,
      defaultAccountId: "acct-managed",
      accounts: [
        {
          id: "acct-managed",
          login: "user@example.com",
          is_default: true,
          reauth_required: authState.codexReauthRequired,
          requires_reauth: false,
        },
      ],
    }),
    useXaiOauth: () => ({
      isAuthenticated: authState.xaiAuthenticated,
      accounts: authState.xaiAuthenticated
        ? [{ id: "xai-legacy", requires_reauth: false }]
        : [],
    }),
  };
});

vi.mock("@/lib/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query")>();
  return {
    ...actual,
    useSettingsQuery: () => ({
      data: { commonConfigConfirmed: true },
    }),
  };
});

function renderCodexForm(
  onSubmit: (values: ProviderFormValues) => void,
  restrictCodexCreation = false,
  initialCodexAccountId?: string,
  apiKeyOnly = false,
) {
  const queryClient = createTestQueryClient();
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          initialCodexAccountId={initialCodexAccountId}
          restrictCodexCreation={restrictCodexCreation}
          productShell={restrictCodexCreation}
          apiKeyOnly={apiKeyOnly}
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
        />
      </QueryClientProvider>
    </StrictMode>,
  );
}

describe("ProviderForm Codex Official managed account", () => {
  beforeEach(() => {
    authState.codexReauthRequired = false;
    authState.codexStatusSuccess = true;
    authState.xaiAuthenticated = false;
    toastMocks.error.mockReset();
  });

  it("seeds a homepage account in an official configuration without overwriting later selection", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit, true, "acct-managed");
    expect(
      await screen.findByTestId("selected-managed-account"),
    ).toHaveTextContent("acct-managed");
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta.authBinding.accountId).toBe(
      "acct-managed",
    );
    fireEvent.click(screen.getByText("invalidate-selected-account"));
    expect(
      screen.getByTestId("selected-managed-account"),
    ).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("请先选择登录方式"),
    );
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it.each(["acct-missing", "acct-managed"])(
    "keeps the submit safety gate for seeded %s",
    async (accountId) => {
      if (accountId === "acct-managed") authState.codexStatusSuccess = false;
      const onSubmit = vi.fn();
      renderCodexForm(onSubmit, true, accountId);
      await screen.findByTestId("selected-managed-account");
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
      expect(onSubmit).not.toHaveBeenCalled();
    },
  );

  it("offers only OpenAI API, ChatGPT Official and DeepSeek creation in the product", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit, true);
    expect(
      screen.getByRole("button", { name: "OpenAI API" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /OpenAI Official/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /DeepSeek/ }),
    ).toBeInTheDocument();
    for (const name of [/MiniMax/i, /Grok/i, /Kimi/i, /Gemini/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /OpenAI Official/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "select-managed-account" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta.authBinding.accountId).toBe(
      "acct-managed",
    );
    expect(JSON.parse(onSubmit.mock.calls[0][0].settingsConfig).auth).toEqual(
      {},
    );
  });

  it("uses the official OpenAI endpoint for the API creation template", async () => {
    renderCodexForm(vi.fn(), true);
    fireEvent.click(screen.getByRole("button", { name: "OpenAI API" }));
    await waitFor(() =>
      expect(screen.getByLabelText("codexConfig.apiUrlLabel")).toHaveValue(
        "https://api.openai.com/v1",
      ),
    );
  });

  it("creates the API Key branch without choosing a ChatGPT account", async () => {
    authState.codexStatusSuccess = false;
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit, true, undefined, true);
    expect(
      screen.queryByRole("button", { name: /OpenAI Official/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("selected-managed-account"),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("codexConfig.apiUrlLabel")).toHaveValue(
      "https://api.openai.com/v1",
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "openai-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted.name).toBe("OpenAI API");
    expect(JSON.parse(submitted.settingsConfig)).toMatchObject({
      auth: { OPENAI_API_KEY: "openai-test-key" },
      config: expect.stringContaining('wire_api = "responses"'),
    });
    expect(submitted.meta?.authBinding).toBeUndefined();
    expect(submitted.meta?.providerType).toBeUndefined();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "preserves the existing %s managed login editor when apiKeyOnly is supplied",
    async (managed) => {
      const onSubmit = vi.fn();
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId="codex"
            providerId="codex-official"
            productShell
            apiKeyOnly
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            initialData={{
              name: "OpenAI Official",
              category: "official",
              settingsConfig: { auth: {}, config: "" },
              ...(managed
                ? {
                    meta: {
                      providerType: "codex_oauth",
                      authBinding: {
                        source: "managed_account",
                        authProvider: "codex_oauth",
                        accountId: "acct-managed",
                      },
                    },
                  }
                : {}),
            }}
          />
        </QueryClientProvider>,
      );
      expect(
        screen.getByRole("button", { name: "select-native-login" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "select-managed-account" }),
      ).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
      expect(submitted.presetCategory).toBe("official");
      if (managed) {
        expect(submitted.meta?.authBinding?.accountId).toBe("acct-managed");
      } else {
        expect(submitted.meta?.authBinding).toBeUndefined();
      }
    },
  );

  it("creates DeepSeek with a native Responses catalog and no routing controls", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit, true);
    fireEvent.click(screen.getByRole("button", { name: /DeepSeek/ }));
    await waitFor(() =>
      expect(screen.getByLabelText("codexConfig.apiUrlLabel")).toHaveValue(
        "https://api.deepseek.com",
      ),
    );
    expect(screen.getByLabelText("默认模型")).toHaveValue("deepseek-flash");
    expect(screen.queryByText("上游格式")).not.toBeInTheDocument();
    expect(screen.queryByText("完整 URL")).not.toBeInTheDocument();
    expect(screen.queryByText("管理和测速")).not.toBeInTheDocument();
    expect(screen.queryByText("Custom User-Agent")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "deepseek-test-key" },
    });
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    const settings = JSON.parse(submitted.settingsConfig);
    expect(settings.config).toContain('wire_api = "responses"');
    expect(settings.config).toContain('model = "deepseek-flash"');
    expect(settings.auth).toEqual({ OPENAI_API_KEY: "deepseek-test-key" });
    expect(settings.modelCatalog.models[0]).toMatchObject({
      model: "deepseek-flash",
      reasoningLevels: ["low", "high", "max"],
      inputModalities: ["text", "image"],
    });
    expect(submitted.meta?.apiFormat).toBe("openai_responses");
    expect(submitted.meta?.localProxyRequestOverrides).toBeUndefined();
    expect(submitted.meta?.isFullUrl).toBeUndefined();
  });

  it("preserves a saved Chat wire protocol and hidden request overrides when editing", async () => {
    const onSubmit = vi.fn();
    const config =
      'model_provider = "custom"\nmodel = "legacy-model"\n[model_providers.custom]\nname = "Legacy"\nbase_url = "https://legacy.example/v1"\nwire_api = "chat"\nrequires_openai_auth = true';
    const localProxyRequestOverrides = {
      headers: { "X-Legacy": "kept" },
      body: { legacy_option: true },
    };
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="codex"
          productShell
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Legacy",
            category: "custom",
            settingsConfig: { auth: { OPENAI_API_KEY: "saved-key" }, config },
            meta: {
              apiFormat: "openai_chat",
              localProxyRequestOverrides,
              isFullUrl: true,
            },
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(JSON.parse(submitted.settingsConfig).config).toBe(config);
    expect(submitted.meta?.apiFormat).toBe("openai_chat");
    expect(submitted.meta?.localProxyRequestOverrides).toEqual(
      localProxyRequestOverrides,
    );
    expect(submitted.meta?.isFullUrl).toBe(true);
  });

  it("hides legacy client options without changing an existing provider's saved settings", async () => {
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="codex"
          productShell
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Saved API provider",
            category: "custom",
            settingsConfig: {
              auth: { OPENAI_API_KEY: "saved-key" },
              config:
                'model_provider = "custom"\nmodel = "model-a"\n[model_providers.custom]\nname = "Saved API"\nbase_url = "https://api.example.com/v1"\nwire_api = "responses"\nrequires_openai_auth = true',
            },
            meta: {
              apiFormat: "anthropic",
              apiKeyField: "ANTHROPIC_API_KEY",
              impersonateClaudeCode: true,
              maxOutputTokens: 4096,
              customUserAgent: "saved-client/1.0",
            },
          }}
        />
      </QueryClientProvider>,
    );
    // The native catalog section must expose no retired controls when expanded.
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
    expect(screen.getByRole("button", { name: "高级选项" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      screen.queryByText("模拟 Claude Code 客户端"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("ANTHROPIC_API_KEY（x-api-key）"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByDisplayValue("saved-client/1.0"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("codex-upstream-format"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("cannot be activated");
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).toEqual(
      expect.objectContaining({
        apiFormat: "anthropic",
        apiKeyField: "ANTHROPIC_API_KEY",
        impersonateClaudeCode: true,
        maxOutputTokens: 4096,
        customUserAgent: "saved-client/1.0",
      }),
    );
  });

  it("persists the selected managed account while stripping OAuth secrets", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /OpenAI Official/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "select-managed-account" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted).toEqual(
      expect.objectContaining({
        name: "OpenAI Official (user@example.com)",
        presetId: "codex-0",
        presetCategory: "official",
        meta: expect.objectContaining({
          providerType: "codex_oauth",
          authBinding: {
            source: "managed_account",
            authProvider: "codex_oauth",
            accountId: "acct-managed",
          },
        }),
      }),
    );
    expect(JSON.parse(submitted.settingsConfig)).toEqual({
      auth: {},
      config: "",
    });
  });

  it("defaults every new Official card to the current Codex login", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /OpenAI Official/ }));
    expect(
      await screen.findByRole("button", { name: "select-native-login" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("allow-unbound-selection")).toHaveTextContent(
      "true",
    );
    expect(
      screen.getByTestId("allow-unbound-without-status"),
    ).toHaveTextContent("true");
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted.presetCategory).toBe("official");
    expect(submitted.meta?.providerType).toBeUndefined();
    expect(submitted.meta?.authBinding).toBeUndefined();
    expect(submitted).not.toHaveProperty("codexNativeLoginSelected");
  });

  it("requires confirmation before falling back when a selected account disappears", async () => {
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /OpenAI Official/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "select-managed-account" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "invalidate-selected-account" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith("请先选择登录方式"),
    );
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "select-native-login" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.providerType).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].meta?.authBinding).toBeUndefined();
  });

  it("allows the fixed Official card to switch to a managed account", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          providerId="codex-official"
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "OpenAI Official",
            settingsConfig: { auth: {}, config: "" },
          }}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "select-managed-account" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "select-native-login" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "select-managed-account" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.authBinding).toEqual({
      source: "managed_account",
      authProvider: "codex_oauth",
      accountId: "acct-managed",
    });
    expect(onSubmit.mock.calls[0][0].meta?.providerType).toBe("codex_oauth");
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty(
      "codexNativeLoginSelected",
    );
  });

  it.each(["acct-managed", "deleted-account"])(
    "saves the selected account when the fixed card was bound to %s",
    async (previousAccountId) => {
      const queryClient = createTestQueryClient();
      const onSubmit = vi.fn();
      render(
        <QueryClientProvider client={queryClient}>
          <ProviderForm
            appId="codex"
            providerId="codex-official"
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            initialData={{
              name: "OpenAI Official",
              settingsConfig: { auth: {}, config: "" },
              meta: {
                providerType: "codex_oauth",
                authBinding: {
                  source: "managed_account",
                  authProvider: "codex_oauth",
                  accountId: previousAccountId,
                },
              },
            }}
          />
        </QueryClientProvider>,
      );

      if (previousAccountId === "deleted-account") {
        fireEvent.click(
          screen.getByRole("button", { name: "select-managed-account" }),
        );
      }
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      expect(onSubmit.mock.calls[0][0].meta?.authBinding).toEqual({
        source: "managed_account",
        authProvider: "codex_oauth",
        accountId: "acct-managed",
      });
    },
  );

  it("keeps a category-less managed card Official when it is unbound", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          providerId="managed-official"
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "OpenAI Official (user@example.com)",
            settingsConfig: { auth: {}, config: "" },
            meta: {
              providerType: "codex_oauth",
              authBinding: {
                source: "managed_account",
                authProvider: "codex_oauth",
                accountId: "acct-managed",
              },
            },
          }}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "select-native-login" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta).not.toEqual(
      expect.objectContaining({ authBinding: expect.anything() }),
    );
    expect(onSubmit.mock.calls[0][0].meta?.providerType).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].presetCategory).toBe("official");
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty(
      "codexNativeLoginSelected",
    );
  });

  it("keeps an unmarked legacy Official row on follow-login", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          providerId="legacy-unbound-official"
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Legacy OpenAI Official",
            category: "official",
            settingsConfig: {
              auth: {
                auth_mode: "chatgpt",
                tokens: { refresh_token: "legacy-refresh-token" },
              },
              config: "",
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("button", { name: "select-native-login" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0][0].meta?.providerType).toBeUndefined();
    expect(onSubmit.mock.calls[0][0].meta?.authBinding).toBeUndefined();
    expect(JSON.parse(onSubmit.mock.calls[0][0].settingsConfig).auth).toEqual({
      auth_mode: "chatgpt",
      tokens: { refresh_token: "legacy-refresh-token" },
    });
  });

  it("does not add OAuth binding behavior to a third-party route with a stale Official category", async () => {
    const queryClient = createTestQueryClient();
    const onSubmit = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
          providerId="legacy-unbound-official"
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Legacy OpenAI Official",
            category: "official",
            settingsConfig: {
              auth: { tokens: { refresh_token: "stale-secret" } },
              config:
                'model_provider = "custom"\nbase_url = "https://example.com/v1"\nexperimental_bearer_token = "stale-key"\n[model_providers.custom]\nrequires_openai_auth = true',
            },
          }}
        />
      </QueryClientProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "select-native-login" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(submitted.meta?.providerType).toBeUndefined();
    const submittedSettings = JSON.parse(submitted.settingsConfig);
    expect(submittedSettings.auth).toEqual({
      tokens: { refresh_token: "stale-secret" },
    });
    expect(submittedSettings.config).toContain('model_provider = "custom"');
    expect(submittedSettings.config).toContain(
      'base_url = "https://example.com/v1"',
    );
  });

  it("blocks saving a managed account that requires reauthentication", async () => {
    authState.codexReauthRequired = true;
    const onSubmit = vi.fn();
    renderCodexForm(onSubmit);

    fireEvent.click(screen.getByRole("button", { name: /OpenAI Official/ }));
    fireEvent.click(
      await screen.findByRole("button", { name: "select-managed-account" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "已绑定账号不存在或需要重新登录",
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
  it.each(["anthropic", "openai_chat"] as const)(
    "preserves existing %s routes, model defaults, catalog fields and unknown TOML",
    async (apiFormat) => {
      const onSubmit = vi.fn();
      const config =
        'model_provider = "custom"\nmodel = "kept-default"\nfuture_global = "keep-global"\n[model_providers.custom]\nname = "Legacy"\nbase_url = "https://legacy.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true\nfuture_provider = "keep-provider"\n[ui]\nfuture_option = true';
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId="codex"
            productShell
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            initialData={{
              name: "Legacy API route",
              category: "custom",
              settingsConfig: {
                auth: { OPENAI_API_KEY: "kept-key" },
                config,
                modelCatalog: {
                  models: [
                    {
                      model: "catalog-model",
                      inputModalities: ["text"],
                      baseInstructions: "kept instructions",
                      supportsParallelToolCalls: false,
                    },
                  ],
                },
              },
              meta: {
                apiFormat,
                customUserAgent: "legacy-agent",
                codexChatReasoning: {
                  supportsThinking: true,
                  supportsEffort: true,
                },
                promptCacheRouting: "enabled",
              },
            }}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
      const saved = JSON.parse(values.settingsConfig);
      expect(saved.config).toBe(config);
      expect(saved.auth).toEqual({ OPENAI_API_KEY: "kept-key" });
      expect(saved.modelCatalog.models).toEqual([
        {
          model: "catalog-model",
          inputModalities: ["text"],
          baseInstructions: "kept instructions",
          supportsParallelToolCalls: false,
        },
      ]);
      expect(values.meta?.apiFormat).toBe(apiFormat);
      expect(values.meta?.customUserAgent).toBe("legacy-agent");
      if (apiFormat === "openai_chat") {
        expect(values.meta?.codexChatReasoning).toMatchObject({
          supportsThinking: true,
          supportsEffort: true,
        });
        expect(values.meta?.promptCacheRouting).toBe("enabled");
      }
      expect(values.meta?.authBinding).toBeUndefined();
    },
  );

  it("preserves raw unsupported protocol flags and future native settings on edit", async () => {
    const onSubmit = vi.fn();
    const settingsConfig = {
      auth: { OPENAI_API_KEY: "saved-key" },
      config:
        'model_provider = "custom"\nmodel = "legacy-model"\n[model_providers.custom]\nname = "Legacy"\nbase_url = "https://legacy.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true',
      apiFormat: "openai_chat",
      fullURL: true,
      future_native_option: { enabled: true },
    };
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="codex"
          productShell
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Raw legacy config",
            category: "custom",
            settingsConfig,
          }}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("status")).toHaveTextContent("cannot be activated");
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSubmit.mock.calls[0][0].settingsConfig)).toEqual(
      settingsConfig,
    );
  });

  it.each(["openai_chat", "anthropic"] as const)(
    "preserves an unsupported %s connection with a stale Official category",
    async (apiFormat) => {
      const onSubmit = vi.fn();
      const config =
        'model_provider = "custom"\nmodel = "legacy-model"\n[model_providers.custom]\nname = "Legacy"\nbase_url = "https://legacy.example/v1"\nwire_api = "responses"\nrequires_openai_auth = true';
      const meta = {
        apiFormat,
        customUserAgent: "saved-agent",
        promptCacheRouting: "enabled" as const,
        codexChatReasoning: { supportsEffort: true },
        localProxyRequestOverrides: { body: { kept: true } },
      };
      const models = [{ model: "legacy-model", reasoningLevels: ["high"] }];
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId="codex"
            productShell
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            initialData={{
              name: "Stale official legacy",
              category: "official",
              settingsConfig: {
                auth: { OPENAI_API_KEY: "saved-key" },
                config,
                modelCatalog: { models },
              },
              meta,
            }}
          />
        </QueryClientProvider>,
      );
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
      const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
      expect(values.meta).toEqual(meta);
      expect(JSON.parse(values.settingsConfig)).toEqual({
        auth: { OPENAI_API_KEY: "saved-key" },
        config,
        modelCatalog: { models },
      });
    },
  );

  it("preserves a legacy Codex xAI managed binding without requiring a static API key", async () => {
    authState.xaiAuthenticated = false;
    const onSubmit = vi.fn();
    const config =
      'model_provider = "custom"\nmodel = "grok-legacy"\n[model_providers.custom]\nname = "Legacy xAI"\nbase_url = "https://api.x.ai/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nfuture_option = "keep"';
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <ProviderForm
          appId="codex"
          productShell
          submitLabel="save-provider"
          onSubmit={onSubmit}
          onCancel={vi.fn()}
          initialData={{
            name: "Legacy xAI",
            category: "third_party",
            settingsConfig: { auth: {}, config },
            meta: {
              providerType: "xai_oauth",
              authBinding: {
                source: "managed_account",
                authProvider: "xai_oauth",
                accountId: "xai-legacy",
              },
              apiFormat: "openai_responses",
            },
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const values = onSubmit.mock.calls[0][0] as ProviderFormValues;
    expect(values.meta?.authBinding).toEqual({
      source: "managed_account",
      authProvider: "xai_oauth",
      accountId: "xai-legacy",
    });
    expect(values.meta?.providerType).toBe("xai_oauth");
    expect(values.meta?.apiFormat).toBe("openai_responses");
    expect(JSON.parse(values.settingsConfig).config).toBe(config);
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it.each(["claude", "gemini", "grokbuild", "pi"] as const)(
    "rejects the unsupported %s form entry before mounting its editor",
    (appId) => {
      const { container } = render(
        <ProviderForm
          appId={appId}
          submitLabel="save-provider"
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );
      expect(container).toBeEmptyDOMElement();
      expect(
        screen.queryByTestId("codex-config-editor"),
      ).not.toBeInTheDocument();
    },
  );
});
