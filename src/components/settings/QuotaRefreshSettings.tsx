import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";
import type { SettingsFormState } from "@/hooks/useSettings";
import { HelpButton } from "@/components/ui/help-button";
import { Label } from "@/components/ui/label";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PRESETS = [30, 60, 120, 300, 600, 0];

interface Props {
  settings: SettingsFormState;
  onChange: (
    updates: Partial<SettingsFormState>,
  ) => Promise<boolean> | boolean | void;
}

export function QuotaRefreshSettings({ settings, onChange }: Props) {
  const { t } = useTranslation();
  const interval = settings.quotaRefreshIntervalSeconds ?? 60;
  const [custom, setCustom] = useState(false);
  const [draft, setDraft] = useState(String(interval || 90));
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const selected =
    custom || !PRESETS.includes(interval) ? "custom" : String(interval);

  useEffect(() => setDraft(String(interval || 90)), [interval]);

  const save = async (next: number) => {
    if (savingRef.current) return;
    if (!Number.isInteger(next) || (next !== 0 && (next < 30 || next > 3600))) {
      setError(t("settings.quotaRefresh.invalid"));
      return;
    }
    setError(null);
    if (next === interval) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if ((await onChange({ quotaRefreshIntervalSeconds: next })) === false)
        throw new Error("Save failed");
    } catch {
      setDraft(String(interval || 90));
      setError(t("settings.saveFailedGeneric"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const saveCustom = () => {
    const next = draft.trim() ? Number(draft) : NaN;
    if (next === 0) {
      setError(t("settings.quotaRefresh.invalid"));
      return;
    }
    void save(next);
  };

  return (
    <section className="settings-section space-y-3" aria-busy={saving}>
      <SettingsSectionHeader
        title={t("settings.quotaRefresh.title")}
        icon={<RefreshCw />}
        help={
          <HelpButton label={t("settings.quotaRefresh.title")}>
            <p>{t("settings.quotaRefresh.help")}</p>
          </HelpButton>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={selected}
          disabled={saving}
          onValueChange={(value) => {
            setError(null);
            setCustom(value === "custom");
            if (value !== "custom") void save(Number(value));
          }}
        >
          <SelectTrigger
            className="settings-control-text h-10 w-auto min-w-28 gap-3 rounded-full"
            aria-label={t("settings.quotaRefresh.title")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="settings-control-menu">
            {PRESETS.map((seconds) => (
              <SelectItem key={seconds} value={String(seconds)}>
                {seconds === 0
                  ? t("settings.quotaRefresh.off")
                  : seconds < 60
                    ? t("settings.quotaRefresh.seconds", { count: seconds })
                    : t("settings.quotaRefresh.minutes", {
                        count: seconds / 60,
                      })}
              </SelectItem>
            ))}
            <SelectItem value="custom">
              {t("settings.quotaRefresh.custom")}
            </SelectItem>
          </SelectContent>
        </Select>
        {selected === "custom" && (
          <div className="relative w-24 shrink-0">
            <Label htmlFor="quota-refresh-seconds" className="sr-only">
              {t("settings.quotaRefresh.custom")}
            </Label>
            <input
              id="quota-refresh-seconds"
              type="number"
              min={30}
              max={3600}
              step={1}
              autoComplete="off"
              className="settings-control-text quota-refresh-input glass-button block h-10 w-full rounded-full pl-3 pr-7 tabular-nums focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              value={draft}
              disabled={saving}
              aria-invalid={!!error}
              aria-describedby={`quota-refresh-unit${error ? " quota-refresh-error" : ""}`}
              onChange={(event) => {
                setDraft(event.target.value);
                setError(null);
              }}
              onBlur={saveCustom}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  saveCustom();
                }
              }}
            />
            <span
              aria-hidden="true"
              className="settings-description pointer-events-none absolute right-3 top-1/2 -translate-y-1/2"
            >
              {t("settings.quotaRefresh.secondsUnitShort")}
            </span>
            <span id="quota-refresh-unit" className="sr-only">
              {t("settings.quotaRefresh.secondsUnit")}
            </span>
          </div>
        )}
      </div>
      {error && (
        <p
          id="quota-refresh-error"
          role="alert"
          className="settings-description text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
