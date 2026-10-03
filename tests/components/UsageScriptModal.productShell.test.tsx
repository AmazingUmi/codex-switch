import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import UsageScriptModal from "@/components/UsageScriptModal";
import { createTestQueryClient } from "../utils/testQueryClient";
import type { Provider } from "@/types";

vi.mock("@/components/JsonEditor", () => ({ default: () => <div /> }));

it("hides third-party usage choices and retains an existing saved script", async () => {
  const onSave = vi.fn();
  const provider: Provider = {
    id: "saved-legacy-usage",
    name: "Saved provider",
    category: "custom",
    settingsConfig: {
      auth: { OPENAI_API_KEY: "test-key" },
      config:
        'model_provider = "custom"\n[model_providers.custom]\nbase_url = "https://api.example.com/v1"',
    },
    meta: {
      usage_script: {
        enabled: true,
        language: "javascript",
        code: "",
        templateType: "token_plan",
        codingPlanProvider: "minimax",
      },
    },
  };
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <UsageScriptModal
        productShell
        provider={provider}
        appId="codex"
        isOpen
        onClose={vi.fn()}
        onSave={onSave}
      />
    </QueryClientProvider>,
  );
  expect(screen.queryByText("MiniMax")).not.toBeInTheDocument();
  expect(screen.queryByText("OpenCode Go")).not.toBeInTheDocument();
  expect(
    screen.queryByText("usageScript.templateTokenPlan"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("usageScript.templateCopilot"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("usageScript.templateCustom")).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", { name: "usageScript.saveConfig" }),
  );
  await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
  expect(onSave.mock.calls[0][0]).toEqual(
    expect.objectContaining({
      templateType: "token_plan",
      codingPlanProvider: "minimax",
    }),
  );
});
