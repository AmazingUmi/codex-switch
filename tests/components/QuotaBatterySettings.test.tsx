import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { QuotaBatterySettings } from "@/components/settings/QuotaBatterySettings";
import type { SettingsFormState } from "@/hooks/useSettings";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});

function setup(
  updates: Partial<SettingsFormState> = {},
  onChange = vi.fn().mockResolvedValue(true),
) {
  const settings: SettingsFormState = {
    showInTray: true,
    minimizeToTrayOnClose: true,
    language: "en",
    ...updates,
  };
  const view = (next: SettingsFormState) => (
    <I18nextProvider i18n={i18n}>
      <QuotaBatterySettings settings={next} onChange={onChange} />
    </I18nextProvider>
  );
  const result = render(view(settings));
  const warning = screen.getByRole("spinbutton", {
    name: i18n.t("settings.quotaBattery.warning"),
  });
  const low = screen.getByRole("spinbutton", {
    name: i18n.t("settings.quotaBattery.low"),
  });
  return {
    ...result,
    warning,
    low,
    onChange,
    rerenderSettings: (next: Partial<SettingsFormState>) =>
      result.rerender(view({ ...settings, ...next })),
  };
}

describe("QuotaBatterySettings", () => {
  it("uses 50/10 defaults and avoids saving untouched fields", () => {
    const { warning, low, onChange } = setup();
    expect(warning).toHaveValue(50);
    expect(low).toHaveValue(10);
    fireEvent.blur(warning);
    fireEvent.keyDown(low, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves the whole pair on blur, after keeping edits local while typing", async () => {
    const { warning, low, onChange, rerenderSettings } = setup();
    fireEvent.change(warning, { target: { value: "70.5" } });
    fireEvent.change(low, { target: { value: "20.25" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(low);
    const saved = {
      quotaBatteryWarningThresholdPercent: 70.5,
      quotaBatteryLowThresholdPercent: 20.25,
    };
    await waitFor(() => expect(onChange).toHaveBeenCalledOnce());
    expect(onChange).toHaveBeenCalledWith(saved);
    await waitFor(() => expect(warning).toBeEnabled());
    rerenderSettings(saved);
    expect(warning).toHaveValue(70.5);
    expect(low).toHaveValue(20.25);
    fireEvent.blur(warning);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("saves valid inclusive range boundaries on Enter", async () => {
    const { warning, low, onChange } = setup();
    fireEvent.change(warning, { target: { value: "100" } });
    fireEvent.change(low, { target: { value: "0" } });
    fireEvent.keyDown(warning, { key: "Enter" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaBatteryWarningThresholdPercent: 100,
        quotaBatteryLowThresholdPercent: 0,
      }),
    );
  });

  it.each([
    { warningValue: "", lowValue: "10" },
    { warningValue: "101", lowValue: "10" },
    { warningValue: "50", lowValue: "-1" },
    { warningValue: "10", lowValue: "10" },
    { warningValue: "10", lowValue: "20" },
  ])(
    "blocks an invalid pair $warningValue/$lowValue and shows a localized inline error",
    ({ warningValue, lowValue }) => {
      const { warning, low, onChange } = setup();
      fireEvent.change(warning, { target: { value: warningValue } });
      fireEvent.change(low, { target: { value: lowValue } });
      fireEvent.blur(low);
      expect(onChange).not.toHaveBeenCalled();
      const error = screen.getByRole("alert");
      expect(i18n.exists("settings.quotaBattery.invalid")).toBe(true);
      expect(error).toHaveTextContent(i18n.t("settings.quotaBattery.invalid"));
      expect(warning).toHaveAttribute("aria-invalid", "true");
      expect(low).toHaveAttribute("aria-invalid", "true");
      expect(warning).toHaveAttribute("aria-describedby", error.id);
      expect(low).toHaveAttribute("aria-describedby", error.id);
    },
  );

  it("clears an invalid draft's error and saves a corrected pair", async () => {
    const { warning, onChange } = setup();
    fireEvent.change(warning, { target: { value: "10" } });
    fireEvent.blur(warning);
    expect(screen.getByRole("alert")).toBeInTheDocument();
    fireEvent.change(warning, { target: { value: "60" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    fireEvent.keyDown(warning, { key: "Enter" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaBatteryWarningThresholdPercent: 60,
        quotaBatteryLowThresholdPercent: 10,
      }),
    );
  });

  it.each(["false", "throw"])(
    "restores the saved pair when saving returns %s",
    async (failure) => {
      const onChange =
        failure === "false"
          ? vi.fn().mockResolvedValue(false)
          : vi.fn().mockRejectedValue(new Error("Store unavailable"));
      const { warning, low } = setup(
        {
          quotaBatteryWarningThresholdPercent: 65,
          quotaBatteryLowThresholdPercent: 15,
        },
        onChange,
      );
      fireEvent.change(warning, { target: { value: "90" } });
      fireEvent.change(low, { target: { value: "20" } });
      fireEvent.keyDown(low, { key: "Enter" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        i18n.t("settings.saveFailedGeneric"),
      );
      expect(warning).toHaveValue(65);
      expect(low).toHaveValue(15);
      expect(warning).toBeEnabled();
      expect(low).toBeEnabled();
      expect(onChange).toHaveBeenCalledOnce();
    },
  );

  it("disables both inputs during an asynchronous save and prevents duplicate submission", async () => {
    let finishSave!: (saved: boolean) => void;
    const onChange = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { warning, low } = setup({}, onChange);
    fireEvent.change(warning, { target: { value: "70" } });
    fireEvent.keyDown(warning, { key: "Enter" });
    expect(warning).toBeDisabled();
    expect(low).toBeDisabled();
    expect(warning.closest("section")).toHaveAttribute("aria-busy", "true");
    fireEvent.blur(warning);
    expect(onChange).toHaveBeenCalledOnce();
    await act(async () => finishSave(true));
    expect(warning).toBeEnabled();
    expect(low).toBeEnabled();
    expect(warning.closest("section")).toHaveAttribute("aria-busy", "false");
  });

  it("reflects persisted threshold updates without submitting changes", () => {
    const { warning, low, onChange, rerenderSettings } = setup();
    rerenderSettings({
      quotaBatteryWarningThresholdPercent: 72,
      quotaBatteryLowThresholdPercent: 12,
    });
    expect(warning).toHaveValue(72);
    expect(low).toHaveValue(12);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("opens threshold guidance without changing or saving the fields", () => {
    const { warning, low, onChange } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: i18n.t("settings.quotaBattery.title"),
      }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      i18n.t("settings.quotaBattery.help"),
    );
    expect(warning).toHaveValue(50);
    expect(low).toHaveValue(10);
    expect(onChange).not.toHaveBeenCalled();
  });
});
