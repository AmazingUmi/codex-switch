import { useState } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CapsuleControl } from "@/components/ui/capsule";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { LanguageSettings } from "@/components/settings/LanguageSettings";
import { ThemeSettings } from "@/components/settings/ThemeSettings";

const themeChange = vi.hoisted(() => vi.fn());
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/theme-provider", () => ({
  useTheme: () => {
    const [theme, setTheme] = useState("system");
    return {
      theme,
      setTheme: (value: string) => {
        themeChange(value);
        setTheme(value);
      },
    };
  },
}));

describe("shared capsule controls", () => {
  it("keeps all language options and calls the language callback on click and arrow navigation", async () => {
    const change = vi.fn();
    function LanguageControl() {
      const [language, setLanguage] = useState<"zh" | "zh-TW" | "en" | "ja">(
        "zh",
      );
      return (
        <LanguageSettings
          value={language}
          onChange={(value) => {
            change(value);
            setLanguage(value);
          }}
        />
      );
    }
    const user = userEvent.setup();
    const { container } = render(<LanguageControl />);
    const group = screen.getByRole("group", { name: "settings.language" });
    expect(within(group).getAllByRole("button")).toHaveLength(4);
    const english = within(group).getByRole("button", {
      name: "settings.languageOptionEnglish",
    });
    await user.click(english);
    expect(english).toHaveAttribute("aria-pressed", "true");
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("button", { name: "settings.languageOptionJapanese" }),
    ).toHaveFocus();
    await user.keyboard("{Home}");
    expect(
      screen.getByRole("button", { name: "settings.languageOptionChinese" }),
    ).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(
      screen.getByRole("button", { name: "settings.languageOptionJapanese" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(change.mock.calls.map(([value]) => value)).toEqual([
      "en",
      "ja",
      "zh",
      "ja",
    ]);
    expect(container.querySelectorAll(".capsule-selection")).toHaveLength(1);
  });

  it("keeps theme state, native keyboard activation and one shared selection", async () => {
    const user = userEvent.setup();
    const { container } = render(<ThemeSettings />);
    const system = screen.getByRole("button", { name: "settings.themeSystem" });
    expect(system).toHaveAttribute("aria-pressed", "true");
    await user.tab();
    expect(system).toHaveFocus();
    await user.keyboard("{Home}");
    const light = screen.getByRole("button", { name: "settings.themeLight" });
    expect(light).toHaveFocus();
    expect(light).toHaveAttribute("aria-pressed", "true");
    await user.click(
      screen.getByRole("button", { name: "settings.themeDark" }),
    );
    await user.keyboard(" ");
    expect(themeChange.mock.calls.map(([value]) => value)).toEqual([
      "light",
      "dark",
      "dark",
    ]);
    expect(container.querySelectorAll(".capsule-selection")).toHaveLength(1);
  });

  it("preserves Radix keyboard navigation, disabled triggers and panel associations", async () => {
    const change = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <Tabs defaultValue="logs" onValueChange={change}>
        <TabsList aria-label="Usage views">
          <TabsTrigger value="logs">Logs</TabsTrigger>
          <TabsTrigger value="disabled" disabled>
            Unavailable
          </TabsTrigger>
          <TabsTrigger value="models">Models</TabsTrigger>
        </TabsList>
        <TabsContent value="logs">Log content</TabsContent>
        <TabsContent value="models">Model content</TabsContent>
      </Tabs>,
    );
    const logs = screen.getByRole("tab", { name: "Logs" });
    await user.tab();
    expect(logs).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    const models = screen.getByRole("tab", { name: "Models" });
    expect(models).toHaveFocus();
    expect(models).toHaveAttribute("aria-selected", "true");
    const panel = screen.getByRole("tabpanel", { name: "Models" });
    expect(models).toHaveAttribute("aria-controls", panel.id);
    expect(panel).toHaveTextContent("Model content");
    await user.click(logs);
    expect(screen.getByRole("tabpanel", { name: "Logs" })).toHaveTextContent(
      "Log content",
    );
    expect(change.mock.calls.map(([value]) => value)).toEqual([
      "models",
      "logs",
    ]);
    expect(container.querySelectorAll(".capsule-selection")).toHaveLength(1);
  });

  it("remeasures the selection when option widths change and when translated labels replace text", async () => {
    let resize: ResizeObserverCallback | undefined;
    const resizeSpy = vi
      .spyOn(globalThis, "ResizeObserver")
      .mockImplementation((callback) => {
        resize = callback;
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      });
    try {
      const options = (label: string) => [
        { value: "first", label: "First" },
        { value: "second", label },
      ];
      const { container, rerender } = render(
        <CapsuleControl
          value="second"
          label="Options"
          onChange={vi.fn()}
          options={options("Second")}
        />,
      );
      const bar = screen.getByRole("group", { name: "Options" });
      const selected = screen.getByRole("button", { name: "Second" });
      let left = 76;
      Object.defineProperties(selected, {
        offsetParent: { get: () => bar },
        offsetLeft: { get: () => left },
        offsetWidth: {
          get: () => (selected.textContent === "Second" ? 90 : 140),
        },
      });
      act(() => resize?.([], {} as ResizeObserver));
      const selection = container.querySelector(".capsule-selection");
      expect(selection).toHaveStyle({
        width: "90px",
        transform: "translateX(76px)",
      });
      left = 110;
      act(() => resize?.([], {} as ResizeObserver));
      expect(selection).toHaveStyle({ transform: "translateX(110px)" });
      rerender(
        <CapsuleControl
          value="second"
          label="Options"
          onChange={vi.fn()}
          options={options("A longer translated label")}
        />,
      );
      await waitFor(() => expect(selection).toHaveStyle({ width: "140px" }));
    } finally {
      resizeSpy.mockRestore();
    }
  });
});
