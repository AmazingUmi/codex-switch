import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { AppSwitcher } from "@/components/AppSwitcher";
import { PRODUCT_APP_IDS } from "@/config/productShell";

it("only exposes Codex in the product even with legacy visibility settings", () => {
  render(
    <AppSwitcher
      activeApp="codex"
      onSwitch={vi.fn()}
      allowedApps={PRODUCT_APP_IDS}
    />,
  );
  expect(screen.getByRole("button", { name: "Codex" })).toBeInTheDocument();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: "Claude Code" }),
  ).not.toBeInTheDocument();
});
