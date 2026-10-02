import { useCallback } from "react";
import { useSettings, type SettingsFormState } from "@/hooks/useSettings";
import { UsageDashboard } from "./UsageDashboard";

// Keep homepage controls on the same settings save path as the settings page.
export function HomeUsageDashboard() {
  const { settings, updateSettings, autoSaveSettings } = useSettings();
  const persistUsageSettings = useCallback(
    async (updates: Partial<SettingsFormState>): Promise<boolean> => {
      if (!settings) return false;
      const previousValues = Object.fromEntries(
        Object.keys(updates).map((key) => [
          key,
          settings[key as keyof SettingsFormState],
        ]),
      ) as Partial<SettingsFormState>;
      updateSettings(updates);
      try {
        const saved = await autoSaveSettings(updates);
        if (saved) return true;
      } catch {
        // useSettings reports save failures; restore the form so a later save
        // cannot accidentally replay the failed usage preference.
      }
      updateSettings(previousValues);
      return false;
    },
    [autoSaveSettings, settings, updateSettings],
  );

  return (
    <UsageDashboard
      refreshIntervalMs={settings?.usageDashboardRefreshIntervalMs}
      onRefreshIntervalChange={(usageDashboardRefreshIntervalMs) =>
        persistUsageSettings({ usageDashboardRefreshIntervalMs })
      }
      sessionAutoSyncEnabled={settings?.sessionAutoSyncEnabled ?? true}
      onSessionAutoSyncEnabledChange={(sessionAutoSyncEnabled) =>
        persistUsageSettings({ sessionAutoSyncEnabled })
      }
      codexUsageSourceDir={settings?.codexUsageSourceDir}
      onCodexUsageSourceDirChange={(codexUsageSourceDir) =>
        persistUsageSettings({ codexUsageSourceDir })
      }
    />
  );
}
