import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { DatabaseUpgrade } from "@/components/DatabaseUpgrade";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ exit: vi.fn() }));

describe("Codex Switch database recovery", () => {
  it("keeps recovery local without checking or opening an upstream release", async () => {
    render(
      <DatabaseUpgrade
        payload={{
          db_version: 99,
          supported_version: 18,
          path: "/example/cc-switch.db",
        }}
      />,
    );
    expect(invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(screen.getByText(/\/example\/cc-switch.db/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "dbUpgrade.openConfigDir",
      }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("open_app_config_folder"),
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});
