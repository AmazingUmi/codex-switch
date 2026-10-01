import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProviderActions } from "@/components/providers/ProviderActions";

function renderActions(
  props: Partial<React.ComponentProps<typeof ProviderActions>> = {},
) {
  const callbacks = {
    onSwitch: vi.fn(),
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onTest: vi.fn(),
    onConfigureUsage: vi.fn(),
    onDelete: vi.fn(),
    onOpenTerminal: vi.fn(),
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
  it("forwards ordinary provider actions without changing their meaning", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions();
    await user.click(screen.getByRole("button", { name: "provider.enable" }));
    await user.click(screen.getByRole("button", { name: "common.edit" }));
    await user.click(screen.getByTitle("provider.duplicate"));
    await user.click(screen.getByTitle("检测连通"));
    await user.click(screen.getByTitle("provider.configureUsage"));
    await user.click(screen.getByTitle("打开终端"));
    await user.click(screen.getByRole("button", { name: "common.delete" }));
    for (const callback of Object.values(callbacks))
      expect(callback).toHaveBeenCalledOnce();
  });

  it("protects the current provider from switching and deletion while allowing edits", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions({ isCurrent: true });
    expect(
      screen.getByRole("button", { name: "provider.inUse" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "common.delete" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "common.edit" }));
    expect(callbacks.onEdit).toHaveBeenCalledOnce();
    expect(callbacks.onSwitch).not.toHaveBeenCalled();
    expect(callbacks.onDelete).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "toggles queue membership instead of switching while failover is active (%s)",
    async (isInFailoverQueue) => {
      const user = userEvent.setup();
      const onToggleFailover = vi.fn();
      const callbacks = renderActions({
        isAutoFailoverEnabled: true,
        isInFailoverQueue,
        onToggleFailover,
      });
      await user.click(
        screen.getByRole("button", {
          name: isInFailoverQueue ? "已加入" : "加入",
        }),
      );
      expect(onToggleFailover).toHaveBeenCalledWith(!isInFailoverQueue);
      expect(callbacks.onSwitch).not.toHaveBeenCalled();
    },
  );

  it("lets supported official accounts switch in failover mode without a queue callback", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions({
      isAutoFailoverEnabled: true,
      isProxyTakeover: true,
    });
    await user.click(screen.getByRole("button", { name: "provider.enable" }));
    expect(callbacks.onSwitch).toHaveBeenCalledOnce();
  });

  it("explains why an official API provider cannot switch into unsupported routing", () => {
    renderActions({ isOfficialBlockedByProxy: true });
    const enable = screen.getByRole("button", { name: "provider.enable" });
    expect(enable).toBeDisabled();
    expect(enable.parentElement).toHaveAttribute(
      "title",
      "provider.blockedByProxyHint",
    );
  });

  it("omits duplication when the caller disallows it and keeps testing disabled during checks", () => {
    renderActions({ onDuplicate: undefined, isTesting: true });
    expect(screen.queryByTitle("provider.duplicate")).not.toBeInTheDocument();
    expect(screen.getByTitle("检测连通")).toBeDisabled();
  });
});
