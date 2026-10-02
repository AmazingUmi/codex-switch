import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { FolderSearch, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { settingsApi } from "@/lib/api/settings";
import { codexUsageSourceQueryKey, usageApi } from "@/lib/api/usage";
import { Button } from "@/components/ui/button";
import { HelpButton } from "@/components/ui/help-button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface UsageSessionSourceDialogProps {
  value?: string;
  onSave: (next?: string) => Promise<boolean>;
  onClose: () => void;
}

export function UsageSessionSourceDialog({
  value,
  onSave,
  onClose,
}: UsageSessionSourceDialogProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  // Initialize only on mount: a failed optimistic settings save must not erase
  // this draft when the parent restores the previous persisted value.
  const [draft, setDraft] = useState(value ?? "");
  const [saving, setSaving] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string>();
  const source = useQuery({
    queryKey: codexUsageSourceQueryKey,
    queryFn: usageApi.getCodexUsageSource,
    retry: false,
    staleTime: 0,
  });
  const busy = saving || browsing;

  const browse = async () => {
    setBrowsing(true);
    setError(undefined);
    try {
      const selected = await settingsApi.pickDirectory(
        draft.trim() || source.data?.directory,
      );
      if (selected !== null) setDraft(selected);
    } catch {
      setError(
        t("usage.sessionSource.browseFailed", "Unable to choose a folder."),
      );
    } finally {
      setBrowsing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const saved = await onSave(draft.trim() || undefined);
      if (!saved) {
        setError(
          t(
            "usage.sessionSource.saveFailed",
            "Unable to save the session source. Your draft is still here.",
          ),
        );
        return;
      }
    } catch {
      setError(
        t(
          "usage.sessionSource.saveFailed",
          "Unable to save the session source. Your draft is still here.",
        ),
      );
      return;
    } finally {
      setSaving(false);
    }
    // This refresh only reads the effective source. Scanning is an explicit
    // separate action, so a scan failure cannot look like a settings rollback.
    void queryClient.invalidateQueries({ queryKey: codexUsageSourceQueryKey });
    toast.success(
      t(
        "usage.sessionSource.saved",
        "Session source saved. Use Sync now to scan the selected source.",
      ),
    );
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t("usage.sessionSource.title", "Session token source")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(
              "usage.sessionSource.description",
              "Choose the Codex root containing sessions and archived_sessions. This affects only token usage scanning; account configuration and sign-in files use their own directory. Leave blank to use the default.",
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto px-6 py-5">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <label htmlFor={inputId} className="text-sm font-medium">
                {t("usage.sessionSource.directory", "Codex root directory")}
              </label>
              <HelpButton
                label={t(
                  "usage.sessionSource.help",
                  "About the session source",
                )}
              >
                {t(
                  "usage.sessionSource.description",
                  "Choose the Codex root containing sessions and archived_sessions. This affects only token usage scanning; account configuration and sign-in files use their own directory. Leave blank to use the default.",
                )}
              </HelpButton>
            </div>
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                id={inputId}
                value={draft}
                disabled={busy}
                placeholder={
                  source.data?.defaultDirectory ??
                  t("usage.sessionSource.placeholder", "Default Codex root")
                }
                onChange={(event) => setDraft(event.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={busy}
                onClick={() => void browse()}
                aria-label={t("usage.sessionSource.browse", "Choose folder")}
              >
                {browsing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <FolderSearch className="h-4 w-4" />
                )}
              </Button>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft("");
                setError(undefined);
              }}
            >
              {t("usage.sessionSource.reset", "Restore default")}
            </Button>
          </div>
          {source.data && (
            <dl className="space-y-3 rounded-lg bg-muted/40 p-3 text-xs">
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.sessionSource.current", "Currently saved source")}
                </dt>
                <dd className="mt-1 break-all font-mono">
                  {source.data.directory}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("usage.sessionSource.default", "Default source")}
                </dt>
                <dd className="mt-1 break-all font-mono">
                  {source.data.defaultDirectory}
                </dd>
              </div>
            </dl>
          )}
          {source.isPending && (
            <p role="status" className="text-xs text-muted-foreground">
              {t("usage.sessionSource.loading", "Loading session source…")}
            </p>
          )}
          {source.isError && (
            <div className="flex items-center justify-between gap-2">
              <p role="alert" className="text-xs text-destructive">
                {t(
                  "usage.sessionSource.loadFailed",
                  "Unable to read the effective session source.",
                )}
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={source.isFetching || busy}
                onClick={() => void source.refetch()}
              >
                {t("usage.sessionSource.retry", "Retry")}
              </Button>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {t("usage.sessionSource.cancel", "Cancel")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void save()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t("usage.sessionSource.save", "Save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
