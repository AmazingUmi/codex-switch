import { useId, useMemo } from "react";
import { FolderSearch, Undo2 } from "lucide-react";
import { HelpButton } from "@/components/ui/help-button";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import type { AppId } from "@/lib/api";
import type { ResolvedDirectories } from "@/hooks/useSettings";

type DirectoryAppId = Exclude<AppId, "claude-desktop" | "mcode">;

interface DirectorySettingsProps {
  appConfigDir?: string;
  resolvedDirs: ResolvedDirectories;
  onAppConfigChange: (value?: string) => void;
  onBrowseAppConfig: () => Promise<void>;
  onResetAppConfig: () => Promise<void>;
  codexDir?: string;
  onDirectoryChange: (app: DirectoryAppId, value?: string) => void;
  onBrowseDirectory: (app: DirectoryAppId) => Promise<void>;
  onResetDirectory: (app: DirectoryAppId) => Promise<void>;
}

export function DirectorySettings({
  appConfigDir,
  resolvedDirs,
  onAppConfigChange,
  onBrowseAppConfig,
  onResetAppConfig,
  codexDir,
  onDirectoryChange,
  onBrowseDirectory,
  onResetDirectory,
}: DirectorySettingsProps) {
  const { t } = useTranslation();
  const appDirectoryId = useId();

  return (
    <div className="space-y-6">
      {/* Codex Switch 配置目录 - 独立区块 */}
      <section className="space-y-4">
        <header className="flex items-center gap-2">
          <label htmlFor={appDirectoryId} className="text-sm font-medium">
            {t("settings.appConfigDir")}
          </label>
          <HelpButton label={t("settings.appConfigDir")}>
            {t("settings.appConfigDirDescription")}
          </HelpButton>
        </header>

        <div className="flex items-center gap-2">
          <Input
            id={appDirectoryId}
            value={appConfigDir ?? resolvedDirs.appConfig ?? ""}
            placeholder={t("settings.browsePlaceholderApp")}
            className="text-xs"
            onChange={(event) => onAppConfigChange(event.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onBrowseAppConfig}
            title={t("settings.browseDirectory")}
          >
            <FolderSearch className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={onResetAppConfig}
            title={t("settings.resetDefault")}
          >
            <Undo2 className="h-4 w-4" />
          </Button>
        </div>
      </section>

      {/* Codex 配置目录 - 独立区块 */}
      <section className="space-y-4">
        <DirectoryInput
          label={t("settings.codexConfigDir")}
          description={t("productShell.settings.codexDirectoryDescription", {
            defaultValue:
              "Override the Codex configuration directory, including paths in WSL.",
          })}
          value={codexDir}
          resolvedValue={resolvedDirs.codex}
          placeholder={t("settings.browsePlaceholderCodex")}
          onChange={(val) => onDirectoryChange("codex", val)}
          onBrowse={() => onBrowseDirectory("codex")}
          onReset={() => onResetDirectory("codex")}
        />
      </section>
    </div>
  );
}

interface DirectoryInputProps {
  label: string;
  description?: string;
  value?: string;
  resolvedValue: string;
  placeholder?: string;
  onChange: (value?: string) => void;
  onBrowse: () => Promise<void>;
  onReset: () => Promise<void>;
}

function DirectoryInput({
  label,
  description,
  value,
  resolvedValue,
  placeholder,
  onChange,
  onBrowse,
  onReset,
}: DirectoryInputProps) {
  const { t } = useTranslation();
  const inputId = useId();
  const displayValue = useMemo(
    () => value ?? resolvedValue ?? "",
    [value, resolvedValue],
  );

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <label
          htmlFor={inputId}
          className="text-sm font-medium text-foreground"
        >
          {label}
        </label>
        {description ? (
          <HelpButton label={label}>{description}</HelpButton>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={displayValue}
          placeholder={placeholder}
          className="text-xs"
          onChange={(event) => onChange(event.target.value)}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onBrowse}
          title={t("settings.browseDirectory")}
        >
          <FolderSearch className="h-4 w-4" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={onReset}
          title={t("settings.resetDefault")}
        >
          <Undo2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
