import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "@/types";

const apiMocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  getEditorView: vi.fn(),
  getLiveProviderSettings: vi.fn(),
  getOpenClawLiveProvider: vi.fn(),
}));
let mockFormReady = true;
let mockCodexManagedAccountSelected = false;
let submitReadyCallbacks: Array<(isReady: boolean) => void> = [];

vi.mock("@/lib/api", () => ({
  providersApi: {
    getCurrent: apiMocks.getCurrent,
    getEditorView: apiMocks.getEditorView,
  },
  vscodeApi: {
    getLiveProviderSettings: apiMocks.getLiveProviderSettings,
  },
  openclawApi: {
    getLiveProvider: apiMocks.getOpenClawLiveProvider,
  },
}));

vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({
    isOpen,
    children,
    footer,
  }: {
    isOpen: boolean;
    children: React.ReactNode;
    footer?: React.ReactNode;
  }) =>
    isOpen ? (
      <div>
        <div>{children}</div>
        <div>{footer}</div>
      </div>
    ) : null,
}));

vi.mock("@/components/providers/forms/ProviderForm", () => ({
  ProviderForm: ({
    initialData,
    onSubmit,
    onSubmitReadyChange,
    onManageAuthAccounts,
    isProxyTakeover,
  }: {
    initialData: {
      name?: string;
      websiteUrl?: string;
      notes?: string;
      settingsConfig?: Record<string, unknown>;
      meta?: Record<string, unknown>;
      icon?: string;
      iconColor?: string;
    };
    onSubmit: (values: {
      name: string;
      websiteUrl: string;
      notes?: string;
      settingsConfig: string;
      meta?: Record<string, unknown>;
      icon?: string;
      iconColor?: string;
    }) => void;
    onSubmitReadyChange?: (isReady: boolean) => void;
    onManageAuthAccounts?: (target: "codex_oauth") => void;
    isProxyTakeover?: boolean;
    appId?: string;
  }) => {
    const [draftName, setDraftName] = useState(initialData.name ?? "");
    useEffect(() => {
      if (onSubmitReadyChange) {
        submitReadyCallbacks.push(onSubmitReadyChange);
        onSubmitReadyChange(mockFormReady);
      }
    }, [onSubmitReadyChange]);
    return (
      <form
        id="provider-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name: draftName,
            websiteUrl: initialData.websiteUrl ?? "",
            notes: initialData.notes,
            settingsConfig: JSON.stringify(initialData.settingsConfig ?? {}),
            meta: mockCodexManagedAccountSelected
              ? {
                  ...(initialData.meta ?? {}),
                  providerType: "codex_oauth",
                  authBinding: {
                    source: "managed_account",
                    authProvider: "codex_oauth",
                    accountId: "acct-managed",
                  },
                }
              : initialData.meta,
            icon: initialData.icon,
            iconColor: initialData.iconColor,
          });
        }}
      >
        <input
          aria-label="connection-name"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
        />
        <output data-testid="settings-config">
          {JSON.stringify(initialData.settingsConfig ?? {})}
        </output>
        <output data-testid="is-proxy-takeover">
          {isProxyTakeover ? "true" : "false"}
        </output>
        <button
          type="button"
          onClick={() => onManageAuthAccounts?.("codex_oauth")}
        >
          manage-auth
        </button>
      </form>
    );
  },
}));

vi.mock("@/components/providers/AuthSettingsPanel", () => ({
  AuthSettingsPanel: ({ target }: { target: string | null }) =>
    target ? <div data-testid="auth-settings-panel">{target}</div> : null,
}));

import { EditProviderDialog } from "@/components/providers/EditProviderDialog";

describe("EditProviderDialog", () => {
  beforeEach(() => {
    mockFormReady = true;
    mockCodexManagedAccountSelected = false;
    submitReadyCallbacks = [];
    apiMocks.getCurrent.mockReset();
    apiMocks.getEditorView.mockReset();
    apiMocks.getEditorView.mockImplementation(
      async (_app: string, settingsConfig: Record<string, unknown>) => ({
        settings: settingsConfig,
        inactive: [],
      }),
    );
    apiMocks.getLiveProviderSettings.mockReset();
    apiMocks.getOpenClawLiveProvider.mockReset();
  });

  it("cancels deletion inside the editor without losing unsaved form values", async () => {
    const provider = { id: "relay", name: "Relay", settingsConfig: {} };
    const onSubmit = vi.fn();
    const onConfirm = vi.fn();
    function Editor() {
      const [confirming, setConfirming] = useState(false);
      return (
        <EditProviderDialog
          open
          provider={provider}
          appId="codex"
          onOpenChange={vi.fn()}
          onSubmit={onSubmit}
          onDelete={() => setConfirming(true)}
          deleteConfirmation={
            confirming
              ? {
                  message: "Delete Relay?",
                  onConfirm,
                  onCancel: () => setConfirming(false),
                }
              : undefined
          }
        />
      );
    }
    render(<Editor />);
    fireEvent.change(
      await screen.findByRole("textbox", { name: "connection-name" }),
      {
        target: { value: "Unsaved connection name" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "common.delete" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Delete Relay?");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "common.save" }),
    ).not.toBeInTheDocument();
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Unsaved connection name");
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0][0].provider.name).toBe(
      "Unsaved connection name",
    );
  });

  it("explains why the current connection cannot be deleted while allowing save", async () => {
    const onDelete = vi.fn();
    render(
      <EditProviderDialog
        open
        provider={{ id: "current", name: "Current", settingsConfig: {} }}
        appId="codex"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onDelete={onDelete}
        deleteDisabledReason="Switch to another connection first."
      />,
    );
    await screen.findByRole("textbox");
    const button = screen.getByRole("button", { name: "common.delete" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      "Switch to another connection first.",
    );
    expect(screen.getByRole("button", { name: "common.save" })).toBeEnabled();
    fireEvent.click(button);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("prevents repeated confirmation while deletion is pending and permits retry after failure", async () => {
    let rejectDelete!: (reason: Error) => void;
    const onConfirm = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectDelete = reject;
          }),
      )
      .mockResolvedValueOnce(undefined);
    const onOpenChange = vi.fn();
    render(
      <EditProviderDialog
        open
        provider={{ id: "relay", name: "Relay", settingsConfig: {} }}
        appId="codex"
        onOpenChange={onOpenChange}
        onSubmit={vi.fn()}
        onDelete={vi.fn()}
        deleteConfirmation={{
          message: "Delete Relay?",
          onConfirm,
          onCancel: vi.fn(),
        }}
      />,
    );
    await screen.findByRole("textbox");
    const button = screen.getByRole("button", { name: "common.delete" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "common.cancel" }),
    ).toBeDisabled();
    await act(async () => rejectDelete(new Error("Delete failed")));
    expect(button).toBeEnabled();
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
  });

  it("Codex 显示后端算出的切换投影，并把它作为保存时三方比较的基准", async () => {
    const modelCatalog = {
      models: [{ model: "deepseek-v4-flash", contextWindow: 1000000 }],
    };
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "aggregator",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "db-key" },
        config: 'model_provider = "custom"\nmodel = "deepseek-v4-flash"\n',
        modelCatalog,
      },
    };
    const view = {
      auth: { OPENAI_API_KEY: "db-key" },
      config:
        'approval_policy = "never"\nmodel_provider = "custom"\nmodel = "deepseek-v4-flash"\n',
      modelCatalog,
    };
    apiMocks.getEditorView.mockResolvedValue({ settings: view, inactive: [] });
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(view);
    });
    expect(apiMocks.getEditorView).toHaveBeenCalledWith(
      "codex",
      provider.settingsConfig,
      "aggregator",
      provider.id,
    );
    expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    const payload = handleSubmit.mock.calls[0][0];
    expect(payload.provider.settingsConfig).toEqual(view);
    expect(payload.editorSave).toEqual({ base: view, onConflict: "refuse" });
  });

  it("Codex 读不了配置文件时退回显示保存的供应商配置", async () => {
    const provider: Provider = {
      id: "relay",
      name: "Relay",
      category: "custom",
      settingsConfig: {
        auth: { OPENAI_API_KEY: "db-key" },
        config: 'model_provider = "custom"\n',
      },
    };
    apiMocks.getEditorView.mockRejectedValue(new Error("broken config.toml"));
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(provider.settingsConfig);
    });
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));
    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].editorSave).toBeUndefined();
  });

  it("代理模式下编辑 Codex 供应商也显示它自己的关键字段，不读 live 里的代理契约", async () => {
    const provider: Provider = {
      id: "deepseek",
      name: "DeepSeek",
      category: "custom",
      settingsConfig: {
        auth: {
          OPENAI_API_KEY: "db-key",
        },
        config:
          'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.deepseek.com/v1"\n',
      },
    };

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        appId="codex"
        isProxyTakeover
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("is-proxy-takeover").textContent).toBe("true");
    });

    expect(apiMocks.getLiveProviderSettings).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        JSON.parse(screen.getByTestId("settings-config").textContent ?? "{}"),
      ).toEqual(provider.settingsConfig);
    });
    expect(apiMocks.getEditorView).toHaveBeenCalledWith(
      "codex",
      provider.settingsConfig,
      "custom",
      provider.id,
    );
  });

  it("clears the nested auth panel before the dialog reopens", async () => {
    const provider: Provider = {
      id: "official",
      name: "OpenAI Official",
      settingsConfig: { auth: {}, config: "" },
    };
    const props = {
      provider,
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      appId: "codex" as const,
    };
    const { rerender } = render(<EditProviderDialog open {...props} />);

    fireEvent.click(await screen.findByRole("button", { name: "manage-auth" }));
    expect(screen.getByTestId("auth-settings-panel")).toHaveTextContent(
      "codex_oauth",
    );

    rerender(<EditProviderDialog open={false} {...props} />);
    rerender(<EditProviderDialog open {...props} />);

    await waitFor(() => {
      expect(
        screen.queryByTestId("auth-settings-panel"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps an unbound Codex Official provider ID unchanged", async () => {
    apiMocks.getCurrent.mockResolvedValue(null);
    const onSubmit = vi.fn();
    const provider: Provider = {
      id: "legacy-unbound-official",
      name: "Legacy OpenAI Official",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        appId="codex"
      />,
    );

    await screen.findByTestId("settings-config");
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        originalId: "legacy-unbound-official",
        provider: expect.objectContaining({ id: "legacy-unbound-official" }),
      }),
    );
  });

  it("keeps the fixed Codex provider ID when an account is bound", async () => {
    mockCodexManagedAccountSelected = true;
    apiMocks.getCurrent.mockResolvedValue(null);
    const onSubmit = vi.fn();
    const provider: Provider = {
      id: "codex-official",
      name: "OpenAI Official",
      category: "official",
      settingsConfig: { auth: {}, config: "" },
    };

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        appId="codex"
      />,
    );

    await screen.findByTestId("settings-config");
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const submitted = onSubmit.mock.calls[0][0];
    expect(submitted.originalId).toBe("codex-official");
    expect(submitted.provider.id).toBe("codex-official");
    expect(submitted.provider.meta?.authBinding).toEqual({
      source: "managed_account",
      authProvider: "codex_oauth",
      accountId: "acct-managed",
    });
  });

  it("编辑 Codex 供应商时保留通用元数据", async () => {
    const provider: Provider = {
      id: "codex-provider",
      name: "Codex Provider",
      settingsConfig: {
        baseUrl: "https://api.example.com/v1",
        models: [{ id: "model" }],
      },
      meta: {
        isPartner: true,
        endpointAutoSelect: true,
        custom_endpoints: {
          "https://failover.example.com/v1": {
            url: "https://failover.example.com/v1",
            addedAt: 1,
          },
        },
      },
    };
    const handleSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <EditProviderDialog
        open
        provider={provider}
        onOpenChange={vi.fn()}
        onSubmit={handleSubmit}
        appId="codex"
      />,
    );

    await screen.findByTestId("settings-config");
    fireEvent.click(screen.getByRole("button", { name: "common.save" }));

    await waitFor(() => expect(handleSubmit).toHaveBeenCalledTimes(1));
    expect(handleSubmit.mock.calls[0][0].provider.meta).toMatchObject({
      isPartner: true,
    });
    expect(handleSubmit.mock.calls[0][0]).not.toHaveProperty(
      "expectedSettingsConfig",
    );
  });

  it("重新打开 Codex 编辑表单后忽略上一轮的就绪回调", async () => {
    const provider: Provider = {
      id: "codex-provider",
      name: "Codex Provider",
      settingsConfig: { models: [{ id: "model" }] },
    };
    const props = {
      provider,
      onOpenChange: vi.fn(),
      onSubmit: vi.fn(),
      appId: "codex" as const,
    };
    const { rerender } = render(<EditProviderDialog open {...props} />);

    const saveButton = await screen.findByRole("button", {
      name: "common.save",
    });
    await waitFor(() => expect(saveButton).toBeEnabled());
    const staleCallback = submitReadyCallbacks.at(-1);
    expect(staleCallback).toBeDefined();

    rerender(<EditProviderDialog open={false} {...props} />);
    mockFormReady = false;
    rerender(<EditProviderDialog open {...props} />);
    const reopenedButton = await screen.findByRole("button", {
      name: "common.save",
    });
    await waitFor(() => expect(reopenedButton).toBeDisabled());

    act(() => staleCallback?.(true));
    expect(reopenedButton).toBeDisabled();
  });
  it.each(["claude", "gemini", "pi"] as const)(
    "rejects unsupported %s dialog requests",
    (appId) => {
      const { container } = render(
        <EditProviderDialog
          open
          appId={appId}
          provider={{ id: "legacy", name: "Legacy", settingsConfig: {} }}
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
      expect(container).toBeEmptyDOMElement();
    },
  );
});
