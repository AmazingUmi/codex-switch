import { act, render, screen } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { QueryTimestamp } from "@/components/ui/query-timestamp";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});
afterEach(() => vi.useRealTimers());

describe("Query timestamps", () => {
  it("ages a successful query without refetching and clears its clock when unmounted", () => {
    vi.useFakeTimers();
    const queriedAt = new Date("2026-10-02T12:00:00Z").getTime();
    vi.setSystemTime(queriedAt);
    const { unmount } = render(
      <I18nextProvider i18n={i18n}>
        <QueryTimestamp timestamp={queriedAt} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Just now")).toHaveAttribute(
      "title",
      new Date(queriedAt).toLocaleString(),
    );
    act(() => vi.advanceTimersByTime(120_000));
    expect(screen.getByText("2 min ago")).toHaveAttribute(
      "title",
      new Date(queriedAt).toLocaleString(),
    );
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows never updated for an unavailable or invalid timestamp", () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <QueryTimestamp timestamp={null} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Never")).not.toHaveAttribute("title");
    rerender(
      <I18nextProvider i18n={i18n}>
        <QueryTimestamp timestamp={Number.NaN} />
      </I18nextProvider>,
    );
    expect(screen.getByText("Never")).not.toHaveAttribute("title");
    expect(screen.queryByText("Invalid Date")).not.toBeInTheDocument();
  });
});
