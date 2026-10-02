import { useEffect, useState } from "react";
import { Clock } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/utils/relativeTime";

export function QueryTimestamp({
  timestamp,
  label,
  className,
}: {
  timestamp?: number | null;
  label?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [now, setNow] = useState(Date.now);
  const validTime =
    typeof timestamp === "number" &&
    timestamp > 0 &&
    Number.isFinite(new Date(timestamp).getTime());

  useEffect(() => {
    if (label !== undefined || !validTime) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [label, timestamp, validTime]);

  return (
    <span
      className={cn(
        "flex items-center gap-1 whitespace-nowrap text-[10px] text-muted-foreground",
        className,
      )}
      title={validTime ? new Date(timestamp!).toLocaleString() : undefined}
    >
      <Clock size={10} aria-hidden="true" />
      {label ??
        (validTime
          ? formatRelativeTime(timestamp!, now, t)
          : t("usage.never", { defaultValue: "从未更新" }))}
    </span>
  );
}
