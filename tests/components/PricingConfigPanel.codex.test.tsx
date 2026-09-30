import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelPricing } from "@/types/usage";
import { PricingConfigPanel } from "@/components/usage/PricingConfigPanel";

const mocks = vi.hoisted(() => ({
  translate: (key: string) => key,
  getModelPricing: vi.fn(),
  updateModelPricing: vi.fn(),
  getPricingModelSource: vi.fn(),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));
vi.mock("@/lib/api/usage", () => ({ usageApi: mocks }));
vi.mock("@/lib/api/proxy", () => ({ proxyApi: mocks }));
vi.mock("@/components/usage/ModelsDevAutoSyncPanel", () => ({
  ModelsDevAutoSyncPanel: () => null,
}));
vi.mock("@/components/usage/ModelsDevPickerDialog", () => ({
  ModelsDevPickerDialog: () => null,
}));
vi.mock("@/components/common/FullScreenPanel", () => ({
  FullScreenPanel: ({ children, footer }: any) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

const entry = (modelId: string, displayName: string): ModelPricing => ({
  modelId,
  displayName,
  inputCostPerMillion: "1",
  outputCostPerMillion: "2",
  cacheReadCostPerMillion: "0",
  cacheCreationCostPerMillion: "0",
});

let pricing: ModelPricing[];
beforeEach(() => {
  vi.clearAllMocks();
  pricing = [
    entry("gpt-5-codex", "GPT-5 Codex"),
    entry("claude-sonnet-4", "Claude Sonnet 4"),
  ];
  mocks.getModelPricing.mockImplementation(async () => [...pricing]);
  mocks.getPricingModelSource.mockResolvedValue("response");
  mocks.updateModelPricing.mockImplementation(
    async (
      modelId: string,
      displayName: string,
      input: string,
      output: string,
      cacheRead: string,
      cacheCreation: string,
    ) => {
      pricing = pricing.filter((model) => model.modelId !== modelId);
      pricing.push({
        modelId,
        displayName,
        inputCostPerMillion: input,
        outputCostPerMillion: output,
        cacheReadCostPerMillion: cacheRead,
        cacheCreationCostPerMillion: cacheCreation,
      });
    },
  );
});
function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PricingConfigPanel />
    </QueryClientProvider>,
  );
}

describe("Codex pricing", () => {
  it("loads pricing source settings only for Codex and hides other harness model rows", async () => {
    renderPanel();
    expect(await screen.findByText("gpt-5-codex")).toBeInTheDocument();
    expect(screen.queryByText("claude-sonnet-4")).not.toBeInTheDocument();
    expect(mocks.getPricingModelSource.mock.calls).toEqual([["codex"]]);
    expect(pricing).toHaveLength(2);
  });

  it("keeps a newly saved custom model alias visible and editable", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "common.add" }));
    fireEvent.change(screen.getByLabelText("usage.modelId"), {
      target: { value: "company-fast-alias" },
    });
    fireEvent.change(screen.getByLabelText("usage.displayName"), {
      target: { value: "Company Fast" },
    });
    fireEvent.submit(document.getElementById("pricing-form")!);
    const model = await screen.findByText("company-fast-alias");
    expect(screen.getByText("Company Fast")).toBeInTheDocument();
    fireEvent.click(within(model.closest("tr")!).getAllByRole("button")[0]);
    const displayName = screen.getByLabelText("usage.displayName");
    expect(displayName).toHaveValue("Company Fast");
    fireEvent.change(displayName, {
      target: { value: "Company Fast Updated" },
    });
    fireEvent.submit(document.getElementById("pricing-form")!);
    await waitFor(() =>
      expect(screen.getByText("Company Fast Updated")).toBeInTheDocument(),
    );
    expect(screen.getByText("company-fast-alias")).toBeInTheDocument();
    expect(mocks.updateModelPricing).toHaveBeenCalledTimes(2);
  });
});
