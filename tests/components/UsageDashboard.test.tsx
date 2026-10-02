import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usageApi } from "@/lib/api/usage";
import { UsageDashboard } from "@/components/usage/UsageDashboard";

const useProviderStatsMock = vi.hoisted(() => vi.fn());
const useModelStatsMock = vi.hoisted(() => vi.fn());
const usageHeroMock = vi.hoisted(() => vi.fn());

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
    useProviderStats: (...args: unknown[]) => useProviderStatsMock(...args),
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
  UsageTrendChart: () => <div data-testid="usage-trend" />,
}));

vi.mock("@/components/usage/RequestLogTable", () => ({
  RequestLogTable: () => <div data-testid="request-log-table" />,
}));

vi.mock("@/components/usage/ProviderStatsTable", () => ({
  ProviderStatsTable: () => <div data-testid="provider-stats-table" />,
}));

vi.mock("@/components/usage/ModelStatsTable", () => ({
  ModelStatsTable: () => <div data-testid="model-stats-table" />,
}));

vi.mock("@/components/usage/PricingConfigPanel", () => ({
  PricingConfigPanel: () => <div data-testid="pricing-config-panel" />,
}));

vi.mock("@/components/usage/UsageDateRangePicker", () => ({
  UsageDateRangePicker: () => <button type="button">date-range</button>,
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ value, onValueChange, children }: any) => (
    <div data-testid={`select-${value}`}>
      {children}
      <button type="button" onClick={() => onValueChange?.("5000")}>
        choose-5000
      </button>
    </div>
  ),
  SelectTrigger: ({ children, ...props }: any) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  SelectValue: () => null,
  SelectContent: ({ children }: any) => <div>{children}</div>,
  SelectItem: ({ children, ...props }: any) => <div {...props}>{children}</div>,
}));

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
    useProviderStatsMock.mockReset();
    useModelStatsMock.mockReset();
    usageHeroMock.mockReset();
    useProviderStatsMock.mockReturnValue({ data: [] });
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
      screen.getByRole("button", { name: "usage.filterBySource" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "usage.filterByModel" }),
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

    expect(screen.getByTestId("select-5000")).toBeInTheDocument();
  });

  it("scopes every usage view and filter query to Codex on first render", () => {
    renderDashboard();
    expect(useProviderStatsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { appType: "codex" },
      expect.anything(),
    );
    expect(useModelStatsMock).toHaveBeenLastCalledWith(
      expect.anything(),
      { appType: "codex", providerName: undefined },
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
        expect(useProviderStatsMock).toHaveBeenLastCalledWith(
          expect.anything(),
          { appType: "codex" },
          expect.anything(),
        );
      } finally {
        sync.mockRestore();
      }
    },
  );

  it("persists refresh interval changes", async () => {
    const onRefreshIntervalChange = vi.fn().mockResolvedValue(true);
    renderDashboard({ onRefreshIntervalChange });

    fireEvent.click(
      within(screen.getByTestId("select-30000")).getByRole("button", {
        name: "choose-5000",
      }),
    );

    await waitFor(() =>
      expect(onRefreshIntervalChange).toHaveBeenCalledWith(5000),
    );
    expect(screen.getByTestId("select-5000")).toBeInTheDocument();
  });

  it("rolls back optimistic interval changes when persistence fails", async () => {
    const onRefreshIntervalChange = vi.fn().mockResolvedValue(false);
    renderDashboard({ onRefreshIntervalChange });

    fireEvent.click(
      within(screen.getByTestId("select-30000")).getByRole("button", {
        name: "choose-5000",
      }),
    );

    await waitFor(() =>
      expect(onRefreshIntervalChange).toHaveBeenCalledWith(5000),
    );
    await waitFor(() =>
      expect(screen.getByTestId("select-30000")).toBeInTheDocument(),
    );
  });
});
