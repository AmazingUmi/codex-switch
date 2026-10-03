import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { HomeUsageDashboard } from "@/components/usage/HomeUsageDashboard";
import { settingsApi } from "@/lib/api";
import * as postChangeSync from "@/utils/postChangeSync";
import { getSettings, resetProviderState, setSettings } from "../msw/state";
import { server } from "../msw/server";
import type { Settings } from "@/types";

vi.mock("@/components/usage/UsageDashboard", () => ({
  UsageDashboard: ({
    refreshIntervalMs,
    onRefreshIntervalChange,
    sessionAutoSyncEnabled,
    onSessionAutoSyncEnabledChange,
    codexUsageSourceDir,
    onCodexUsageSourceDirChange,
  }: any) => {
    const [saved, setSaved] = useState<string>("");
    return (
      <div>
        <output data-testid="refresh-interval">{refreshIntervalMs}</output>
        <output data-testid="session-scan">
          {String(sessionAutoSyncEnabled)}
        </output>
        <output data-testid="save-result">{saved}</output>
        <output data-testid="session-source">
          {codexUsageSourceDir ?? "default"}
        </output>
        <button
          onClick={async () =>
            setSaved(String(await onRefreshIntervalChange(60000)))
          }
        >
          change-refresh
        </button>
        <button
          onClick={async () =>
            setSaved(
              String(
                await onCodexUsageSourceDirChange("/fixture/session-source"),
              ),
            )
          }
        >
          change-session-source
        </button>
        <button
          onClick={async () =>
            setSaved(String(await onCodexUsageSourceDirChange(undefined)))
          }
        >
          reset-session-source
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
    // Rust saves a complete Settings value: an omitted optional source clears
    // the override. The shared fixture otherwise merges partial settings.
    server.use(
      http.post("http://tauri.local/save_settings", async ({ request }) => {
        const { settings } = (await request.json()) as { settings: Settings };
        setSettings({
          ...settings,
          codexUsageSourceDir: settings.codexUsageSourceDir,
        });
        return HttpResponse.json(true);
      }),
    );
    setSettings({
      usageDashboardRefreshIntervalMs: 30000,
      sessionAutoSyncEnabled: true,
      enableClaudePluginIntegration: false,
      launchOnStartup: false,
      preserveCodexOfficialAuthOnSwitch: true,
    });
  });

  it("persists usage controls and the independent source through the existing settings path without live sync", async () => {
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
      fireEvent.click(screen.getByText("change-session-source"));
      await waitFor(() =>
        expect(getSettings().codexUsageSourceDir).toBe(
          "/fixture/session-source",
        ),
      );
      fireEvent.click(screen.getByText("reset-session-source"));
      await waitFor(() =>
        expect(getSettings().codexUsageSourceDir).toBeUndefined(),
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
    {
      control: "change-session-source",
      field: "session-source",
      previous: "default",
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
            : control === "disable-session-scan"
              ? {
                  usageDashboardRefreshIntervalMs: 60000,
                  sessionAutoSyncEnabled: true,
                }
              : {
                  usageDashboardRefreshIntervalMs: 60000,
                },
        );
        if (control === "change-session-source") {
          expect(getSettings().codexUsageSourceDir).toBeUndefined();
        }
      } finally {
        save.mockRestore();
      }
    },
  );
});
