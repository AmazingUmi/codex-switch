import { Activity, ArrowRightLeft, Loader2, Pencil } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { CurrentStatus } from "@/components/ui/current-status";
import { cn } from "@/lib/utils";

interface ProviderActionsProps {
  appId?: "codex";
  isCurrent: boolean;
  isTesting?: boolean;
  switchDisabledReason?: string;
  onSwitch: () => void;
  onEdit: () => void;
  onTest?: () => void;
}

export function ProviderActions({
  isCurrent,
  isTesting,
  switchDisabledReason,
  onSwitch,
  onEdit,
  onTest,
}: ProviderActionsProps) {
  const { t } = useTranslation();
  const iconButtonClass = "h-7 w-7 shrink-0 rounded-full";
  const switchLabel = isCurrent
    ? t("provider.inUse")
    : t("provider.switchConnection", "切换到此连接");
  const switchDisabled = isCurrent || !!switchDisabledReason;
  const testLabel = t("provider.connectivityCheck", "检测连通");

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onTest}
        disabled={isTesting || !onTest}
        aria-label={testLabel}
        title={testLabel}
        className={iconButtonClass}
      >
        {isTesting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        ) : (
          <Activity className="h-3.5 w-3.5" aria-hidden="true" />
        )}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="outline"
        onClick={onEdit}
        aria-label={t("common.edit")}
        title={t("common.edit")}
        className={iconButtonClass}
      >
        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
      {isCurrent ? (
        <CurrentStatus label={switchLabel} />
      ) : (
        /* A wrapper keeps the explanation available for a disabled button. */
        <span
          title={switchDisabledReason || switchLabel}
          className={cn("inline-flex", switchDisabled && "cursor-not-allowed")}
        >
          <Button
            type="button"
            size="icon"
            variant="default"
            onClick={onSwitch}
            disabled={switchDisabled}
            aria-label={switchLabel}
            title={switchDisabledReason || switchLabel}
            className={iconButtonClass}
          >
            <ArrowRightLeft className="h-3.5 w-3.5" aria-hidden="true" />
          </Button>
        </span>
      )}
    </div>
  );
}
