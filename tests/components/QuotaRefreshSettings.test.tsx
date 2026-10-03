import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { QuotaRefreshSettings } from "@/components/settings/QuotaRefreshSettings";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
const scrollDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  await i18n
    .use(initReactI18next)
    .init({ lng: "en", resources: { en: { translation: en } } });
});
afterAll(() => {
  if (scrollDescriptor)
    Object.defineProperty(
      HTMLElement.prototype,
      "scrollIntoView",
      scrollDescriptor,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function setup(onChange = vi.fn().mockResolvedValue(true)) {
  render(
    <I18nextProvider i18n={i18n}>
      <QuotaRefreshSettings
        settings={{
          showInTray: true,
          minimizeToTrayOnClose: true,
          quotaRefreshIntervalSeconds: 60,
          language: "en",
        }}
        onChange={onChange}
      />
    </I18nextProvider>,
  );
  return onChange;
}

describe("shared quota refresh setting", () => {
  it("offers off and presets and saves only the selected interval", async () => {
    const onChange = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(
      screen.getByRole("option", { name: en.settings.quotaRefresh.off }),
    );
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({ quotaRefreshIntervalSeconds: 0 }),
    );
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("rejects invalid custom intervals without saving and accepts a valid integer", async () => {
    const onChange = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(
      screen.getByRole("option", { name: en.settings.quotaRefresh.custom }),
    );
    const input = screen.getByRole("spinbutton", {
      name: en.settings.quotaRefresh.custom,
    });
    for (const value of ["", "0", "29", "30.5", "3601"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
      expect(screen.getByRole("alert")).toHaveTextContent(
        en.settings.quotaRefresh.invalid,
      );
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        quotaRefreshIntervalSeconds: 90,
      }),
    );
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("reports save failure and restores the persisted custom value", async () => {
    setup(vi.fn().mockResolvedValue(false));
    const user = userEvent.setup();
    await user.click(screen.getByRole("combobox"));
    await user.click(
      screen.getByRole("option", { name: en.settings.quotaRefresh.custom }),
    );
    const input = screen.getByRole("spinbutton");
    fireEvent.change(input, { target: { value: "90" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        en.settings.saveFailedGeneric,
      ),
    );
    expect(input).toHaveValue(60);
  });
});
