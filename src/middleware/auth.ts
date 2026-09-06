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
// /history) są dostępne dla każdego zalogowanego użytkownika.
const API_TAB_MAP: { prefix: string; tabs: string[] }[] = [
  { prefix: "/contractors", tabs: ["contractors"] },
  { prefix: "/objects", tabs: ["objects"] },
  { prefix: "/contracts", tabs: ["contracts"] },
  { prefix: "/orders", tabs: ["orders"] },
  // Analityka — TRZY OSOBNE wpisy, a nie jeden { prefix: "/analytics", tabs: [wszystkie trzy] }.
  // maxLevel() bierze NAJWYŻSZY poziom spośród wypisanych zakładek, więc wspólny wpis
  // byłby dziurą: ktoś z samą „analityka/obiekty" czytałby też rentowność klientów
  // i wynagrodzenia handlowców. Każdy widok pilnuje wyłącznie swojego klucza.
  { prefix: "/analytics/kontrahenci", tabs: ["analityka/kontrahenci"] },
  { prefix: "/analytics/obiekty", tabs: ["analityka/obiekty"] },
  { prefix: "/analytics/handlowcy", tabs: ["analityka/handlowcy"] },
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
  // Handlowcy: własna zakładka, ale listę czytają też formularze kontrahenta i obiektu.
  { prefix: "/salespeople", tabs: ["handlowcy", "contractors", "objects"] },
  // Spółki: własna zakładka; listę czyta też formularz obiektu i kadry.
  // Spółki: własna zakładka; słownik czytają też formularz obiektu i kadry
  // (umowa/biuro wybierają spółkę z listy).
  { prefix: "/companies", tabs: ["spolki", "objects", "kadry/wynagrodzenia", "kadry/pracownicy"] },
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
  { prefix: "/calendar", tabs: ["technical/kalendarz"] },
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
  // edycja danych modułu — wystarczy poziom "view".
  const isOwnPreference =
    path.startsWith("/calendar/filter-sets") || path.startsWith("/calendar/feed-token");
  const isWrite = !isOwnPreference && !READ_METHODS.has(c.req.method.toUpperCase());
  if (level === "none") {
    return c.json({ success: false, error: "Brak dostępu do tej sekcji" }, 403);
  }
  if (isWrite && level !== "edit") {
    return c.json({ success: false, error: "Brak uprawnień do edycji (tryb tylko do odczytu)" }, 403);
  }
  return next();
}
