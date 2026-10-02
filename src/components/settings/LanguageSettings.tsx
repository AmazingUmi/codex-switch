import { CapsuleControl } from "@/components/ui/capsule";
import { useTranslation } from "react-i18next";

type LanguageOption = "zh" | "zh-TW" | "en" | "ja";

interface LanguageSettingsProps {
  value: LanguageOption;
  onChange: (value: LanguageOption) => void;
}

export function LanguageSettings({ value, onChange }: LanguageSettingsProps) {
  const { t } = useTranslation();

  return (
    <section className="space-y-2">
      <header className="space-y-1">
        <h3 className="text-sm font-medium">{t("settings.language")}</h3>
      </header>
      <CapsuleControl
        value={value}
        onChange={onChange}
        label={t("settings.language")}
        optionClassName="min-w-[96px]"
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
