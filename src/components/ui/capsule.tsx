import * as React from "react";
import { cn } from "@/lib/utils";

const selectedOption =
  '.capsule-option[data-state="active"], .capsule-option[aria-selected="true"], .capsule-option[aria-pressed="true"]';

/** Shared moving selection, measured against the bar rather than fixed labels. */
export function useCapsuleSelection(
  containerRef: React.RefObject<HTMLElement>,
) {
  const [position, setPosition] = React.useState({ left: 0, width: 0 });

  React.useLayoutEffect(() => {
    const bar = containerRef.current;
    if (!bar) return;

    const measure = () => {
      const option = bar.querySelector<HTMLElement>(selectedOption);
      let left = 0;
      let element = option;
      while (element && element !== bar) {
        left += element.offsetLeft;
        element = element.offsetParent as HTMLElement | null;
      }
      const width = option?.offsetWidth ?? 0;
      setPosition((previous) =>
        previous.left === left && previous.width === width
          ? previous
          : { left, width },
      );
    };

    measure();
    const resize =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(measure);
    const observeOptions = () => {
      resize?.disconnect();
      resize?.observe(bar);
      bar.querySelectorAll<HTMLElement>(".capsule-option").forEach((option) => {
        resize?.observe(option);
      });
    };
    observeOptions();
    const mutations = new MutationObserver(() => {
      observeOptions();
      measure();
    });
    mutations.observe(bar, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-state", "aria-selected", "aria-pressed"],
    });
    window.addEventListener("resize", measure);
    return () => {
      resize?.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [containerRef]);

  return {
    width: position.width,
    transform: `translateX(${position.left}px)`,
    visibility: position.width > 0 ? "visible" : "hidden",
  } satisfies React.CSSProperties;
}

export function CapsuleSelection({ style }: { style: React.CSSProperties }) {
  return (
    <span className="capsule-selection" aria-hidden="true" style={style} />
  );
}

interface CapsuleControlProps<Value extends string> {
  value: Value;
  onChange: (value: Value) => void;
  label: string;
  options: readonly { value: Value; label: React.ReactNode }[];
  className?: string;
  optionClassName?: string;
}

export function CapsuleControl<Value extends string>({
  value,
  onChange,
  label,
  options,
  className,
  optionClassName,
}: CapsuleControlProps<Value>) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const selectionStyle = useCapsuleSelection(barRef);
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([]);

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    let next: number;
    switch (event.key) {
      case "ArrowLeft":
        next = (index + options.length - 1) % options.length;
        break;
      case "ArrowRight":
        next = (index + 1) % options.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = options.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      ref={barRef}
      role="group"
      aria-label={label}
      className={cn("capsule-bar", className)}
    >
      <CapsuleSelection style={selectionStyle} />
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          className={cn(
            "capsule-option inline-flex items-center justify-center whitespace-nowrap gap-1.5 px-3 text-sm font-medium",
            optionClassName,
          )}
          aria-pressed={value === option.value}
          tabIndex={value === option.value ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => handleKeyDown(event, index)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
