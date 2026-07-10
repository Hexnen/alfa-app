import { Hono } from "hono";
import { requireAdmin, getUser } from "../middleware/auth.js";
import {
  listUsers,
  createUserFull,
  updateUser,
  setUserPassword,
  deleteUser,
  findUserById,
  findUserByEmail,
  publicUser,
  otherAdminsCount,
} from "../lib/auth/users.js";
import { TABS } from "../lib/auth/permissions.js";

const admin = new Hono();

// Wszystkie trasy admina wymagają roli administratora.
admin.use("*", requireAdmin);

// Katalog zakładek (klucze + etykiety) — źródło prawdy dla macierzy uprawnień.
admin.get("/tabs", (c) => {
  return c.json({ success: true, data: TABS });
});

// Lista użytkowników.
admin.get("/users", (c) => {
  return c.json({ success: true, data: listUsers() });
});

// Utworzenie użytkownika.
admin.post("/users", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim()
      ? body.displayName.trim()
      : email.split("@")[0];
  if (email.length < 3 || email.length > 200) {
    return c.json({ success: false, error: "Login: min. 3 znaki." }, 400);
  }
  if (password.length < 6 || password.length > 200) {
    return c.json({ success: false, error: "Hasło: min. 6 znaków." }, 400);
  }
  if (displayName.length > 60) {
    return c.json({ success: false, error: "Nazwa wyświetlana: max 60 znaków." }, 400);
  }
  if (findUserByEmail(email)) {
    return c.json({ success: false, error: "Konto z tym loginem już istnieje." }, 409);
  }
  const role = body.role === "admin" ? "admin" : "user";
  const user = createUserFull({
    email,
    password,
    displayName,
    role,
    permissions: body.permissions,
  });
  return c.json({ success: true, data: publicUser(user) });
});

// Aktualizacja użytkownika (nazwa, rola, uprawnienia).
admin.patch("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const target = findUserById(id);
  if (!target) return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Zabezpieczenie: nie można zdegradować ostatniego admina.
  if (
    body.role !== undefined &&
    body.role !== "admin" &&
    target.role === "admin" &&
    otherAdminsCount(id) === 0
  ) {
    return c.json({ success: false, error: "Nie można zdegradować jedynego administratora." }, 400);
  }

  let displayName: string | undefined;
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || body.displayName.trim().length > 60) {
      return c.json({ success: false, error: "Nieprawidłowa nazwa wyświetlana." }, 400);
    }
    displayName = body.displayName.trim();
  }

  const updated = updateUser(id, {
    displayName,
    role: body.role === "admin" ? "admin" : body.role === "user" ? "user" : undefined,
    permissions: body.permissions,
  });
  return c.json({ success: true, data: updated ? publicUser(updated) : null });
});

// Reset hasła.
admin.put("/users/:id/password", async (c) => {
  const id = Number(c.req.param("id"));
  const target = findUserById(id);
  if (!target) return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 6 || password.length > 200) {
    return c.json({ success: false, error: "Hasło: min. 6 znaków." }, 400);
  }
  setUserPassword(id, password);
  return c.json({ success: true });
});

// Usunięcie użytkownika.
admin.delete("/users/:id", (c) => {
  const id = Number(c.req.param("id"));
  const target = findUserById(id);
  if (!target) return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  const me = getUser(c);
  if (me.id === id) {
    return c.json({ success: false, error: "Nie można usunąć własnego konta." }, 400);
  }
  if (target.role === "admin" && otherAdminsCount(id) === 0) {
    return c.json({ success: false, error: "Nie można usunąć jedynego administratora." }, 400);
  }
  deleteUser(id);
  return c.json({ success: true });
});

export default admin;
