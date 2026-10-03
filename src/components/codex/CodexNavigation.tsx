import { useRef, type CSSProperties, type KeyboardEvent } from "react";
import { BarChart2, Settings, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { CapsuleSelection, useCapsuleSelection } from "@/components/ui/capsule";

export type CodexNavigationView = "accounts" | "usage" | "settings";

interface CodexNavigationProps {
  activeView: CodexNavigationView;
  onNavigate: (view: CodexNavigationView) => void;
}

const views: CodexNavigationView[] = ["accounts", "usage", "settings"];

export function CodexNavigation({
  activeView,
  onNavigate,
}: CodexNavigationProps) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLElement>(null);
  const selectionStyle = useCapsuleSelection(barRef);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const labels = {
    accounts: t("codexAccounts.navigationAccounts", "账户"),
    usage: t("codexAccounts.navigationUsage", "用量"),
    settings: t("common.settings", "设置"),
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + views.length - 1) % views.length;
        break;
      case "ArrowRight":
        next = (index + 1) % views.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = views.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onNavigate(views[next]);
    buttons.current[next]?.focus();
  };

  return (
    <nav
      ref={barRef}
      className="capsule-bar codex-navigation"
      aria-label={t("codexAccounts.homeTabs", "Codex management")}
      data-active-view={activeView}
      data-tauri-no-drag
      style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
    >
      <CapsuleSelection style={selectionStyle} />
      <div
        className="codex-navigation-tabs"
        role="tablist"
        aria-label={t("codexAccounts.homeTabs", "Codex management")}
      >
        {(["accounts", "usage"] as const).map((view, index) => (
          <button
            key={view}
            ref={(element) => {
              buttons.current[index] = element;
            }}
            type="button"
            className="capsule-option codex-navigation-item"
            role="tab"
            id={`codex-tab-${view}`}
            aria-controls={`codex-home-${view}`}
            aria-selected={activeView === view}
            tabIndex={
              activeView === view ||
              (activeView === "settings" && view === "accounts")
                ? 0
                : -1
            }
            aria-label={labels[view]}
            title={labels[view]}
            onClick={() => onNavigate(view)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {view === "accounts" ? (
              <Users aria-hidden="true" />
            ) : (
              <BarChart2 aria-hidden="true" />
            )}
          </button>
        ))}
      </div>
      <button
        ref={(element) => {
          buttons.current[2] = element;
        }}
        type="button"
        className="capsule-option codex-navigation-item"
        aria-pressed={activeView === "settings"}
        aria-label={labels.settings}
        title={labels.settings}
        onClick={() => onNavigate("settings")}
        onKeyDown={(event) => handleKeyDown(event, 2)}
      >
        <Settings aria-hidden="true" />
      </button>
    </nav>
  );
}
