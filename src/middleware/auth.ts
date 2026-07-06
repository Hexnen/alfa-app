import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { SESSION_COOKIE, getSessionUser } from "../lib/auth/sessions.js";
import type { User } from "../db/schema.js";

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

/** Zalogowany użytkownik z kontekstu (po requireAuth). */
export function getUser(c: Context): User {
  return c.get("user") as User;
}

export function getUserId(c: Context): number {
  return (c.get("user") as User).id;
}
