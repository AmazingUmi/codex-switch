import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleGauge } from "lucide-react";
import { CodexSwitchMark } from "@/components/branding/CodexSwitchMark";
import { CapsuleControl } from "@/components/ui/capsule";
import { HelpButton } from "@/components/ui/help-button";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import type { SettingsFormState } from "@/hooks/useSettings";
import { isMac, isWindows } from "@/lib/platform";
import { getQuotaBatteryThresholds } from "@/utils/quotaBatteryThresholds";

interface TraySettingsProps {
  settings: SettingsFormState;
  onChange: (
    updates: Partial<SettingsFormState>,
  ) => Promise<boolean> | boolean | void;
}

export function TraySettings({ settings, onChange }: TraySettingsProps) {
  const { t } = useTranslation();
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState(false);
  const windows = isWindows();
  const platformKey = (key: string) =>
    `settings.tray.${windows ? `windows${key[0].toUpperCase()}${key.slice(1)}` : key}`;
  const mode = settings.trayDisplayMode ?? "icon";
  const window = settings.trayQuotaWindow ?? "fiveHour";
  const colorMode = settings.trayQuotaColorMode ?? "quota";
  const thresholds = getQuotaBatteryThresholds(settings);
  const previewRemaining = 36;
  const tone =
    previewRemaining <= thresholds.low
      ? "low"
      : previewRemaining <= thresholds.warning
        ? "warning"
        : "available";

  const save = async (updates: Partial<SettingsFormState>) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError(false);
    try {
      if ((await onChange(updates)) === false) setError(true);
    } catch {
      setError(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  if (!isMac() && !windows) return null;

  return (
    <section className="settings-section space-y-3" aria-busy={saving}>
      <SettingsSectionHeader
        title={t(platformKey("title"))}
        icon={<CircleGauge />}
        help={
          <HelpButton label={t(platformKey("title"))}>
            <p>{t(platformKey("help"))}</p>
          </HelpButton>
        }
      />
      <fieldset disabled={saving} className="min-w-0 space-y-3">
        <CapsuleControl
          value={mode}
          label={t(platformKey("display"))}
          onChange={(trayDisplayMode) => {
            if (trayDisplayMode !== mode) void save({ trayDisplayMode });
          }}
          options={[
            {
              value: "icon",
              label: (
                <>
                  <CodexSwitchMark className="h-5 w-5" />
                  <span className="sr-only">{t("settings.tray.icon")}</span>
                </>
              ),
            },
            {
              value: "quotaRing",
              label: (
                <>
                  <span
                    className={`codex-quota-battery inline-flex flex-none ${windows ? "w-4" : "w-[50px]"}`}
                    aria-hidden="true"
                  >
                    <span
                      className="inline-flex items-center gap-1"
                      data-quota-tone={tone}
                    >
                      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                        <circle
                          cx="10"
                          cy="10"
                          r="8"
                          stroke="currentColor"
                          strokeWidth="2"
                          opacity="0.2"
                        />
                        <circle
                          cx="10"
                          cy="10"
                          r="8"
                          stroke={
                            colorMode === "quota" && tone !== "available"
                              ? "var(--codex-quota-color)"
                              : "currentColor"
                          }
                          strokeWidth="2"
                          strokeLinecap="round"
                          pathLength="100"
                          strokeDasharray={`${previewRemaining} 100`}
                          transform="rotate(-90 10 10)"
                        />
                        {windows && (
                          <text
                            x="10"
                            y="12"
                            textAnchor="middle"
                            fontSize="6"
                            fill="currentColor"
                          >
                            {previewRemaining}
                          </text>
                        )}
                      </svg>
                      {!windows && (
                        <span className="settings-control-text tabular-nums">
                          {previewRemaining}%
                        </span>
                      )}
                    </span>
                  </span>
                  <span className="sr-only">{t(platformKey("quotaRing"))}</span>
                </>
              ),
            },
            {
              value: "quotaRingOnly",
              label: (
                <>
                  <svg
                    viewBox="0 0 20 20"
                    className="h-4 w-4"
                    fill="none"
                    aria-hidden="true"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      stroke="currentColor"
                      strokeWidth="2"
                      opacity="0.2"
                    />
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      stroke="currentColor"
                      strokeWidth="2"
                      pathLength="100"
                      strokeDasharray="36 100"
                      transform="rotate(-90 10 10)"
                    />
                  </svg>
                  <span className="sr-only">
                    {t("settings.tray.quotaRingOnly")}
                  </span>
                </>
              ),
            },
          ]}
        />
        {mode !== "icon" && (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="space-y-1.5">
              <p className="settings-field-label">
                {t("settings.tray.window")}
              </p>
              <CapsuleControl
                value={window}
                label={t("settings.tray.window")}
                onChange={(trayQuotaWindow) => {
                  if (trayQuotaWindow !== window)
                    void save({ trayQuotaWindow });
                }}
                options={[
                  { value: "fiveHour", label: t("settings.tray.fiveHour") },
                  { value: "sevenDay", label: t("settings.tray.sevenDay") },
                ]}
              />
            </div>
            <div className="space-y-1.5">
              <p className="settings-field-label">{t("settings.tray.color")}</p>
              <CapsuleControl
                value={colorMode}
                label={t("settings.tray.color")}
                onChange={(trayQuotaColorMode) => {
                  if (trayQuotaColorMode !== colorMode)
                    void save({ trayQuotaColorMode });
                }}
                options={[
                  { value: "system", label: t(platformKey("system")) },
                  { value: "quota", label: t("settings.tray.quota") },
                ]}
              />
            </div>
          </div>
        )}
      </fieldset>
      <p className="settings-description">{t(platformKey("hint"))}</p>
      {error && (
        <p role="alert" className="settings-description text-destructive">
          {t("settings.saveFailedGeneric")}
        </p>
      )}
    </section>
  );
}
