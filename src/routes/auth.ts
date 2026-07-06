import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSessionUser,
} from "../lib/auth/sessions.js";
import { createUser, findUserByEmail, publicUser } from "../lib/auth/users.js";
import { verifyPassword } from "../lib/auth/passwords.js";

const auth = new Hono();

// Login = dowolny identyfikator (nie musi być emailem).
// Walidacja ręczna (brak zod w zależnościach) — te same reguły co we wzorcu.
interface RegisterInput {
  email: string;
  password: string;
  displayName: string;
}

function parseRegister(body: unknown): RegisterInput | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.email !== "string" || typeof b.password !== "string") return null;
  const email = b.email.trim();
  if (email.length < 3 || email.length > 200) return null;
  if (b.password.length < 6 || b.password.length > 200) return null;
  let displayName = "";
  if (b.displayName !== undefined) {
    if (typeof b.displayName !== "string") return null;
    displayName = b.displayName.trim();
    if (displayName.length > 60) return null;
  }
  return { email, password: b.password, displayName };
}

function parseLogin(body: unknown): { email: string; password: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.email !== "string" || typeof b.password !== "string") return null;
  const email = b.email.trim();
  if (email.length < 1 || email.length > 200) return null;
  if (b.password.length < 1 || b.password.length > 200) return null;
  return { email, password: b.password };
}

function setSessionCookie(c: Context, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: false, // dev/self-hosted; za reverse-proxy HTTPS można ustawić true
    path: "/",
    expires: expiresAt,
  });
}

// --- POST /register — otwarta rejestracja ---
auth.post("/register", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseRegister(body);
  if (!parsed) {
    return c.json(
      { error: "Podaj login (min. 3 znaki) i hasło (min. 6 znaków)." },
      400
    );
  }
  const email = parsed.email.toLowerCase();
  const displayName = parsed.displayName || email.split("@")[0];
  if (findUserByEmail(email)) {
    return c.json({ error: "Konto z tym adresem już istnieje." }, 409);
  }
  const user = createUser(email, parsed.password, displayName);
  const { token, expiresAt } = createSession(user.id);
  setSessionCookie(c, token, expiresAt);
  return c.json({ user: publicUser(user) });
});

// --- POST /login ---
auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseLogin(body);
  if (!parsed) {
    return c.json({ error: "Podaj login i hasło." }, 400);
  }
  const email = parsed.email.toLowerCase();
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(parsed.password, user.passwordHash)) {
    return c.json({ error: "Nieprawidłowy email lub hasło." }, 401);
  }
  const { token, expiresAt } = createSession(user.id);
  setSessionCookie(c, token, expiresAt);
  return c.json({ user: publicUser(user) });
});

// --- POST /logout ---
auth.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  deleteSession(token);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

// --- GET /me ---
auth.get("/me", (c) => {
  const user = getSessionUser(getCookie(c, SESSION_COOKIE));
  if (!user) return c.json({ user: null }, 200);
  return c.json({ user: publicUser(user) });
});

export default auth;
