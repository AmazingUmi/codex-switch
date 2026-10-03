import { AlertCircle, CheckCircle2, Loader2, Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";
import { HelpButton } from "@/components/ui/help-button";
import type { ChatGptAppVersion } from "@/lib/api/settings";

interface ChatGptAppVersionCardProps {
  report: ChatGptAppVersion | null;
  isLoading: boolean;
}

export function ChatGptAppVersionCard({
  report,
  isLoading,
}: ChatGptAppVersionCardProps) {
  const { t } = useTranslation();
  const installed = report?.status === "installed";
  const statusText = installed
    ? report.version || "—"
    : report?.status === "not_installed"
      ? t("common.notInstalled")
      : report?.status === "unsupported"
        ? t("settings.appVersionUnsupported")
        : t("settings.appVersionUnavailable");

  return (
    <div
      className="flex min-h-[150px] min-w-0 flex-col gap-3 rounded-xl border border-border bg-gradient-to-br from-card/80 to-card/40 p-4 shadow-sm transition-colors hover:border-primary/30"
      aria-busy={isLoading}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-background/80 text-muted-foreground">
            <Monitor className="h-4 w-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1">
              <span
                className="truncate text-sm font-medium"
                title={report?.path || undefined}
              >
                ChatGPT
              </span>
              <HelpButton label={t("settings.chatGptAppVersionHelp")}>
                {t("settings.chatGptAppVersionHint")}
              </HelpButton>
            </div>
            <span className="text-xs text-muted-foreground">
              {t("settings.desktopApp")}
            </span>
          </div>
        </div>
        {isLoading ? (
          <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
        ) : installed ? (
          <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-green-500" />
        ) : (
          <AlertCircle className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
      </div>

      <div className="space-y-1.5 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">
            {t("settings.currentVersion")}
          </span>
          <span
            className="min-w-0 truncate font-mono text-foreground"
            title={statusText}
          >
            {isLoading ? t("common.loading") : statusText}
          </span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="shrink-0 text-muted-foreground">
            {t("settings.buildVersion")}
          </span>
          <span className="min-w-0 truncate font-mono text-foreground">
            {isLoading ? t("common.loading") : report?.build_version || "—"}
          </span>
        </div>
      </div>
    </div>
  );
}
