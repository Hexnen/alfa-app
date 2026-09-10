/**
 * Widoczność i prawo edycji WIERSZA kalendarza — po `calendar_events.department`.
 *
 * Prefiks `/calendar` w `API_TAB_MAP` (src/middleware/auth.ts) jest tylko grubą bramką:
 * przepuszcza każdego, kto ma którykolwiek klucz kalendarza (technicznego albo handlowego).
 * Właściwa kontrola jest TUTAJ i musi być wołana z KAŻDEJ trasy kalendarza — pominięta
 * trasa to wyciek danych między działami (technik czytający lejek, handlowiec edytujący
 * montaże). Test `scripts/test-sales-calendar-perms.ts` pilnuje obu kierunków.
 *
 * Zasada: dział handlowy edytuje kalendarz z klucza `handlowy/kalendarz` ALBO
 * `handlowy/leady` — planowanie następnej aktywności jest częścią pracy na szansie,
 * a nie osobnym przywilejem.
 */
import type { Context } from "hono";
import type { User } from "../db/schema.js";
import { CALENDAR_DEPARTMENTS, type CalendarDepartment } from "../db/schema.js";
import { canEdit, canView, isAdmin } from "./auth/permissions.js";
import { ApiError } from "./calendar-labels.js";

type ScopeUser = Pick<User, "role" | "permissions">;

/** Zakładki dające WGLĄD w kalendarz danego działu. */
const VIEW_TABS: Record<CalendarDepartment, readonly string[]> = {
  technical: ["technical/kalendarz"],
  // Pulpit, Leady i Aktywności czytają te same wydarzenia, co Kalendarz handlowy.
  handlowy: ["handlowy/kalendarz", "handlowy/leady", "handlowy/pulpit", "handlowy/aktywnosci"],
};

/** Zakładki dające prawo EDYCJI wydarzeń danego działu. */
const EDIT_TABS: Record<CalendarDepartment, readonly string[]> = {
  technical: ["technical/kalendarz"],
  handlowy: ["handlowy/kalendarz", "handlowy/leady"],
};

/** Tekst z bazy → dział (nieznana wartość = techniczny, tak jak historyczny default kolumny). */
export function asDepartment(raw: string | null | undefined): CalendarDepartment {
  return CALENDAR_DEPARTMENTS.includes(raw as CalendarDepartment) ? (raw as CalendarDepartment) : "technical";
}

/**
 * Działy, których wydarzenia użytkownik może OGLĄDAĆ (admin: wszystkie).
 * STRICT — pusty wynik znaczy „żadnego kalendarza”. Używane tam, gdzie nie ma nad
 * nami bramki prefiksu: feed ICS (poza `requireAuth`) i globalny dziennik aktywności.
 */
export function viewableDepartments(user: ScopeUser): CalendarDepartment[] {
  if (isAdmin(user)) return [...CALENDAR_DEPARTMENTS];
  return CALENDAR_DEPARTMENTS.filter((d) => VIEW_TABS[d].some((tab) => canView(user, tab)));
}

/**
 * Zasięg działowy ŻĄDANIA wewnątrz routera `/calendar`.
 *
 * Kontrola wierszowa rozstrzyga MIĘDZY działami; „czy w ogóle wolno wejść do kalendarza”
 * pilnuje bramka prefiksu w API_TAB_MAP, a router jest montowany wyłącznie za nią
 * (src/routes/index.ts). Użytkownik bez ŻADNEGO klucza kalendarza jest więc w produkcji
 * nieosiągalny — a gdy mimo to tu trafi (router zamontowany bez middleware, jak w skryptach
 * testowych), zachowujemy się jak dotąd: bez zawężenia, zamiast udawać bramkę modułu.
 */
export function requestDepartments(user: ScopeUser): CalendarDepartment[] {
  const own = viewableDepartments(user);
  return own.length > 0 ? own : [...CALENDAR_DEPARTMENTS];
}

export function canViewDepartment(user: ScopeUser, dept: CalendarDepartment): boolean {
  return requestDepartments(user).includes(dept);
}

/** Czy użytkownik może TWORZYĆ/ZMIENIAĆ wydarzenia danego działu. */
export function canEditDepartment(user: ScopeUser, dept: CalendarDepartment): boolean {
  if (isAdmin(user)) return true;
  if (EDIT_TABS[dept].some((tab) => canEdit(user, tab))) return true;
  // Ten sam wyjątek, co w `requestDepartments` — brak jakiegokolwiek klucza kalendarza
  // znaczy „router bez bramki”, a nie „użytkownik bez uprawnień”.
  return viewableDepartments(user).length === 0;
}

/**
 * Działy z parametru `?department=` (csv) przecięte z uprawnieniami.
 * Pusty parametr = wszystkie widoczne; nieznana wartość → 400; dział bez wglądu → 403.
 */
export function departmentsFromQuery(c: Context, user: ScopeUser): CalendarDepartment[] {
  const viewable = requestDepartments(user);
  const raw = (c.req.query("department") || "").trim();
  if (!raw) return viewable;
  const wanted = [...new Set(raw.split(",").map((s) => s.trim()).filter(Boolean))];
  const out: CalendarDepartment[] = [];
  for (const d of wanted) {
    if (!CALENDAR_DEPARTMENTS.includes(d as CalendarDepartment)) {
      throw new ApiError(400, `Parametr department: dozwolone ${CALENDAR_DEPARTMENTS.join(", ")}`);
    }
    if (!viewable.includes(d as CalendarDepartment)) {
      throw new ApiError(403, `Brak dostępu do kalendarza działu ${d}`);
    }
    out.push(d as CalendarDepartment);
  }
  return out;
}

/**
 * Sprawdza dostęp do konkretnego wiersza. `mode: "edit"` wymaga też wglądu —
 * inaczej „brak dostępu” dałoby się wykryć po tym, który błąd wróci.
 */
export function assertEventAccess(
  user: ScopeUser,
  ev: { department: string | null | undefined },
  mode: "view" | "edit"
): void {
  const dept = asDepartment(ev.department);
  if (!canViewDepartment(user, dept)) {
    throw new ApiError(403, "Brak dostępu do wydarzeń tego działu");
  }
  if (mode === "edit" && !canEditDepartment(user, dept)) {
    throw new ApiError(403, "Brak uprawnień do edycji wydarzeń tego działu");
  }
}
