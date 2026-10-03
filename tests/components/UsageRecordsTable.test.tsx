import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import userEvent from "@testing-library/user-event";
import {
  UsageRecordsTable,
  usageRowSelector,
} from "@/components/usage/UsageRecordsTable";
import { usageRowSource, usageSourceName } from "@/lib/usageSource";
import { usageApi } from "@/lib/api/usage";
import type { UsageRecordRow } from "@/types/usage";

const group: UsageRecordRow = {
  id: "session:s1",
  sessionId: "session-123456",
  appType: "codex",
  startAt: 100,
  endAt: 200,
  recordCount: 50,
  accountIds: ["a1", "a2"],
  providerIds: ["p1", "p2"],
  accountNames: ["Account A", "Account B"],
  providerNames: ["Provider A", "Provider B"],
  models: ["deepseek"],
  method: "mixed",
  inputTokens: 123,
  outputTokens: 25,
  cacheReadTokens: 30,
  cacheCreationTokens: 0,
  totalCostUsd: "0",
  unpricedCount: 50,
};
const props = {
  range: { preset: "custom" as const, customStartDate: 1, customEndDate: 300 },
  rangeLabel: "range",
  refreshIntervalMs: 0,
};

function renderTable(
  overrides: Partial<ComponentProps<typeof UsageRecordsTable>> = {},
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = render(
    <QueryClientProvider client={client}>
      <UsageRecordsTable {...props} {...overrides} />
    </QueryClientProvider>,
  );
  return { invalidate, client, ...view };
}

async function chooseOption(trigger: HTMLElement, option: string) {
  const user = userEvent.setup();
  await user.click(trigger);
  const item = await screen.findByRole("option", { name: option });
  expect(screen.getByRole("listbox")).toHaveClass("glass-popover");
  await user.click(item);
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.spyOn(usageApi, "getUsageRecords").mockResolvedValue({
    data: [group],
    total: 41,
    page: 0,
    pageSize: 20,
  });
  vi.spyOn(usageApi, "getUsageAttributionChoices").mockResolvedValue([
    {
      id: "choice-1",
      label: "DeepSeek API · DeepSeek",
      accountId: "api:deepseek",
      accountName: "DeepSeek API",
      providerId: "deepseek",
      providerName: "DeepSeek",
    },
  ]);
  vi.spyOn(usageApi, "previewUsageAttribution").mockResolvedValue(50);
  vi.spyOn(usageApi, "setUsageAttribution").mockResolvedValue({
    actionId: 42,
    count: 50,
  });
  vi.spyOn(usageApi, "undoUsageAttribution").mockResolvedValue(50);
});

describe("grouped usage records", () => {
  it("defaults to server-side session grouping, shows multiple identities and unknown price", async () => {
    renderTable();
    await screen.findByText("session-");
    expect(screen.getByRole("combobox", { name: "View" })).toHaveTextContent(
      "session",
    );
    for (const trigger of screen.getAllByRole("combobox")) {
      expect(trigger.tagName).toBe("BUTTON");
      expect(trigger).toHaveClass(
        "app-button",
        "glass-button",
        "rounded-full",
        "h-9",
        "px-4",
        "text-xs",
        "font-medium",
      );
      expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    }
    expect(usageApi.getUsageRecords).toHaveBeenCalledWith(
      expect.objectContaining({ startDate: 1, endDate: 300 }),
      "session",
      0,
      20,
      "local",
    );
    expect(screen.getAllByText("Multiple")).toHaveLength(1);
    expect(screen.getByText("—")).toBeVisible();
    expect(screen.queryByText("$0.0000")).not.toBeInTheDocument();
    expect(screen.getByText("123")).toBeVisible(); // backend normalized; do not subtract cache again
  });

  it("expands the session with all active filters and paginates raw details", async () => {
    renderTable();
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand records" }),
    );
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-123456",
          startDate: 1,
          endDate: 300,
        }),
        "details",
        0,
        20,
        "local",
      ),
    );
  });

  it("assigns the entire filtered range across pages, previews count, defaults to untagged and supports undo", async () => {
    const { invalidate } = renderTable();
    await screen.findByText("session-");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenCalledWith(
        expect.anything(),
        "session",
        1,
        20,
        "local",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Assign filtered records" }),
    );
    expect(
      await screen.findByText("Currently 50 matching usage records"),
    ).toBeVisible();
    expect(usageApi.previewUsageAttribution).toHaveBeenLastCalledWith(
      expect.objectContaining({ startDate: 1, endDate: 300 }),
      true,
    );
    const target = within(screen.getByRole("dialog")).getByRole("combobox", {
      name: "Source",
    });
    expect(target).toHaveClass(
      "app-button",
      "glass-button",
      "rounded-full",
      "h-9",
      "px-4",
      "font-medium",
    );
    expect(target).toHaveTextContent("Choose…");
    await chooseOption(target, "DeepSeek");
    fireEvent.click(screen.getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(usageApi.setUsageAttribution).toHaveBeenCalledWith(
        expect.not.objectContaining({ requestIds: expect.anything() }),
        "choice-1",
        true,
      ),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["usage"] });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(usageApi.undoUsageAttribution).toHaveBeenCalledWith(42),
    );
  });

  it("requires explicit replacement of existing tags", async () => {
    renderTable();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Assign this record or group",
      }),
    );
    fireEvent.click(
      await screen.findByRole("checkbox", {
        name: "Replace existing labels in this selection",
      }),
    );
    await waitFor(() =>
      expect(usageApi.previewUsageAttribution).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: "session-123456" }),
        false,
      ),
    );
  });

  it("shows identity/model breakdown totals and keeps unassigned bucket scope exact", async () => {
    const unknown = {
      ...group,
      id: "hour:unknown",
      sessionId: null,
      accountIds: ["__unassigned__"],
      providerIds: ["__unassigned__"],
      accountNames: ["Unassigned"],
      providerNames: ["Unassigned"],
      accountName: "Unassigned",
      providerName: "Unassigned",
      bucketStartAt: 0,
      bucketEndAt: 3600,
      method: "untagged" as const,
    };
    vi.mocked(usageApi.getUsageRecords).mockResolvedValue({
      data: [
        {
          ...unknown,
          breakdown: [{ ...unknown, inputTokens: 777, outputTokens: 888 }],
        },
      ],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    renderTable();
    await chooseOption(screen.getByRole("combobox", { name: "View" }), "hour");
    fireEvent.click(
      await screen.findByRole("button", { name: "Expand records" }),
    );
    expect(await screen.findByText(/Input: 777 · Output: 888/)).toBeVisible();
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenCalledWith(
        expect.objectContaining({
          startDate: 1,
          endDate: 300,
          accountId: "__unassigned__",
          providerId: "__unassigned__",
          attribution: "untagged",
        }),
        "details",
        0,
        20,
        "local",
      ),
    );
    fireEvent.click(
      screen.getAllByRole("button", { name: "Assign this record or group" })[0],
    );
    await waitFor(() =>
      expect(usageApi.previewUsageAttribution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: "__unassigned__",
          providerId: "__unassigned__",
          startDate: 1,
          endDate: 300,
        }),
        true,
      ),
    );
  });

  it("merges columns and lists subscription nicknames and API provider names as peers", async () => {
    const choices = [
      {
        id: "account-choice",
        label: "old",
        accountId: "oauth:1",
        accountName: "My Plus",
        providerId: "official-config",
        providerName: "OpenAI",
      },
      {
        id: "api-choice",
        label: "DeepSeek API · DeepSeek",
        accountId: "api:deepseek",
        accountName: "DeepSeek API credentials",
        providerId: "deepseek",
        providerName: "DeepSeek",
      },
      {
        id: "historical-account-choice",
        label: "Old name",
        accountId: "oauth:1",
        accountName: "Old name",
        providerId: "other-official-config",
        providerName: "OpenAI",
      },
    ];
    vi.mocked(usageApi.getUsageAttributionChoices).mockResolvedValue(choices);
    vi.mocked(usageApi.getUsageRecords).mockResolvedValue({
      data: [
        {
          ...group,
          accountIds: ["oauth:1"],
          accountName: "Old name",
          accountNames: ["Old name"],
          providerIds: ["old-official"],
          providerNames: ["OpenAI"],
        },
      ],
      total: 1,
      page: 0,
      pageSize: 20,
    });
    renderTable();
    await screen.findAllByText("My Plus");
    expect(screen.getByRole("columnheader", { name: "Source" })).toBeVisible();
    expect(
      screen.queryByRole("columnheader", { name: "account" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("columnheader", { name: "provider" }),
    ).not.toBeInTheDocument();
    const source = screen.getByRole("combobox", { name: "Source" });
    await userEvent.setup().click(source);
    expect(
      await screen.findByRole("option", { name: "My Plus" }),
    ).toBeVisible();
    expect(screen.getByRole("option", { name: "DeepSeek" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Old name" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("option", { name: "My Plus" }));
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: "oauth:1",
          providerId: undefined,
        }),
        "session",
        0,
        20,
        "local",
      ),
    );
    await chooseOption(source, "DeepSeek");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: undefined,
          providerId: "deepseek",
        }),
        "session",
        0,
        20,
        "local",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Assign filtered records" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("combobox", { name: "Source" }),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        /Only unassigned records are labeled by default/,
      ),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("checkbox", {
        name: "Replace existing labels in this selection",
      }),
    );
    await waitFor(() =>
      expect(usageApi.previewUsageAttribution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          providerId: "deepseek",
          accountId: undefined,
          startDate: 1,
          endDate: 300,
        }),
        false,
      ),
    );
  });

  it("uses canonical source identity rather than names or official config pairings", () => {
    const subscription = {
      ...group,
      accountIds: ["oauth:1"],
      accountNames: ["Old"],
      providerIds: ["official-1", "official-2"],
      providerNames: ["OpenAI"],
    };
    const choices = [
      {
        id: "one",
        label: "My Plus",
        accountId: "oauth:1",
        accountName: "My Plus",
        providerId: "official-current",
        providerName: "OpenAI",
      },
    ];
    expect(usageRowSource(subscription, choices)).toEqual({
      name: "My Plus",
      multiple: false,
    });
    expect(
      usageRowSource(
        {
          ...group,
          accountNames: ["Same", "Same"],
          accountIds: ["oauth:1", "oauth:2"],
        },
        choices,
      ).multiple,
    ).toBe(true);
    expect(
      usageRowSource(
        {
          ...group,
          accountIds: ["api:deepseek"],
          providerIds: ["deepseek"],
          providerName: "Deleted provider",
          providerNames: ["Deleted provider"],
          accountName: "Credentials",
        },
        [],
      ),
    ).toEqual({ name: "Deleted provider", multiple: false });
  });

  it("uses canonical Source for time bucket expansion and tagging across subscription configs and legacy API records", () => {
    const bucket = {
      ...group,
      sessionId: null,
      bucketStartAt: 3600,
      bucketEndAt: 7200,
    };
    expect(
      usageRowSelector(
        {
          ...bucket,
          accountIds: ["oauth:1"],
          providerIds: ["official-old", "official-new"],
        },
        {
          startDate: 4000,
          endDate: 5000,
          providerId: "official-old",
          model: "gpt",
        },
      ),
    ).toEqual({
      startDate: 4000,
      endDate: 5000,
      accountId: "oauth:1",
      providerId: undefined,
      model: "gpt",
      attribution: undefined,
    });
    expect(
      usageRowSelector(
        {
          ...bucket,
          accountIds: ["api:deepseek", "__unassigned__"],
          providerIds: ["deepseek"],
          method: "mixed",
        },
        { startDate: 4000, endDate: 5000, accountId: "api:deepseek" },
      ),
    ).toEqual({
      startDate: 4000,
      endDate: 5000,
      accountId: undefined,
      providerId: "deepseek",
      attribution: undefined,
    });
    expect(
      usageRowSelector(
        {
          ...bucket,
          accountIds: ["__unassigned__"],
          providerIds: ["deepseek"],
          method: "untagged",
        },
        {},
      ),
    ).toEqual({
      startDate: 3600,
      endDate: 7199,
      accountId: undefined,
      providerId: "deepseek",
      attribution: "untagged",
    });
    expect(
      usageSourceName({
        accountId: "__unassigned__",
        accountName: " Unassigned ",
        providerName: " DeepSeek ",
      }),
    ).toBe("DeepSeek");
    expect(
      usageSourceName({ accountName: "  ", providerName: " Gateway " }),
    ).toBe("Gateway");
    expect(
      usageSourceName({ accountName: " Unassigned ", providerName: "  " }),
    ).toBeNull();
  });

  it("identifies provider-only legacy choices as API when source names collide", async () => {
    vi.mocked(usageApi.getUsageAttributionChoices).mockResolvedValue([
      {
        id: "account-peer",
        label: "Same",
        accountId: "oauth:peer",
        accountName: "Same",
        providerId: "official",
      },
      {
        id: "provider-peer",
        label: "Same",
        accountId: null,
        providerId: "legacy-api",
        providerName: "Same",
      },
    ]);
    renderTable();
    await screen.findByText("session-");
    await userEvent
      .setup()
      .click(screen.getByRole("combobox", { name: "Source" }));
    expect(
      await screen.findByRole("option", { name: "Same (API)" }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: "Same (Account)" }),
    ).toBeVisible();
  });

  it("supports keyboard navigation through the glass filters and clears Source through its all sentinel", async () => {
    const user = userEvent.setup();
    renderTable();
    await screen.findByText("session-");
    await user.tab();
    expect(screen.getByRole("combobox", { name: "View" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "details" });
    await user.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.anything(),
        "details",
        0,
        20,
        "local",
      ),
    );
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Attribution" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "manual" });
    await user.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({ attribution: "manual" }),
        "details",
        0,
        20,
        "local",
      ),
    );
    await user.tab();
    const source = screen.getByRole("combobox", { name: "Source" });
    expect(source).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "DeepSeek" });
    await user.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({ providerId: "deepseek" }),
        "details",
        0,
        20,
        "local",
      ),
    );
    await user.tab();
    expect(screen.getByRole("combobox", { name: "Time zone" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "UTC", selected: false });
    await user.keyboard("{End}{Enter}");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.anything(),
        "details",
        0,
        20,
        "UTC",
      ),
    );
    source.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "All sources" });
    await user.keyboard("{Home}{Enter}");
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: undefined,
          providerId: undefined,
        }),
        "details",
        0,
        20,
        "UTC",
      ),
    );
    expect(source).toHaveTextContent("All sources");
  });

  it("keeps canonical Source controlled by the dashboard and synchronizes account changes and clearing", async () => {
    vi.mocked(usageApi.getUsageAttributionChoices).mockResolvedValue([
      {
        id: "one-choice",
        label: "My Plus",
        accountId: "oauth:one",
        accountName: "My Plus",
        providerId: "same-official",
        providerName: "OpenAI",
      },
      {
        id: "two-choice",
        label: "My Pro",
        accountId: "oauth:two",
        accountName: "My Pro",
        providerId: "same-official",
        providerName: "OpenAI",
      },
    ]);
    const onSourceChange = vi.fn();
    const { client, rerender } = renderTable({
      sourceId: "account:oauth:two",
      onSourceChange,
    });
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Source" }),
      ).toHaveTextContent("My Pro"),
    );
    expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
      expect.objectContaining({
        accountId: "oauth:two",
        providerId: undefined,
      }),
      "session",
      0,
      20,
      "local",
    );
    await chooseOption(
      screen.getByRole("combobox", { name: "Source" }),
      "My Plus",
    );
    expect(onSourceChange).toHaveBeenLastCalledWith("account:oauth:one");
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent(
      "My Pro",
    );
    rerender(
      <QueryClientProvider client={client}>
        <UsageRecordsTable
          {...props}
          sourceId="account:oauth:one"
          onSourceChange={onSourceChange}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: "oauth:one",
          providerId: undefined,
        }),
        "session",
        0,
        20,
        "local",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent(
      "My Plus",
    );
    rerender(
      <QueryClientProvider client={client}>
        <UsageRecordsTable
          {...props}
          sourceId=""
          onSourceChange={onSourceChange}
        />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(usageApi.getUsageRecords).toHaveBeenLastCalledWith(
        expect.objectContaining({
          accountId: undefined,
          providerId: undefined,
        }),
        "session",
        0,
        20,
        "local",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent(
      "All sources",
    );
  });

  it("builds exact record/session/bucket scopes", () => {
    expect(
      usageRowSelector({ ...group, requestId: "req1" }, { startDate: 1 }),
    ).toEqual({ requestIds: ["req1"] });
    expect(
      usageRowSelector(group, { model: "deepseek", startDate: 1 }),
    ).toEqual({ model: "deepseek", startDate: 1, sessionId: "session-123456" });
    expect(
      usageRowSelector(
        {
          ...group,
          sessionId: null,
          accountIds: ["a1"],
          providerIds: ["p1"],
          bucketStartAt: 3600,
          bucketEndAt: 7200,
        },
        { startDate: 4000, endDate: 5000 },
      ),
    ).toEqual({
      startDate: 4000,
      endDate: 5000,
      accountId: "a1",
      providerId: undefined,
      attribution: undefined,
    });
  });
});
