import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { settingsApi, ToolInstallationReport } from "@/lib/api/settings";

type ToolVersions = Awaited<ReturnType<typeof settingsApi.getToolVersions>>;

const mocks = vi.hoisted(() => ({
  getToolVersions: vi.fn(),
  probeToolInstallations: vi.fn(),
  runToolLifecycleAction: vi.fn(),
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/lib/api", () => ({ settingsApi: mocks }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "3.20.4" }));
vi.mock("@/config/appConfig", () => ({ APP_ICON_MAP: {} }));
vi.mock("sonner", () => ({ toast: mocks }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function report(
  tool: string,
  overrides: Partial<ToolInstallationReport> = {},
): ToolInstallationReport {
  return {
    tool,
    installs: [],
    is_conflict: false,
    needs_confirmation: false,
    command: `${tool} update`,
    anchored: true,
    unmanaged: false,
    ...overrides,
  };
}

const upgraded = new Set<string>();
const outdated = new Set<string>();
const missing = new Set<string>();

function card(name: string) {
  return within(screen.getByText(name).closest(".rounded-xl") as HTMLElement);
}

function updateButton(name: string) {
  return card(name).getByRole("button", { name: "settings.toolUpdate" });
}

async function renderAbout() {
  // AboutSection caches version results at module scope between mounts.
  const { AboutSection } = await import("@/components/settings/AboutSection");
  const view = render(<AboutSection isPortable={false} />);
  await waitFor(() =>
    expect(
      within(view.container).getByText("common.refresh"),
    ).toBeInTheDocument(),
  );
  return view;
}

describe("AboutSection Codex CLI lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    upgraded.clear();
    outdated.clear();
    missing.clear();
    outdated.add("codex");
    mocks.getToolVersions
      .mockReset()
      .mockImplementation(async (tools: string[]) =>
        tools.map((name) => ({
          name,
          version: missing.has(name)
            ? null
            : upgraded.has(name) || !outdated.has(name)
              ? "2.0.0"
              : "1.0.0",
          latest_version: "2.0.0",
          error: null,
          installed_but_broken: false,
          env_type: "windows",
          wsl_distro: null,
        })),
      );
    mocks.probeToolInstallations
      .mockReset()
      .mockImplementation(async (tools: string[]) =>
        tools.map((tool) => report(tool)),
      );
    mocks.runToolLifecycleAction
      .mockReset()
      .mockImplementation(async ([tool]: string[]) => {
        upgraded.add(tool);
        missing.delete(tool);
      });
  });

  it("exposes local build identity without upstream project or update actions", async () => {
    const view = await renderAbout();
    expect(screen.getByText("Codex Switch")).toBeInTheDocument();
    expect(screen.getByText("settings.localBuildHint")).toBeInTheDocument();
    expect(view.container.querySelectorAll("a[href]")).toHaveLength(0);
    for (const name of [
      "settings.github",
      "settings.officialWebsite",
      "settings.releaseNotes",
      "settings.checkForUpdates",
      "settings.updateTo",
    ]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
  });

  it("only probes and exposes Codex, including batch diagnosis and manual commands", async () => {
    await renderAbout();
    await waitFor(() =>
      expect(mocks.getToolVersions).toHaveBeenCalledWith(["codex"], {}),
    );
    expect(
      mocks.getToolVersions.mock.calls.every(([tools]) =>
        tools.every((tool: string) => tool === "codex"),
      ),
    ).toBe(true);
    for (const name of [
      "Claude Code",
      "Gemini CLI",
      "Grok Build",
      "OpenCode",
      "OpenClaw",
      "Hermes",
      "Pi",
      "MiniMax Code",
    ]) {
      expect(screen.queryByText(name)).not.toBeInTheDocument();
    }
    fireEvent.click(
      screen.getByRole("button", { name: "settings.manualInstallCommands" }),
    );
    expect(
      screen.getByText("npm i -g @openai/codex@latest"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.toolDiagnose" }),
    );
    await waitFor(() =>
      expect(mocks.probeToolInstallations).toHaveBeenCalledWith(["codex"]),
    );
  });

  it("runs the batch update only for Codex", async () => {
    await renderAbout();
    fireEvent.click(
      screen.getByRole("button", { name: "settings.updateAllTools" }),
    );
    await waitFor(() =>
      expect(mocks.runToolLifecycleAction).toHaveBeenCalledWith(
        ["codex"],
        "update",
        {},
      ),
    );
    expect(mocks.runToolLifecycleAction).toHaveBeenCalledTimes(1);
  });
  it.each(["install", "update"] as const)(
    "restores an ongoing %s after remount and receives its completion",
    async (action) => {
      if (action === "install") missing.add("codex");
      const running = deferred<void>();
      mocks.runToolLifecycleAction.mockImplementationOnce(async () => {
        await running.promise;
        upgraded.add("codex");
        missing.delete("codex");
      });
      const actionButton = () =>
        card("Codex").getByRole("button", {
          name:
            action === "install"
              ? "settings.toolInstall"
              : "settings.toolUpdate",
        });
      const view = await renderAbout();
      fireEvent.click(actionButton());
      await waitFor(() =>
        expect(mocks.runToolLifecycleAction).toHaveBeenCalledTimes(1),
      );
      view.unmount();
      await renderAbout();
      const versionChecks = mocks.getToolVersions.mock.calls.length;
      expect(actionButton()).toBeDisabled();
      expect(actionButton()).toHaveAttribute("aria-busy", "true");
      fireEvent.click(actionButton());
      expect(mocks.runToolLifecycleAction).toHaveBeenCalledTimes(1);
      expect(mocks.getToolVersions).toHaveBeenCalledTimes(versionChecks);
      expect(mocks.info).not.toHaveBeenCalled();
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.warning).not.toHaveBeenCalled();
      expect(mocks.success).not.toHaveBeenCalled();

      await act(async () => running.resolve());
      expect(card("Codex").getByText("settings.toolReady")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "common.refresh" }),
      ).toBeEnabled();
      expect(mocks.success).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["install", "update"] as const)(
    "shows an informational toast when the backend reports an ongoing %s",
    async (action) => {
      if (action === "install") missing.add("codex");
      mocks.runToolLifecycleAction.mockRejectedValueOnce(
        "TOOL_ACTION_IN_PROGRESS",
      );
      await renderAbout();
      const versionChecks = mocks.getToolVersions.mock.calls.length;
      fireEvent.click(
        card("Codex").getByRole("button", {
          name:
            action === "install"
              ? "settings.toolInstall"
              : "settings.toolUpdate",
        }),
      );
      await waitFor(() =>
        expect(mocks.info).toHaveBeenCalledWith(
          "settings.toolActionInProgress",
          {
            description: "settings.toolActionInProgressDetail",
            closeButton: true,
          },
        ),
      );
      expect(mocks.getToolVersions).toHaveBeenCalledTimes(versionChecks);
      expect(mocks.error).not.toHaveBeenCalled();
      expect(mocks.warning).not.toHaveBeenCalled();
      expect(mocks.success).not.toHaveBeenCalled();
    },
  );

  it("ignores a late probe from the old page after the remounted page upgrades a tool", async () => {
    const stale = deferred<ToolVersions>();
    const getVersions = mocks.getToolVersions.getMockImplementation()!;
    let firstCodexProbe = true;
    let oldResult: ToolVersions = [];
    mocks.getToolVersions.mockImplementation(async (tools: string[]) => {
      if (tools.includes("codex") && firstCodexProbe) {
        firstCodexProbe = false;
        oldResult = await getVersions(tools);
        return stale.promise;
      }
      return getVersions(tools);
    });
    const { AboutSection } = await import("@/components/settings/AboutSection");
    const view = render(<AboutSection isPortable={false} />);
    await waitFor(() => expect(mocks.getToolVersions).toHaveBeenCalledTimes(1));
    view.unmount();
    const remounted = await renderAbout();
    fireEvent.click(updateButton("Codex"));
    await waitFor(() =>
      expect(card("Codex").queryByText("settings.toolReady")).not.toBeNull(),
    );

    await act(async () => stale.resolve(oldResult));
    expect(card("Codex").queryByText("settings.toolReady")).not.toBeNull();
    expect(card("Codex").queryByText("1.0.0")).not.toBeInTheDocument();
    remounted.unmount();
    await renderAbout();
    expect(card("Codex").getByText("settings.toolReady")).toBeInTheDocument();
  });

  it("preserves preflight and its confirmation when navigating away and back", async () => {
    const preflight = deferred<ToolInstallationReport[]>();
    mocks.probeToolInstallations.mockImplementationOnce(
      () => preflight.promise,
    );
    const view = await renderAbout();
    fireEvent.click(updateButton("Codex"));
    view.unmount();
    const remounted = await renderAbout();
    expect(updateButton("Codex")).toBeDisabled();
    expect(updateButton("Codex")).toHaveAttribute("aria-busy", "true");
    expect(mocks.probeToolInstallations).toHaveBeenCalledTimes(1);
    await act(async () =>
      preflight.resolve([report("codex", { needs_confirmation: true })]),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    remounted.unmount();
    await renderAbout();
    expect(
      within(screen.getByRole("dialog")).getByText("Codex"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "common.cancel" }));
    expect(updateButton("Codex")).toBeEnabled();
    expect(mocks.runToolLifecycleAction).not.toHaveBeenCalled();
    fireEvent.click(updateButton("Codex"));
    await waitFor(() =>
      expect(card("Codex").getByText("settings.toolReady")).toBeInTheDocument(),
    );
  });

  it("unlocks a failed background task after remount so it can be retried", async () => {
    const running = deferred<void>();
    mocks.runToolLifecycleAction.mockImplementationOnce(() => running.promise);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const view = await renderAbout();
      fireEvent.click(updateButton("Codex"));
      await waitFor(() =>
        expect(mocks.runToolLifecycleAction).toHaveBeenCalledTimes(1),
      );
      view.unmount();
      await renderAbout();
      expect(updateButton("Codex")).toBeDisabled();
      await act(async () => running.reject(new Error("installer failed")));
      expect(mocks.error).toHaveBeenCalledWith("settings.toolActionFailed", {
        description: "installer failed",
        closeButton: true,
      });
      fireEvent.click(updateButton("Codex"));
      await waitFor(() =>
        expect(
          card("Codex").getByText("settings.toolReady"),
        ).toBeInTheDocument(),
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("keeps a tool locked through version refresh and remount with an expired cache", async () => {
    const refreshed =
      deferred<Awaited<ReturnType<typeof mocks.getToolVersions>>>();
    const view = await renderAbout();
    mocks.getToolVersions.mockImplementationOnce(() => refreshed.promise);
    fireEvent.click(updateButton("Codex"));
    await waitFor(() =>
      expect(
        card("Codex").getAllByText("common.loading").length,
      ).toBeGreaterThan(0),
    );
    view.unmount();
    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.now() + 11 * 60 * 1000);
    try {
      await renderAbout();
      // Initial probe and the original task's refresh only: remount must not
      // probe a tool again while its installation/version refresh is pending.
      expect(
        mocks.getToolVersions.mock.calls.filter(([tools]) =>
          tools.includes("codex"),
        ),
      ).toHaveLength(2);
    } finally {
      now.mockRestore();
    }
    expect(updateButton("Codex")).toBeDisabled();
    expect(updateButton("Codex")).toHaveAttribute("aria-busy", "true");
    expect(
      screen.getByRole("button", { name: "settings.updateAllTools" }),
    ).toBeDisabled();
    expect(mocks.runToolLifecycleAction).toHaveBeenCalledTimes(1);
    await act(async () =>
      refreshed.resolve([
        {
          name: "codex",
          version: "2.0.0",
          latest_version: "2.0.0",
          error: null,
          installed_but_broken: false,
          env_type: "windows",
          wsl_distro: null,
        },
      ]),
    );
    expect(card("Codex").getByText("settings.toolReady")).toBeInTheDocument();
  });
});
