import { useCallback, useRef, useState, useSyncExternalStore } from "react";
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
  const confirmedSelectionRevision = useRef(
    queryClient.getQueryState(["codex-active-selection"])?.dataUpdateCount ?? 0,
  );
  const subscribeToReadback = useCallback(
    (notify: () => void) =>
      queryClient.getQueryCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.query.queryKey.length === 1 &&
          event.query.queryKey[0] === "codex-active-selection" &&
          event.action.type === "success" &&
          !event.action.manual
        ) {
          confirmedSelectionRevision.current =
            event.query.state.dataUpdateCount;
          notify();
        }
      }),
    [queryClient],
  );
  const selectionRevision = useSyncExternalStore(
    subscribeToReadback,
    () => confirmedSelectionRevision.current,
    () => 0,
  );
  const [uncertainSince, setUncertainSince] = useState<number | null>(null);
  // Only a newer successful native readback can resolve an uncertain publication.
  // Optimistic cache updates and the initial cached selection cannot clear it.
  const isCurrentUncertain =
    uncertainSince !== null && selectionRevision <= uncertainSince;
  const mutation = useMutation({
    mutationFn: ({ accountId }: { accountId: string }) =>
      authSwitchCodexAccount(accountId),
    onSuccess: async (result) => {
      // The command has already committed. A failed readback is a refresh
      // problem; it must never be reported as a failed account switch.
      const reads = await Promise.allSettled([
        queryClient.invalidateQueries(
          { queryKey: ["codex-active-selection"] },
          { throwOnError: true },
        ),
        queryClient.invalidateQueries(
          { queryKey: ["managed-auth-status", "codex_oauth"] },
          { throwOnError: true },
        ),
      ]);
      void queryClient.invalidateQueries({ queryKey: ["providers", "codex"] });
      const readFailed = reads.some((read) => read.status === "rejected");
      setUncertainSince(readFailed ? confirmedSelectionRevision.current : null);
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
      if (uncertain) setUncertainSince(confirmedSelectionRevision.current);
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

  const switchAccount = (accountId: string): Promise<unknown> => {
    // The ref closes the gap before React renders the disabled buttons.
    if (inFlight.current) return inFlight.current;
    const request = mutation.mutateAsync({ accountId });
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
