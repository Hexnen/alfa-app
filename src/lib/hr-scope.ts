/**
 * SEKCJE DZIAŁOWE KADR („portale”) — kto widzi i pisze KTÓRE wiersze godzin.
 *
 * Wzorowane na `src/lib/calendar-scope.ts`: prefiks `/hr` w `API_TAB_MAP`
 * (src/middleware/auth.ts) jest tylko grubą bramką „ma cokolwiek kadrowego”,
 * a właściwa kontrola jest TUTAJ i musi być wołana z KAŻDEJ trasy godzin.
 * Pominięta trasa to wyciek między sekcjami: kierownik CMA czytający godziny
 * ochrony obiektowej albo dopisujący się do cudzego działu.
 *
 * MODEL. Dział firmy (`hr_departments`) może należeć do sekcji portalu
 * (kolumna `portal`, migracja 0110): CMA→`cma`, OFI i Operacyjny→`ofi`,
 * Handlowy→`handlowy`, Techniczny→`technical`. Księgowość i Zarząd portalu nie
 * mają — ich wiersze widzą wyłącznie pełne Kadry.
 *
 *  - WPIS GODZIN należy do sekcji przez swój dział (`hr_hours.department_id`);
 *    wpisy obiektowe mają dział OFI, więc trafiają do sekcji `ofi`,
 *  - PRACOWNIK należy do sekcji, gdy ma w niej dział w kartotece ALBO choć
 *    jeden wpis godzin (`employeeIdsOfPortal` — uzasadnienie przy funkcji).
 *
 * KTO CO MOŻE:
 *  - `kadry/godziny` (albo admin) = pełne Kadry: brak zawężenia, `?portal=`
 *    wolno podać, żeby ZAWĘZIĆ widok (admin wchodzący na /cma/godziny),
 *  - `<sekcja>/godziny` = wyłącznie wiersze swojej sekcji; żądanie BEZ
 *    `?portal=` jest dla takiego konta błędem (403), a nie cichym „pokaż
 *    wszystko”.
 */
import type { Context } from "hono";
import type { User } from "../db/schema.js";
import { db, schema } from "../db/index.js";
import { eq, inArray } from "drizzle-orm";
import { canEdit, canView, isAdmin } from "./auth/permissions.js";
import type { HrLockScope } from "./hr-locks.js";

type ScopeUser = Pick<User, "role" | "permissions">;

/** Sekcje sidebara, które mają własne „Godziny działu”. */
export const HR_PORTALS = ["cma", "ofi", "handlowy", "technical"] as const;
export type HrPortalKey = (typeof HR_PORTALS)[number];

export const isHrPortal = (v: unknown): v is HrPortalKey =>
  typeof v === "string" && (HR_PORTALS as readonly string[]).includes(v);

/** Klucz uprawnień podzakładki „Godziny działu” danej sekcji. */
export const PORTAL_HOURS_TAB: Record<HrPortalKey, string> = {
  cma: "cma/godziny",
  ofi: "ofi/godziny",
  handlowy: "handlowy/godziny",
  technical: "technical/godziny",
};

/** Etykiety sekcji do komunikatów (nazwa działu bywa inna niż nazwa sekcji). */
export const PORTAL_LABEL: Record<HrPortalKey, string> = {
  cma: "CMA",
  ofi: "OFI",
  handlowy: "Handlowy",
  technical: "Techniczny",
};

/** Klucz pełnych Kadr rządzący daną listą (rezerwacje trzech list miesiąca). */
export const FULL_SCOPE_TAB: Record<HrLockScope, string> = {
  hours: "kadry/godziny",
  payroll: "kadry/wynagrodzenia",
  // Rozliczenie biura mieszka w Wynagrodzeniach (dawny klucz `kadry/biuro`).
  office: "kadry/wynagrodzenia",
};

/** Pełne Kadry — konto, które widzi CAŁĄ listę godzin, bez zawężenia. */
export const hasFullHoursView = (user: ScopeUser): boolean =>
  isAdmin(user) || canView(user, "kadry/godziny");

export const hasFullHoursEdit = (user: ScopeUser): boolean =>
  isAdmin(user) || canEdit(user, "kadry/godziny");

/** Sekcje, których godziny użytkownik może OGLĄDAĆ (bez pełnych Kadr). */
export function viewablePortals(user: ScopeUser): HrPortalKey[] {
  if (isAdmin(user)) return [...HR_PORTALS];
  return HR_PORTALS.filter((p) => canView(user, PORTAL_HOURS_TAB[p]));
}

/** Sekcje, w których użytkownik może ZAPISYWAĆ godziny. */
export function editablePortals(user: ScopeUser): HrPortalKey[] {
  if (isAdmin(user)) return [...HR_PORTALS];
  return HR_PORTALS.filter((p) => canEdit(user, PORTAL_HOURS_TAB[p]));
}

/** Czy wolno pisać w tej sekcji (pełne Kadry z edycją godzin mogą wszędzie). */
export const canEditPortal = (user: ScopeUser, portal: HrPortalKey): boolean =>
  hasFullHoursEdit(user) || canEdit(user, PORTAL_HOURS_TAB[portal]);

/** Czy wolno wziąć rezerwację CAŁEJ listy (portal `null`) danego scope. */
export const canLockWholeList = (user: ScopeUser, scope: HrLockScope): boolean =>
  isAdmin(user) || canEdit(user, FULL_SCOPE_TAB[scope]);

// ---------------------------------------------------------------------------
// Słownik działów sekcji
// ---------------------------------------------------------------------------

/**
 * Id działów należących do sekcji. Czytane przy każdym żądaniu, bez cache'u —
 * to jedno zapytanie po kilkunastowierszowym słowniku, a nieświeży cache po
 * zmianie portalu działu pokazywałby „nie te” wiersze (albo je ukrywał).
 */
export function departmentIdsOfPortal(portal: HrPortalKey): number[] {
  return db
    .select({ id: schema.hrDepartments.id })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.portal, portal))
    .all()
    .map((r) => r.id);
}

/** Portal działu (`null` = dział bez sekcji albo brak działu). */
export function portalOfDepartmentId(id: number | null | undefined): string | null {
  if (id == null) return null;
  return (
    db
      .select({ portal: schema.hrDepartments.portal })
      .from(schema.hrDepartments)
      .where(eq(schema.hrDepartments.id, id))
      .get()?.portal ?? null
  );
}

/**
 * LUDZIE SEKCJI — dwa zbiory, nie jeden.
 *
 * Naturalne „pracownik należy do sekcji przez swój dział w kartotece” nie
 * wystarcza i nie wystarczy nigdy: dział w kartotece mówi, GDZIE ktoś pracuje
 * na stałe, a godziny mówią, CO robił w danym miesiącu. W praktyce cała ochrona
 * obiektowa siedzi w OFI, ale dyżury w centrum monitorowania (dział CMA)
 * obsadzają ci sami ludzie — gdyby liczył się sam dział z kartoteki, sekcja CMA
 * widziałaby swoje trzynaście wierszy i nie mogłaby tknąć ani jednego.
 *
 * Dlatego do sekcji należy ten, kto MA W NIEJ DZIAŁ w kartotece ALBO ma w niej
 * choć jeden wpis godzin (z dowolnego miesiąca). Ten sam zbiór karmi listę
 * wyboru w formularzu i bramkę zapisu, więc nie da się dopisać kogoś, kogo nie
 * ma w podpowiedziach.
 */
export function employeeIdsOfPortal(portal: HrPortalKey): Set<number> {
  const depts = departmentIdsOfPortal(portal);
  if (depts.length === 0) return new Set();
  const byCard = db
    .select({ id: schema.hrEmployees.id })
    .from(schema.hrEmployees)
    .where(inArray(schema.hrEmployees.departmentId, depts))
    .all()
    .map((r) => r.id);
  const byHours = db
    .selectDistinct({ id: schema.hrHours.employeeId })
    .from(schema.hrHours)
    .where(inArray(schema.hrHours.departmentId, depts))
    .all()
    .map((r) => r.id);
  return new Set([...byCard, ...byHours]);
}

/** Czy sekcja ma dział obiektowy (`has_objects`) — tylko wtedy widzi posterunki. */
export function portalHasObjects(portal: HrPortalKey): boolean {
  return db
    .select({ id: schema.hrDepartments.id, hasObjects: schema.hrDepartments.hasObjects })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.portal, portal))
    .all()
    .some((d) => d.hasObjects === true);
}

// ---------------------------------------------------------------------------
// Zasięg ŻĄDANIA
// ---------------------------------------------------------------------------

/** Odmowa gotowa do zwrócenia z handlera (Kadry nie rzucają wyjątkami). */
export interface ScopeDenial {
  error: string;
  status: 400 | 403;
}

export type PortalScope =
  /** `portal: null` = bez zawężenia (pełne Kadry). */
  { portal: HrPortalKey | null } | ScopeDenial;

export const isDenial = (v: PortalScope): v is ScopeDenial => "error" in v;

const NO_SECTION =
  "Wskaż sekcję (parametr portal) — konto bez pełnych Kadr widzi wyłącznie godziny swojego działu";

/**
 * Sekcja ŻĄDANIA z `?portal=` (albo z ciała zapisu) przecięta z uprawnieniami.
 *
 * Brak parametru znaczy „cała lista” i wolno go pominąć TYLKO pełnym Kadrom;
 * konto sekcji dostaje 403, a nie po cichu zawężony albo pełny wynik — jedno
 * i drugie byłoby zgadywaniem za użytkownika.
 */
export function portalScope(raw: string | null | undefined, user: ScopeUser): PortalScope {
  const value = (raw ?? "").trim();
  if (!value) {
    return hasFullHoursView(user) ? { portal: null } : { error: NO_SECTION, status: 403 };
  }
  if (!isHrPortal(value)) {
    return { error: `Nieznana sekcja: dozwolone ${HR_PORTALS.join(", ")}`, status: 400 };
  }
  if (!hasFullHoursView(user) && !canView(user, PORTAL_HOURS_TAB[value])) {
    return { error: `Brak dostępu do godzin działu ${PORTAL_LABEL[value]}`, status: 403 };
  }
  return { portal: value };
}

/** To samo z kontekstu żądania — `?portal=`. */
export const portalFromQuery = (c: Context, user: ScopeUser): PortalScope =>
  portalScope(c.req.query("portal"), user);

/** Klucze pełnych Kadr — komplet z `API_TAB_MAP` dla prefiksu `/hr`. */
const HR_TAB_KEYS = [
  "kadry/wynagrodzenia",
  "kadry/godziny",
  "kadry/pracownicy",
  "kadry/obiekty",
  "kadry/dzialy",
  "kadry/normy",
  "kadry/historia",
];

/** Czy konto ma WGLĄD w Kadry jako moduł (dowolna podzakładka). */
export const hasAnyHrTab = (user: ScopeUser): boolean =>
  isAdmin(user) || HR_TAB_KEYS.some((k) => canView(user, k));

/**
 * Zasięg SŁOWNIKA (działy, posterunki, lista pracowników).
 *
 * Różnica wobec `portalScope`: te listy czytają też ekrany spoza Kadr
 * (kartoteka pracownika, formularz handlowca, mapowanie obiektów), więc brak
 * `?portal=` zostaje „bez zawężenia” dla każdego, kto miał do nich dostęp
 * WCZEŚNIEJ. Odmowa dotyczy wyłącznie kont, które weszły tu kluczem sekcji
 * — dla nich pominięty parametr oznaczałby pełny słownik firmy.
 */
export function dictionaryPortalScope(
  raw: string | null | undefined,
  user: ScopeUser,
  /** Czy konto ma prawo do NIEZAWĘŻONEJ listy (poza kluczem sekcji). */
  fallbackAllowed: boolean,
): PortalScope {
  const value = (raw ?? "").trim();
  if (!value) {
    return fallbackAllowed ? { portal: null } : { error: NO_SECTION, status: 403 };
  }
  return portalScope(value, user);
}

/** Kto czyta skróconą listę pracowników poza sekcjami (patrz API_TAB_MAP). */
export const hasDirectoryAccess = (user: ScopeUser): boolean =>
  hasAnyHrTab(user) || canView(user, "handlowcy") || canView(user, "technical/technicy");

/**
 * Zasięg ZAPISU: jak `portalScope`, ale wymaga prawa edycji sekcji. Bez tego
 * konto z samym `view` na „Godziny działu” dopisywałoby wiersze (bramka
 * prefiksu `/hr` przepuszcza zapis, gdy ma się edycję CZEGOKOLWIEK z Kadr).
 */
export function writablePortalScope(
  raw: string | null | undefined,
  user: ScopeUser,
): PortalScope {
  const scope = portalScope(raw, user);
  if (isDenial(scope)) return scope;
  if (scope.portal == null) {
    return hasFullHoursEdit(user)
      ? scope
      : { error: "Brak uprawnień do edycji godzin (tryb tylko do odczytu)", status: 403 };
  }
  if (!canEditPortal(user, scope.portal)) {
    return {
      error: `Brak uprawnień do edycji godzin działu ${PORTAL_LABEL[scope.portal]}`,
      status: 403,
    };
  }
  return scope;
}

/**
 * Czy WIERSZ (po dziale) należy do sekcji żądania. `portal: null` (pełne Kadry)
 * przepuszcza wszystko, łącznie z wierszami bez działu.
 */
export function departmentInPortal(
  departmentId: number | null | undefined,
  portal: HrPortalKey | null,
): boolean {
  if (portal == null) return true;
  if (departmentId == null) return false;
  return portalOfDepartmentId(departmentId) === portal;
}

/** Komunikat 403 dla wiersza spoza sekcji — jeden tekst na wszystkie trasy. */
export const outsidePortalError = (portal: HrPortalKey): string =>
  `Wiersz należy do innego działu niż sekcja ${PORTAL_LABEL[portal]} — otwórz pełne Kadry`;

/** Komunikat 403 dla pracownika spoza sekcji. */
export const employeeOutsidePortalError = (portal: HrPortalKey): string =>
  `Pracownik nie należy do sekcji ${PORTAL_LABEL[portal]} — nie ma w niej działu ani ani jednego wpisu godzin`;
