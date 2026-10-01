import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { ProviderCard } from "@/components/providers/ProviderCard";
import type { Provider } from "@/types";
import { createTestQueryClient } from "../utils/testQueryClient";

const actionsSpy = vi.hoisted(() => vi.fn());
vi.mock("@/components/providers/ProviderActions", () => ({
  ProviderActions: (props: unknown) => {
    actionsSpy(props);
    return null;
  },
}));
vi.mock("@/components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("@/components/UsageFooter", () => ({ default: () => null }));
vi.mock("@/components/SubscriptionQuotaFooter", () => ({
  default: () => <span>subscription-quota</span>,
}));
vi.mock("@/components/CopilotQuotaFooter", () => ({
  default: () => <span>copilot-quota</span>,
}));
vi.mock("@/components/CodexOauthQuotaFooter", () => ({
  default: () => <span>codex-quota</span>,
}));
vi.mock("@/components/XaiOauthQuotaFooter", () => ({
  default: () => <span>xai-quota</span>,
}));
vi.mock("@/lib/query/failover", () => ({
  useProviderHealth: () => ({
    data: { consecutive_failures: 0, is_healthy: true },
  }),
}));
vi.mock("@/lib/query/queries", () => ({
  useUsageQuery: () => ({ data: undefined }),
}));

const customProvider = (overrides: Partial<Provider> = {}): Provider => ({
  id: "api-provider",
  name: "API connection",
  category: "custom",
  settingsConfig: {
    auth: { OPENAI_API_KEY: "test-key" },
    config:
      'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://example.com/v1"\nwire_api = "responses"',
  },
  ...overrides,
});
function renderCard(
  provider = customProvider(),
  props: Partial<ComponentProps<typeof ProviderCard>> = {},
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(["managed-auth-status", "codex_oauth"], {
    accounts: [],
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ProviderCard
        provider={provider}
        appId="codex"
        isCurrent={false}
        isProxyRunning={false}
        onSwitch={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onConfigureUsage={vi.fn()}
        onOpenWebsite={vi.fn()}
        onDuplicate={vi.fn()}
        onTest={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

describe("Codex card routing and existing provider formats", () => {
  it.each([
    {
      takeover: false,
      failover: false,
      current: true,
      active: undefined,
      color: "blue",
    },
    {
      takeover: true,
      failover: false,
      current: true,
      active: undefined,
      color: "emerald",
    },
    {
      takeover: true,
      failover: true,
      current: false,
      active: "api-provider",
      color: "emerald",
    },
    {
      takeover: true,
      failover: true,
      current: true,
      active: "other-provider",
      color: undefined,
    },
    {
      takeover: true,
      failover: true,
      current: true,
      active: undefined,
      color: undefined,
    },
  ])(
    "uses the actual route target only after it is known: %j",
    ({ takeover, failover, current, active, color }) => {
      const { container } = renderCard(customProvider(), {
        isCurrent: current,
        isProxyTakeover: takeover,
        isAutoFailoverEnabled: failover,
        activeProviderId: active,
      });
      const card = container.querySelector(".group")!;
      expect(card.classList.contains("border-blue-500/60")).toBe(
        color === "blue",
      );
      expect(card.classList.contains("border-emerald-500/60")).toBe(
        color === "emerald",
      );
    },
  );

  it("keeps the direct marker separate from the active route and preserves website callbacks", async () => {
    const user = userEvent.setup();
    const onOpenWebsite = vi.fn();
    renderCard(customProvider(), {
      isDirectProvider: true,
      isProxyTakeover: true,
      onOpenWebsite,
    });
    expect(screen.getByText("直连")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "https://example.com/v1" }),
    );
    expect(onOpenWebsite).toHaveBeenCalledWith("https://example.com/v1");
  });

  it.each(["openai_chat", "anthropic"] as const)(
    "retains routing and detection for %s API providers",
    (apiFormat) => {
      renderCard(customProvider({ meta: { apiFormat } }));
      expect(screen.getByText("需要路由")).toBeInTheDocument();
      expect(actionsSpy.mock.calls.at(-1)![0].onTest).toBeTypeOf("function");
    },
  );

  it.each([
    { providerType: "github_copilot", quota: "copilot-quota" },
    { providerType: "xai_oauth", quota: "xai-quota" },
  ] as const)(
    "keeps managed upstream $providerType quota and routing behavior",
    ({ providerType, quota }) => {
      renderCard(customProvider({ meta: { providerType } }));
      expect(screen.getByText(quota)).toBeInTheDocument();
      expect(screen.getByText("需要路由")).toBeInTheDocument();
      expect(actionsSpy.mock.calls.at(-1)![0].onConfigureUsage).toBeUndefined();
    },
  );

  it.each(["native", "managed", "api_key"] as const)(
    "preserves the official %s takeover policy",
    (kind) => {
      const provider: Provider = {
        id: kind === "native" ? "codex-official" : "official-account",
        name: "OpenAI Official",
        category: "official",
        settingsConfig: {
          auth: kind === "api_key" ? { OPENAI_API_KEY: "test-key" } : {},
          config: "",
        },
        meta:
          kind === "managed"
            ? {
                authBinding: {
                  source: "managed_account",
                  authProvider: "codex_oauth",
                  accountId: "account-id",
                },
              }
            : undefined,
      };
      renderCard(provider, {
        isProxyTakeover: true,
        isAutoFailoverEnabled: true,
        isInFailoverQueue: true,
        failoverPriority: 1,
        onToggleFailover: vi.fn(),
      });
      const actions = actionsSpy.mock.calls.at(-1)![0];
      expect(actions.isOfficialBlockedByProxy).toBe(kind === "api_key");
      expect(actions.onToggleFailover === undefined).toBe(kind !== "api_key");
      expect(actions.onTest).toBeUndefined();
      expect(screen.queryByText("需要路由")).not.toBeInTheDocument();
      if (kind !== "api_key")
        expect(screen.queryByText("P1")).not.toBeInTheDocument();
    },
  );
});
