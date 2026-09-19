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

/**
 * Rola `technik` poza `/api/technik/*` → 403.
 *
 * PO CO OSOBNY STRAŻNIK. `tabPermissionGuard` przepuszcza wszystko, czego nie ma
 * w `API_TAB_MAP` (/stats, /company/office, /links, /company-lookup…), więc sam
 * klucz uprawnień nie wystarcza do zamknięcia konta podwykonawcy w jednym module.
 * Montować BEZPOŚREDNIO po `requireAuth`, przed `/admin`, `/assistant` i strażnikiem
 * zakładek (src/routes/index.ts) — inaczej technik dostałby panel admina, który ma
 * własny `requireAdmin`, ale też własne trasy spoza mapy zakładek.
 *
 * `/auth/*` jest poza tym strażnikiem z natury: montuje się PRZED `requireAuth`,
 * więc technik normalnie loguje się i wylogowuje.
 */
export async function technikRoleGuard(c: Context, next: Next) {
  const user = c.get("user") as User | undefined;
  if (!user || user.role !== "technik") return next();
  const path = c.req.path.replace(/^\/api/, "");
  if (path === "/technik" || path.startsWith("/technik/")) return next();
  return c.json({ success: false, error: "Konto technika ma dostęp wyłącznie do panelu technika" }, 403);
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
/**
 * Klucze modułu Kadry (odczyt) i te z nich, które dają ZAPIS.
 *
 * Wyciągnięte do stałych, bo powtarzają się w kilku wpisach mapy niżej
 * (`/hr`, `/hr/departments`, `/hr/objects`) i rozjazd między kopiami byłby
 * dziurą, a nie literówką: `maxLevel()` liczy najwyższy poziom z listy.
 *
 * `kadry/historia` jest w `tabs`, ale NIE w `writeTabs` — ten klucz nadaje się
 * po to, żeby ktoś mógł czytać dziennik, a nie pisać po całym module.
 */
const HR_WRITE_TABS = [
  "kadry/wynagrodzenia",
  "kadry/godziny",
  "kadry/pracownicy",
  "kadry/obiekty",
  "kadry/dzialy",
  "kadry/normy",
];
const HR_TABS = [...HR_WRITE_TABS, "kadry/historia"];

/**
 * Klucze podzakładek „Godziny działu” (mini-Kadry sekcji, src/lib/hr-scope.ts).
 * Osobno od `kadry/godziny`, bo to one otwierają trasy godzin komuś, kto nie ma
 * ANI JEDNEGO klucza Kadr — zawężenie do własnych wierszy robi `?portal=`.
 */
const HOURS_PORTAL_TABS = [
  "cma/godziny",
  "ofi/godziny",
  "handlowy/godziny",
  "technical/godziny",
];
/** Pełne Kadry + sekcje — komplet kont, które mają wstęp na trasy godzin. */
const HOURS_TABS = ["kadry/godziny", ...HOURS_PORTAL_TABS];

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
    tabs: [
      "kadry/pracownicy",
      "handlowcy",
      "technical/technicy",
      // Sekcje działowe („Godziny działu”) wybierają z tej listy pracownika do
      // wpisu godzin. Odpowiedź zawęża do własnego działu `src/lib/hr-scope.ts`
      // (parametr `?portal=`), więc kierownik CMA nie zobaczy tu ochrony.
      ...HOURS_PORTAL_TABS,
    ],
  },
  // Dziennik zmian Kadr (/hr/activity/*) — WŁASNY wpis, koniecznie PRZED "/hr":
  // find() bierze pierwsze dopasowanie. Trasa jest wyłącznie do odczytu i wydaje
  // streszczenia z kwotami wynagrodzeń WSZYSTKICH osób, więc stoi pod jednym
  // kluczem „kadry/historia", a nie pod sumą kluczy Kadr (ten sam warunek
  // powtarza jawnie `guard()` w src/routes/hr-activity.ts — także dla historii
  // pracownika, która z adresu należy do /hr/employees). `writeTabs: []` domyka
  // ją na zapis: nikt nie ma prawa pisać pod tym prefiksem.
  // Sekcje działowe czytają stąd historię SWOICH wpisów godzin i swoich ludzi
  // (`guard()` w hr-activity.ts zawęża je do encji `hr_hours` własnego działu).
  { prefix: "/hr/activity", tabs: ["kadry/historia", ...HOURS_PORTAL_TABS], writeTabs: [] },
  /*
   * MINI-KADRY SEKCJI („Godziny działu”, src/lib/hr-scope.ts).
   *
   * Konto z samym `cma/godziny` nie ma ŻADNEGO klucza `kadry/*`, więc szeroki
   * wpis „/hr” niżej odbiłby je 403 na całym module. Te wpisy otwierają mu
   * dokładnie tyle, ile potrzebuje ekran „Godziny działu” — a nie Kadry:
   * wypłaty, biuro, normy, kartoteka i CRUD słowników zostają pod „/hr”.
   * Każdy MUSI stać przed „/hr”: `find()` bierze pierwsze dopasowanie.
   *
   * Co zawęża WIERSZE, a czego ta mapa nie umie: `?portal=` i kontrola per
   * wiersz w `src/lib/hr-scope.ts`, wołana z każdej trasy godzin. Bez niej ten
   * wpis dawałby kierownikowi CMA całą listę godzin firmy.
   */
  { prefix: "/hr/hours", tabs: HOURS_TABS, writeTabs: HOURS_TABS },
  // Rezerwacja listy do edycji — sekcja bierze WYŁĄCZNIE swój portal
  // (`canLockWholeList` w hr-locks.ts pilnuje, że nie weźmie całości).
  { prefix: "/hr/locks", tabs: HOURS_TABS, writeTabs: HOURS_TABS },
  // Strumień SSE: sam sygnał „coś się zmieniło”, bez danych.
  { prefix: "/hr/live", tabs: HOURS_TABS, writeTabs: [] },
  // Stan miesiąca — dla sekcji TYLKO do odczytu (pasek „miesiąc zamknięty”).
  // Zamknięcie i otwarcie i tak wymaga `kadry/wynagrodzenia` (hr-month.ts).
  {
    prefix: "/hr/month-status",
    tabs: [...HOURS_TABS, "kadry/wynagrodzenia", "kadry/pracownicy", "kadry/historia"],
    writeTabs: ["kadry/wynagrodzenia"],
  },
  // Słownik działów i posterunków: sekcja CZYTA (zawężony `?portal=`), ale
  // zakładanie i kasowanie zostaje przy pełnych Kadrach.
  { prefix: "/hr/departments", tabs: [...HR_TABS, ...HOURS_PORTAL_TABS], writeTabs: HR_WRITE_TABS },
  { prefix: "/hr/objects", tabs: [...HR_TABS, ...HOURS_PORTAL_TABS], writeTabs: HR_WRITE_TABS },
  // Kadry — jedno API dla wszystkich podzakładek; kontrola per-podzakładka
  // (ukrywanie + read-only) odbywa się na froncie, backend pilnuje modułu.
  //
  // `writeTabs` BEZ „kadry/historia": ten klucz nadaje się po to, żeby ktoś
  // mógł CZYTAĆ dziennik (i historię pracownika pod /hr/employees/:id/activity),
  // więc musi zostać w `tabs`. Gdyby został też w prawie zapisu, `maxLevel()`
  // liczony po wszystkich kluczach otwierałby posiadaczowi „kadry/historia: edit"
  // zapis w całym module, łącznie z kwotami wypłat.
  {
    prefix: "/hr",
    // `HR_TABS` niesie też „kadry/historia” (historia pracownika mieszka pod
    // /hr/employees/:id/activity) — bez niego ktoś z samą „Historią” dostawałby
    // 403 na całym /hr. Do zapisu służy węższe `HR_WRITE_TABS`.
    tabs: HR_TABS,
    writeTabs: HR_WRITE_TABS,
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
  // Panel technika. Dla roli `technik` poziom bierze się z `levelFor` (zawsze
  // „edit"), dla roli `user` — z klucza nadanego w macierzy admina, więc ten wpis
  // załatwia jednocześnie odcięcie osób bez klucza i tryb tylko-do-odczytu (view).
  { prefix: "/technik", tabs: ["technik"] },
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
  // Subskrypcja powiadomień panelu technika to również preferencja WŁASNEGO
  // urządzenia, a nie edycja cudzych danych: konto „tylko do odczytu" też musi
  // się dowiedzieć, że dostało zlecenie (POST/DELETE /technik/push/subscribe).
  const isOwnPreference =
    path.startsWith("/calendar/filter-sets") ||
    path.startsWith("/calendar/feed-token") ||
    path === "/technik/push/subscribe" ||
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
