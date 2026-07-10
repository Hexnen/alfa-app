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
  { key: "contracts", label: "Umowy", group: "Ogólne" },
  { key: "orders", label: "Zlecenia", group: "Ogólne" },
  // Kadry
  { key: "kadry/wynagrodzenia", label: "Wynagrodzenia", group: "Kadry" },
  { key: "kadry/godziny", label: "Godziny", group: "Kadry" },
  { key: "kadry/biuro", label: "Biuro", group: "Kadry" },
  { key: "kadry/umowy", label: "Umowy", group: "Kadry" },
  { key: "kadry/pracownicy", label: "Pracownicy", group: "Kadry" },
  { key: "kadry/obiekty", label: "Obiekty", group: "Kadry" },
  { key: "kadry/normy", label: "Normy", group: "Kadry" },
  // CMA
  { key: "cma/raporty", label: "Raporty", group: "CMA" },
  { key: "cma/trendy", label: "Trendy", group: "CMA" },
  { key: "cma/braki-kamer", label: "Braki kamer", group: "CMA" },
  { key: "cma/ustawienia", label: "Ustawienia", group: "CMA" },
  // Techniczny
  { key: "technical/realizacje", label: "Realizacje", group: "Techniczny" },
  { key: "technical/protokoly", label: "Protokoły", group: "Techniczny" },
  { key: "technical/wyceny", label: "Wyceny", group: "Techniczny" },
  { key: "technical/cennik", label: "Cennik", group: "Techniczny" },
  { key: "technical/technicy", label: "Technicy", group: "Techniczny" },
  { key: "technical/obiekty", label: "Obiekty", group: "Techniczny" },
  { key: "technical/projekty", label: "Projekty", group: "Techniczny" },
  { key: "technical/szablony", label: "Szablony", group: "Techniczny" },
  // OFI
  { key: "ofi", label: "OFI", group: "OFI" },
];

const TAB_KEYS = new Set(TABS.map((t) => t.key));

/** Bezpieczny parse mapy uprawnień z kolumny JSON. */
export function parsePermissions(raw: string | null | undefined): PermissionMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (typeof obj !== "object" || obj === null) return {};
    const out: PermissionMap = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (TAB_KEYS.has(k) && (v === "view" || v === "edit")) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Normalizuje dowolny obiekt do poprawnej mapy uprawnień (do zapisu). */
export function sanitizePermissions(input: unknown): PermissionMap {
  if (typeof input !== "object" || input === null) return {};
  const out: PermissionMap = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (TAB_KEYS.has(k) && (v === "view" || v === "edit")) out[k] = v;
  }
  return out;
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
