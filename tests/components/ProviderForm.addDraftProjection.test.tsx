/**
 * 新增对话框：Codex、Gemini CLI、Grok Build 的表单把预设或模板投影到当前配置文件上显示，
 * 投影结果就是保存时三方比较的底。锁定一条不变式：每次重置显示内容之后，编辑框里的内容
 * 和最后上报的底一致。对不上时，底里有、显示里没有的全局设置会在保存时被当成删除写进
 * 配置文件。
 *
 * MSW 替身：投影在原内容上加一份「配置文件里已有的全局设置」，模拟真实的 live。
 */
import {
  ProviderForm,
  type ProviderFormValues,
} from "@/components/providers/forms/ProviderForm";
import { providersApi } from "@/lib/api/providers";
import type { AppId } from "@/lib/api";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../msw/server";
import { createTestQueryClient } from "../utils/testQueryClient";

const toastError = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn() },
}));

vi.mock("@/components/JsonEditor", () => ({
  default: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) => (
    <textarea
      data-testid="json-editor"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));

vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: () => <div data-testid="codex-oauth-section" />,
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
      isAuthenticated: false,
      isStatusSuccess: true,
      isStatusError: false,
      defaultAccountId: null,
      accounts: [],
    }),
    useXaiOauth: () => ({ isAuthenticated: false, accounts: [] }),
  };
});

const LIVE_TOML = '\n[ui]\ntheme = "dark"\n';

type Base = Record<string, unknown> | null;

function projectAsLive() {
  server.use(
    http.post(
      "http://tauri.local/get_provider_editor_view",
      async ({ request }) => {
        const { app, settingsConfig = {} } = (await request.json()) as {
          app: AppId;
          settingsConfig?: Record<string, unknown>;
        };
        const settings = { ...settingsConfig };
        if (app === "gemini") {
          settings.env = {
            ...(settingsConfig.env as Record<string, unknown>),
            GEMINI_SANDBOX: "docker",
          };
          settings.config = {
            ...(settingsConfig.config as Record<string, unknown>),
            ui: { theme: "dark" },
          };
        } else {
          settings.config = `${String(settingsConfig.config ?? "")}${LIVE_TOML}`;
        }
        return HttpResponse.json({ settings, inactive: [] });
      },
    ),
  );
}

function renderForm(
  appId: AppId,
  bases: Base[],
  onSubmit = vi.fn(),
  drafts: Record<string, unknown>[] = [],
) {
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderForm
        appId={appId}
        productShell
        apiKeyOnly
        submitLabel="save"
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        onEditorBaseChange={(base, draft) => {
          bases.push(base);
          if (draft) drafts.push(draft);
        }}
      />
    </QueryClientProvider>,
  );
}

function clickPreset(name: string) {
  const matches = screen
    .getAllByRole("button")
    .filter(
      (button) => button.querySelector("span.truncate")?.textContent === name,
    );
  expect(matches, `预设按钮「${name}」应唯一`).toHaveLength(1);
  fireEvent.click(matches[0]);
}

function editorTexts(): string[] {
  return screen
    .getAllByTestId("json-editor")
    .map((node) => (node as HTMLTextAreaElement).value);
}

/** 等到最后一次上报的底不为空，并且和上一次检查时不同。 */
async function nextBase(bases: Base[], seen: number): Promise<Base> {
  await waitFor(() => {
    expect(bases.length).toBeGreaterThan(seen);
    expect(bases.at(-1)).not.toBeNull();
  });
  return bases.at(-1)!;
}

describe("新增对话框的草稿投影", () => {
  beforeEach(() => {
    projectAsLive();
    toastError.mockReset();
  });
  afterEach(() => vi.restoreAllMocks());

  it("waits for an API Key before projecting, then saves the real live base and credential draft", async () => {
    const getView = vi.spyOn(providersApi, "getEditorView");
    const bases: Base[] = [];
    const drafts: Record<string, unknown>[] = [];
    const onSubmit = vi.fn();
    renderForm("codex", bases, onSubmit, drafts);
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(getView).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "test-openai-key" },
    });
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    const base = await nextBase(bases, bases.length);
    expect(getView).toHaveBeenCalledTimes(1);
    expect(drafts.at(-1)?.auth).toEqual({ OPENAI_API_KEY: "test-openai-key" });
    expect(String(drafts.at(-1)?.config)).toContain(
      "requires_openai_auth = true",
    );
    expect(String(drafts.at(-1)?.config)).not.toContain(LIVE_TOML.trim());
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
    await waitFor(() => expect(editorTexts()).toContain(String(base!.config)));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "final-openai-key" },
    });
    fireEvent.change(screen.getByLabelText("codexConfig.apiUrlLabel"), {
      target: { value: "https://final.example/v1" },
    });
    const rawConfig = screen
      .getAllByTestId("json-editor")
      .find((node) =>
        (node as HTMLTextAreaElement).value.includes("model_provider"),
      ) as HTMLTextAreaElement;
    fireEvent.change(rawConfig, {
      target: { value: `${rawConfig.value}\n[draft]\nkeep = true\n` },
    });
    expect(getView).toHaveBeenCalledTimes(1);
    expect(bases.at(-1)).toEqual(base);
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        (onSubmit.mock.calls[0][0] as ProviderFormValues).settingsConfig,
      ),
    ).toMatchObject({
      auth: { OPENAI_API_KEY: "final-openai-key" },
      config: expect.stringContaining("keep = true"),
    });
    const saved = JSON.parse(
      (onSubmit.mock.calls[0][0] as ProviderFormValues).settingsConfig,
    );
    expect(saved.config).toContain("https://final.example/v1");
    expect(saved.config).toContain(LIVE_TOML.trim());
    expect(drafts.at(-1)?.auth).toEqual({ OPENAI_API_KEY: "test-openai-key" });
  });

  it("switches API presets without projecting an empty key or automatically opening advanced options", async () => {
    const getView = vi.spyOn(providersApi, "getEditorView");
    const bases: Base[] = [];
    renderForm("codex", bases);
    clickPreset("DeepSeek");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(getView).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "高级选项" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(screen.queryByLabelText("实际请求模型")).not.toBeInTheDocument();
    expect(screen.queryByTestId("json-editor")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "deepseek-key" },
    });
    let base = await nextBase(bases, bases.length);
    expect(String(base!.config)).toContain(LIVE_TOML.trim());
    expect(String(base!.config)).toContain("api.deepseek.com");
    fireEvent.click(screen.getByRole("button", { name: "高级选项" }));
    expect(screen.getAllByLabelText("实际请求模型").length).toBeGreaterThan(0);
    await waitFor(() => expect(editorTexts()).toContain(String(base!.config)));

    getView.mockClear();
    clickPreset("OpenAI API");
    expect(bases.at(-1)).toBeNull();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(getView).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "new-openai-key" },
    });
    base = await nextBase(bases, bases.length);
    expect(String(base!.config)).not.toContain("deepseek");
    await waitFor(() => expect(editorTexts()).toContain(String(base!.config)));
  });

  it("invalidates in-flight projections on preset changes and on later draft edits", async () => {
    const requests: Array<{
      settings: Record<string, unknown>;
      resolve: (view: {
        settings: Record<string, unknown>;
        inactive: [];
      }) => void;
    }> = [];
    vi.spyOn(providersApi, "getEditorView").mockImplementation(
      (_app, settings) =>
        new Promise((resolve) => requests.push({ settings, resolve })),
    );
    const bases: Base[] = [];
    const onSubmit = vi.fn();
    renderForm("codex", bases, onSubmit);
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "first-key" },
    });
    await waitFor(() => expect(requests).toHaveLength(1));
    clickPreset("DeepSeek");
    await act(async () =>
      requests[0].resolve({
        settings: { config: "stale = true" },
        inactive: [],
      }),
    );
    expect(bases.at(-1)).toBeNull();
    expect(screen.getByLabelText("codexConfig.apiUrlLabel")).toHaveValue(
      "https://api.deepseek.com",
    );
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "second-key" },
    });
    await waitFor(() => expect(requests).toHaveLength(2));
    fireEvent.change(screen.getByLabelText("默认模型"), {
      target: { value: "new-model" },
    });
    await waitFor(() => expect(requests).toHaveLength(3));
    await act(async () =>
      requests[1].resolve({
        settings: { config: "also_stale = true" },
        inactive: [],
      }),
    );
    expect(bases.at(-1)).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    fireEvent.submit(document.getElementById("provider-form")!);
    expect(onSubmit).not.toHaveBeenCalled();
    const latest = {
      ...requests[2].settings,
      config: `${requests[2].settings.config}${LIVE_TOML}`,
    };
    await act(async () =>
      requests[2].resolve({ settings: latest, inactive: [] }),
    );
    await waitFor(() => expect(bases.at(-1)).toEqual(latest));
    expect(screen.getByLabelText("默认模型")).toHaveValue("new-model");
    expect(screen.getByLabelText("API Key")).toHaveValue("second-key");
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("reports a real live configuration failure after credentials are complete", async () => {
    vi.spyOn(providersApi, "getEditorView").mockRejectedValue(
      new Error("broken config.toml"),
    );
    const bases: Base[] = [];
    renderForm("codex", bases);
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "real-key" },
    });
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        expect.stringContaining("broken config.toml"),
      ),
    );
    expect(bases.at(-1)).toBeNull();
    expect(screen.getByRole("button", { name: "save" })).toBeEnabled();
  });

  it("clears the pending save lock when the key is removed and still offers soft-warning save", async () => {
    let resolve!: (view: {
      settings: Record<string, unknown>;
      inactive: [];
    }) => void;
    vi.spyOn(providersApi, "getEditorView").mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const bases: Base[] = [];
    const onSubmit = vi.fn();
    renderForm("codex", bases, onSubmit);
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "temporary-key" },
    });
    await waitFor(() => expect(resolve).toBeDefined());
    expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("API Key"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "save" })).toBeEnabled(),
    );
    await act(async () =>
      resolve({ settings: { config: "stale = true" }, inactive: [] }),
    );
    expect(bases.at(-1)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    expect(
      await screen.findByRole("button", { name: "仍要保存" }),
    ).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "仍要保存" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(JSON.parse(onSubmit.mock.calls[0][0].settingsConfig).auth).toEqual({
      OPENAI_API_KEY: "",
    });
    expect(toastError).not.toHaveBeenCalled();
  });
});
