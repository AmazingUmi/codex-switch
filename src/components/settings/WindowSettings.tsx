import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import type { SettingsFormState } from "@/hooks/useSettings";
import { AppWindow, Power, EyeOff } from "lucide-react";
import { HelpButton } from "@/components/ui/help-button";
import { CapsuleControl } from "@/components/ui/capsule";
import { SettingsSectionHeader } from "./SettingsSectionHeader";
import { AnimatePresence, motion } from "framer-motion";
import { isLinux } from "@/lib/platform";

interface WindowSettingsProps {
  settings: SettingsFormState;
  onChange: (updates: Partial<SettingsFormState>) => void;
}

function WindowBehaviorControl({
  icon,
  title,
  help,
  checked,
  onCheckedChange,
}: {
  icon: ReactNode;
  title: string;
  help?: ReactNode;
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="min-w-0 max-w-full space-y-2">
      <div className="flex min-h-7 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground" aria-hidden="true">
          {icon}
        </span>
        <p className="settings-field-label min-w-0">{title}</p>
        {help}
      </div>
      <CapsuleControl
        label={title}
        value={checked ? "on" : "off"}
        onChange={(value) => {
          if ((value === "on") !== checked) onCheckedChange(value === "on");
        }}
        optionClassName="min-w-[64px]"
        options={[
          { value: "off", label: t("settings.toggleOff") },
          { value: "on", label: t("settings.toggleOn") },
        ]}
      />
    </div>
  );
}

export function WindowSettings({ settings, onChange }: WindowSettingsProps) {
  const { t } = useTranslation();

  return (
    <section className="settings-section space-y-3">
      <SettingsSectionHeader
        title={t("settings.windowBehavior")}
        icon={<AppWindow />}
      />

      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <WindowBehaviorControl
          icon={<Power className="h-3.5 w-3.5" />}
          title={t("settings.launchOnStartup")}
          checked={!!settings.launchOnStartup}
          onCheckedChange={(value) => onChange({ launchOnStartup: value })}
        />

        <AnimatePresence initial={false}>
          {settings.launchOnStartup && (
            <motion.div
              key="silent-startup"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.3 }}
              className="min-w-0 max-w-full"
            >
              <WindowBehaviorControl
                icon={<EyeOff className="h-3.5 w-3.5" />}
                title={t("settings.silentStartup")}
                help={
                  <HelpButton label={t("settings.silentStartup")}>
                    {t("settings.silentStartupDescription")}
                  </HelpButton>
                }
                checked={!!settings.silentStartup}
                onCheckedChange={(value) => onChange({ silentStartup: value })}
              />
            </motion.div>
          )}
        </AnimatePresence>

        <WindowBehaviorControl
          icon={<AppWindow className="h-3.5 w-3.5" />}
          title={t("settings.minimizeToTray")}
          help={
            <HelpButton label={t("settings.minimizeToTray")}>
              {t("settings.minimizeToTrayDescription")}
            </HelpButton>
          }
          checked={settings.minimizeToTrayOnClose}
          onCheckedChange={(value) =>
            onChange({ minimizeToTrayOnClose: value })
          }
        />

        {isLinux() && (
          <WindowBehaviorControl
            icon={<AppWindow className="h-3.5 w-3.5" />}
            title={t("settings.useAppWindowControls")}
            help={
              <HelpButton label={t("settings.useAppWindowControls")}>
                {t("settings.useAppWindowControlsDescription")}
              </HelpButton>
            }
            checked={!!settings.useAppWindowControls}
            onCheckedChange={(value) =>
              onChange({ useAppWindowControls: value })
            }
          />
        )}
      </div>
    </section>
  );
}
