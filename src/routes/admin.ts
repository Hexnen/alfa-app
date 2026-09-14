import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { requireAdmin, getUser } from "../middleware/auth.js";
import {
  listUsers,
  listTechniciansLite,
  createUserFull,
  updateUser,
  setUserPassword,
  deleteUser,
  findUserById,
  findUserByEmail,
  publicUser,
  revokeCalendarToken,
  setUserTechnician,
  technicianIdOfUser,
  findTechnicianOwner,
  unlinkUserFromDirectories,
  coerceRole,
} from "../lib/auth/users.js";
import { TABS } from "../lib/auth/permissions.js";

const admin = new Hono();

/** Sygnał wewnątrz transakcji: „to jedyny admin" — wycofuje zapis (patrz DELETE /users/:id). */
class LastAdminError extends Error {}

// Wszystkie trasy admina wymagają roli administratora.
admin.use("*", requireAdmin);

// Katalog zakładek (klucze + etykiety) — źródło prawdy dla macierzy uprawnień.
admin.get("/tabs", (c) => {
  return c.json({ success: true, data: TABS });
});

/**
 * Technicy do selecta „Powiązany technik" w karcie użytkownika. Osobny, wąski
 * endpoint zamiast pełnego /api/technicians: panel admina ma konto podpiąć, a nie
 * pokazywać kartotekę techników (stawki, cenniki, kadry) — i wołają go admini,
 * którzy niekoniecznie mają klucz `technical/technicy`.
 */
admin.get("/technicians-lite", (c) => {
  return c.json({ success: true, data: listTechniciansLite() });
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
  const role = coerceRole(body.role);
  // `technicianId` sprawdzamy PRZED założeniem konta, żeby oczywista pomyłka
  // (technik już podpięty) nie zostawiała w bazie konta-sieroty. Wyścigu to nie
  // zamyka — rozstrzyga go dopiero `setUserTechnician` w transakcji, niżej.
  const technicianIdRaw = body.technicianId;
  if (
    technicianIdRaw !== undefined &&
    technicianIdRaw !== null &&
    !Number.isInteger(technicianIdRaw)
  ) {
    return c.json({ success: false, error: "Nieprawidłowy technik." }, 400);
  }
  if (typeof technicianIdRaw === "number") {
    const taken = findTechnicianOwner(technicianIdRaw);
    if (taken === "notfound") {
      return c.json({ success: false, error: "Wskazany technik nie istnieje." }, 400);
    }
    if (taken !== null) {
      return c.json({ success: false, error: "Ten technik jest już powiązany z innym kontem." }, 409);
    }
  }
  let user;
  try {
    user = await createUserFull({
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
  if (technicianIdRaw !== undefined) {
    const linked = setUserTechnician(user.id, (technicianIdRaw as number | null) ?? null);
    if (!linked.ok) {
      // Konto już istnieje — nie wycofujemy go, tylko mówimy wprost, że samo
      // powiązanie się nie udało (admin poprawi je edycją).
      return c.json(
        {
          success: false,
          error:
            linked.reason === "taken"
              ? "Konto założone, ale ten technik jest już powiązany z innym kontem."
              : "Konto założone, ale wskazany technik nie istnieje.",
          data: publicUser(user, null),
        },
        409,
      );
    }
  }
  return c.json({ success: true, data: publicUser(user, technicianIdOfUser(user.id)) });
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
    // Rola z koercji, nie literał 'user': degradacja admina na technika ma od razu
    // zapisać 'technik'. Wcześniej ten UPDATE wpisywał twardo 'user', a właściwy
    // zapis roli szedł dopiero niżej — konto przez chwilę było zwykłym userem
    // z pełną mapą uprawnień admina.
    const newRole = coerceRole(body.role);
    const res = db.run(
      sql`UPDATE users SET role = ${newRole} WHERE id = ${id} AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ${id}) > 0`,
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
      role: body.role === undefined ? undefined : coerceRole(body.role),
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

  // Powiązanie z kartoteką techników. POZA `users.version`: to kolumna w
  // `technicians`, a nie pole konta — optimistic lock na użytkowniku nie ma tu
  // czego pilnować. Pominięte pole = bez zmian, `null` = odepnij.
  if (body.technicianId !== undefined) {
    if (body.technicianId !== null && !Number.isInteger(body.technicianId)) {
      return c.json({ success: false, error: "Nieprawidłowy technik." }, 400);
    }
    const linked = setUserTechnician(id, (body.technicianId as number | null) ?? null);
    if (!linked.ok) {
      return c.json(
        {
          success: false,
          error:
            linked.reason === "taken"
              ? "Ten technik jest już powiązany z innym kontem."
              : "Wskazany technik nie istnieje.",
        },
        409,
      );
    }
  }
  return c.json({ success: true, data: publicUser(result.user, technicianIdOfUser(id)) });
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
  await setUserPassword(id, password);
  return c.json({ success: true });
});

// Unieważnienie tokenu subskrypcji ICS cudzego konta (gdy link do kalendarza
// wyciekł). Reset hasła robi to samo przy okazji, ale tu nie ruszamy ani hasła,
// ani sesji — użytkownik dalej pracuje, tylko feed przestaje działać.
admin.delete("/users/:id/calendar-token", (c) => {
  const id = Number(c.req.param("id"));
  if (!revokeCalendarToken(id)) {
    return c.json({ success: false, error: "Nie znaleziono użytkownika." }, 404);
  }
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
  // Powiązania z kartotekami (technik, handlowiec) zdejmujemy w TEJ SAMEJ
  // transakcji: bez tego klucz obcy `technicians.user_id` / `salespeople.user_id`
  // odrzuca DELETE i admin dostaje 500. Gdy okaże się, że to jedyny admin,
  // transakcja wraca w całości — powiązania zostają nietknięte.
  if (target.role === "admin") {
    let deleted = false;
    try {
      db.transaction((tx) => {
        unlinkUserFromDirectories(tx, id);
        const res = tx.run(
          sql`DELETE FROM users WHERE id = ${id} AND (SELECT COUNT(*) FROM users WHERE role = 'admin' AND id <> ${id}) > 0`,
        );
        if (res.changes === 0) throw new LastAdminError();
        deleted = true;
      });
    } catch (e) {
      if (!(e instanceof LastAdminError)) throw e;
    }
    if (!deleted) {
      return c.json({ success: false, error: "Nie można usunąć jedynego administratora." }, 400);
    }
  } else {
    deleteUser(id);
  }
  return c.json({ success: true });
});

export default admin;
