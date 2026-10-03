import { useEffect, useRef } from "react";
import { CodexOAuthSection } from "@/components/providers/forms/CodexOAuthSection";
import {
  CodexAccountsPanel,
  type CodexAccountsPanelProps,
} from "@/components/codex/CodexAccountsPanel";
import type { ManagedAuthProvider } from "@/lib/api";

interface AuthCenterPanelProps {
  authScrollTarget?: ManagedAuthProvider | null;
  accountPanelProps?: CodexAccountsPanelProps;
}

export function AuthCenterPanel({
  authScrollTarget,
  accountPanelProps,
}: AuthCenterPanelProps) {
  const codexOauthSectionRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (authScrollTarget !== "codex_oauth") return;

    const frame = requestAnimationFrame(() => {
      const prefersReducedMotion = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;

      codexOauthSectionRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? "auto" : "smooth",
        block: "start",
      });
    });

    return () => cancelAnimationFrame(frame);
  }, [authScrollTarget]);

  return (
    <div className="space-y-6">
      <section ref={codexOauthSectionRef} className="scroll-mt-4">
        {accountPanelProps ? (
          <CodexAccountsPanel {...accountPanelProps} showLogoutAll />
        ) : (
          <CodexOAuthSection showAccountQuota showLogoutAll />
        )}
      </section>
    </div>
  );
}
