import { eq, ne, and } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, type User } from "../../db/schema.js";
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
  createdAt?: string;
}

export function publicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    role: u.role,
    permissions: parsePermissions(u.permissions),
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

export function updateUser(id: number, input: UpdateUserInput): User | null {
  const patch: Partial<User> = {};
  if (input.displayName !== undefined) patch.displayName = input.displayName;
  if (input.role !== undefined) patch.role = input.role === "admin" ? "admin" : "user";
  if (input.permissions !== undefined)
    patch.permissions = JSON.stringify(sanitizePermissions(input.permissions));
  if (Object.keys(patch).length === 0) return findUserById(id);
  return db.update(users).set(patch).where(eq(users.id, id)).returning().get() ?? null;
}

export function setUserPassword(id: number, password: string): void {
  db.update(users).set({ passwordHash: hashPassword(password) }).where(eq(users.id, id)).run();
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
