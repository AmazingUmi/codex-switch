import { useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { exit } from "@tauri-apps/plugin-process";
import { AlertTriangle, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DatabaseUpgradeProps {
  payload: {
    path?: string;
    error?: string;
    kind?: string;
    db_version?: number;
    supported_version?: number;
  };
}

/** Recovery is manual until this fork has its own compatible update channel. */
export function DatabaseUpgrade({ payload }: DatabaseUpgradeProps) {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg space-y-5 rounded-2xl border border-border/60 bg-card/80 p-7 shadow-xl">
        <div className="flex items-start gap-4">
          <AlertTriangle
            className="h-8 w-8 shrink-0 text-amber-500"
            aria-hidden="true"
          />
          <div className="space-y-2">
            <h1 className="text-lg font-semibold">{t("dbUpgrade.title")}</h1>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {t("dbUpgrade.localBuildRecovery")}
            </p>
            {payload.db_version != null &&
              payload.supported_version != null && (
                <p className="text-xs tabular-nums text-muted-foreground">
                  {t("dbUpgrade.versionInfo", {
                    db: payload.db_version,
                    supported: payload.supported_version,
                  })}
                </p>
              )}
          </div>
        </div>
        {(payload.error || payload.path) && (
          <div className="space-y-1 rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            {payload.error && (
              <p className="break-words font-mono">{payload.error}</p>
            )}
            {payload.path && (
              <p className="break-all">
                {t("dbUpgrade.dbPath")}: {payload.path}
              </p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await invoke("open_app_config_folder");
              } catch (cause) {
                setError(
                  cause instanceof Error ? cause.message : String(cause),
                );
              }
            }}
          >
            <FolderOpen className="h-4 w-4" aria-hidden="true" />
            {t("dbUpgrade.openConfigDir")}
          </Button>
          <Button
            variant="ghost"
            className="ml-auto"
            onClick={() => void exit(0)}
          >
            {t("dbUpgrade.quit")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default DatabaseUpgrade;
