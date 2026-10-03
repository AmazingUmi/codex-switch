import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WindowSettings } from "@/components/settings/WindowSettings";
import { DirectorySettings } from "@/components/settings/DirectorySettings";
import type {
  ResolvedDirectories,
  SettingsFormState,
} from "@/hooks/useSettings";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/lib/platform", () => ({ isLinux: () => false }));

describe("Settings guidance", () => {
  it("explains closing behavior without changing the window setting", () => {
    const onChange = vi.fn();
    render(
      <WindowSettings
        settings={{ minimizeToTrayOnClose: true } as SettingsFormState}
        onChange={onChange}
      />,
    );

    expect(
      screen.queryByText("settings.minimizeToTrayDescription"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.minimizeToTray" }),
    );
    expect(
      screen.getByText("settings.minimizeToTrayDescription"),
    ).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.click(
      within(
        screen.getByRole("group", { name: "settings.minimizeToTray" }),
      ).getByRole("button", { name: "settings.toggleOff" }),
    );
    expect(onChange).toHaveBeenCalledWith({ minimizeToTrayOnClose: false });
  });

  it("keeps directory explanations separate from editing paths", () => {
    const onDirectoryChange = vi.fn();
    const onAppConfigChange = vi.fn();
    const action = vi.fn().mockResolvedValue(undefined);
    render(
      <DirectorySettings
        resolvedDirs={
          { appConfig: "/app", codex: "/codex" } as ResolvedDirectories
        }
        onAppConfigChange={onAppConfigChange}
        onBrowseAppConfig={action}
        onResetAppConfig={action}
        onDirectoryChange={onDirectoryChange}
        onBrowseDirectory={action}
        onResetDirectory={action}
      />,
    );

    expect(
      screen.queryByText("productShell.settings.codexDirectoryDescription"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.codexConfigDir" }),
    );
    expect(
      screen.getByText("productShell.settings.codexDirectoryDescription"),
    ).toBeInTheDocument();
    expect(onDirectoryChange).not.toHaveBeenCalled();
    expect(onAppConfigChange).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    fireEvent.change(
      screen.getByRole("textbox", { name: "settings.codexConfigDir" }),
      {
        target: { value: "/new-codex" },
      },
    );
    expect(onDirectoryChange).toHaveBeenCalledWith("codex", "/new-codex");
    expect(onAppConfigChange).not.toHaveBeenCalled();
  });
});
