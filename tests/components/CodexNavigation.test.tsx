import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createInstance } from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  CodexNavigation,
  type CodexNavigationView,
} from "@/components/codex/CodexNavigation";
import en from "@/i18n/locales/en.json";

const i18n = createInstance();
beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    resources: { en: { translation: en } },
  });
});

function renderNavigation(initialView: CodexNavigationView = "accounts") {
  const onNavigate = vi.fn();
  function ControlledNavigation() {
    const [activeView, setActiveView] = useState(initialView);
    return (
      <CodexNavigation
        activeView={activeView}
        onNavigate={(view) => {
          onNavigate(view);
          setActiveView(view);
        }}
      />
    );
  }
  return {
    ...render(
      <I18nextProvider i18n={i18n}>
        <ControlledNavigation />
      </I18nextProvider>,
    ),
    onNavigate,
  };
}

describe("CodexNavigation", () => {
  it("preserves panel associations and moves one shared selection through all views", async () => {
    const user = userEvent.setup();
    const { container, onNavigate } = renderNavigation();
    const accounts = screen.getByRole("tab", {
      name: en.codexAccounts.navigationAccounts,
    });
    const usage = screen.getByRole("tab", {
      name: en.codexAccounts.navigationUsage,
    });
    const settings = screen.getByRole("button", { name: en.common.settings });
    expect(
      screen.getByRole("navigation", { name: en.codexAccounts.homeTabs }),
    ).toHaveAttribute("data-tauri-no-drag");
    expect(accounts).toHaveAttribute("id", "codex-tab-accounts");
    expect(accounts).toHaveAttribute("aria-controls", "codex-home-accounts");
    expect(usage).toHaveAttribute("id", "codex-tab-usage");
    expect(usage).toHaveAttribute("aria-controls", "codex-home-usage");
    expect(accounts).toHaveAttribute("aria-selected", "true");
    expect(usage).toHaveAttribute("aria-selected", "false");
    expect(settings).toHaveAttribute("aria-pressed", "false");
    const slider = container.querySelector(".capsule-selection")!;
    expect(container.querySelectorAll(".capsule-selection")).toHaveLength(1);
    expect(slider).toHaveAttribute("aria-hidden", "true");
    await user.click(usage);
    expect(usage).toHaveAttribute("aria-selected", "true");
    expect(accounts).toHaveAttribute("aria-selected", "false");
    await user.click(settings);
    expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(usage).toHaveAttribute("aria-selected", "false");
    await user.click(accounts);
    expect(settings).toHaveAttribute("aria-pressed", "false");
    expect(onNavigate.mock.calls.map(([view]) => view)).toEqual([
      "usage",
      "settings",
      "accounts",
    ]);
  });

  it("supports arrow wrapping and Home/End navigation across three icons", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderNavigation();
    const accounts = screen.getByRole("tab", {
      name: en.codexAccounts.navigationAccounts,
    });
    const usage = screen.getByRole("tab", {
      name: en.codexAccounts.navigationUsage,
    });
    const settings = screen.getByRole("button", { name: en.common.settings });
    await user.tab();
    expect(accounts).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(usage).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(settings).toHaveFocus();
    await user.keyboard("{Home}");
    expect(accounts).toHaveFocus();
    await user.keyboard("{End}");
    expect(settings).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(accounts).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(settings).toHaveFocus();
    expect(onNavigate.mock.calls.map(([view]) => view)).toEqual([
      "usage",
      "settings",
      "accounts",
      "settings",
      "accounts",
      "settings",
    ]);
  });

  it("keeps settings reachable by Tab and enables native keyboard activation", async () => {
    const user = userEvent.setup();
    const { onNavigate } = renderNavigation("usage");
    const usage = screen.getByRole("tab", {
      name: en.codexAccounts.navigationUsage,
    });
    const settings = screen.getByRole("button", { name: en.common.settings });
    await user.tab();
    expect(usage).toHaveFocus();
    await user.tab();
    expect(settings).toHaveFocus();
    await user.keyboard(" ");
    expect(settings).toHaveAttribute("aria-pressed", "true");
    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("settings");
  });
});
