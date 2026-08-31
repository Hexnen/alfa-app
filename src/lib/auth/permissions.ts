import type { User } from "../../db/schema.js";

// Poziom dostępu do pojedynczej podzakładki.
export type PermLevel = "none" | "view" | "edit";

// Mapa uprawnień zapisywana w users.permissions (JSON).
// Brak klucza = "none". Wartości tylko "view" | "edit".
export type PermissionMap = Record<string, "view" | "edit">;

// Pojedyncza podzakładka objęta kontrolą dostępu.
export interface TabDef {
  key: string; // stabilny identyfikator (== ścieżka SPA bez wiodącego "/")
  label: string; // etykieta w UI
  group: string; // nazwa grupy (moduł nadrzędny) do zestawienia w macierzy
}

// Kanoniczny katalog zakładek. MUSI być zsynchronizowany z odpowiednikiem
// na froncie (frontend/src/auth/permissions.ts) — te same klucze.
// Dashboard jest zawsze dostępny i celowo nie występuje tutaj.
export const TABS: TabDef[] = [
  // Zakładki najwyższego poziomu
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
  // Kadry
  { key: "kadry/wynagrodzenia", label: "Wynagrodzenia", group: "Kadry" },
  { key: "kadry/godziny", label: "Godziny", group: "Kadry" },
  // Pracownicy = kartoteka osób razem z ich umowami (dawna podzakładka
  // "kadry/umowy"); rozliczenie biura siedzi w Wynagrodzeniach.
  { key: "kadry/pracownicy", label: "Pracownicy", group: "Kadry" },
  { key: "kadry/obiekty", label: "Obiekty", group: "Kadry" },
  { key: "kadry/normy", label: "Normy", group: "Kadry" },
  // CMA
  { key: "cma/raporty", label: "Raporty", group: "CMA" },
  { key: "cma/trendy", label: "Trendy", group: "CMA" },
  { key: "cma/braki-kamer", label: "Braki kamer", group: "CMA" },
  // Mapowanie rejestru monitoringu na kartotekę obiektów. Własny klucz, bo to
  // ekran edycji powiązań, a nie kolejny raport — nadaje się osobno.
  { key: "cma/obiekty", label: "Obiekty", group: "CMA" },
  { key: "cma/ustawienia", label: "Ustawienia", group: "CMA" },
  // Techniczny
  { key: "technical/realizacje", label: "Realizacje", group: "Techniczny" },
  { key: "technical/protokoly", label: "Protokoły", group: "Techniczny" },
  { key: "technical/wyceny", label: "Wyceny", group: "Techniczny" },
  { key: "technical/cennik", label: "Cennik", group: "Techniczny" },
  // Usługi (montaż, uruchomienie, konfiguracja) — katalog z kosztem własnym,
  // z którego oferty biorą robociznę. Osobny od Cennika, który obsługuje
  // wyceny powykonawcze i nie zna kosztów.
  { key: "technical/uslugi", label: "Usługi", group: "Techniczny" },
  { key: "technical/oferty", label: "Oferty", group: "Techniczny" },
  /*
   * WYJĄTEK OD REGUŁY „klucz == ścieżka SPA": to nie jest zakładka, tylko
   * przełącznik widoczności KOSZTÓW I MARŻY na ofertach. Nadaje się osobno, bo
   * ofertę może składać ktoś, komu nie pokazujemy cen zakupu całego magazynu
   * ani zarobku na kliencie — tak samo, jak rozdzielono klucze w Analityce.
   *
   * Nie ma dla niego trasy ani wpisu w API_TAB_MAP; czyta go `redactCosts`
   * w src/routes/offers.ts, a front pomija go przy wyznaczaniu zakładki
   * z adresu (`tabKeyForPath`).
   */
  { key: "technical/oferty-koszty", label: "Oferty — koszty i marża", group: "Techniczny" },
  { key: "technical/technicy", label: "Technicy", group: "Techniczny" },
  { key: "technical/obiekty", label: "Obiekty", group: "Techniczny" },
  { key: "technical/projekty", label: "Projekty", group: "Techniczny" },
  { key: "technical/szablony", label: "Szablony", group: "Techniczny" },
  { key: "technical/magazyn", label: "Magazyn", group: "Techniczny" },
  { key: "technical/kalendarz", label: "Kalendarz", group: "Techniczny" },
  // OFI
  { key: "ofi", label: "OFI", group: "OFI" },
];

const TAB_KEYS = new Set(TABS.map((t) => t.key));

// Klucze zakładek, które zniknęły po scaleniu — mapowane na następcę, żeby
// zapisane uprawnienia użytkowników nie wyparowały przy odczycie. Gdy oba
// klucze mają wpis, wygrywa wyższy poziom.
const LEGACY_TAB_ALIASES: Record<string, string> = {
  // Umowy weszły do kartoteki pracownika…
  "kadry/umowy": "kadry/pracownicy",
  // …a rozliczenie biura pod wypłaty miesiąca.
  "kadry/biuro": "kadry/wynagrodzenia",
};

/** Wspólna normalizacja: filtr po katalogu zakładek + mapowanie starych kluczy. */
function normalizePermissions(entries: [string, unknown][]): PermissionMap {
  const out: PermissionMap = {};
  for (const [rawKey, v] of entries) {
    if (v !== "view" && v !== "edit") continue;
    const key = LEGACY_TAB_ALIASES[rawKey] ?? rawKey;
    if (!TAB_KEYS.has(key)) continue;
    if (out[key] === "edit") continue; // "edit" bije "view" przy scaleniu
    out[key] = v;
  }
  return out;
}

/** Bezpieczny parse mapy uprawnień z kolumny JSON. */
export function parsePermissions(raw: string | null | undefined): PermissionMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return {};
    return normalizePermissions(Object.entries(obj as Record<string, unknown>));
  } catch {
    return {};
  }
}

/** Normalizuje dowolny obiekt do poprawnej mapy uprawnień (do zapisu). */
export function sanitizePermissions(input: unknown): PermissionMap {
  if (typeof input !== "object" || input === null) return {};
  return normalizePermissions(Object.entries(input as Record<string, unknown>));
}

export function isAdmin(user: Pick<User, "role">): boolean {
  return user.role === "admin";
}

/** Efektywny poziom dostępu użytkownika do danej zakładki. */
export function levelFor(user: Pick<User, "role" | "permissions">, tabKey: string): PermLevel {
  if (isAdmin(user)) return "edit";
  const map = parsePermissions(user.permissions);
  return map[tabKey] ?? "none";
}

export function canView(user: Pick<User, "role" | "permissions">, tabKey: string): boolean {
  const l = levelFor(user, tabKey);
  return l === "view" || l === "edit";
}

export function canEdit(user: Pick<User, "role" | "permissions">, tabKey: string): boolean {
  return levelFor(user, tabKey) === "edit";
}

/** Najwyższy poziom dostępu wśród podanych zakładek (dla API dzielonego przez kilka podzakładek). */
export function maxLevel(
  user: Pick<User, "role" | "permissions">,
  tabKeys: string[]
): PermLevel {
  if (isAdmin(user)) return "edit";
  let best: PermLevel = "none";
  for (const k of tabKeys) {
    const l = levelFor(user, k);
    if (l === "edit") return "edit";
    if (l === "view") best = "view";
  }
  return best;
}
