import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, getSessionUser } from "../lib/auth/sessions.js";
import type { User } from "../db/schema.js";
import { isAdmin, maxLevel, canEdit } from "../lib/auth/permissions.js";
import { resolveField } from "../lib/ai/assistantConfig.js";

/** Chroni trasy API: wymaga ważnej sesji i ustawia `user` w kontekście. */
export async function requireAuth(c: Context, next: Next) {
  const token = getCookie(c, SESSION_COOKIE);
  const user = getSessionUser(token);
  if (!user) {
    return c.json({ success: false, error: "Wymagane logowanie" }, 401);
  }
  c.set("user", user);
  return next();
}

/** Wymaga roli admina (po requireAuth). */
export async function requireAdmin(c: Context, next: Next) {
  const user = c.get("user") as User | undefined;
  if (!user || !isAdmin(user)) {
    return c.json({ success: false, error: "Wymagane uprawnienia administratora" }, 403);
  }
  return next();
}

/**
 * Czy użytkownik ma dostęp do Asystenta AI wg ustawienia `assistant.access`
 * (admins | calendar_editors = admin LUB edycja technical/kalendarz). Czytane przy każdym żądaniu.
 */
export function hasAssistantAccess(user: Pick<User, "role" | "permissions">): boolean {
  if (isAdmin(user)) return true;
  return resolveField("access").value === "calendar_editors" && canEdit(user, "technical/kalendarz");
}

/** Wymaga dostępu do asystenta (po requireAuth); GET /assistant/status jest poza tym strażnikiem. */
export async function requireAssistantAccess(c: Context, next: Next) {
  const user = c.get("user") as User | undefined;
  if (!user || !hasAssistantAccess(user)) {
    return c.json({ success: false, error: "Brak dostępu do asystenta" }, 403);
  }
  return next();
}

/** Zalogowany użytkownik z kontekstu (po requireAuth). */
export function getUser(c: Context): User {
  return c.get("user") as User;
}

export function getUserId(c: Context): number {
  return (c.get("user") as User).id;
}

// Mapowanie prefiksu API → podzakładki, które go używają. Kolejność ma
// znaczenie: dłuższe/bardziej szczegółowe prefiksy przed ogólnymi
// (np. "/cma/mail" przed "/cma"). Ścieżki nieobjęte tą listą (np. /stats,
// /history/recent, /company/office) są dostępne dla każdego zalogowanego
// użytkownika — każda z nich sama pilnuje, co pokazuje (patrz komentarze
// przy trasach).
//
// `writeTabs` (opcjonalne): gdy API dzieli kilka zakładek, bo inne moduły
// czytają z niego słownik (spółki w formularzu obiektu, handlowcy w formularzu
// kontrahenta), ODCZYT wolno z każdej wypisanej zakładki, ale ZAPIS wyłącznie
// z tych w `writeTabs`. Bez tego maxLevel() z „objects: edit" dawał prawo
// edycji spółek i handlowców komuś, kto ma edytować tylko obiekty.
const API_TAB_MAP: { prefix: string; tabs: string[]; writeTabs?: string[] }[] = [
  // Słownik kontrahentów do selecta (GET /contractors/catalog: id + nazwa + NIP).
  // MUSI stać PRZED szerszym "/contractors": find() bierze pierwsze dopasowanie,
  // a bez tego wpisu handlowiec z samymi kluczami `handlowy/*` dostawał 403
  // i nie mógł podpiąć szansy ani osoby kontaktowej pod istniejącą kartotekę.
  // Zapis dalej wyłącznie z „contractors" (na samym /catalog nie ma zresztą
  // żadnej trasy zapisu — writeTabs jest tu zabezpieczeniem na przyszłość).
  {
    prefix: "/contractors/catalog",
    tabs: [
      "contractors",
      "objects",
      "handlowy/leady",
      "handlowy/kontakty",
      "handlowy/kalendarz",
      "orders",
    ],
    writeTabs: ["contractors"],
  },
  { prefix: "/contractors", tabs: ["contractors"] },
  { prefix: "/objects", tabs: ["objects"] },
  // Historia zmian obiektu (stare/nowe wartości pól, w tym kwoty umów) — to
  // rekordy obiektów i kontrahentów, więc widzi ją ten, kto widzi obiekty.
  // /history/recent zostaje poza mapą (Dashboard) i sam zwraca pustą listę
  // bez tych uprawnień — 403 wywalałoby cały Dashboard w Promise.all.
  { prefix: "/history/object", tabs: ["objects", "contractors"] },
  // Dziennik aktywności obiektu — jak wyżej; globalny /activity/recent ma
  // własną bramkę (technical/kalendarz) w src/routes/activity.ts.
  { prefix: "/activity/object", tabs: ["objects"] },
  // Dojazd biuro → obiekt wołają tylko dialog i dymki kalendarza
  // (frontend/src/lib/travel.ts, Calendar.tsx). /company/office (znacznik
  // biura na mapie realizacji) zostaje otwarte dla zalogowanych.
  { prefix: "/company/travel", tabs: ["technical/kalendarz"] },
  { prefix: "/contracts", tabs: ["contracts"] },
  { prefix: "/orders", tabs: ["orders"] },
  // Analityka — TRZY OSOBNE wpisy, a nie jeden { prefix: "/analytics", tabs: [wszystkie trzy] }.
  // maxLevel() bierze NAJWYŻSZY poziom spośród wypisanych zakładek, więc wspólny wpis
  // byłby dziurą: ktoś z samą „analityka/obiekty" czytałby też rentowność klientów
  // i wynagrodzenia handlowców. Każdy widok pilnuje wyłącznie swojego klucza.
  { prefix: "/analytics/kontrahenci", tabs: ["analityka/kontrahenci"] },
  { prefix: "/analytics/obiekty", tabs: ["analityka/obiekty"] },
  { prefix: "/analytics/handlowcy", tabs: ["analityka/handlowcy"] },
  // Lejek sprzedaży rysuje się W zakładce „Handlowcy" i mówi o wynikach imiennie
  // (win rate per osoba), więc stoi pod tym samym kluczem. Bez tego wpisu trasa
  // byłaby NIEOBJĘTA kontrolą — `tabPermissionGuard` przepuszcza wszystko, czego
  // nie ma w tej mapie, a to znaczyłoby lejek dla każdego zalogowanego.
  { prefix: "/analytics/lejek", tabs: ["analityka/handlowcy"] },
  // Skrócona lista pracowników kadr (id + nazwisko, bez płac) — czytają ją
  // formularze handlowca i technika, żeby powiązać osobę z listą płac.
  // MUSI stać PRZED "/hr": find() bierze pierwsze dopasowanie, więc szerszy
  // wpis kadrowy przykryłby ten węższy i handlowiec-edytor dostałby 403.
  {
    prefix: "/hr/directory",
    tabs: ["kadry/pracownicy", "handlowcy", "technical/technicy"],
  },
  // Kadry — jedno API dla wszystkich podzakładek; kontrola per-podzakładka
  // (ukrywanie + read-only) odbywa się na froncie, backend pilnuje modułu.
  {
    prefix: "/hr",
    tabs: [
      "kadry/wynagrodzenia",
      "kadry/godziny",
      "kadry/pracownicy",
      "kadry/obiekty",
      "kadry/dzialy",
      "kadry/normy",
    ],
  },
  { prefix: "/cma/mail", tabs: ["cma/ustawienia"] },
  // Grupy interwencyjne mają WŁASNY klucz i MUSZĄ stać przed szerszym "/cma":
  // find() bierze pierwsze dopasowanie, więc bez tego właściciel klucza dostawałby
  // 403, a ktoś z samymi „cma/raporty" czytałby warunki i stawki podwykonawców.
  { prefix: "/cma/intervention-groups", tabs: ["cma/grupy-interwencyjne"] },
  { prefix: "/cma", tabs: ["cma/raporty", "cma/trendy", "cma/braki-kamer"] },
  { prefix: "/realizations", tabs: ["technical/realizacje"] },
  { prefix: "/protocols", tabs: ["technical/protokoly"] },
  { prefix: "/quotes", tabs: ["technical/wyceny"] },
  { prefix: "/pricelist", tabs: ["technical/cennik"] },
  // Katalog usług czyta nie tylko własna zakładka, ale i edytor ofert —
  // bez tego handlowiec z dostępem wyłącznie do ofert nie doda robocizny.
  { prefix: "/services", tabs: ["technical/uslugi", "technical/oferty"] },
  // Oferty. Klucz kosztowy `technical/oferty-koszty` NIE jest tutaj: on nie
  // otwiera ani nie zamyka tras, tylko decyduje, czy w odpowiedzi zostają pola
  // kosztowe (redactCosts w src/routes/offers.ts).
  { prefix: "/offers", tabs: ["technical/oferty"] },
  { prefix: "/technicians", tabs: ["technical/technicy", "technical/kalendarz"] },
  // Szanse sprzedaży (lejek). Pulpit czyta tę samą listę, ale zapisuje wyłącznie
  // właściciel klucza „handlowy/leady".
  { prefix: "/leads", tabs: ["handlowy/leady", "handlowy/pulpit"], writeTabs: ["handlowy/leady"] },
  // Osoby kontaktowe: własna zakładka, ale kartoteki kontrahenta i obiektu też je
  // pokazują. Zapis — z Kontaktów albo z Leadów (kontakt zakłada się przy szansie).
  {
    prefix: "/contacts",
    tabs: ["handlowy/kontakty", "handlowy/leady", "contractors", "objects"],
    writeTabs: ["handlowy/kontakty", "handlowy/leady"],
  },
  // Handlowcy: własna zakładka, ale listę czytają też formularze kontrahenta
  // i obiektu oraz cały moduł handlowy (filtr „Moje”, przypisania w kalendarzu).
  // Zapis (stawki, prowizje, przypisania) — tylko z „handlowcy".
  {
    prefix: "/salespeople",
    tabs: [
      "handlowcy",
      "contractors",
      "objects",
      "handlowy/leady",
      "handlowy/kalendarz",
      "handlowy/pulpit",
      "handlowy/aktywnosci",
    ],
    writeTabs: ["handlowcy"],
  },
  // Spółki: własna zakładka; słownik czytają też formularz obiektu i kadry
  // (umowa/biuro wybierają spółkę z listy). Zapis — tylko z „spolki".
  {
    prefix: "/companies",
    tabs: ["spolki", "objects", "kadry/wynagrodzenia", "kadry/pracownicy"],
    writeTabs: ["spolki"],
  },
  // Import raportu obiektów nadpisuje CAŁY rejestr — zostaje wyłącznie przy
  // dziale technicznym. MUSI stać PRZED szerszym "/monitored-objects", bo
  // find() bierze pierwsze dopasowanie.
  { prefix: "/monitored-objects/import", tabs: ["technical/obiekty"] },
  // Rejestr czytają dwa ekrany: kartoteka techniczna i ekran mapowania w CMA
  // (mapowanie na kartotekę obiektów robi operator monitoringu).
  { prefix: "/monitored-objects", tabs: ["technical/obiekty", "cma/obiekty"] },
  { prefix: "/monitoring", tabs: ["technical/projekty"] },
  { prefix: "/camera-models", tabs: ["technical/szablony"] },
  { prefix: "/warehouse", tabs: ["technical/magazyn"] },
  { prefix: "/manuals", tabs: ["technical/manuale"] },
  // Kalendarz obsługuje DWA działy jednym routerem, więc ten wpis jest tylko grubą
  // bramką „ma jakikolwiek kalendarz”. Właściwa kontrola jest WIERSZOWA, po
  // `calendar_events.department` (src/lib/calendar-scope.ts) — bez niej ktoś
  // z samym „handlowy/kalendarz" czytałby grafik techników.
  {
    prefix: "/calendar",
    tabs: [
      "technical/kalendarz",
      "handlowy/kalendarz",
      "handlowy/leady",
      "handlowy/pulpit",
      "handlowy/aktywnosci",
    ],
  },
];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Strażnik uprawnień do zakładek: dla żądań na trasy objęte API_TAB_MAP
 * wymaga poziomu "view" (odczyt) lub "edit" (zapis). Admin i trasy spoza
 * mapy przechodzą bez ograniczeń. Uruchamiać po requireAuth.
 */
export async function tabPermissionGuard(c: Context, next: Next) {
  const user = c.get("user") as User | undefined;
  if (!user) return c.json({ success: false, error: "Wymagane logowanie" }, 401);
  if (isAdmin(user)) return next();

  // Ścieżka względem montażu API (np. "/hr/employees"). c.req.path zawiera
  // pełną ścieżkę ("/api/hr/..."); dopasowujemy po fragmencie po "/api".
  const path = c.req.path.replace(/^\/api/, "");
  const match = API_TAB_MAP.find(
    (m) => path === m.prefix || path.startsWith(m.prefix + "/")
  );
  if (!match) return next(); // trasa nieobjęta kontrolą (stats, history, ...)

  const level = maxLevel(user, match.tabs);
  // Zapis własnych preferencji (zestawy filtrów kalendarza, token ICS) to nie
  // edycja danych modułu — wystarczy poziom "view". Tak samo dogrzanie cache'u
  // dojazdów (POST /company/travel/warm): to obliczenie dla dymków kalendarza,
  // które czytelnik i tak widzi, a nie edycja czyichś danych.
  const isOwnPreference =
    path.startsWith("/calendar/filter-sets") ||
    path.startsWith("/calendar/feed-token") ||
    path === "/company/travel/warm";
  const isWrite = !isOwnPreference && !READ_METHODS.has(c.req.method.toUpperCase());
  if (level === "none") {
    return c.json({ success: false, error: "Brak dostępu do tej sekcji" }, 403);
  }
  if (isWrite) {
    // Zapis liczy się wyłącznie z zakładek `writeTabs` (gdy są) — poziom
    // z pozostałych zakładek daje tylko odczyt słownika.
    const writeLevel = match.writeTabs ? maxLevel(user, match.writeTabs) : level;
    if (writeLevel !== "edit") {
      return c.json({ success: false, error: "Brak uprawnień do edycji (tryb tylko do odczytu)" }, 403);
    }
  }
  return next();
}
