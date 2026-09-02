import { useAuth, type AuthUser } from "./AuthProvider";

export type PermLevel = "none" | "view" | "edit";
export type PermissionMap = Record<string, "view" | "edit">;

export interface TabDef {
  key: string;
  label: string;
  group: string;
}

// Kanoniczny katalog zakładek — MUSI być zsynchronizowany z backendem
// (src/lib/auth/permissions.ts). Te same klucze i etykiety.
export const TABS: TabDef[] = [
  { key: "contractors", label: "Kontrahenci", group: "Ogólne" },
  { key: "objects", label: "Obiekty", group: "Ogólne" },
  { key: "handlowcy", label: "Handlowcy", group: "Ogólne" },
  { key: "spolki", label: "Spółki", group: "Ogólne" },
  { key: "contracts", label: "Umowy", group: "Ogólne" },
  { key: "orders", label: "Zlecenia", group: "Ogólne" },
  // Analityka — widoki finansowe (przychód/koszt/zysk). Każda podzakładka ma
  // WŁASNY klucz, bo pokazują dane o różnej wrażliwości (rentowność klientów,
  // obiektów i wynagrodzenia handlowców) i nadaje się je nadawać osobno.
  { key: "analityka/kontrahenci", label: "Kontrahenci", group: "Analityka" },
  { key: "analityka/obiekty", label: "Obiekty", group: "Analityka" },
  { key: "analityka/handlowcy", label: "Handlowcy", group: "Analityka" },
  { key: "kadry/wynagrodzenia", label: "Wynagrodzenia", group: "Kadry" },
  { key: "kadry/godziny", label: "Godziny", group: "Kadry" },
  // Pracownicy = kartoteka osób razem z umowami (dawne "kadry/umowy");
  // biuro trafiło do Wynagrodzeń. Stare klucze mapuje backend.
  { key: "kadry/pracownicy", label: "Pracownicy", group: "Kadry" },
  { key: "kadry/obiekty", label: "Obiekty", group: "Kadry" },
  // Słownik działów firmy — osobny klucz od obiektów, bo to inny byt: godziny
  // działu są kosztem ogólnym, nie kosztem klienta.
  { key: "kadry/dzialy", label: "Działy", group: "Kadry" },
  { key: "kadry/normy", label: "Normy", group: "Kadry" },
  { key: "cma/raporty", label: "Raporty", group: "CMA" },
  { key: "cma/trendy", label: "Trendy", group: "CMA" },
  { key: "cma/braki-kamer", label: "Braki kamer", group: "CMA" },
  // Mapowanie rejestru monitoringu na kartotekę obiektów — osobny klucz, bo to
  // ekran edycji powiązań, a nie kolejny raport.
  { key: "cma/obiekty", label: "Obiekty", group: "CMA" },
  { key: "cma/ustawienia", label: "Ustawienia", group: "CMA" },
  { key: "technical/realizacje", label: "Realizacje", group: "Techniczny" },
  { key: "technical/protokoly", label: "Protokoły", group: "Techniczny" },
  { key: "technical/wyceny", label: "Wyceny", group: "Techniczny" },
  { key: "technical/cennik", label: "Cennik", group: "Techniczny" },
  // Lustro wpisów z src/lib/auth/permissions.ts — katalog usług i oferty.
  { key: "technical/uslugi", label: "Usługi", group: "Techniczny" },
  { key: "technical/oferty", label: "Oferty", group: "Techniczny" },
  // Nie zakładka, tylko przełącznik widoczności kosztów i marży na ofertach —
  // patrz komentarz przy odpowiedniku w backendzie. Celowo poza NAVIGABLE_KEYS.
  { key: "technical/oferty-koszty", label: "Oferty — koszty i marża", group: "Techniczny" },
  { key: "technical/technicy", label: "Technicy", group: "Techniczny" },
  { key: "technical/obiekty", label: "Obiekty", group: "Techniczny" },
  { key: "technical/magazyn", label: "Magazyn", group: "Techniczny" },
  { key: "technical/kalendarz", label: "Kalendarz", group: "Techniczny" },
  { key: "technical/projekty", label: "Projekty", group: "Techniczny" },
  { key: "technical/szablony", label: "Szablony", group: "Techniczny" },
  { key: "ofi", label: "OFI", group: "OFI" },
];

const TAB_KEY_SET = new Set(TABS.map((t) => t.key));

/**
 * Klucze, które NIE są ścieżkami SPA — uprawnienia doprecyzowujące widoczność
 * danych wewnątrz innej zakładki. Nie wolno po nich nawigować ani ich
 * dopasowywać do adresu, bo `AccessGuard` odesłałby użytkownika donikąd.
 */
const NON_NAVIGABLE_KEYS = new Set(["technical/oferty-koszty"]);

/**
 * Mapuje ścieżkę SPA na klucz zakładki. Ścieżki szczegółowe bez własnego
 * klucza (np. /orders/formularz, /objects/5) dziedziczą uprawnienie z
 * nadrzędnej zakładki. Zwraca null dla ścieżek nieobjętych katalogiem.
 */
export function tabKeyForPath(pathname: string): string | null {
  let key = pathname.replace(/^\//, "").split("?")[0];
  while (key) {
    if (TAB_KEY_SET.has(key) && !NON_NAVIGABLE_KEYS.has(key)) return key;
    const i = key.lastIndexOf("/");
    if (i < 0) break;
    key = key.slice(0, i);
  }
  return null;
}

export function levelFor(user: AuthUser | null, tabKey: string): PermLevel {
  if (!user) return "none";
  if (user.role === "admin") return "edit";
  const v = user.permissions?.[tabKey];
  return v === "edit" ? "edit" : v === "view" ? "view" : "none";
}

export function canView(user: AuthUser | null, tabKey: string): boolean {
  const l = levelFor(user, tabKey);
  return l === "view" || l === "edit";
}

export function canEdit(user: AuthUser | null, tabKey: string): boolean {
  return levelFor(user, tabKey) === "edit";
}

export interface Perms {
  user: AuthUser | null;
  isAdmin: boolean;
  level: (tabKey: string) => PermLevel;
  canView: (tabKey: string) => boolean;
  canEdit: (tabKey: string) => boolean;
}

/** Hook uprawnień dla komponentów. */
// eslint-disable-next-line react-refresh/only-export-components
export function usePerms(): Perms {
  const { user } = useAuth();
  return {
    user,
    isAdmin: user?.role === "admin",
    level: (k) => levelFor(user, k),
    canView: (k) => canView(user, k),
    canEdit: (k) => canEdit(user, k),
  };
}
