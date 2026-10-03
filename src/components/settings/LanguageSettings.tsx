import { CapsuleControl } from "@/components/ui/capsule";
import { useTranslation } from "react-i18next";
import { Languages } from "lucide-react";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

type LanguageOption = "zh" | "zh-TW" | "en" | "ja";

interface LanguageSettingsProps {
  value: LanguageOption;
  onChange: (value: LanguageOption) => void;
}

export function LanguageSettings({ value, onChange }: LanguageSettingsProps) {
  const { t } = useTranslation();

  return (
    <section className="settings-section space-y-3">
      <SettingsSectionHeader
        title={t("settings.language")}
        icon={<Languages />}
      />
      <CapsuleControl
        value={value}
        onChange={onChange}
        label={t("settings.language")}
        optionClassName="min-w-[64px] sm:min-w-[96px]"
        options={[
          { value: "zh", label: t("settings.languageOptionChinese") },
          {
            value: "zh-TW",
            label: t("settings.languageOptionTraditionalChinese"),
          },
          { value: "en", label: t("settings.languageOptionEnglish") },
          { value: "ja", label: t("settings.languageOptionJapanese") },
        ]}
      />
    </section>
  );
}
