import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UpdateProvider, useUpdate } from "@/contexts/UpdateContext";
import { checkForUpdate } from "@/lib/updater";

vi.mock("@/config/buildMode", () => ({ IS_CODEX_PREVIEW: true }));
vi.mock("@/lib/updater", () => ({ checkForUpdate: vi.fn() }));

function UpdateProbe() {
  const { checkUpdate, isChecking, hasUpdate } = useUpdate();
  return (
    <button onClick={() => void checkUpdate()}>
      {isChecking ? "checking" : hasUpdate ? "available" : "idle"}
    </button>
  );
}

describe("isolated preview updates", () => {
  afterEach(() => vi.useRealTimers());

  it("never contacts the upstream updater on startup or manual check", async () => {
    vi.useFakeTimers();
    render(
      <UpdateProvider>
        <UpdateProbe />
      </UpdateProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    fireEvent.click(screen.getByRole("button", { name: "idle" }));
    expect(checkForUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "idle" })).toBeInTheDocument();
  });
});
