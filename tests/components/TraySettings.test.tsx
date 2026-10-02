import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TraySettings } from "@/components/settings/TraySettings";
import type { SettingsFormState } from "@/hooks/useSettings";
import { isMac } from "@/lib/platform";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

vi.mock("@/lib/platform", () => ({ isMac: vi.fn(() => true) }));
const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      "zh-TW": { translation: zhTW },
      ja: { translation: ja },
    },
  });
});
beforeEach(async () => {
  vi.mocked(isMac).mockReturnValue(true);
  await i18n.changeLanguage("en");
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
      <TraySettings settings={next} onChange={onChange} />
    </I18nextProvider>
  );
  const result = render(view(settings));
  return {
    ...result,
    onChange,
    rerenderSettings: (next: Partial<SettingsFormState>) =>
      result.rerender(view({ ...settings, ...next })),
  };
}

const label = (key: keyof typeof en.settings.tray) =>
  i18n.t(`settings.tray.${key}`);
const button = (key: keyof typeof en.settings.tray) =>
  screen.getByRole("button", { name: label(key) });

describe("TraySettings", () => {
  it("is hidden outside macOS", () => {
    vi.mocked(isMac).mockReturnValue(false);
    const { container, onChange } = setup({ trayDisplayMode: "quotaRing" });
    expect(container).toBeEmptyDOMElement();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("defaults to the existing icon and offers only icon or ring plus remaining percentage", () => {
    const { onChange } = setup();
    const display = screen.getByRole("group", { name: label("display") });
    expect(within(display).getAllByRole("button")).toHaveLength(2);
    expect(button("icon")).toHaveAttribute("aria-pressed", "true");
    expect(button("quotaRing")).toHaveAttribute("aria-pressed", "false");
    expect(button("icon").querySelector("svg")).toHaveAttribute(
      "viewBox",
      "0 0 64 64",
    );
    expect(button("quotaRing")).toHaveTextContent("36%");
    expect(
      screen.queryByRole("group", { name: label("window") }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: label("color") }),
    ).not.toBeInTheDocument();
    fireEvent.click(button("icon"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("saves the ring mode and reflects saved period/color defaults", async () => {
    const { onChange, rerenderSettings } = setup();
    fireEvent.click(button("quotaRing"));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ trayDisplayMode: "quotaRing" }),
    );
    rerenderSettings({ trayDisplayMode: "quotaRing" });
    expect(button("fiveHour")).toHaveAttribute("aria-pressed", "true");
    expect(button("quota")).toHaveAttribute("aria-pressed", "true");
    expect(button("sevenDay")).toHaveAttribute("aria-pressed", "false");
  });

  it.each([
    ["sevenDay", { trayQuotaWindow: "sevenDay" }],
    ["system", { trayQuotaColorMode: "system" }],
  ] as const)(
    "saves only the selected %s preference",
    async (key, expected) => {
      const { onChange } = setup({ trayDisplayMode: "quotaRing" });
      fireEvent.click(button(key));
      await waitFor(() => expect(onChange).toHaveBeenCalledWith(expected));
      expect(onChange).toHaveBeenCalledOnce();
    },
  );

  it("supports arrow navigation and keyboard activation", async () => {
    const user = userEvent.setup();
    const { onChange } = setup();
    button("icon").focus();
    await user.keyboard("{ArrowRight}");
    expect(button("quotaRing")).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith({
      trayDisplayMode: "quotaRing",
    });
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("keeps one Tab stop per choice group and supports End/Home focus", async () => {
    const user = userEvent.setup();
    const { onChange } = setup({ trayDisplayMode: "quotaRing" });
    expect(button("icon")).toHaveAttribute("tabindex", "-1");
    expect(button("quotaRing")).toHaveAttribute("tabindex", "0");
    button("quotaRing").focus();
    await user.tab();
    expect(button("fiveHour")).toHaveFocus();
    await user.keyboard("{End}");
    expect(button("sevenDay")).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith({ trayQuotaWindow: "sevenDay" });
    await user.tab();
    expect(button("quota")).toHaveFocus();
    await user.keyboard("{Home}");
    expect(button("system")).toHaveFocus();
    expect(onChange).toHaveBeenCalledWith({ trayQuotaColorMode: "system" });
  });

  it("disables all choices during a save and prevents duplicate submission", async () => {
    let finishSave!: (saved: boolean) => void;
    const onChange = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    setup({ trayDisplayMode: "quotaRing" }, onChange);
    fireEvent.click(button("sevenDay"));
    for (const key of [
      "icon",
      "quotaRing",
      "fiveHour",
      "sevenDay",
      "system",
      "quota",
    ] as const) {
      expect(button(key)).toBeDisabled();
    }
    fireEvent.click(button("system"));
    fireEvent.keyDown(button("fiveHour"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenCalledOnce();
    await act(async () => finishSave(true));
    expect(button("sevenDay")).toBeEnabled();
  });

  it.each(["false", "throws"])(
    "reports a %s save failure and keeps the persisted selection",
    async (failure) => {
      const onChange =
        failure === "false"
          ? vi.fn().mockResolvedValue(false)
          : vi.fn().mockRejectedValue(new Error("Unavailable"));
      setup({}, onChange);
      fireEvent.click(button("quotaRing"));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        i18n.t("settings.saveFailedGeneric"),
      );
      expect(button("icon")).toHaveAttribute("aria-pressed", "true");
      expect(button("quotaRing")).toBeEnabled();
    },
  );

  it.each([
    [{}, "warning", "var(--codex-quota-color)"],
    [
      { quotaBatteryLowThresholdPercent: 40 },
      "low",
      "var(--codex-quota-color)",
    ],
    [{ quotaBatteryWarningThresholdPercent: 30 }, "available", "currentColor"],
    [{ trayQuotaColorMode: "system" as const }, "warning", "currentColor"],
  ])(
    "reuses quota thresholds and keeps healthy/system rings neutral for %j",
    (updates, tone, stroke) => {
      setup({ trayDisplayMode: "quotaRing", ...updates });
      expect(
        button("quotaRing").querySelector("[data-quota-tone]"),
      ).toHaveAttribute("data-quota-tone", tone);
      expect(
        button("quotaRing").querySelector("circle[pathLength]"),
      ).toHaveAttribute("stroke", stroke);
    },
  );

  it("opens contextual help without saving", () => {
    const { onChange } = setup();
    fireEvent.click(button("title"));
    expect(screen.getByRole("dialog")).toHaveTextContent(label("help"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has complete translated tray choices and guidance in all four locales", () => {
    for (const locale of [en, zh, zhTW, ja]) {
      expect(Object.keys(locale.settings.tray).sort()).toEqual(
        Object.keys(en.settings.tray).sort(),
      );
      expect(
        Object.values(locale.settings.tray).every(
          (value) => value.trim().length > 0,
        ),
      ).toBe(true);
    }
  });

  it.each(["en", "zh", "zh-TW", "ja"])(
    "uses translated accessible choice names in %s",
    async (language) => {
      await i18n.changeLanguage(language);
      setup({ trayDisplayMode: "quotaRing" });
      for (const key of [
        "icon",
        "quotaRing",
        "fiveHour",
        "sevenDay",
        "system",
        "quota",
      ] as const) {
        expect(label(key)).not.toBe(`settings.tray.${key}`);
        expect(button(key)).toHaveAccessibleName(label(key));
      }
      expect(button("quotaRing")).not.toHaveAccessibleName(/36%/);
      expect(
        screen.getByRole("group", { name: label("display") }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("group", { name: label("window") }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("group", { name: label("color") }),
      ).toBeInTheDocument();
    },
  );
});
