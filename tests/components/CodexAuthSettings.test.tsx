import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAuthSettings } from "@/components/settings/CodexAuthSettings";
import type { SettingsFormState } from "@/hooks/useSettings";

const api = vi.hoisted(() => ({
  hasCodexUnifyHistoryBackup: vi.fn(),
  restoreCodexUnifiedHistory: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ settingsApi: api }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

function renderSettings(
  updates: Partial<SettingsFormState> = {},
  onChange = vi.fn().mockResolvedValue(true),
) {
  render(
    <CodexAuthSettings
      settings={
        {
          preserveCodexOfficialAuthOnSwitch: false,
          unifyCodexSessionHistory: false,
          ...updates,
        } as SettingsFormState
      }
      onChange={onChange}
    />,
  );
  return onChange;
}

describe("CodexAuthSettings guidance and confirmations", () => {
  beforeEach(() => {
    api.hasCodexUnifyHistoryBackup.mockReset().mockResolvedValue(true);
    api.restoreCodexUnifiedHistory.mockReset();
  });

  it("opens field guidance without toggling either setting", () => {
    const onChange = renderSettings();

    for (const key of [
      "preserveCodexOfficialAuthOnSwitch",
      "unifyCodexSessionHistory",
    ]) {
      expect(
        screen.queryByText(`settings.${key}Description`),
      ).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: `settings.${key}` }));
      expect(
        screen.getByText(`settings.${key}Description`),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: `settings.${key}` }),
      ).toHaveAttribute("aria-checked", "false");
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    }

    expect(onChange).not.toHaveBeenCalled();
    expect(api.hasCodexUnifyHistoryBackup).not.toHaveBeenCalled();
    expect(api.restoreCodexUnifiedHistory).not.toHaveBeenCalled();
  });

  it("requires migration confirmation before saving unified history", () => {
    const onChange = renderSettings();

    fireEvent.click(
      screen.getByRole("switch", { name: "settings.unifyCodexSessionHistory" }),
    );
    expect(onChange).not.toHaveBeenCalled();
    expect(
      screen.getByText("confirm.unifyCodexHistory.message"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "confirm.unifyCodexHistory.migrateExisting",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "confirm.unifyCodexHistory.confirm" }),
    );

    expect(onChange).toHaveBeenCalledWith({
      unifyCodexSessionHistory: true,
      unifyCodexMigrateExisting: true,
    });
  });

  it("does not restore history when disabling fails to save", async () => {
    const onChange = vi.fn().mockResolvedValue(false);
    renderSettings({ unifyCodexSessionHistory: true }, onChange);

    fireEvent.click(
      screen.getByRole("switch", { name: "settings.unifyCodexSessionHistory" }),
    );
    const confirm = await screen.findByRole("button", {
      name: "confirm.unifyCodexHistoryOff.confirm",
    });
    expect(
      screen.getByRole("checkbox", {
        name: "confirm.unifyCodexHistoryOff.restoreBackup",
      }),
    ).toBeChecked();
    fireEvent.click(confirm);

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        unifyCodexSessionHistory: false,
        unifyCodexMigrateExisting: false,
      }),
    );
    expect(api.restoreCodexUnifiedHistory).not.toHaveBeenCalled();
  });
});
