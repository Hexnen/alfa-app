import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
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
  // Szybka ścieżka; ostateczną wyłączność loginu egzekwuje UNIQUE(email) niżej,
  // co eliminuje wyścig check-then-insert (dwa równoległe POST z tym samym loginem).
  if (findUserByEmail(email)) {
    return c.json({ success: false, error: "Konto z tym loginem już istnieje." }, 409);
  }
  const role = body.role === "admin" ? "admin" : "user";
  let user;
  try {
    user = createUserFull({
      email,
      password,
      displayName,
      role,
      permissions: body.permissions,
    });
  } catch (e) {
    if (e instanceof Error && /UNIQUE|constraint/i.test(e.message)) {
      return c.json({ success: false, error: "Konto z tym loginem już istnieje." }, 409);
    }
    throw e;
  }
  return c.json({ success: true, data: publicUser(user) });
});

// Aktualizacja użytkownika (nazwa, rola, uprawnienia).
admin.patch("/users/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const target = findUserById(id);
  if (!target) return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

  // Zabezpieczenie: nie można zdegradować ostatniego admina.
  // Warunek i zapis w jednym atomowym UPDATE (podzapytanie liczy pozostałych
  // adminów), więc dwa równoległe żądania degradacji nie zostawią 0 adminów.
  if (body.role !== undefined && body.role !== "admin" && target.role === "admin") {
    const res = db.run(
      sql`UPDATE users SET role = 'user' WHERE id = ${id} AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ${id}) > 0`,
    );
    if (res.changes === 0) {
      // 0 zmian ma dwie przyczyny: wiersz zniknął (równoległy DELETE między
      // odczytem body a tym UPDATE) albo to jedyny admin. Rozróżniamy je
      // ponownym odczytem, aby nie zwracać mylącego komunikatu o adminie.
      if (!findUserById(id)) {
        return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
      }
      return c.json({ success: false, error: "Nie można zdegradować jedynego administratora." }, 400);
    }
  }

  let displayName: string | undefined;
  if (body.displayName !== undefined) {
    if (typeof body.displayName !== "string" || body.displayName.trim().length > 60) {
      return c.json({ success: false, error: "Nieprawidłowa nazwa wyświetlana." }, 400);
    }
    displayName = body.displayName.trim();
  }

  // Optimistic concurrency: front odsyła wersję, którą wczytał. Jeśli inny admin
  // zapisał w międzyczasie, wersja się nie zgadza i zwracamy 409 zamiast po cichu
  // nadpisać jego zmiany (lost update na mapie uprawnień).
  const expectedVersion =
    typeof body.expectedVersion === "number" ? body.expectedVersion : undefined;
  const result = updateUser(
    id,
    {
      displayName,
      role: body.role === "admin" ? "admin" : body.role === "user" ? "user" : undefined,
      permissions: body.permissions,
    },
    expectedVersion,
  );
  if (!result.ok) {
    if (result.reason === "conflict") {
      return c.json(
        {
          success: false,
          error:
            "Ten użytkownik został zmieniony przez kogoś innego. Odśwież i zapisz ponownie.",
        },
        409,
      );
    }
    return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  }
  return c.json({ success: true, data: publicUser(result.user) });
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
  // Warunek "istnieje inny admin" i samo usunięcie w jednym atomowym DELETE
  // (podzapytanie), więc dwa równoległe usunięcia nie zostawią 0 adminów.
  if (target.role === "admin") {
    const res = db.run(
      sql`DELETE FROM users WHERE id = ${id} AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ${id}) > 0`,
    );
    if (res.changes === 0) {
      return c.json({ success: false, error: "Nie można usunąć jedynego administratora." }, 400);
    }
  } else {
    deleteUser(id);
  }
  return c.json({ success: true });
});

export default admin;
