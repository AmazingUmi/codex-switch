import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BatteryMedium } from "lucide-react";
import type { SettingsFormState } from "@/hooks/useSettings";
import { HelpButton } from "@/components/ui/help-button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  areQuotaBatteryThresholdsValid,
  getQuotaBatteryThresholds,
} from "@/utils/quotaBatteryThresholds";

interface QuotaBatterySettingsProps {
  settings: SettingsFormState;
  onChange: (
    updates: Partial<SettingsFormState>,
  ) => Promise<boolean> | boolean | void;
}

export function QuotaBatterySettings({
  settings,
  onChange,
}: QuotaBatterySettingsProps) {
  const { t } = useTranslation();
  const thresholds = getQuotaBatteryThresholds(settings);
  const [warning, setWarning] = useState(String(thresholds.warning));
  const [low, setLow] = useState(String(thresholds.low));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setWarning(String(thresholds.warning));
    setLow(String(thresholds.low));
  }, [thresholds.warning, thresholds.low]);

  const save = async () => {
    if (savingRef.current) return;
    const next = {
      warning: warning.trim() ? Number(warning) : NaN,
      low: low.trim() ? Number(low) : NaN,
    };
    if (!areQuotaBatteryThresholdsValid(next)) {
      setError(t("settings.quotaBattery.invalid"));
      return;
    }
    setError(null);
    if (next.warning === thresholds.warning && next.low === thresholds.low)
      return;
    savingRef.current = true;
    setSaving(true);
    try {
      const saved = await onChange({
        quotaBatteryWarningThresholdPercent: next.warning,
        quotaBatteryLowThresholdPercent: next.low,
      });
      if (saved === false) throw new Error("Threshold save failed");
    } catch {
      setWarning(String(thresholds.warning));
      setLow(String(thresholds.low));
      setError(t("settings.saveFailedGeneric"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <section className="space-y-3" aria-busy={saving}>
      <div className="flex items-center gap-2">
        <BatteryMedium className="h-4 w-4 text-primary" aria-hidden="true" />
        <h3 className="text-sm font-medium">
          {t("settings.quotaBattery.title")}
        </h3>
        <HelpButton label={t("settings.quotaBattery.title")}>
          <p>{t("settings.quotaBattery.help")}</p>
        </HelpButton>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {[
          {
            id: "quota-battery-warning",
            label: "warning",
            value: warning,
            set: setWarning,
          },
          { id: "quota-battery-low", label: "low", value: low, set: setLow },
        ].map((field) => (
          <div
            key={field.id}
            className="flex items-center justify-between gap-3"
          >
            <Label htmlFor={field.id} className="text-xs text-muted-foreground">
              {t(`settings.quotaBattery.${field.label}`)}
            </Label>
            <div className="relative w-24 shrink-0">
              <Input
                id={field.id}
                type="number"
                min={0}
                max={100}
                step="any"
                className="h-8 pr-6 tabular-nums"
                value={field.value}
                disabled={saving}
                aria-invalid={!!error}
                aria-describedby={error ? "quota-battery-error" : undefined}
                onChange={(event) => {
                  field.set(event.target.value);
                  setError(null);
                }}
                onBlur={() => void save()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void save();
                  }
                }}
              />
              <span
                className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                %
              </span>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p
          id="quota-battery-error"
          role="alert"
          className="text-xs text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
