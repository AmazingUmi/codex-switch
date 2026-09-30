import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DeepLinkImportDialog } from "@/components/DeepLinkImportDialog";
import { deeplinkApi, type DeepLinkImportRequest } from "@/lib/api/deeplink";
import { emitTauriEvent } from "../msw/tauriMocks";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h1>{children}</h1>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>
    {children}
  </QueryClientProvider>
);

describe("DeepLinkImportDialog", () => {
  it("renders masked usage access token and user id for provider imports", async () => {
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Test Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
        usageEnabled: true,
        usageScript: btoa("console.log('usage');"),
        usageApiKey: "sk-usage-key",
        usageBaseUrl: "https://usage.example.com",
        usageAccessToken: "pat-secret-token",
        usageUserId: "user-12345",
        usageAutoInterval: 60,
      });
    });

    await waitFor(() => {
      expect(screen.getByText("用量访问令牌")).toBeInTheDocument();
    });

    expect(screen.getByText("用量用户 ID")).toBeInTheDocument();
    expect(screen.getByText("user-12345")).toBeInTheDocument();
    // Masked: first 4 chars + 12 stars
    expect(screen.getByText("pat-************")).toBeInTheDocument();
  });

  it("shows usage credentials even when the deeplink carries no usageScript", async () => {
    // 后端 build_provider_meta 在任一 usage 字段存在时即持久化（含 access_token
    // 与 user_id）。若对话框只在 usageScript 存在时开门，这条链接会把凭据静默
    // 写进供应商配置。撤销门槛 widening（恢复只按 usageScript 开门）本测试即失败。
    render(<DeepLinkImportDialog />, { wrapper: Wrapper });

    act(() => {
      emitTauriEvent("deeplink-import", {
        version: "v1",
        resource: "provider",
        app: "claude",
        name: "Token Only Provider",
        homepage: "https://example.com",
        endpoint: "https://api.example.com",
        apiKey: "sk-provider-key",
        usageAccessToken: "pat-secret-token",
        usageUserId: "user-12345",
      });
    });

    await waitFor(() => {
      expect(screen.getByText("用量访问令牌")).toBeInTheDocument();
    });

    expect(screen.getByText("pat-************")).toBeInTheDocument();
    expect(screen.getByText("用量用户 ID")).toBeInTheDocument();
    expect(screen.getByText("user-12345")).toBeInTheDocument();
    // 没有脚本就不应渲染脚本执行警告与脚本代码区
    expect(
      screen.queryByText(
        "这是一段 JavaScript 代码，启用后会在查询用量时执行。请确认来源可信后再导入。",
      ),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("脚本代码")).not.toBeInTheDocument();
  });
});

describe("Codex product deeplink boundary", () => {
  it.each([
    { app: "claude", resource: "provider" },
    { app: "gemini", resource: "provider" },
    { app: "codex", resource: "skill" },
    { app: "codex", resource: "mcp" },
    { app: "codex", resource: "prompt" },
    { resource: "provider" },
  ])(
    "rejects unsupported requests before fetching or importing: %j",
    async (scope) => {
      const merge = vi.spyOn(deeplinkApi, "mergeDeeplinkConfig");
      const importRequest = vi.spyOn(deeplinkApi, "importFromDeeplink");
      try {
        render(<DeepLinkImportDialog productShell />, { wrapper: Wrapper });
        await act(async () => {
          emitTauriEvent("deeplink-import", {
            ...scope,
            version: "v1",
            name: "Unsupported import",
            configUrl: "https://example.com/config",
          });
        });
        expect(
          screen.queryByText("Unsupported import"),
        ).not.toBeInTheDocument();
        expect(merge).not.toHaveBeenCalled();
        expect(importRequest).not.toHaveBeenCalled();
      } finally {
        merge.mockRestore();
        importRequest.mockRestore();
      }
    },
  );

  it("rejects a merged request that changes the allowed app", async () => {
    const merge = vi
      .spyOn(deeplinkApi, "mergeDeeplinkConfig")
      .mockResolvedValue({
        version: "v1",
        app: "claude",
        resource: "provider",
        name: "Merged unsupported import",
      });
    const importRequest = vi.spyOn(deeplinkApi, "importFromDeeplink");
    try {
      render(<DeepLinkImportDialog productShell />, { wrapper: Wrapper });
      await act(async () => {
        emitTauriEvent("deeplink-import", {
          version: "v1",
          app: "codex",
          resource: "provider",
          config: "e30=",
        });
      });
      expect(merge).toHaveBeenCalledTimes(1);
      expect(
        screen.queryByText("Merged unsupported import"),
      ).not.toBeInTheDocument();
      expect(importRequest).not.toHaveBeenCalled();
    } finally {
      merge.mockRestore();
      importRequest.mockRestore();
    }
  });

  it("does not reopen an older merge after a newer unsupported request", async () => {
    let resolveMerge!: (request: DeepLinkImportRequest) => void;
    const merge = vi
      .spyOn(deeplinkApi, "mergeDeeplinkConfig")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveMerge = resolve;
          }),
      );
    try {
      render(<DeepLinkImportDialog productShell />, { wrapper: Wrapper });
      await act(async () => {
        emitTauriEvent("deeplink-import", {
          version: "v1",
          app: "codex",
          resource: "provider",
          config: "e30=",
        });
      });
      await act(async () => {
        emitTauriEvent("deeplink-import", {
          version: "v1",
          app: "codex",
          resource: "mcp",
        });
        resolveMerge({
          version: "v1",
          app: "codex",
          resource: "provider",
          name: "Outdated provider",
        });
      });
      expect(screen.queryByText("Outdated provider")).not.toBeInTheDocument();
    } finally {
      merge.mockRestore();
    }
  });

  it("still imports an allowed Codex provider", async () => {
    const importRequest = vi
      .spyOn(deeplinkApi, "importFromDeeplink")
      .mockResolvedValue({ type: "provider", id: "imported-codex" });
    try {
      render(<DeepLinkImportDialog productShell />, { wrapper: Wrapper });
      const request = {
        version: "v1",
        app: "codex",
        resource: "provider",
        name: "OpenAI import",
        endpoint: "https://api.openai.com/v1",
      } as const;
      await act(async () => {
        emitTauriEvent("deeplink-import", request);
      });
      expect(screen.getByText("OpenAI import")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "deeplink.import" }));
      await waitFor(() => expect(importRequest).toHaveBeenCalledWith(request));
    } finally {
      importRequest.mockRestore();
    }
  });
});
