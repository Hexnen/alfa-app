import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { usePerms } from "@/auth/permissions";

/**
 * Link do innego modułu, który znika (zostaje zwykły tekst), gdy użytkownik nie
 * ma klucza docelowej zakładki. Bez tego kliknięcie kończyło się cichym
 * przerzuceniem na Dashboard przez `AccessGuard` (docs/AUDYT-UPRAWNIEN-B.md #10).
 */
export function PermLink({
  to,
  tab,
  className,
  children,
  ...rest
}: {
  to: string;
  /** Klucz zakładki, którą otwiera `to` (np. „objects”). */
  tab: string;
  className?: string;
  children: ReactNode;
  "data-testid"?: string;
}) {
  const { canView } = usePerms();
  if (!canView(tab)) {
    return (
      <span className={className?.replace(/\bhover:underline\b/g, "").trim()} data-testid={rest["data-testid"]}>
        {children}
      </span>
    );
  }
  return (
    <Link to={to} className={className} data-testid={rest["data-testid"]}>
      {children}
    </Link>
  );
}
