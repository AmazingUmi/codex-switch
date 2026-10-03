import type { ReactNode } from "react";

interface SettingsSectionHeaderProps {
  title: string;
  icon: ReactNode;
  help?: ReactNode;
}

export function SettingsSectionHeader({
  title,
  icon,
  help,
}: SettingsSectionHeaderProps) {
  return (
    <header className="settings-section-heading">
      <span className="settings-section-icon" aria-hidden="true">
        {icon}
      </span>
      <h3 className="settings-section-title">{title}</h3>
      {help}
    </header>
  );
}
