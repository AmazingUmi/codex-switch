import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HelpButton } from "@/components/ui/help-button";

describe("HelpButton", () => {
  it("previews on hover without moving focus and allows reading the floating content", async () => {
    const user = userEvent.setup();
    render(
      <HelpButton label="Statistics scope">
        Locally recorded requests.
      </HelpButton>,
    );
    const trigger = screen.getByRole("button", { name: "Statistics scope" });
    await user.hover(trigger);
    const content = await screen.findByRole("dialog", {
      name: "Statistics scope",
    });
    expect(trigger).not.toHaveFocus();
    await user.unhover(trigger);
    await user.hover(content);
    expect(content).toHaveTextContent("Locally recorded requests.");
    await user.unhover(content);
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });

  it("opens for keyboard focus, dismisses on Escape and lets Tab continue", async () => {
    const user = userEvent.setup();
    render(
      <>
        <HelpButton label="Quota help">Percentages show used quota.</HelpButton>
        <button>Next action</button>
      </>,
    );
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Quota help" });
    expect(trigger).toHaveFocus();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Next action" })).toHaveFocus();
  });

  it("keeps clicked help open until dismissed and does not activate its parent", async () => {
    const user = userEvent.setup();
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <HelpButton label="Account help">
          Choose an account to switch.
        </HelpButton>
      </div>,
    );
    const trigger = screen.getByRole("button", { name: "Account help" });
    fireEvent.pointerEnter(trigger);
    fireEvent.click(trigger);
    fireEvent.pointerLeave(trigger);
    expect(trigger).not.toHaveFocus();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(parentClick).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
