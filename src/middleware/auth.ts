import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, getSessionUser } from "../lib/auth/sessions.js";
import type { User } from "../db/schema.js";
import { isAdmin, maxLevel } from "../lib/auth/permissions.js";

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
  // Kadry — jedno API dla wszystkich podzakładek; kontrola per-podzakładka
  // (ukrywanie + read-only) odbywa się na froncie, backend pilnuje modułu.
  {
    prefix: "/hr",
    tabs: [
      "kadry/wynagrodzenia",
      "kadry/godziny",
      "kadry/biuro",
      "kadry/umowy",
      "kadry/pracownicy",
      "kadry/obiekty",
      "kadry/normy",
    ],
  },
  { prefix: "/cma/mail", tabs: ["cma/ustawienia"] },
  { prefix: "/cma", tabs: ["cma/raporty", "cma/trendy", "cma/braki-kamer"] },
  { prefix: "/realizations", tabs: ["technical/realizacje"] },
  { prefix: "/protocols", tabs: ["technical/protokoly"] },
  { prefix: "/quotes", tabs: ["technical/wyceny"] },
  { prefix: "/pricelist", tabs: ["technical/cennik"] },
  { prefix: "/technicians", tabs: ["technical/technicy", "technical/kalendarz"] },
  { prefix: "/monitored-objects", tabs: ["technical/obiekty"] },
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
  const isWrite = !READ_METHODS.has(c.req.method.toUpperCase());
  if (level === "none") {
    return c.json({ success: false, error: "Brak dostępu do tej sekcji" }, 403);
  }
  if (isWrite && level !== "edit") {
    return c.json({ success: false, error: "Brak uprawnień do edycji (tryb tylko do odczytu)" }, 403);
  }
  return next();
}
