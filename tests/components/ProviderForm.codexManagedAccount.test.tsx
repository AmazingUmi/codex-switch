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
  apiKeyOnly = false,
) {
  const queryClient = createTestQueryClient();
  return render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ProviderForm
          appId="codex"
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

  it("offers only API presets and never mounts an account selector", () => {
    renderCodexForm(vi.fn(), true);
    expect(
      screen.getByRole("button", { name: "OpenAI API" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /DeepSeek/ }),
    ).toBeInTheDocument();
    for (const name of [
      /OpenAI Official/,
      /MiniMax/i,
      /Grok/i,
      /Kimi/i,
      /Gemini/i,
      /select-managed-account/,
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
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
    renderCodexForm(onSubmit, true, true);
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

  it.each([false, true])(
    "preserves or edits the catalog of a real official OpenAI API-key connection (edit %s)",
    async (editCatalog) => {
      const onSubmit = vi.fn();
      const model = {
        model: "gpt-fixture",
        displayName: "Fixture",
        contextWindow: 100000,
        reasoningLevels: ["high", "max"],
        defaultReasoningLevel: "high",
        inputModalities: ["text", "image"],
        supportsParallelToolCalls: true,
      };
      render(
        <QueryClientProvider client={createTestQueryClient()}>
          <ProviderForm
            appId="codex"
            productShell
            providerId="openai-api"
            submitLabel="save-provider"
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            initialData={{
              name: "OpenAI API",
              category: "official",
              settingsConfig: {
                auth: { OPENAI_API_KEY: "saved-api-key" },
                config: 'model = "gpt-fixture"',
                modelCatalog: { models: [model] },
              },
            }}
          />
        </QueryClientProvider>,
      );
      expect(screen.getByLabelText("API Key")).toBeEnabled();
      expect(
        screen.queryByTestId("selected-managed-account"),
      ).not.toBeInTheDocument();
      if (editCatalog) {
        fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
        fireEvent.change(await screen.findByLabelText("菜单显示名"), {
          target: { value: "Updated fixture" },
        });
      }
      fireEvent.click(screen.getByRole("button", { name: "save-provider" }));
      await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
      const settings = JSON.parse(onSubmit.mock.calls[0][0].settingsConfig);
      expect(settings.auth).toEqual({ OPENAI_API_KEY: "saved-api-key" });
      expect(settings.config).toContain('model = "gpt-fixture"');
      expect(settings.modelCatalog.models).toEqual([
        { ...model, displayName: editCatalog ? "Updated fixture" : "Fixture" },
      ]);
    },
  );

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
});
