import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderActions } from "@/components/providers/ProviderActions";

function renderActions(
  props: Partial<React.ComponentProps<typeof ProviderActions>> = {},
) {
  const callbacks = {
    onSwitch: vi.fn(),
    onTest: vi.fn(),
    onEdit: vi.fn(),
  };
  render(
    <ProviderActions
      appId="codex"
      isCurrent={false}
      {...callbacks}
      {...props}
    />,
  );
  return callbacks;
}

describe("Codex provider actions", () => {
  it("exposes only switch, connectivity test, and edit in that order and forwards each action", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions();
    const buttons = screen.getAllByRole("button");
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.getAttribute("aria-label"))).toEqual([
      "切换到此连接",
      "检测连通",
      "common.edit",
    ]);
    for (const button of buttons) await user.click(button);
    for (const callback of Object.values(callbacks))
      expect(callback).toHaveBeenCalledOnce();
    expect(screen.queryByTitle("provider.duplicate")).not.toBeInTheDocument();
    expect(
      screen.queryByTitle("provider.configureUsage"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "common.delete" }),
    ).not.toBeInTheDocument();
  });

  it("protects the current connection from switching while keeping testing and editing available", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions({ isCurrent: true });
    expect(
      screen.getByRole("button", { name: "provider.inUse" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "检测连通" }));
    await user.click(screen.getByRole("button", { name: "common.edit" }));
    expect(callbacks.onTest).toHaveBeenCalledOnce();
    expect(callbacks.onEdit).toHaveBeenCalledOnce();
    expect(callbacks.onSwitch).not.toHaveBeenCalled();
  });

  it("blocks unsupported saved connections and explains the reason while preserving editing", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions({
      switchDisabledReason: "Requires native Responses",
    });
    const switchButton = screen.getByRole("button", { name: "切换到此连接" });
    expect(switchButton).toBeDisabled();
    expect(switchButton.parentElement).toHaveAttribute(
      "title",
      "Requires native Responses",
    );
    await user.click(screen.getByRole("button", { name: "common.edit" }));
    expect(callbacks.onEdit).toHaveBeenCalledOnce();
    expect(callbacks.onSwitch).not.toHaveBeenCalled();
  });

  it.each([{ isTesting: true }, { onTest: undefined }])(
    "disables the connectivity action when it is pending or unavailable: %j",
    (props) => {
      renderActions(props);
      expect(screen.getByRole("button", { name: "检测连通" })).toBeDisabled();
      expect(screen.getAllByRole("button")).toHaveLength(3);
    },
  );
});
