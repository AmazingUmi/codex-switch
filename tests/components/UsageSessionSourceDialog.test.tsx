import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { UsageSessionSourceDialog } from "@/components/usage/UsageSessionSourceDialog";
import { codexUsageSourceQueryKey, usageApi } from "@/lib/api/usage";
import { settingsApi } from "@/lib/api/settings";

const source = {
  directory: "/fixture/effective-codex",
  defaultDirectory: "/fixture/default-codex",
};

function renderDialog(
  value?: string,
  onSave = vi.fn().mockResolvedValue(true),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onClose = vi.fn();
  const wrap = (nextValue?: string) => (
    <QueryClientProvider client={client}>
      <UsageSessionSourceDialog
        value={nextValue}
        onSave={onSave}
        onClose={onClose}
      />
    </QueryClientProvider>
  );
  const view = render(wrap(value));
  return {
    ...view,
    onSave,
    onClose,
    client,
    rerenderValue: (next?: string) => view.rerender(wrap(next)),
  };
}

describe("session token source dialog", () => {
  beforeEach(() => {
    vi.spyOn(usageApi, "getCodexUsageSource").mockResolvedValue(source);
  });

  it("reads effective and default roots without scanning and exposes the default as placeholder", async () => {
    const sync = vi.spyOn(usageApi, "syncSessionUsage");
    renderDialog();
    expect(await screen.findByText(source.directory)).toBeVisible();
    expect(screen.getByText(source.defaultDirectory)).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Codex root directory" }),
    ).toHaveValue("");
    expect(screen.getByRole("textbox")).toHaveAttribute(
      "placeholder",
      source.defaultDirectory,
    );
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "About the session source" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(sync).not.toHaveBeenCalled();
    expect(usageApi.getCodexUsageSource).toHaveBeenCalledTimes(1);
  });

  it("trims and saves only the selected root, refreshes its query, and leaves scan explicit", async () => {
    const sync = vi.spyOn(usageApi, "syncSessionUsage");
    const success = vi.spyOn(toast, "success");
    const { onSave, onClose, client } = renderDialog();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await screen.findByText(source.directory);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "  /fixture/custom-codex  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith("/fixture/custom-codex");
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: codexUsageSourceQueryKey,
    });
    expect(success).toHaveBeenCalledWith(
      "Session source saved. Use Sync now to scan the selected source.",
    );
    expect(sync).not.toHaveBeenCalled();
  });

  it("chooses folders using the draft or effective root and does not persist on Cancel", async () => {
    const pick = vi
      .spyOn(settingsApi, "pickDirectory")
      .mockResolvedValueOnce("/fixture/chosen")
      .mockResolvedValueOnce(null);
    const { onSave, onClose } = renderDialog();
    await screen.findByText(source.directory);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox")).toHaveValue("/fixture/chosen"),
    );
    expect(pick).toHaveBeenNthCalledWith(1, source.directory);
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(pick).toHaveBeenCalledTimes(2));
    expect(pick).toHaveBeenNthCalledWith(2, "/fixture/chosen");
    expect(screen.getByRole("textbox")).toHaveValue("/fixture/chosen");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSave).not.toHaveBeenCalled();
  });

  it.each(["reset", "blank"])(
    "saves undefined for %s only after Save",
    async (mode) => {
      const { onSave } = renderDialog("/fixture/custom-codex");
      await screen.findByText(source.directory);
      if (mode === "reset") {
        fireEvent.click(
          screen.getByRole("button", { name: "Restore default" }),
        );
      } else {
        fireEvent.change(screen.getByRole("textbox"), {
          target: { value: "   " },
        });
      }
      expect(onSave).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onSave).toHaveBeenCalledWith(undefined));
    },
  );

  it.each([false, "throw"])(
    "preserves the draft and stays open when saving fails with %s",
    async (failure) => {
      const onSave =
        failure === "throw"
          ? vi.fn().mockRejectedValue(new Error("fixture failure"))
          : vi.fn().mockResolvedValue(false);
      const { onClose, rerenderValue } = renderDialog("/fixture/old", onSave);
      await screen.findByText(source.directory);
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "/fixture/retry" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Your draft is still here.",
      );
      rerenderValue(undefined);
      expect(screen.getByRole("textbox")).toHaveValue("/fixture/retry");
      expect(onClose).not.toHaveBeenCalled();
      onSave.mockResolvedValue(true);
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
      expect(onSave).toHaveBeenLastCalledWith("/fixture/retry");
    },
  );

  it("reports source lookup and folder picker failures without dropping the draft", async () => {
    vi.mocked(usageApi.getCodexUsageSource).mockRejectedValueOnce(
      new Error("fixture source unavailable"),
    );
    vi.spyOn(settingsApi, "pickDirectory").mockRejectedValueOnce(
      new Error("fixture picker unavailable"),
    );
    renderDialog("/fixture/draft");
    expect(
      await screen.findByText("Unable to read the effective session source."),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText(source.directory)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    expect(await screen.findByText("Unable to choose a folder.")).toBeVisible();
    expect(screen.getByRole("textbox")).toHaveValue("/fixture/draft");
  });
});
