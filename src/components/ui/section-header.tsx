import type { ReactNode } from "react";

interface SectionHeaderProps {
  title: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
}

/** Shared heading and action alignment for the account sections. */
export function SectionHeader({ title, status, actions }: SectionHeaderProps) {
  return (
    <div className="section-heading">
      <div className="flex min-w-0 items-center gap-2">
        <h2 className="section-title">{title}</h2>
        {status}
      </div>
      {actions && <div className="section-actions">{actions}</div>}
    </div>
  );
}
