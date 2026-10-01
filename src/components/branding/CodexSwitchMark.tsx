import type { SVGProps } from "react";

/** Outlined Codex cloud and terminal prompt, matching the app and tray icons. */
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
      <g
        stroke="currentColor"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M28 9C35 5 43 8 46 15C54 14 60 22 56 31C61 39 56 49 47 49C43 58 32 61 25 54C15 58 7 50 10 41C3 34 5 23 14 20C13 12 21 6 28 9Z" />
        <path d="m23 24 5 8-5 8m12 0h9" />
      </g>
    </svg>
  );
}
