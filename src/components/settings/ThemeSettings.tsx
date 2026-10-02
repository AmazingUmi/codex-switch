import { Monitor, Moon, Sun } from "lucide-react";
import { CapsuleControl } from "@/components/ui/capsule";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/components/theme-provider";

export function ThemeSettings() {
  const { t } = useTranslation();
  const { theme, setTheme } = useTheme();

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">{t("settings.theme")}</h3>
      </header>
      <CapsuleControl
        value={theme}
        onChange={setTheme}
        label={t("settings.theme")}
        optionClassName="min-w-[96px]"
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
