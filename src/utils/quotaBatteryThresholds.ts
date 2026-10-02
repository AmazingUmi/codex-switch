import type { Settings } from "@/types";

export interface QuotaBatteryThresholds {
  warning: number;
  low: number;
}

export const DEFAULT_QUOTA_BATTERY_THRESHOLDS: QuotaBatteryThresholds = {
  warning: 50,
  low: 10,
};

export function areQuotaBatteryThresholdsValid({
  warning,
  low,
}: QuotaBatteryThresholds): boolean {
  return (
    Number.isFinite(warning) &&
    Number.isFinite(low) &&
    low >= 0 &&
    warning <= 100 &&
    low < warning
  );
}

export function getQuotaBatteryThresholds(
  settings?: Pick<
    Settings,
    "quotaBatteryWarningThresholdPercent" | "quotaBatteryLowThresholdPercent"
  > | null,
): QuotaBatteryThresholds {
  const thresholds = {
    warning:
      settings?.quotaBatteryWarningThresholdPercent ??
      DEFAULT_QUOTA_BATTERY_THRESHOLDS.warning,
    low:
      settings?.quotaBatteryLowThresholdPercent ??
      DEFAULT_QUOTA_BATTERY_THRESHOLDS.low,
  };
  return areQuotaBatteryThresholdsValid(thresholds)
    ? thresholds
    : DEFAULT_QUOTA_BATTERY_THRESHOLDS;
}
