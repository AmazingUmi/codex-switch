import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderCard } from "@/components/providers/ProviderCard";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

vi.mock("@/components/providers/ApiBalance", () => ({
  ApiBalance: () => <div>api-balance</div>,
}));
vi.mock("@/components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("@/components/CodexOauthQuotaFooter", () => ({
  default: () => <div>account-quota</div>,
}));
vi.mock("@/components/SubscriptionQuotaFooter", () => ({
  default: () => <div>subscription-quota</div>,
}));

const provider: Provider = {
  id: "openai-api",
  name: "OpenAI API",
  category: "official",
  settingsConfig: { auth: { OPENAI_API_KEY: "fixture" }, config: "" },
  meta: {
    usage_script: {
      enabled: true,
      language: "javascript",
      code: "",
      templateType: "official_subscription",
    },
  },
};

function renderCard(isCurrent = false) {
  const onDelete = vi.fn();
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <ProviderCard
        provider={provider}
        appId="codex"
        isCurrent={isCurrent}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={onDelete}
        onConfigureUsage={vi.fn()}
        onOpenWebsite={vi.fn()}
        onDuplicate={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return onDelete;
}

describe("API provider and subscription account separation", () => {
  it("shows only API balance even with stale subscription usage metadata", () => {
    renderCard();
    expect(screen.getByText("api-balance")).toBeInTheDocument();
    expect(screen.queryByText("account-quota")).not.toBeInTheDocument();
    expect(screen.queryByText("subscription-quota")).not.toBeInTheDocument();
    expect(screen.queryByText("选择账号")).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "exposes Remove for a current or inactive provider (%s)",
    async (isCurrent) => {
      const onDelete = renderCard(isCurrent);
      await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "移除" }));
      expect(onDelete).toHaveBeenCalledWith(provider);
    },
  );
});
