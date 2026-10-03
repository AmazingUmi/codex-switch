import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { BatteryMedium } from "lucide-react";
import type { SettingsFormState } from "@/hooks/useSettings";
import { HelpButton } from "@/components/ui/help-button";
import { QuotaBatteryTrack } from "@/components/QuotaBatteryTrack";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import {
  areQuotaBatteryThresholdsValid,
  getQuotaBatteryThresholds,
  type QuotaBatteryThresholds,
} from "@/utils/quotaBatteryThresholds";

interface QuotaBatterySettingsProps {
  settings: SettingsFormState;
  onChange: (
    updates: Partial<SettingsFormState>,
  ) => Promise<boolean> | boolean | void;
}

type Threshold = keyof QuotaBatteryThresholds;
const ADJUST_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowDown",
  "ArrowUp",
  "PageDown",
  "PageUp",
  "Home",
  "End",
]);

export function QuotaBatterySettings({
  settings,
  onChange,
}: QuotaBatterySettingsProps) {
  const { t } = useTranslation();
  const thresholds = getQuotaBatteryThresholds(settings);
  const [draft, setDraft] = useState(thresholds);
  const draftRef = useRef(draft);
  const savedRef = useRef(thresholds);
  const trackRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    field: Threshold;
    pointerId: number;
    startX: number;
    width: number;
    initial: QuotaBatteryThresholds;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  // Keep existing fractional preferences valid; new gestures maintain separation.
  const gap = Math.min(1, thresholds.warning - thresholds.low);

  const updateDraft = (next: QuotaBatteryThresholds) => {
    draftRef.current = next;
    setDraft(next);
    setError(null);
  };
  useEffect(() => {
    const next = { warning: thresholds.warning, low: thresholds.low };
    savedRef.current = next;
    draftRef.current = next;
    setDraft(next);
  }, [thresholds.warning, thresholds.low]);

  const save = async () => {
    if (savingRef.current || gesture.current) return;
    const next = draftRef.current;
    if (!areQuotaBatteryThresholdsValid(next)) {
      setError(t("settings.quotaBattery.invalid"));
      return;
    }
    if (
      next.warning === savedRef.current.warning &&
      next.low === savedRef.current.low
    )
      return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      if (
        (await onChange({
          quotaBatteryWarningThresholdPercent: next.warning,
          quotaBatteryLowThresholdPercent: next.low,
        })) === false
      )
        throw new Error("Threshold save failed");
      savedRef.current = next;
    } catch {
      updateDraft(savedRef.current);
      setError(t("settings.saveFailedGeneric"));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const adjust = (field: Threshold, value: number) => {
    if (savingRef.current || !Number.isFinite(value)) return;
    const current = draftRef.current;
    const min = field === "low" ? 0 : current.low + gap;
    const max = field === "low" ? current.warning - gap : 100;
    updateDraft({ ...current, [field]: Math.max(min, Math.min(max, value)) });
  };
  const startDrag = (
    event: PointerEvent<HTMLButtonElement>,
    field: Threshold,
  ) => {
    if (event.button !== 0 || savingRef.current || gesture.current) return;
    const width = trackRef.current?.getBoundingClientRect().width;
    if (!width) return;
    event.preventDefault();
    event.currentTarget.focus();
    if (savingRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      field,
      pointerId: event.pointerId,
      startX: event.clientX,
      width,
      initial: { ...draftRef.current },
    };
    setDragging(true);
  };
  const moveDrag = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    const delta = ((event.clientX - active.startX) / active.width) * 100;
    adjust(
      active.field,
      delta === 0
        ? active.initial[active.field]
        : Math.round(active.initial[active.field] + delta),
    );
  };
  const finishDrag = (
    event: PointerEvent<HTMLButtonElement>,
    cancelled = false,
  ) => {
    const active = gesture.current;
    if (!active || event.pointerId !== active.pointerId) return;
    if (!cancelled) moveDrag(event);
    gesture.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (cancelled) updateDraft(active.initial);
    else void save();
  };
  const keyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    field: Threshold,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
      return;
    }
    if (!ADJUST_KEYS.has(event.key)) return;
    event.preventDefault();
    const step = event.shiftKey || event.key.startsWith("Page") ? 5 : 1;
    const current = draftRef.current[field];
    adjust(
      field,
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 100
          : current +
            (["ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
              ? -step
              : step),
    );
  };
  const percent = (value: number) =>
    `${new Intl.NumberFormat(settings.language, { maximumFractionDigits: 20 }).format(value)}%`;

  return (
    <section className="settings-section space-y-3" aria-busy={saving}>
      <SettingsSectionHeader
        title={t("settings.quotaBattery.title")}
        icon={<BatteryMedium />}
        help={
          <HelpButton label={t("settings.quotaBattery.title")}>
            <p>{t("settings.quotaBattery.help")}</p>
          </HelpButton>
        }
      />
      <div className="codex-quota-panel codex-quota-battery w-full max-w-md rounded-2xl px-3 py-3">
        <div className="px-1 py-6" dir="ltr">
          <QuotaBatteryTrack
            ref={trackRef}
            charged
            className="codex-battery-threshold-track"
            data-dragging={dragging}
            style={
              {
                "--codex-quota-remaining": 100,
                "--codex-battery-low-stop": `${draft.low}%`,
                "--codex-battery-warning-stop": `${draft.warning}%`,
              } as CSSProperties
            }
          >
            {(["low", "warning"] as const).map((field) => (
              <button
                key={field}
                type="button"
                role="slider"
                aria-label={t(`settings.quotaBattery.${field}`)}
                aria-valuemin={field === "low" ? 0 : draft.low + gap}
                aria-valuemax={field === "low" ? draft.warning - gap : 100}
                aria-valuenow={draft[field]}
                aria-valuetext={percent(draft[field])}
                aria-orientation="horizontal"
                aria-describedby={error ? "quota-battery-error" : undefined}
                disabled={saving}
                className="codex-battery-threshold-handle"
                data-threshold={field}
                data-quota-tone={field}
                title={`${t(`settings.quotaBattery.${field}`)} ${percent(draft[field])}`}
                style={{ left: `${draft[field]}%` }}
                onPointerDown={(event) => startDrag(event, field)}
                onPointerMove={moveDrag}
                onPointerUp={(event) => finishDrag(event)}
                onPointerCancel={(event) => finishDrag(event, true)}
                onLostPointerCapture={(event) => finishDrag(event, true)}
                onKeyDown={(event) => keyDown(event, field)}
                onKeyUp={(event) => {
                  if (ADJUST_KEYS.has(event.key)) void save();
                }}
                onBlur={() => void save()}
              >
                <span
                  className="codex-battery-threshold-line"
                  aria-hidden="true"
                />
                <span
                  className="codex-battery-threshold-thumb glass-button"
                  aria-hidden="true"
                >
                  <span />
                </span>
              </button>
            ))}
          </QuotaBatteryTrack>
        </div>
        <div className="settings-description flex flex-wrap items-center gap-x-5 gap-y-1">
          {(["low", "warning", "available"] as const).map((tone) => (
            <span
              key={tone}
              className="inline-flex items-center gap-1.5"
              data-quota-tone={tone}
            >
              <span
                className="codex-battery-threshold-dot"
                aria-hidden="true"
              />
              {t(`settings.quotaBattery.${tone}Short`)}
              {tone !== "available" && (
                <span className="tabular-nums">{percent(draft[tone])}</span>
              )}
            </span>
          ))}
        </div>
      </div>
      {error && (
        <p
          id="quota-battery-error"
          role="alert"
          className="settings-description text-destructive"
        >
          {error}
        </p>
      )}
    </section>
  );
}
