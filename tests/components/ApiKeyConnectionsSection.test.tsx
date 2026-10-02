import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import {
  ApiKeyConnectionsSection,
  type ApiKeyConnectionsSectionProps,
} from "@/components/codex/ApiKeyConnectionsSection";
import { providersApi } from "@/lib/api/providers";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const toastMocks = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));
vi.mock("@/hooks/useDragSort", () => ({
  useDragSort: (providers: Record<string, Provider>) => ({
    sortedProviders: Object.values(providers),
    sensors: [],
    handleDragEnd: vi.fn(),
  }),
}));
vi.mock("@/hooks/useStreamCheck", () => ({
  useStreamCheck: () => ({ checkProvider: vi.fn(), isChecking: () => false }),
}));
vi.mock("@/components/providers/ProviderCard", () => ({
  ProviderCard: ({
    provider,
    onSwitch,
    onEdit,
  }: {
    provider: Provider;
    onSwitch: (provider: Provider) => void;
    onEdit: (provider: Provider) => void;
  }) => (
    <div>
      <span>{provider.name}</span>
      <button onClick={() => onSwitch(provider)}>switch-connection</button>
      <button onClick={() => onEdit(provider)}>edit-connection</button>
    </div>
  ),
}));

function renderSection(overrides: Partial<ApiKeyConnectionsSectionProps> = {}) {
  const client = createTestQueryClient();
  const props: ApiKeyConnectionsSectionProps = {
    providers: {},
    currentProviderId: "",
    onSwitch: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onDuplicate: vi.fn(),
    onOpenWebsite: vi.fn(),
    onAddApiKey: vi.fn(),
    ...overrides,
  };
  render(
    <QueryClientProvider client={client}>
      <ApiKeyConnectionsSection {...props} />
    </QueryClientProvider>,
  );
  return { props, client };
}

const helpLabel = "连接配置用途";
afterEach(() => vi.restoreAllMocks());

describe("API Key connections section", () => {
  it("shows the compact empty message and opens API Key creation directly from the header", () => {
    const { props } = renderSection();
    expect(
      screen.getByRole("heading", { name: "API Key" }),
    ).toBeInTheDocument();
    expect(screen.getByText("暂无 API Key")).toBeInTheDocument();
    expect(
      screen.queryByText("provider.noProvidersDescription"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "导入当前配置" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加 API Key" }));
    expect(props.onAddApiKey).toHaveBeenCalledTimes(1);
  });

  it("keeps saved connection actions available", () => {
    const provider: Provider = {
      id: "saved",
      name: "Saved API",
      settingsConfig: {},
    };
    const { props } = renderSection({
      providers: { saved: provider },
      currentProviderId: "saved",
    });
    expect(screen.queryByText("暂无 API Key")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("switch-connection"));
    fireEvent.click(screen.getByText("edit-connection"));
    expect(props.onSwitch).toHaveBeenCalledWith(provider);
    expect(props.onEdit).toHaveBeenCalledWith(provider);
  });

  it("keeps API Key creation and the help import action accessible from the keyboard", async () => {
    const user = userEvent.setup();
    const { props } = renderSection();
    const add = screen.getByRole("button", { name: "添加 API Key" });
    add.focus();
    await user.keyboard("{Enter}");
    expect(props.onAddApiKey).toHaveBeenCalledOnce();
    const help = screen.getByRole("button", { name: helpLabel });
    act(() => help.focus());
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: "导入当前配置" }),
    ).toBeVisible();
    expect(screen.getByText("暂无 API Key")).toBeVisible();
  });

  it("imports the current Codex configuration from hovered help, prevents duplicates, and refreshes providers", async () => {
    let resolve!: (imported: boolean) => void;
    const importCurrent = vi
      .spyOn(providersApi, "importDefault")
      .mockImplementation(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
    const { client } = renderSection();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.pointerEnter(screen.getByRole("button", { name: helpLabel }));
    const importButton = await screen.findByRole("button", {
      name: "导入当前配置",
    });
    fireEvent.click(importButton);
    await waitFor(() => expect(importCurrent).toHaveBeenCalledWith("codex"));
    expect(importButton).toBeDisabled();
    fireEvent.click(importButton);
    expect(importCurrent).toHaveBeenCalledTimes(1);
    await act(async () => resolve(true));
    await waitFor(() =>
      expect(toastMocks.success).toHaveBeenCalledWith(
        "provider.importCurrentDescription",
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["providers", "codex"],
    });
    expect(importButton).toBeEnabled();
  });

  it("shows a serialized import error and allows retry from pinned help", async () => {
    const importCurrent = vi
      .spyOn(providersApi, "importDefault")
      .mockRejectedValueOnce("[import] unreadable config.toml")
      .mockResolvedValueOnce(false);
    const { client } = renderSection();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    fireEvent.click(screen.getByRole("button", { name: helpLabel }));
    const importButton = await screen.findByRole("button", {
      name: "导入当前配置",
    });
    fireEvent.click(importButton);
    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith(
        "[import] unreadable config.toml",
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["providers", "codex"],
    });
    await waitFor(() => expect(importButton).toBeEnabled());
    fireEvent.click(importButton);
    await waitFor(() =>
      expect(toastMocks.info).toHaveBeenCalledWith("provider.noProviders"),
    );
    expect(importCurrent).toHaveBeenCalledTimes(2);
  });
});
