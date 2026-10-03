import { describe, expect, it } from "vitest";
import {
  areQuotaBatteryThresholdsValid,
  DEFAULT_QUOTA_BATTERY_THRESHOLDS,
  getQuotaBatteryThresholds,
} from "@/utils/quotaBatteryThresholds";

describe("quota battery threshold configuration", () => {
  it("uses 50% warning and 10% low defaults when settings omit thresholds", () => {
    expect(DEFAULT_QUOTA_BATTERY_THRESHOLDS).toEqual({ warning: 50, low: 10 });
    expect(getQuotaBatteryThresholds(undefined)).toEqual({
      warning: 50,
      low: 10,
    });
    expect(getQuotaBatteryThresholds({})).toEqual({ warning: 50, low: 10 });
  });

  it("restores a valid saved pair and defaults each omitted field", () => {
    expect(
      getQuotaBatteryThresholds({
        quotaBatteryWarningThresholdPercent: 70,
        quotaBatteryLowThresholdPercent: 20,
      }),
    ).toEqual({ warning: 70, low: 20 });
    expect(
      getQuotaBatteryThresholds({ quotaBatteryWarningThresholdPercent: 70 }),
    ).toEqual({ warning: 70, low: 10 });
    expect(
      getQuotaBatteryThresholds({ quotaBatteryLowThresholdPercent: 20 }),
    ).toEqual({ warning: 50, low: 20 });
  });

  it.each([
    { warning: 100, low: 0 },
    { warning: 50.5, low: 10.25 },
  ])("accepts finite ordered thresholds $warning/$low", (thresholds) => {
    expect(areQuotaBatteryThresholdsValid(thresholds)).toBe(true);
  });

  it.each([
    { warning: 50, low: 50 },
    { warning: 10, low: 20 },
    { warning: 101, low: 10 },
    { warning: 50, low: -1 },
    { warning: NaN, low: 10 },
    { warning: 50, low: Infinity },
  ])(
    "rejects invalid thresholds $warning/$low and restores the whole default pair",
    (thresholds) => {
      expect(areQuotaBatteryThresholdsValid(thresholds)).toBe(false);
      expect(
        getQuotaBatteryThresholds({
          quotaBatteryWarningThresholdPercent: thresholds.warning,
          quotaBatteryLowThresholdPercent: thresholds.low,
        }),
      ).toEqual({ warning: 50, low: 10 });
    },
  );
});
