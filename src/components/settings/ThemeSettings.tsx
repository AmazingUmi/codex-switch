import { Monitor, Moon, Sun, Palette } from "lucide-react";
import { CapsuleControl } from "@/components/ui/capsule";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/components/theme-provider";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

export function ThemeSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <section className="settings-section space-y-3">
      <SettingsSectionHeader title={t("settings.theme")} icon={<Palette />} />
      <CapsuleControl
        value={theme}
        onChange={setTheme}
        label={t("settings.theme")}
        optionClassName="min-w-[80px] sm:min-w-[96px]"
        options={[
          {
            value: "light",
            label: (
              <>
                <Sun className="h-3.5 w-3.5" aria-hidden="true" />
                {t("settings.themeLight")}
              </>
            ),
          },
          {
            value: "dark",
            label: (
              <>
                <Moon className="h-3.5 w-3.5" aria-hidden="true" />
                {t("settings.themeDark")}
              </>
            ),
          },
          {
            value: "system",
            label: (
              <>
                <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                {t("settings.themeSystem")}
              </>
            ),
          },
        ]}
      />
    </section>
  );
}
