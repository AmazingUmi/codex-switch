import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Briefcase,
  Code2,
  Heart,
  Loader2,
  Shield,
  RefreshCw,
  Trash2,
  Star,
  User,
} from "lucide-react";
import type { ManagedAuthAccount } from "@/lib/api/auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HelpButton } from "@/components/ui/help-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type CodexAccountAppearance = {
  display_name: string | null;
  notes: string | null;
  icon: string | null;
  color: string | null;
};

const accountIcons = {
  user: User,
  star: Star,
  briefcase: Briefcase,
  code: Code2,
  heart: Heart,
  shield: Shield,
};
const safeColor = (color?: string | null) =>
  color && /^#[0-9a-f]{6}$/i.test(color) ? color : undefined;

export function CodexAccountIcon({ account }: { account: ManagedAuthAccount }) {
  const Icon = accountIcons[account.icon as keyof typeof accountIcons] ?? User;
  return (
    <Icon
      className="h-5 w-5 shrink-0 text-muted-foreground"
      style={{ color: safeColor(account.color) }}
      aria-hidden="true"
    />
  );
}

export function EditCodexAccountDialog({
  account,
  onClose,
  onSave,
  isDefault = false,
  isReauthenticating = false,
  isRemoving = false,
  isSettingDefault = false,
  actionError,
  onReauthenticate,
  onSetDefault,
  onRemove,
  accountOptions,
}: {
  account: ManagedAuthAccount;
  onClose: () => void;
  isDefault?: boolean;
  isReauthenticating?: boolean;
  isRemoving?: boolean;
  isSettingDefault?: boolean;
  actionError?: string | null;
  onReauthenticate?: () => void;
  onSetDefault?: () => void;
  onRemove?: () => void;
  accountOptions?: ReactNode;
  onSave: (
    accountId: string,
    appearance: CodexAccountAppearance,
  ) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const [displayName, setDisplayName] = useState(account.display_name ?? "");
  const [notes, setNotes] = useState(account.notes ?? "");
  const [icon, setIcon] = useState(account.icon ?? "user");
  const [color, setColor] = useState(safeColor(account.color) ?? "#6366f1");
  const [useColor, setUseColor] = useState(!!safeColor(account.color));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await onSave(account.id, {
        display_name: displayName.trim() || null,
        notes: notes.trim() || null,
        icon: icon || null,
        color: useColor ? color : null,
      });
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-2rem)] max-w-md overflow-hidden"
        zIndex="nested"
      >
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => void submit(event)}
        >
          <DialogHeader>
            <DialogTitle>
              {t("codexAccounts.editTitle", "编辑账号")}
            </DialogTitle>
            <DialogDescription>
              {t("codexAccounts.editDescription", "管理账号信息和登录选项。")}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 space-y-4 overflow-y-auto px-6 py-4">
            <div className="space-y-1.5">
              <Label htmlFor="codex-account-identity">
                {t("codexAccounts.loginIdentity", "登录身份")}
              </Label>
              <Input
                id="codex-account-identity"
                value={account.login}
                readOnly
                aria-readonly="true"
                className="bg-muted/40 text-muted-foreground"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="codex-account-display-name">
                {t("codexAccounts.displayName", "显示名称")}
              </Label>
              <Input
                id="codex-account-display-name"
                value={displayName}
                placeholder={account.login}
                maxLength={120}
                disabled={saving}
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="codex-account-notes">
                {t("codexAccounts.notes", "备注")}
              </Label>
              <textarea
                id="codex-account-notes"
                value={notes}
                maxLength={1000}
                rows={3}
                disabled={saving}
                onChange={(event) => setNotes(event.target.value)}
                className="w-full resize-y rounded-md border border-border-default bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <fieldset className="space-y-2" disabled={saving}>
              <legend className="text-sm font-medium">
                {t("codexAccounts.icon", "图标")}
              </legend>
              <div className="flex flex-wrap gap-2">
                {Object.entries(accountIcons).map(([key, Icon]) => (
                  <Button
                    key={key}
                    type="button"
                    size="icon"
                    variant={icon === key ? "default" : "outline"}
                    className="h-9 w-9"
                    aria-pressed={icon === key}
                    aria-label={t(`codexAccounts.icons.${key}`, key)}
                    onClick={() => setIcon(key)}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </Button>
                ))}
              </div>
            </fieldset>
            <div className="flex items-center gap-3">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={useColor}
                  disabled={saving}
                  onChange={(event) => setUseColor(event.target.checked)}
                />
                {t("codexAccounts.customColor", "自定义颜色")}
              </label>
              <input
                type="color"
                value={color}
                disabled={saving || !useColor}
                aria-label={t("codexAccounts.color", "颜色")}
                onChange={(event) => setColor(event.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border bg-background p-1 disabled:opacity-50"
              />
            </div>
            {accountOptions && (
              <fieldset
                disabled={
                  saving || isRemoving || isSettingDefault || isReauthenticating
                }
              >
                {accountOptions}
              </fieldset>
            )}
            <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
              {onReauthenticate && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={
                    saving ||
                    isReauthenticating ||
                    isRemoving ||
                    isSettingDefault
                  }
                  onClick={onReauthenticate}
                >
                  <RefreshCw
                    className="mr-1.5 h-3.5 w-3.5"
                    aria-hidden="true"
                  />
                  {t("codexOauth.reauthLogin", "重新登录")}
                </Button>
              )}
              {isDefault ? (
                <span className="text-xs text-muted-foreground">
                  {t("codexOauth.defaultAccount", "默认")}
                </span>
              ) : (
                onSetDefault && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving || isSettingDefault || isRemoving}
                    onClick={onSetDefault}
                  >
                    <Star className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                    {t("codexOauth.setAsDefault", "设为默认")}
                  </Button>
                )
              )}
              {onRemove && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="text-destructive"
                  disabled={
                    saving ||
                    isRemoving ||
                    isSettingDefault ||
                    isReauthenticating
                  }
                  onClick={onRemove}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
                  {t("codexOauth.removeAccount", "移除账号")}
                </Button>
              )}
              <HelpButton
                label={t("codexAccounts.accountHelpLabel", "账号说明")}
              >
                <p>
                  {t(
                    "codexAccounts.directSwitchHelp",
                    "登录后的 ChatGPT 账号可以直接切换。默认账号仅供高级托管配置使用，与当前使用的账号无关。",
                  )}
                </p>
                <p>
                  {t(
                    "codexAccounts.credentialStoreHelp",
                    "部分高级登录存储设置暂不支持账号切换。无法切换时，应用会说明具体原因。",
                  )}
                </p>
              </HelpButton>
            </div>
            {actionError && (
              <p role="alert" className="break-words text-sm text-destructive">
                {actionError}
              </p>
            )}
            {error && (
              <p role="alert" className="break-words text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={onClose}
            >
              {t("common.cancel", "取消")}
            </Button>
            <Button
              type="submit"
              disabled={
                saving || isRemoving || isSettingDefault || isReauthenticating
              }
            >
              {saving && (
                <Loader2
                  className="mr-2 h-4 w-4 animate-spin"
                  aria-hidden="true"
                />
              )}
              {t("common.save", "保存")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
