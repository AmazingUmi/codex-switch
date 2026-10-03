import { KeyRound, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function AddCodexConnectionDialog({
  open,
  onOpenChange,
  onLogin,
  onAddApiKey,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onLogin: () => void;
  onAddApiKey: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md overflow-hidden"
        zIndex="nested"
      >
        <DialogHeader>
          <DialogTitle>
            {t("codexAccounts.addTitle", "添加账号或连接")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "codexAccounts.addDescription",
              "选择使用 ChatGPT 账号或 API Key 连接 Codex。",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-6 py-5">
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start gap-3 whitespace-normal px-5 py-4 text-left"
            onClick={onLogin}
          >
            <Users className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-medium">
                {t("codexAccounts.addChatGpt", "ChatGPT 登录")}
              </span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {t(
                  "codexAccounts.addChatGptDescription",
                  "登录后查看订阅额度，并在多个账号之间切换。",
                )}
              </span>
            </span>
          </Button>
          <Button
            type="button"
            variant="outline"
            className="h-auto w-full justify-start gap-3 whitespace-normal px-5 py-4 text-left"
            onClick={onAddApiKey}
          >
            <KeyRound className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span>
              <span className="block font-medium">
                {t("codexAccounts.addApiKey", "API Key 连接")}
              </span>
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                {t(
                  "codexAccounts.addApiKeyDescription",
                  "填写 API Key 和服务地址，连接 OpenAI 或其他支持的服务。",
                )}
              </span>
            </span>
          </Button>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
