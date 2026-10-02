import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageApi } from "@/lib/api/usage";
import { UsageDashboard } from "@/components/usage/UsageDashboard";

const useAttributionChoicesMock = vi.hoisted(() => vi.fn());
const useModelStatsMock = vi.hoisted(() => vi.fn());
const usageHeroMock = vi.hoisted(() => vi.fn());
const usageTrendMock = vi.hoisted(() => vi.fn());
const usageTableMock = vi.hoisted(() => vi.fn());
const providerStatsMock = vi.hoisted(() => vi.fn());
const modelStatsMock = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
    i18n: {
      resolvedLanguage: "en",
      language: "en",
    },
  }),
}));

vi.mock("framer-motion", () => ({
  motion: {
    div: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  },
}));

vi.mock("@/hooks/useUsageEventBridge", () => ({
  useUsageEventBridge: () => {},
}));

vi.mock("@/lib/query/usage", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/query/usage")>(
      "@/lib/query/usage",
    );
  return {
    ...actual,
    useUsageAttributionChoices: () => useAttributionChoicesMock(),
    useModelStats: (...args: unknown[]) => useModelStatsMock(...args),
  };
});

vi.mock("@/components/usage/UsageHero", () => ({
  UsageHero: (props: unknown) => {
    usageHeroMock(props);
    return <div data-testid="usage-hero" />;
  },
}));

vi.mock("@/components/usage/UsageTrendChart", () => ({
  UsageTrendChart: (props: unknown) => {
    usageTrendMock(props);
    return <div data-testid="usage-trend" />;
  },
}));

vi.mock("@/components/usage/UsageRecordsTable", () => ({
  UsageRecordsTable: (props: any) => {
    usageTableMock(props);
    return (
      <div data-testid="request-log-table">
        <span data-testid="table-source">{props.sourceId}</span>
        <button
          type="button"
          onClick={() => props.onSourceChange("provider:deepseek")}
        >
          table-select-api
        </button>
        <button type="button" onClick={() => props.onSourceChange("")}>
          table-clear-source
        </button>
      </div>
    );
  },
}));

vi.mock("@/components/usage/ProviderStatsTable", () => ({
  ProviderStatsTable: (props: unknown) => {
    providerStatsMock(props);
    return <div data-testid="provider-stats-table" />;
  },
}));

vi.mock("@/components/usage/ModelStatsTable", () => ({
  ModelStatsTable: (props: unknown) => {
    modelStatsMock(props);
    return <div data-testid="model-stats-table" />;
  },
}));

vi.mock("@/components/usage/PricingConfigPanel", () => ({
  PricingConfigPanel: () => <div data-testid="pricing-config-panel" />,
}));

vi.mock("@/components/usage/UsageDateRangePicker", () => ({
  UsageDateRangePicker: () => <button type="button">date-range</button>,
}));

async function chooseOption(name: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole("combobox", { name }));
  await user.click(await screen.findByRole("option", { name: option }));
}

const renderDashboard = (props: ComponentProps<typeof UsageDashboard> = {}) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <UsageDashboard {...props} />
    </QueryClientProvider>,
  );
};

describe("UsageDashboard", () => {
  beforeEach(() => {
    useAttributionChoicesMock.mockReset();
    useModelStatsMock.mockReset();
    usageHeroMock.mockReset();
    usageTrendMock.mockReset();
    usageTableMock.mockReset();
    providerStatsMock.mockReset();
    modelStatsMock.mockReset();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    useAttributionChoicesMock.mockReturnValue({ data: [] });
    useModelStatsMock.mockReturnValue({ data: [] });
  });

  it("keeps scope help beside Usage and gives source and model filters accessible names", async () => {
    renderDashboard();
    const scope =
      "统计本机记录的 Codex 请求及扫描到的会话，按所选时间、连接来源和模型筛选；不会汇总账号在其他设备的用量，也不代表订阅额度。费用按本地价格表估算。";
    expect(screen.queryByText(scope)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Statistics scope" }));
    expect(await screen.findByText(scope)).toBeVisible();
    expect(
      screen.getByRole("combobox", { name: "usage.filterBySource" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "usage.filterByModel" }),
    ).toBeInTheDocument();
  });

  it("keeps the maintenance warning and requires confirmation before rebuilding", async () => {
    const rebuild = vi.spyOn(usageApi, "rebuildCodexUsage");
    try {
      renderDashboard();
      fireEvent.click(
        screen.getByRole("button", { name: "usage.rebuildCodex.title" }),
      );
      expect(
        await screen.findByText("usage.rebuildCodex.warning"),
      ).toBeVisible();
      fireEvent.click(
        screen.getByRole("button", { name: "usage.rebuildCodex.action" }),
      );
      expect(
        await screen.findByText("usage.rebuildCodex.confirmMessage"),
      ).toBeVisible();
      expect(rebuild).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
      await waitFor(() =>
        expect(
          screen.queryByText("usage.rebuildCodex.confirmMessage"),
        ).not.toBeInTheDocument(),
      );
      expect(rebuild).not.toHaveBeenCalled();
    } finally {
      rebuild.mockRestore();
    }
  });

  it("opens the source configuration beside session scanning and cancels without persisting", async () => {
    const readSource = vi
      .spyOn(usageApi, "getCodexUsageSource")
      .mockResolvedValue({
        directory: "/fixture/effective-source",
        defaultDirectory: "/fixture/default-source",
      });
    const onCodexUsageSourceDirChange = vi.fn().mockResolvedValue(true);
    try {
      renderDashboard({
        codexUsageSourceDir: "/fixture/custom-source",
        onCodexUsageSourceDirChange,
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Configure session source" }),
      );
      expect(
        await screen.findByText("/fixture/effective-source"),
      ).toBeVisible();
      expect(
        screen.getByRole("textbox", { name: "Codex root directory" }),
      ).toHaveValue("/fixture/custom-source");
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "/fixture/unsaved" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(onCodexUsageSourceDirChange).not.toHaveBeenCalled();
    } finally {
      readSource.mockRestore();
    }
  });

  it("uses the saved refresh interval when mounted", () => {
    renderDashboard({ refreshIntervalMs: 5000 });

    expect(
      screen.getByRole("combobox", { name: "usage.refreshInterval" }),
    ).toHaveTextContent("5s");
  });

  it("scopes every usage view and filter query to Codex on first render", () => {
    renderDashboard();
    expect(useModelStatsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { appType: "codex", accountId: undefined, providerId: undefined },
      expect.anything(),
    );
    expect(usageHeroMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ appType: "codex" }),
    );
    for (const app of [
      "all",
      "claude",
      "gemini",
      "grokbuild",
      "opencode",
      "pi",
      "mcode",
    ]) {
      expect(
        screen.queryByRole("button", { name: `usage.appFilter.${app}` }),
      ).not.toBeInTheDocument();
    }
  });

  it.each([false, true])(
    "keeps explicit session sync available when automatic scanning is %s",
    async (sessionAutoSyncEnabled) => {
      const sync = vi.spyOn(usageApi, "syncSessionUsage").mockResolvedValue({
        imported: 1,
        skipped: 0,
        filesScanned: 1,
        suspectedDuplicates: 0,
        deferredFiles: 0,
        errors: [],
      });
      try {
        renderDashboard({ sessionAutoSyncEnabled });
        fireEvent.click(
          screen.getByRole("button", { name: "usage.sessionSync.syncNow" }),
        );
        await waitFor(() => expect(sync).toHaveBeenCalledTimes(1));
        expect(useModelStatsMock).toHaveBeenLastCalledWith(
          expect.anything(),
          { appType: "codex", accountId: undefined, providerId: undefined },
          expect.anything(),
        );
      } finally {
        sync.mockRestore();
      }
    },
  );

  it("lists two subscription nicknames and one API source without requiring any usage", async () => {
    useAttributionChoicesMock.mockReturnValue({
      data: [
        {
          id: "account-one",
          label: "Account one",
          accountId: "oauth:one",
          accountName: "My Plus",
          providerId: "official-shared",
          providerName: "OpenAI",
        },
        {
          id: "account-two",
          label: "Account two",
          accountId: "oauth:two",
          accountName: "My Pro",
          providerId: "official-shared",
          providerName: "OpenAI",
        },
        {
          id: "api-deepseek",
          label: "DeepSeek",
          accountId: "api:deepseek",
          accountName: "API credentials",
          providerId: "deepseek",
          providerName: "DeepSeek",
        },
      ],
    });
    useModelStatsMock.mockReturnValue({
      data: [{ model: "gpt", requestCount: 1 }],
    });
    renderDashboard();
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("combobox", { name: "usage.filterBySource" }),
    );
    const listbox = await screen.findByRole("listbox");
    for (const name of ["My Plus", "My Pro", "DeepSeek"])
      expect(within(listbox).getByRole("option", { name })).toBeVisible();
    expect(
      within(listbox).queryByRole("option", { name: "OpenAI" }),
    ).not.toBeInTheDocument();
    await user.click(within(listbox).getByRole("option", { name: "My Plus" }));
    expect(usageHeroMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:one",
        providerId: undefined,
      }),
    );
    expect(usageTrendMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:one",
        providerId: undefined,
      }),
    );
    expect(useModelStatsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { appType: "codex", accountId: "oauth:one", providerId: undefined },
      expect.anything(),
    );
    expect(usageTableMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ sourceId: "account:oauth:one" }),
    );
    await chooseOption("usage.filterByModel", "gpt");
    await chooseOption("usage.filterBySource", "My Pro");
    expect(usageHeroMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:two",
        providerId: undefined,
        model: undefined,
      }),
    );
    expect(screen.getByTestId("table-source")).toHaveTextContent(
      "account:oauth:two",
    );
    await user.click(screen.getByRole("tab", { name: "usage.sourceStats" }));
    expect(providerStatsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:two",
        providerId: undefined,
      }),
    );
    await user.click(screen.getByRole("tab", { name: "usage.modelStats" }));
    expect(modelStatsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:two",
        providerId: undefined,
      }),
    );
    await user.click(screen.getByRole("tab", { name: "Usage records" }));
    await user.click(screen.getByRole("button", { name: "table-select-api" }));
    expect(
      screen.getByRole("combobox", { name: "usage.filterBySource" }),
    ).toHaveTextContent("DeepSeek");
    expect(usageHeroMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: undefined, providerId: "deepseek" }),
    );
    await user.click(
      screen.getByRole("button", { name: "table-clear-source" }),
    );
    expect(screen.getByTestId("table-source")).toBeEmptyDOMElement();
    expect(
      screen.getByRole("combobox", { name: "usage.filterBySource" }),
    ).toHaveTextContent("usage.allSources");
    expect(usageHeroMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ accountId: undefined, providerId: undefined }),
    );
  });

  it("persists refresh interval changes", async () => {
    const onRefreshIntervalChange = vi.fn().mockResolvedValue(true);
    renderDashboard({ onRefreshIntervalChange });

    await chooseOption("usage.refreshInterval", "5s");

    await waitFor(() =>
      expect(onRefreshIntervalChange).toHaveBeenCalledWith(5000),
    );
    expect(
      screen.getByRole("combobox", { name: "usage.refreshInterval" }),
    ).toHaveTextContent("5s");
  });

  it("rolls back optimistic interval changes when persistence fails", async () => {
    const onRefreshIntervalChange = vi.fn().mockResolvedValue(false);
    renderDashboard({ onRefreshIntervalChange });

    await chooseOption("usage.refreshInterval", "5s");

    await waitFor(() =>
      expect(onRefreshIntervalChange).toHaveBeenCalledWith(5000),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "usage.refreshInterval" }),
      ).toHaveTextContent("30s"),
    );
  });
});
