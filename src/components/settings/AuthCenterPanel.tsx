import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
          <CodexAccountsPanel {...accountPanelProps} />
        ) : (
          <CodexOAuthSection showAccountQuota />
        )}
        <details className="mt-4 text-xs text-muted-foreground">
          <summary className="cursor-pointer">
            {t("settings.authCenter.title", "账号与认证")}
          </summary>
          <p className="pt-2">
            {t(
              "codexAccounts.sharedAccountsHelp",
              "这里与主页共用同一份账号、编辑信息和登录状态。日常切换也可直接在主页完成。",
            )}
          </p>
        </details>
      </section>
    </div>
  );
}
