import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  getSessionUser,
} from "../lib/auth/sessions.js";
import { findUserByEmail, publicUser } from "../lib/auth/users.js";
import { verifyPassword, burnPasswordCheck } from "../lib/auth/passwords.js";
import { clientIp, createRateLimiter } from "../lib/rate-limit.js";

const auth = new Hono();

/**
 * Limit prób logowania. Dwa klucze, bo chronią przed dwoma różnymi atakami:
 *  - per IP (20/15 min) — jedna maszyna zgadująca hasła do wielu kont,
 *  - per login (10/15 min) — rozproszone zgadywanie hasła do JEDNEGO konta
 *    (klucz per IP tego nie widzi, bo każda próba idzie z innego adresu).
 * Wcześniej limitu nie było: 40 błędnych prób z rzędu = 40 × 401.
 * Wpisy wpadają do liczników TYLKO przy nieudanej próbie (patrz niżej), więc
 * użytkownik, który zna hasło, nie wyczerpie sobie puli własnymi logowaniami.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const loginIpLimiter = createRateLimiter({ limit: 20, windowMs: LOGIN_WINDOW_MS });
export const loginUserLimiter = createRateLimiter({ limit: 10, windowMs: LOGIN_WINDOW_MS, maxKeys: 20_000 });
const TOO_MANY_ATTEMPTS = "Za dużo nieudanych prób logowania. Spróbuj ponownie za 15 minut.";

// Login = dowolny identyfikator (nie musi być emailem).
// Walidacja ręczna (brak zod w zależnościach) — te same reguły co we wzorcu.
function parseLogin(body: unknown): { email: string; password: string } | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b.email !== "string" || typeof b.password !== "string") return null;
  const email = b.email.trim();
  if (email.length < 1 || email.length > 200) return null;
  if (b.password.length < 1 || b.password.length > 200) return null;
  return { email, password: b.password };
}

/**
 * `secure` na cookie sesji: w produkcji zawsze, a poza nią wtedy, gdy żądanie
 * przyszło po HTTPS przez reverse proxy (Traefik dopisuje `x-forwarded-proto`).
 * Sztywne `false` (poprzednia wersja) wysyłało cookie sesji także po czystym
 * HTTP, gdy ktoś wpisał adres bez „s" — a `Secure` to jedyna ochrona przed tym
 * na poziomie przeglądarki. Dev po http://localhost dalej działa, bo tam nie
 * ma ani NODE_ENV=production, ani nagłówka od proxy.
 */
function cookieSecure(c: Context): boolean {
  return process.env.NODE_ENV === "production" || c.req.header("x-forwarded-proto") === "https";
}

function setSessionCookie(c: Context, token: string, expiresAt: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: cookieSecure(c),
    path: "/",
    expires: expiresAt,
  });
}

// --- POST /register — WYŁĄCZONE ---
// Konta zakłada wyłącznie administrator w panelu (POST /api/admin/users).
// Endpoint pozostaje, by front dostał czytelny komunikat zamiast 404.
auth.post("/register", (c) => {
  return c.json(
    { error: "Rejestracja jest wyłączona. Konto zakłada administrator." },
    403
  );
});

// --- POST /login ---
auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = parseLogin(body);
  if (!parsed) {
    return c.json({ error: "Podaj login i hasło." }, 400);
  }
  const email = parsed.email.toLowerCase();
  const ipKey = clientIp(c);

  // Sprawdzenie BEZ zaliczania próby: `remaining()` nie zwiększa licznika.
  // Zaliczamy dopiero nieudaną próbę niżej, żeby poprawne logowania nie
  // zjadały puli, a zablokowany klient nie odblokował się samym czekaniem
  // na odpowiedź scryptu.
  if (loginIpLimiter.remaining(ipKey) <= 0 || loginUserLimiter.remaining(email) <= 0) {
    return c.json({ error: TOO_MANY_ATTEMPTS }, 429);
  }

  const user = findUserByEmail(email);
  // Dla nieistniejącego loginu i tak liczymy scrypt (na stałym zastępczym
  // hashu), żeby czas odpowiedzi nie zdradzał, które loginy istnieją.
  const valid = user
    ? await verifyPassword(parsed.password, user.passwordHash)
    : await burnPasswordCheck(parsed.password);
  if (!user || !valid) {
    loginIpLimiter.check(ipKey);
    loginUserLimiter.check(email);
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
