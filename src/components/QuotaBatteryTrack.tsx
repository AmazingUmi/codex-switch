import { forwardRef, type CSSProperties, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

interface QuotaBatteryTrackProps extends HTMLAttributes<HTMLDivElement> {
  charged: boolean;
}

/** Shared battery geometry for account quota and the threshold editor. */
export const QuotaBatteryTrack = forwardRef<
  HTMLDivElement,
  QuotaBatteryTrackProps
>(function QuotaBatteryTrack({ charged, children, className, ...props }, ref) {
  return (
    <div ref={ref} className={cn("codex-battery-track", className)} {...props}>
      <div className="codex-battery-cells" aria-hidden="true">
        {Array.from({ length: 28 }, (_, index) => (
          <span
            key={index}
            className="codex-battery-cell"
            style={{ "--codex-quota-cell": index } as CSSProperties}
          >
            {charged && <span className="codex-battery-fill" />}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
});
