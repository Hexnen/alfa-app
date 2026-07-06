import { randomBytes } from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../../db/index.js";
import { sessions, users, type User } from "../../db/schema.js";

export const SESSION_COOKIE = "alfa_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000; // 30 dni

export function createSession(userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("hex");
  const expiresAtMs = Date.now() + SESSION_MS;
  db.insert(sessions).values({ token, userId, expiresAt: expiresAtMs }).run();
  // Leniwe sprzątanie: przy okazji usuń wszystkie wygasłe sesje.
  db.delete(sessions).where(lt(sessions.expiresAt, Date.now())).run();
  return { token, expiresAt: new Date(expiresAtMs) };
}

/** Zwraca użytkownika dla ważnej sesji; kasuje wygasłe. */
export function getSessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const row = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!row) return null;
  if (row.expiresAt < Date.now()) {
    db.delete(sessions).where(eq(sessions.token, token)).run();
    return null;
  }
  return db.select().from(users).where(eq(users.id, row.userId)).get() ?? null;
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  db.delete(sessions).where(eq(sessions.token, token)).run();
}
