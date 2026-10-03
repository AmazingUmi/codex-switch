import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface HelpButtonProps {
  label: string;
  children: ReactNode;
  className?: string;
  align?: "start" | "center" | "end";
}

/** Preview on hover/focus; click keeps the explanation open until dismissed. */
export function HelpButton({
  label,
  children,
  className,
  align = "start",
}: HelpButtonProps) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout>>();

  const cancelClose = () => {
    clearTimeout(closeTimer.current);
  };

  useEffect(() => () => clearTimeout(closeTimer.current), []);

  const preview = () => {
    cancelClose();
    setOpen(true);
  };

  const closePreview = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!pinned.current && document.activeElement !== triggerRef.current) {
        setOpen(false);
      }
    }, 150);
  };

  const dismiss = (nextOpen: boolean) => {
    cancelClose();
    if (!nextOpen) pinned.current = false;
    setOpen(nextOpen);
  };

  return (
    <Popover open={open} onOpenChange={dismiss}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            "h-7 w-7 shrink-0 rounded-full text-muted-foreground",
            className,
          )}
          aria-label={label}
          onPointerEnter={preview}
          onPointerLeave={closePreview}
          onFocus={preview}
          onBlur={closePreview}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            cancelClose();
            pinned.current = !pinned.current;
            setOpen(pinned.current);
          }}
        >
          <CircleHelp className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        className="max-h-[min(24rem,70vh)] w-80 max-w-[calc(100vw-2rem)] space-y-3 overflow-y-auto rounded-xl border border-border-default p-4 text-xs leading-relaxed shadow-lg"
        aria-label={label}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerEnter={cancelClose}
        onPointerLeave={closePreview}
        onFocusCapture={cancelClose}
        onBlurCapture={closePreview}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
