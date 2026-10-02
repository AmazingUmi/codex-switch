import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CircleGauge } from "lucide-react";
import { CodexSwitchMark } from "@/components/branding/CodexSwitchMark";
import { CapsuleControl } from "@/components/ui/capsule";
import { HelpButton } from "@/components/ui/help-button";
import type { SettingsFormState } from "@/hooks/useSettings";
import { isMac } from "@/lib/platform";
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

  if (!isMac()) return null;

  return (
    <section className="space-y-3" aria-busy={saving}>
      <div className="flex items-center gap-2">
        <CircleGauge className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">{t("settings.tray.title")}</h3>
        <HelpButton label={t("settings.tray.title")}>
          <p>{t("settings.tray.help")}</p>
        </HelpButton>
      </div>
      <fieldset disabled={saving} className="min-w-0 space-y-3">
        <CapsuleControl
          value={mode}
          label={t("settings.tray.display")}
          onChange={(trayDisplayMode) => {
            if (trayDisplayMode !== mode) void save({ trayDisplayMode });
          }}
          optionClassName="min-w-[80px]"
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
                    className="codex-quota-battery inline-flex w-[66px] flex-none"
                    aria-hidden="true"
                  >
                    <span
                      className="inline-flex items-center gap-1.5"
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
                      </svg>
                      <span className="text-xs tabular-nums">
                        {previewRemaining}%
                      </span>
                    </span>
                  </span>
                  <span className="sr-only">
                    {t("settings.tray.quotaRing")}
                  </span>
                </>
              ),
            },
          ]}
        />
        {mode === "quotaRing" && (
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">
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
              <p className="text-xs text-muted-foreground">
                {t("settings.tray.color")}
              </p>
              <CapsuleControl
                value={colorMode}
                label={t("settings.tray.color")}
                onChange={(trayQuotaColorMode) => {
                  if (trayQuotaColorMode !== colorMode)
                    void save({ trayQuotaColorMode });
                }}
                options={[
                  { value: "system", label: t("settings.tray.system") },
                  { value: "quota", label: t("settings.tray.quota") },
                ]}
              />
            </div>
          </div>
        )}
      </fieldset>
      <p className="text-[11px] text-muted-foreground">
        {t("settings.tray.hint")}
      </p>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {t("settings.saveFailedGeneric")}
        </p>
      )}
    </section>
  );
}
