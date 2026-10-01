import type { SVGProps } from "react";

/** Original terminal prompt mark shared by the app shell and app icon. */
export function CodexSwitchMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="2" y="2" width="60" height="60" rx="15" fill="currentColor" />
      <path
        d="m17 21 12 11-12 11m19 0h11"
        stroke="var(--codex-mark-foreground, #fafafa)"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
