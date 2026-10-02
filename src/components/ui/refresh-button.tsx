import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export function RefreshButton({
  label,
  loading,
  onRefresh,
}: {
  label: string;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      className="h-7 w-7 shrink-0 rounded-full"
      aria-label={label}
      title={label}
      aria-busy={loading}
      disabled={loading}
      onClick={(event) => {
        event.stopPropagation();
        onRefresh();
      }}
    >
      <RefreshCw
        className={`h-3.5 w-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
        aria-hidden="true"
      />
    </Button>
  );
}
