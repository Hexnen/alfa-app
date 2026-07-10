import { eq, ne, and, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, sessions, type User } from "../../db/schema.js";
import { hashPassword } from "./passwords.js";
import {
  parsePermissions,
  sanitizePermissions,
  type PermissionMap,
} from "./permissions.js";

export interface PublicUser {
  id: number;
  email: string;
  displayName: string;
  role: string;
  permissions: PermissionMap;
  version: number;
  createdAt?: string;
}

export function publicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    permissions: parsePermissions(u.permissions),
    version: u.version,
    createdAt: u.createdAt,
  };
}

export function findUserByEmail(email: string): User | null {
  return db.select().from(users).where(eq(users.email, email)).get() ?? null;
}

export function findUserById(id: number): User | null {
  return db.select().from(users).where(eq(users.id, id)).get() ?? null;
}

export function listUsers(): PublicUser[] {
  return db.select().from(users).all().map(publicUser);
}

export function createUser(email: string, password: string, displayName: string): User {
  return db
    .insert(users)
    .values({ email, passwordHash: hashPassword(password), displayName })
    .returning()
    .get();
}

export interface CreateUserInput {
  email: string;
  password: string;
  displayName: string;
  role?: "user" | "admin";
  permissions?: unknown;
}

/** Tworzy konto z pełnym zestawem pól (dla panelu admina). */
export function createUserFull(input: CreateUserInput): User {
  return db
    .insert(users)
    .values({
      email: input.email,
      passwordHash: hashPassword(input.password),
      displayName: input.displayName,
      role: input.role === "admin" ? "admin" : "user",
      permissions: JSON.stringify(sanitizePermissions(input.permissions)),
    })
    .returning()
    .get();
}

export interface UpdateUserInput {
  displayName?: string;
  role?: "user" | "admin";
  permissions?: unknown;
}

export type UpdateUserResult =
  | { ok: true; user: User }
  | { ok: false; reason: "notfound" | "conflict" };

/**
 * Aktualizuje użytkownika i bumpuje `version` w tym samym UPDATE.
 * Gdy podano `expectedVersion`, zapis wykona się tylko jeśli wiersz nadal ma tę
 * wersję (WHERE id=? AND version=?); niezgodność => { ok:false, reason:"conflict" },
 * co pozwala odróżnić kolizję (ktoś zapisał w międzyczasie — 409) od zniknięcia
 * wiersza (równoległy DELETE — 404). Bez `expectedVersion` zachowuje się jak
 * zwykły update (wciąż bumpuje wersję), by starzy klienci działali.
 */
export function updateUser(
  id: number,
  input: UpdateUserInput,
  expectedVersion?: number,
): UpdateUserResult {
  const patch: Partial<User> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.role !== undefined) patch.role = input.role === "admin" ? "admin" : "user";
  if (input.permissions !== undefined)
    patch.permissions = JSON.stringify(sanitizePermissions(input.permissions));
  if (Object.keys(patch).length === 0) {
    const current = findUserById(id);
    return current ? { ok: true, user: current } : { ok: false, reason: "notfound" };
  }

  const where =
    expectedVersion === undefined
      ? eq(users.id, id)
      : and(eq(users.id, id), eq(users.version, expectedVersion));
  const updated = db
    .update(users)
    .set({ ...patch, version: sql`${users.version} + 1` })
    .where(where)
    .returning()
    .get();
  if (updated) return { ok: true, user: updated };
  // 0 wierszy: albo user zniknął (404), albo wersja się nie zgadza (409).
  return { ok: false, reason: findUserById(id) ? "conflict" : "notfound" };
}

export function setUserPassword(id: number, password: string): void {
  // Reset hasła i unieważnienie sesji muszą pójść razem — inaczej użytkownik
  // z aktywnym tokenem pozostaje zalogowany (getSessionUser uwierzytelnia po
  // tokenie, nie po haśle). Robimy to w jednej synchronicznej transakcji, żeby
  // równoległe żądanie nie zobaczyło nowego hasła przy wciąż żywej sesji.
  // Hash liczymy PRZED otwarciem transakcji — scryptSync trwa ~50-100ms, a
  // trzymanie blokady zapisu przez cały czas haszowania serializowałoby resety
  // i blokowało zewnętrznych piszących (backup/CLI) na czas obliczeń.
  const passwordHash = hashPassword(password);
  db.transaction((tx) => {
    tx.update(users).set({ passwordHash }).where(eq(users.id, id)).run();
    tx.delete(sessions).where(eq(sessions.userId, id)).run();
  });
}

export function deleteUser(id: number): void {
  db.delete(users).where(eq(users.id, id)).run();
}

/** Liczba pozostałych adminów poza wskazanym użytkownikiem — chroni przed usunięciem/degradacją ostatniego admina. */
export function otherAdminsCount(excludeId: number): number {
  return db
    .select()
    .from(users)
    .where(and(eq(users.role, "admin"), ne(users.id, excludeId)))
    .all().length;
}
