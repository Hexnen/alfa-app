import type { LucideIcon } from "lucide-react";

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** `true` = trafienie tylko przy dokładnym dopasowaniu ścieżki (pozycja „Dziś”). */
  end?: boolean;
  /** Dodatkowe trasy podświetlające tę pozycję (np. „/technik/co-nowego” → „Więcej”). */
  match?: RegExp;
  /** Licznik nad ikoną (0 / undefined = brak plakietki). */
  badge?: number;
  /** Żółta plakietka: od ostatniego zajrzenia coś w tej zakładce się zmieniło. */
  badgeAlert?: boolean;
}

/**
 * Czy pozycja nawigacji jest aktywna: routerowe dopasowanie ścieżki ALBO
 * własne `match` dla tras, które mieszkają pod inną zakładką. Bez tego drugiego
 * „Co nowego” nie podświetlałoby niczego i technik traciłby poczucie, gdzie jest.
 */
export function isNavActive(item: NavItem, pathname: string, routerActive: boolean): boolean {
  return routerActive || (item.match?.test(pathname) ?? false);
}
