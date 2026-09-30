import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AuthCenterPanel } from "@/components/settings/AuthCenterPanel";
import { WindowSettings } from "@/components/settings/WindowSettings";
import { DirectorySettings } from "@/components/settings/DirectorySettings";
import { UsageHero } from "@/components/usage/UsageHero";
import type {
  SettingsFormState,
  ResolvedDirectories,
} from "@/hooks/useSettings";

const summary = vi.hoisted(() =>
  vi.fn(() => ({ data: undefined, isLoading: false })),
);
const oauth = vi.hoisted(() => vi.fn());
vi.mock("@/lib/query/usage", () => ({
  useUsageSummary: (...args: unknown[]) => summary(...(args as [])),
}));
vi.mock("@/components/providers/forms/CodexOAuthSection", () => ({
  CodexOAuthSection: (props: unknown) => {
    oauth(props);
    return <div>codex-accounts</div>;
  },
}));

const settings = {
  launchOnStartup: false,
  enableClaudePluginIntegration: true,
  skipClaudeOnboarding: true,
  minimizeToTrayOnClose: false,
} as SettingsFormState;
const dirs = {
  appConfig: "/app-config",
  codex: "/codex",
  claude: "/claude",
  gemini: "/gemini",
  grokbuild: "/grok",
  opencode: "/opencode",
  openclaw: "/openclaw",
  hermes: "/hermes",
  pi: "/pi",
} as ResolvedDirectories;

describe("Codex settings shell", () => {
  it("keeps only the existing Codex OAuth account component with quota enabled", () => {
    render(<AuthCenterPanel authScrollTarget="github_copilot" />);
    expect(screen.getByText("ChatGPT (Codex OAuth)")).toBeInTheDocument();
    expect(oauth).toHaveBeenCalledWith({ showAccountQuota: true });
    expect(screen.queryByText("GitHub Copilot")).not.toBeInTheDocument();
    expect(screen.queryByText("xAI (Grok OAuth)")).not.toBeInTheDocument();
  });

  it("does not expose legacy Claude controls with persisted values enabled", () => {
    const change = vi.fn();
    render(<WindowSettings settings={settings} onChange={change} />);
    expect(
      screen.queryByText("settings.enableClaudePluginIntegration"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("settings.skipClaudeOnboarding"),
    ).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
  });

  it("shows app storage and Codex directories without mutating legacy paths", () => {
    const change = vi.fn();
    const action = vi.fn(async () => {});
    render(
      <DirectorySettings
        resolvedDirs={dirs}
        onAppConfigChange={change}
        onBrowseAppConfig={action}
        onResetAppConfig={action}
        onDirectoryChange={change}
        onBrowseDirectory={action}
        onResetDirectory={action}
      />,
    );
    expect(screen.getByDisplayValue("/codex")).toBeInTheDocument();
    expect(screen.getByDisplayValue("/app-config")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);
    expect(change).not.toHaveBeenCalled();
  });

  it("requests Codex summary directly even with a legacy all-app prop", () => {
    render(
      <UsageHero
        range={{ preset: "today" }}
        appType="all"
        refreshIntervalMs={0}
      />,
    );
    expect(summary).toHaveBeenCalledWith(
      { preset: "today" },
      { appType: "codex", providerName: undefined, model: undefined },
      { refetchInterval: false },
    );
  });
});
