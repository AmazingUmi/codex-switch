import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiBalance } from "@/components/providers/ApiBalance";
import { subscriptionApi } from "@/lib/api/subscription";
import type { Provider, UsageResult } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const getBalance = vi.spyOn(subscriptionApi, "getBalance");
const result = (amount: number): UsageResult => ({
  success: true,
  data: [{ remaining: amount, unit: "CNY", isValid: true }],
});
function provider(
  key = "fake-key",
  baseUrl = "https://api.deepseek.com/v1",
): Provider {
  return {
    id: "balance-test",
    name: "DeepSeek",
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: key },
      config: `model_provider = "custom"\n[model_providers.custom]\nbase_url = "${baseUrl}"\nwire_api = "responses"`,
    },
  };
}
function setup(initial = provider()) {
  const client = createTestQueryClient();
  const view = render(
    <QueryClientProvider client={client}>
      <ApiBalance provider={initial} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    update: (next: Provider) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <ApiBalance provider={next} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(() => getBalance.mockReset());

describe("API balance display", () => {
  it("automatically queries the saved connection and refreshes the displayed balance", async () => {
    getBalance
      .mockResolvedValueOnce(result(48.9234))
      .mockResolvedValueOnce(result(42));
    const { client } = setup();
    expect(await screen.findByText("48.9234")).toBeInTheDocument();
    expect(getBalance).toHaveBeenCalledWith(
      "https://api.deepseek.com/v1",
      "fake-key",
    );
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.queryKey),
      ),
    ).not.toContain("fake-key");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "刷新余额" }));
    expect(await screen.findByText("42.00")).toBeInTheDocument();
    expect(getBalance).toHaveBeenCalledTimes(2);
  });

  it("keeps real zero, four decimal precision and multiple currencies separate", async () => {
    getBalance.mockResolvedValue({
      success: true,
      data: [
        { remaining: 0, unit: "CNY", isValid: false },
        { remaining: 0.0001, unit: "USD", isValid: false },
      ],
    });
    setup();
    expect(await screen.findByText("0.00")).toBeInTheDocument();
    expect(screen.getByText("0.0001")).toBeInTheDocument();
    expect(screen.getByText("CNY")).toBeInTheDocument();
    expect(screen.getByText("USD")).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "余额详情" }));
    expect(
      screen.getByText("供应商提示当前余额不可用于 API 调用。"),
    ).toBeInTheDocument();
  });

  it.each([
    "https://example.com/api.deepseek.com",
    "https://api.deepseek.com.evil.test",
  ])("does not send credentials for unsupported URL %s", async (baseUrl) => {
    setup(provider("fake-key", baseUrl));
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "刷新余额" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "余额详情" }));
    expect(screen.getByText("此供应商暂不支持余额查询")).toBeInTheDocument();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it("does not query a connection without an API key", async () => {
    setup(provider(""));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "余额详情" }));
    expect(screen.getByText("请先填写 API Key")).toBeInTheDocument();
    expect(getBalance).not.toHaveBeenCalled();
  });

  it.each([
    () => Promise.reject(new Error("Network error: offline")),
    () =>
      Promise.resolve({
        success: false,
        error: "Authentication failed (HTTP 401)",
      }),
  ])(
    "hides a previous balance on failed refresh and exposes the error",
    async (fail) => {
      getBalance.mockResolvedValueOnce(result(19)).mockImplementationOnce(fail);
      setup();
      expect(await screen.findByText("19.00")).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "刷新余额" }));
      await waitFor(() =>
        expect(screen.queryByText("19.00")).not.toBeInTheDocument(),
      );
      expect(screen.getByText("—")).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "余额详情" }));
      expect(
        screen.getByText(
          /Network error: offline|Authentication failed \(HTTP 401\)/,
        ),
      ).toBeInTheDocument();
    },
  );

  it.each(
    [[], [{ remaining: Number.NaN, unit: "USD" }], [{ remaining: 12 }]].map(
      (data) => ({ data }),
    ),
  )(
    "does not present malformed successful results as zero",
    async ({ data }) => {
      getBalance.mockResolvedValue({ success: true, data });
      setup();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "刷新余额" })).toBeEnabled(),
      );
      expect(screen.getByText("—")).toBeInTheDocument();
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "余额详情" }));
      expect(screen.getByText("供应商未返回有效余额")).toBeInTheDocument();
    },
  );

  it("isolates changed keys and addresses, including out of order responses", async () => {
    let oldResolve!: (value: UsageResult) => void;
    let newResolve!: (value: UsageResult) => void;
    getBalance
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldResolve = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            newResolve = resolve;
          }),
      )
      .mockResolvedValueOnce(result(33));
    const view = setup();
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(1));
    view.update(provider("new-key"));
    await waitFor(() => expect(getBalance).toHaveBeenCalledTimes(2));
    newResolve(result(25));
    expect(await screen.findByText("25.00")).toBeInTheDocument();
    oldResolve(result(999));
    await waitFor(() =>
      expect(screen.queryByText("999.00")).not.toBeInTheDocument(),
    );
    view.update(provider("new-key", "https://api.siliconflow.cn/v1"));
    expect(screen.queryByText("25.00")).not.toBeInTheDocument();
    expect(await screen.findByText("33.00")).toBeInTheDocument();
    view.update(provider(""));
    expect(screen.queryByText("33.00")).not.toBeInTheDocument();
    expect(getBalance).toHaveBeenCalledTimes(3);
  });
});
