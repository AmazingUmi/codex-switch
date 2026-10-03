import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { QuotaBatterySettings } from "@/components/settings/QuotaBatterySettings";
import type { SettingsFormState } from "@/hooks/useSettings";
import en from "@/i18n/locales/en.json";
import zh from "@/i18n/locales/zh.json";
import zhTW from "@/i18n/locales/zh-TW.json";
import ja from "@/i18n/locales/ja.json";

const i18n = createInstance();
const pointerDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "PointerEvent",
);
beforeAll(async () => {
  class TestPointerEvent extends MouseEvent {
    readonly pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
    }
  }
  Object.defineProperty(window, "PointerEvent", {
    configurable: true,
    value: TestPointerEvent,
  });
  await i18n
    .use(initReactI18next)
    .init({ lng: "en", resources: { en: { translation: en } } });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  if (pointerDescriptor)
    Object.defineProperty(window, "PointerEvent", pointerDescriptor);
  else Reflect.deleteProperty(window, "PointerEvent");
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
  const warning = screen.getByRole("slider", {
    name: en.settings.quotaBattery.warning,
  });
  const low = screen.getByRole("slider", {
    name: en.settings.quotaBattery.low,
  });
  const track = low.closest(".codex-battery-track") as HTMLElement;
  vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 300,
    bottom: 40,
    width: 300,
    height: 40,
    toJSON: () => ({}),
  });
  return {
    ...result,
    warning,
    low,
    track,
    onChange,
    rerenderSettings: (next: Partial<SettingsFormState>) =>
      result.rerender(view({ ...settings, ...next })),
  };
}

describe("battery threshold sliders", () => {
  it("reuses the account battery cells, defaults to 10/50, and does not save untouched controls", () => {
    const { warning, low, track, onChange } = setup();
    expect(warning).toHaveAttribute("aria-valuenow", "50");
    expect(low).toHaveAttribute("aria-valuenow", "10");
    expect(track.querySelectorAll(".codex-battery-cell")).toHaveLength(28);
    expect(track.querySelectorAll(".codex-battery-fill")).toHaveLength(28);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
    fireEvent.blur(warning);
    fireEvent.keyDown(low, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("previews repeated keyboard changes locally and saves one pair on release", async () => {
    const { warning, track, onChange } = setup();
    for (let i = 0; i < 4; i++)
      fireEvent.keyDown(warning, { key: "PageUp", repeat: i > 0 });
    expect(warning).toHaveAttribute("aria-valuenow", "70");
    expect(track.style.getPropertyValue("--codex-battery-warning-stop")).toBe(
      "70%",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyUp(warning, { key: "PageUp" });
    await waitFor(() => expect(warning).toBeEnabled());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      quotaBatteryWarningThresholdPercent: 70,
      quotaBatteryLowThresholdPercent: 10,
    });
    fireEvent.blur(warning);
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("keeps the handles ordered and supports the inclusive 0/100 boundaries", async () => {
    const { warning, low, onChange } = setup();
    fireEvent.keyDown(low, { key: "End" });
    expect(low).toHaveAttribute("aria-valuenow", "49");
    fireEvent.keyDown(warning, { key: "Home" });
    expect(warning).toHaveAttribute("aria-valuenow", "50");
    fireEvent.keyDown(low, { key: "Home" });
    fireEvent.keyDown(warning, { key: "End" });
    fireEvent.keyUp(warning, { key: "End" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaBatteryWarningThresholdPercent: 100,
        quotaBatteryLowThresholdPercent: 0,
      }),
    );
  });

  it("preserves fractional stored thresholds and supports shift adjustments", async () => {
    const { warning, low, onChange } = setup({
      quotaBatteryWarningThresholdPercent: 70.5,
      quotaBatteryLowThresholdPercent: 20.25,
    });
    expect(low).toHaveAttribute("aria-valuetext", "20.25%");
    fireEvent.keyDown(warning, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(warning, { key: "ArrowRight" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaBatteryWarningThresholdPercent: 75.5,
        quotaBatteryLowThresholdPercent: 20.25,
      }),
    );
  });

  it("captures the pointer, updates the bands while dragging, and commits once on release", async () => {
    const { low, track, onChange } = setup();
    const capture = vi.spyOn(low, "setPointerCapture");
    vi.spyOn(low, "hasPointerCapture").mockReturnValue(true);
    const release = vi.spyOn(low, "releasePointerCapture");
    fireEvent.pointerDown(low, { pointerId: 1, button: 0, clientX: 30 });
    expect(capture).toHaveBeenCalledWith(1);
    fireEvent.pointerMove(low, { pointerId: 2, clientX: 180 });
    expect(low).toHaveAttribute("aria-valuenow", "10");
    fireEvent.pointerMove(low, { pointerId: 1, clientX: 90 });
    expect(low).toHaveAttribute("aria-valuenow", "30");
    expect(track).toHaveAttribute("data-dragging", "true");
    expect(track.style.getPropertyValue("--codex-battery-low-stop")).toBe(
      "30%",
    );
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerUp(low, { pointerId: 1, clientX: 90 });
    await waitFor(() => expect(low).toBeEnabled());
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith({
      quotaBatteryWarningThresholdPercent: 50,
      quotaBatteryLowThresholdPercent: 30,
    });
    expect(release).toHaveBeenCalledWith(1);
    expect(track).toHaveAttribute("data-dragging", "false");
  });

  it.each(["pointerCancel", "lostPointerCapture"])(
    "restores a cancelled %s gesture without saving",
    (event) => {
      const { low, track, onChange } = setup();
      fireEvent.pointerDown(low, { pointerId: 1, button: 0, clientX: 30 });
      fireEvent.pointerMove(low, { pointerId: 1, clientX: 90 });
      fireEvent[event as "pointerCancel" | "lostPointerCapture"](low, {
        pointerId: 1,
      });
      expect(low).toHaveAttribute("aria-valuenow", "10");
      expect(track).toHaveAttribute("data-dragging", "false");
      expect(onChange).not.toHaveBeenCalled();
    },
  );

  it("uses the final release position even when no move event arrived", async () => {
    const { low, onChange } = setup();
    fireEvent.pointerDown(low, { pointerId: 1, button: 0, clientX: 30 });
    fireEvent.pointerUp(low, { pointerId: 1, clientX: 60 });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaBatteryWarningThresholdPercent: 50,
        quotaBatteryLowThresholdPercent: 20,
      }),
    );
  });

  it("does not round fractional preferences when a handle is pressed without movement", () => {
    const { low, onChange } = setup({
      quotaBatteryWarningThresholdPercent: 70.5,
      quotaBatteryLowThresholdPercent: 20.25,
    });
    fireEvent.pointerDown(low, { pointerId: 1, button: 0, clientX: 60 });
    fireEvent.pointerUp(low, { pointerId: 1, clientX: 60 });
    expect(low).toHaveAttribute("aria-valuenow", "20.25");
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([false, new Error("Store unavailable")])(
    "rolls back both handles and reports a save failure",
    async (failure) => {
      const onChange =
        failure === false
          ? vi.fn().mockResolvedValue(false)
          : vi.fn().mockRejectedValue(failure);
      const { warning, low } = setup(
        {
          quotaBatteryWarningThresholdPercent: 65,
          quotaBatteryLowThresholdPercent: 15,
        },
        onChange,
      );
      fireEvent.keyDown(warning, { key: "PageUp" });
      fireEvent.keyDown(low, { key: "PageUp" });
      fireEvent.keyUp(low, { key: "PageUp" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        en.settings.saveFailedGeneric,
      );
      expect(warning).toHaveAttribute("aria-valuenow", "65");
      expect(low).toHaveAttribute("aria-valuenow", "15");
      expect(warning).toBeEnabled();
      expect(onChange).toHaveBeenCalledOnce();
    },
  );

  it("locks both handles during saving and does not duplicate a completed save on blur", async () => {
    let finishSave!: (saved: boolean) => void;
    const onChange = vi.fn().mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          finishSave = resolve;
        }),
    );
    const { warning, low } = setup({}, onChange);
    fireEvent.keyDown(warning, { key: "PageUp" });
    fireEvent.keyUp(warning, { key: "PageUp" });
    expect(warning).toBeDisabled();
    expect(low).toBeDisabled();
    fireEvent.blur(warning);
    await act(async () => finishSave(true));
    fireEvent.blur(warning);
    expect(warning).toBeEnabled();
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("reflects external preferences while retaining the focused handle and cell DOM", () => {
    const { warning, low, track, onChange, rerenderSettings } = setup();
    warning.focus();
    const cell = track.querySelector(".codex-battery-cell");
    rerenderSettings({
      quotaBatteryWarningThresholdPercent: 72,
      quotaBatteryLowThresholdPercent: 12,
    });
    expect(warning).toHaveFocus();
    expect(warning).toHaveAttribute("aria-valuenow", "72");
    expect(low).toHaveAttribute("aria-valuenow", "12");
    expect(track.querySelector(".codex-battery-cell")).toBe(cell);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("provides translated help and band labels without saving", () => {
    const { onChange } = setup();
    fireEvent.click(
      screen.getByRole("button", { name: en.settings.quotaBattery.title }),
    );
    expect(screen.getByRole("dialog")).toHaveTextContent(
      en.settings.quotaBattery.help,
    );
    expect(onChange).not.toHaveBeenCalled();
    for (const locale of [en, zh, zhTW, ja]) {
      for (const label of [
        "lowShort",
        "warningShort",
        "availableShort",
      ] as const)
        expect(locale.settings.quotaBattery[label]).toBeTruthy();
    }
  });
});
