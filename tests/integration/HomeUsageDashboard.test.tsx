import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeUsageDashboard } from "@/components/usage/HomeUsageDashboard";
import { settingsApi } from "@/lib/api";
import * as postChangeSync from "@/utils/postChangeSync";
import { getSettings, resetProviderState, setSettings } from "../msw/state";

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: ({
    refreshIntervalMs,
    onRefreshIntervalChange,
    sessionAutoSyncEnabled,
    onSessionAutoSyncEnabledChange,
  }: any) => {
    const [saved, setSaved] = useState<string>("");
    return (
      <div>
        <output data-testid="refresh-interval">{refreshIntervalMs}</output>
        <output data-testid="session-scan">
          {String(sessionAutoSyncEnabled)}
        </output>
        <output data-testid="save-result">{saved}</output>
        <button
          onClick={async () =>
            setSaved(String(await onRefreshIntervalChange(60000)))
          }
        >
          change-refresh
        </button>
        <button
          onClick={async () =>
            setSaved(String(await onSessionAutoSyncEnabledChange(false)))
          }
        >
          disable-session-scan
        </button>
      </div>
    );
  },
}));

const renderDashboard = () =>
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <HomeUsageDashboard />
    </QueryClientProvider>,
  );

describe("homepage usage settings persistence", () => {
  beforeEach(() => {
    resetProviderState();
    setSettings({
      usageDashboardRefreshIntervalMs: 30000,
      sessionAutoSyncEnabled: true,
      enableClaudePluginIntegration: false,
      launchOnStartup: false,
      preserveCodexOfficialAuthOnSwitch: true,
    });
  });

  it("persists both usage controls through the existing settings path without live sync", async () => {
    const autoLaunch = vi.spyOn(settingsApi, "setAutoLaunch");
    const pluginSync = vi.spyOn(settingsApi, "applyClaudePluginConfig");
    const liveSync = vi.spyOn(postChangeSync, "syncCurrentProvidersLiveSafe");
    try {
      const original = getSettings();
      renderDashboard();
      await waitFor(() =>
        expect(screen.getByTestId("refresh-interval")).toHaveTextContent(
          "30000",
        ),
      );
      fireEvent.click(screen.getByText("change-refresh"));
      await waitFor(() =>
        expect(screen.getByTestId("save-result")).toHaveTextContent("true"),
      );
      expect(getSettings().usageDashboardRefreshIntervalMs).toBe(60000);
      fireEvent.click(screen.getByText("disable-session-scan"));
      await waitFor(() =>
        expect(getSettings().sessionAutoSyncEnabled).toBe(false),
      );
      expect(getSettings()).toMatchObject({
        codexConfigDir: original.codexConfigDir,
        preserveCodexOfficialAuthOnSwitch:
          original.preserveCodexOfficialAuthOnSwitch,
      });
      expect(autoLaunch).not.toHaveBeenCalled();
      expect(pluginSync).not.toHaveBeenCalled();
      expect(liveSync).not.toHaveBeenCalled();
    } finally {
      autoLaunch.mockRestore();
      pluginSync.mockRestore();
      liveSync.mockRestore();
    }
  });

  it.each([
    {
      control: "change-refresh",
      field: "refresh-interval",
      previous: "30000",
      nextControl: "disable-session-scan",
    },
    {
      control: "disable-session-scan",
      field: "session-scan",
      previous: "true",
      nextControl: "change-refresh",
    },
  ])(
    "rolls back failed $control and does not replay it on a later save",
    async ({ control, field, previous, nextControl }) => {
      const save = vi.spyOn(settingsApi, "save");
      try {
        renderDashboard();
        await waitFor(() =>
          expect(screen.getByTestId("refresh-interval")).toHaveTextContent(
            "30000",
          ),
        );
        save.mockRejectedValueOnce(new Error("fixture save failure"));
        fireEvent.click(screen.getByText(control));
        await waitFor(() =>
          expect(screen.getByTestId("save-result")).toHaveTextContent("false"),
        );
        expect(screen.getByTestId(field)).toHaveTextContent(previous);
        fireEvent.click(screen.getByText(nextControl));
        await waitFor(() =>
          expect(screen.getByTestId("save-result")).toHaveTextContent("true"),
        );
        expect(getSettings()).toMatchObject(
          control === "change-refresh"
            ? {
                usageDashboardRefreshIntervalMs: 30000,
                sessionAutoSyncEnabled: false,
              }
            : {
                usageDashboardRefreshIntervalMs: 60000,
                sessionAutoSyncEnabled: true,
              },
        );
      } finally {
        save.mockRestore();
      }
    },
  );
});
