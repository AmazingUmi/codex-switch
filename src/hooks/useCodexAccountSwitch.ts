import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { authSwitchCodexAccount } from "@/lib/api/auth";
import { extractErrorMessage } from "@/utils/errorUtils";

/** Home and Authentication share the committed native switch and query state. */
export function useCodexAccountSwitch() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const inFlight = useRef<Promise<unknown> | null>(null);
  const [isCurrentUncertain, setCurrentUncertain] = useState(false);
  const mutation = useMutation({
    mutationFn: ({
      accountId,
      providerId,
    }: {
      accountId: string;
      providerId?: string;
    }) => authSwitchCodexAccount(accountId, providerId),
    onSuccess: async (result) => {
      // The command has already committed. A failed readback is a refresh
      // problem; it must never be reported as a failed account switch.
      const reads = await Promise.allSettled([
        queryClient.invalidateQueries(
          { queryKey: ["providers", "codex"] },
          { throwOnError: true },
        ),
        queryClient.invalidateQueries(
          { queryKey: ["managed-auth-status", "codex_oauth"] },
          { throwOnError: true },
        ),
      ]);
      const readFailed = reads.some((read) => read.status === "rejected");
      setCurrentUncertain(readFailed);
      if (readFailed) {
        toast.warning(
          t(
            "codexAccounts.switchRefreshFailed",
            "账号已切换，状态刷新失败，请刷新后确认。",
          ),
        );
      } else {
        toast.success(
          t(
            "codexAccounts.switchSuccess",
            "账号已切换。已运行的 Codex 如仍显示旧账号，请重新打开。",
          ),
          { closeButton: true },
        );
      }
      if (result.warnings?.length) {
        const recovered = result.warnings.includes(
          "codex_account_switch_recovered",
        );
        const remainingWarnings = result.warnings.filter(
          (warning) => warning !== "codex_account_switch_recovered",
        );
        if (recovered)
          toast.warning(
            t(
              "codexAccounts.switchRecovered",
              "切换已完成，并已恢复中断的写入。",
            ),
            { closeButton: true },
          );
        if (remainingWarnings.length) {
          toast.warning(
            t("codexAccounts.switchWarning", {
              defaultValue: "账号已切换，配置保存提示：{{error}}",
              error: remainingWarnings.join("; "),
            }),
            { closeButton: true },
          );
        }
      }
    },
    onError: (error) => {
      const detail = extractErrorMessage(error) || t("common.unknown");
      const uncertain = detail.includes("codex_account_switch_uncertain");
      if (uncertain) setCurrentUncertain(true);
      toast.error(
        t(
          uncertain
            ? "codexAccounts.switchUncertain"
            : "codexAccounts.switchFailed",
          {
            defaultValue: uncertain
              ? "无法确认切换状态：{{error}}"
              : "切换失败，保留原账号：{{error}}",
            error: detail
              .replace("codex_account_switch_uncertain", "")
              .replace(/^[:\s]+/, ""),
          },
        ),
      );
    },
  });

  const switchAccount = (
    accountId: string,
    providerId?: string,
  ): Promise<unknown> => {
    // The ref closes the gap before React renders the disabled buttons.
    if (inFlight.current) return inFlight.current;
    const request = mutation.mutateAsync({ accountId, providerId });
    inFlight.current = request;
    void request
      .finally(() => {
        inFlight.current = null;
      })
      .catch(() => {});
    return request;
  };

  return { switchAccount, isSwitching: mutation.isPending, isCurrentUncertain };
}
