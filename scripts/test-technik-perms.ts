/**
 * Panel admina ↔ panel technika: uprawnienia, powiązanie z kartoteką i
 * atomowość PATCH-a konta.
 *
 *   npx tsx scripts/test-on-copy.ts scripts/test-technik-perms.ts
 *   npx tsx scripts/test-technik-perms.ts       # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane:
 *   • K1 — PATCH /admin/users/:id jest W JEDNEJ transakcji: żądanie odrzucone
 *     na 400/409 nie zostawia konta ze zmienioną rolą ani z podbitą wersją,
 *     a ostatniego admina nie da się zdegradować,
 *   • S1 — konto z poziomem `view` na kluczu `technik` może sobie włączyć
 *     powiadomienia (własna preferencja, nie edycja cudzych danych), ale
 *     zapisu zleceń nadal nie ma,
 *   • S2 — podpięcie NIEAKTYWNEGO technika kończy się 409 z wyjaśnieniem,
 *     zamiast kontem, które melduje „linked: false” bez powodu,
 *   • N1 — `/auth/me` nie oddaje `technicianId` nieaktywnego technika
 *     (inaczej front pokazywałby panel, który zaraz mówi „brak powiązania”).
 *
 * Sprząta po sobie HARD (konta, sesje, subskrypcje push, technicy, dziennik),
 * także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import adminRoutes from "../src/routes/admin.js";
import technikRoutes from "../src/routes/technik.js";
import { tabPermissionGuard, technikRoleGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__TECHNIK_PERMS__";

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): void {
  const userIds = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(like(schema.users.email, `${PREFIX}%`))
    .all()
    .map((u) => u.id);
  if (userIds.length) {
    db.update(schema.technicians)
      .set({ userId: null })
      .where(inArray(schema.technicians.userId, userIds))
      .run();
    db.delete(schema.sessions).where(inArray(schema.sessions.userId, userIds)).run();
    db.delete(schema.pushSubscriptions).where(inArray(schema.pushSubscriptions.userId, userIds)).run();
    db.delete(schema.activityLog)
      .where(
        and(
          eq(schema.activityLog.entityType, "push_subscription"),
          inArray(schema.activityLog.userId, userIds)
        )
      )
      .run();
    db.delete(schema.users).where(inArray(schema.users.id, userIds)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
}
cleanup();

// ---------------------------------------------------------------------------
// Fikstury
// ---------------------------------------------------------------------------

function makeUser(suffix: string, role: string, permissions: PermissionMap = {}): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — kontekst podstawiamy wprost
      displayName: `${PREFIX}${suffix}`,
      role,
      permissions: JSON.stringify(permissions),
    })
    .returning()
    .get();
}

function makeTechnician(suffix: string, userId: number | null, active = true) {
  return db
    .insert(schema.technicians)
    .values({
      firstName: suffix,
      lastName: `${PREFIX}${suffix}`,
      type: "internal",
      active,
      userId,
    })
    .returning()
    .get();
}

/** Panel admina z kontekstem użytkownika (jak po requireAuth). */
function adminFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/api/admin", adminRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/admin${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; error?: string }
      | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Panel technika z PRAWDZIWYMI strażnikami — jak w src/routes/index.ts. */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.use("*", tabPermissionGuard);
  app.route("/api/technik", technikRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/technik${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; error?: string }
      | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

const rowOf = (id: number) => db.select().from(schema.users).where(eq(schema.users.id, id)).get()!;

const adminUser = makeUser("admin", "admin");
// Drugi admin — bez niego KAŻDA degradacja odbijałaby się o „ostatni admin”
// i test nie odróżniłby jednego zabezpieczenia od drugiego.
const admin2 = makeUser("admin2", "admin");
const viewUser = makeUser("view", "user", { technik: "view" });
const targetUser = makeUser("target", "admin");

const activeTech = makeTechnician("Aktywny", null);
const inactiveTech = makeTechnician("Nieaktywny", null, false);
const takenTech = makeTechnician("Zajety", viewUser.id);

const A = adminFor(adminUser);
const V = clientFor(viewUser);

try {
  // =========================================================================
  // 1. K1 — PATCH jest atomowy: odrzucone żądanie nie zmienia NICZEGO
  // =========================================================================
  const before = rowOf(targetUser.id);

  // (a) błąd walidacji nazwy — rola miała jechać na „technik”
  const badName = await A("PATCH", `/users/${targetUser.id}`, {
    role: "technik",
    displayName: "x".repeat(61),
  });
  const afterBadName = rowOf(targetUser.id);
  ok("K1 PATCH: za długa nazwa → 400", badName.status === 400, badName);
  ok(
    "K1 PATCH: po 400 rola została nietknięta",
    afterBadName.role === before.role,
    { przed: before.role, po: afterBadName.role }
  );
  ok(
    "K1 PATCH: po 400 wersja nie została podbita",
    afterBadName.version === before.version,
    { przed: before.version, po: afterBadName.version }
  );

  // (b) błąd wersji (optimistic lock) — rola też ma się nie ruszyć
  const badVersion = await A("PATCH", `/users/${targetUser.id}`, {
    role: "technik",
    expectedVersion: before.version + 99,
  });
  const afterBadVersion = rowOf(targetUser.id);
  ok("K1 PATCH: nieaktualna wersja → 409", badVersion.status === 409, badVersion);
  ok(
    "K1 PATCH: po 409 rola i wersja bez zmian",
    afterBadVersion.role === before.role && afterBadVersion.version === before.version,
    { role: afterBadVersion.role, version: afterBadVersion.version }
  );

  // (c) błąd powiązania z technikiem — rola ma się WYCOFAĆ razem z resztą
  const badTech = await A("PATCH", `/users/${targetUser.id}`, {
    role: "technik",
    technicianId: takenTech.id,
  });
  const afterBadTech = rowOf(targetUser.id);
  ok("K1 PATCH: zajęty technik → 409", badTech.status === 409, badTech);
  ok(
    "K1 PATCH: po 409 na techniku rola NIE została zdegradowana",
    afterBadTech.role === before.role && afterBadTech.version === before.version,
    { role: afterBadTech.role, version: afterBadTech.version }
  );

  // (d) poprawne żądanie przechodzi w całości
  const good = await A("PATCH", `/users/${targetUser.id}`, {
    role: "technik",
    displayName: `${PREFIX}target`,
    technicianId: activeTech.id,
    expectedVersion: before.version,
  });
  const afterGood = rowOf(targetUser.id);
  ok(
    "K1 PATCH: poprawne żądanie → 200, rola `technik` i powiązanie",
    good.status === 200 &&
      afterGood.role === "technik" &&
      afterGood.version === before.version + 1 &&
      (good.data as { technicianId?: number | null })?.technicianId === activeTech.id,
    { status: good.status, role: afterGood.role, data: good.data }
  );
  ok(
    "K1 PATCH: degradacja zapisuje rolę z koercji, nie literał „user”",
    afterGood.role === "technik",
    afterGood.role
  );

  // =========================================================================
  // 2. K1 — ostatniego admina nie da się zdegradować
  // =========================================================================
  // Zostaje dokładnie jeden admin z prefiksem… ale w bazie są też prawdziwi
  // admini, więc scenariusz „ostatni” budujemy na kopii: chowamy wszystkich
  // POZOSTAŁYCH adminów na czas tego sprawdzenia.
  const otherAdmins = db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.role, "admin"))
    .all()
    .filter((u) => u.id !== adminUser.id);
  db.update(schema.users)
    .set({ role: "user" })
    .where(inArray(schema.users.id, otherAdmins.map((u) => u.id)))
    .run();
  const soleBefore = rowOf(adminUser.id);
  const demoteSole = await A("PATCH", `/users/${adminUser.id}`, { role: "user" });
  const soleAfter = rowOf(adminUser.id);
  ok(
    "K1 PATCH: degradacja JEDYNEGO admina → 400",
    demoteSole.status === 400 && /jedynego administratora/i.test(demoteSole.error ?? ""),
    demoteSole
  );
  ok(
    "K1 PATCH: jedyny admin zostaje adminem, wersja bez zmian",
    soleAfter.role === "admin" && soleAfter.version === soleBefore.version,
    { role: soleAfter.role, version: soleAfter.version }
  );
  // Przywracamy adminów (admin2 musi wrócić, żeby dalsze testy miały „innego”).
  db.update(schema.users)
    .set({ role: "admin" })
    .where(inArray(schema.users.id, otherAdmins.map((u) => u.id)))
    .run();
  ok(
    "K1 PATCH: gdy jest drugi admin, degradacja przechodzi",
    (await A("PATCH", `/users/${admin2.id}`, { role: "user" })).status === 200 &&
      rowOf(admin2.id).role === "user",
    rowOf(admin2.id).role
  );

  // =========================================================================
  // 3. S2 — nieaktywny technik nie da się podpiąć po cichu
  // =========================================================================
  const inactiveLink = await A("PATCH", `/users/${targetUser.id}`, { technicianId: inactiveTech.id });
  ok(
    "S2 PATCH: nieaktywny technik → 409 z wyjaśnieniem",
    inactiveLink.status === 409 && /nieaktywny/i.test(inactiveLink.error ?? ""),
    inactiveLink
  );
  ok(
    "S2 PATCH: po odmowie konto zostaje przy dotychczasowym techniku",
    db.select().from(schema.technicians).where(eq(schema.technicians.id, activeTech.id)).get()?.userId ===
      targetUser.id,
    db.select().from(schema.technicians).where(eq(schema.technicians.id, activeTech.id)).get()?.userId
  );

  // =========================================================================
  // 4. N1 — dezaktywacja technika znika z powiązania widocznego dla frontu
  // =========================================================================
  const { findTechnicianByUserId } = await import("../src/lib/calendar-queries.js");
  db.update(schema.technicians)
    .set({ active: false })
    .where(eq(schema.technicians.id, activeTech.id))
    .run();
  const brief = findTechnicianByUserId(targetUser.id, db);
  ok(
    "N1: brief technika niesie flagę `active` (front ma po czym filtrować)",
    brief != null && brief.active === false,
    brief
  );
  const panelMe = await clientFor(rowOf(targetUser.id))("GET", "/me");
  ok(
    "N1: panel nieaktywnego technika → linked: false (spójnie z /auth/me)",
    panelMe.status === 200 && (panelMe.data as { linked?: boolean })?.linked === false,
    panelMe
  );
  db.update(schema.technicians)
    .set({ active: true })
    .where(eq(schema.technicians.id, activeTech.id))
    .run();

  // =========================================================================
  // 5. S1 — konto „tylko do odczytu” a powiadomienia
  // =========================================================================
  const SUB = {
    endpoint: "https://push.example.invalid/__TECHNIK_PERMS__/view",
    keys: { p256dh: "BFakeP256dhKeyForTests0000000000", auth: "FakeAuthSecret00" },
  };
  const vapidBefore = {
    pub: process.env.VAPID_PUBLIC_KEY,
    priv: process.env.VAPID_PRIVATE_KEY,
  };
  process.env.VAPID_PUBLIC_KEY =
    "BHeY6wM8hTPdvjAOacOvbuZJsf5gHibjKgRLKgY-NpO0EidxCWVeMaKrNszZrGXftTHjjKSrqs34tAgYgTOsBzo";
  process.env.VAPID_PRIVATE_KEY = "0bw6pjCvok_06kE6DrpV2AclukIo2cHuLjXW5rqrwE0";
  try {
    ok("S1 push: konto z „view” zapisuje subskrypcję → 201", (await V("POST", "/push/subscribe", SUB)).status === 201);
    ok(
      "S1 push: …i odczytuje swój stan",
      ((await V("GET", `/push/subscribe?endpoint=${encodeURIComponent(SUB.endpoint)}`)).data as {
        subscribed?: boolean;
      })?.subscribed === true
    );
    ok(
      "S1 push: konto z „view” wypisuje własną subskrypcję → 200",
      (await V("DELETE", "/push/subscribe", { endpoint: SUB.endpoint })).status === 200
    );
    // …ale to nadal konto tylko do odczytu: zapisu zleceń nie dostaje.
    ok(
      "S1: konto z „view” nadal nie zapisuje notatek (403)",
      (await V("POST", "/jobs/1/notes", { text: "x" })).status === 403
    );
  } finally {
    if (vapidBefore.pub === undefined) delete process.env.VAPID_PUBLIC_KEY;
    else process.env.VAPID_PUBLIC_KEY = vapidBefore.pub;
    if (vapidBefore.priv === undefined) delete process.env.VAPID_PRIVATE_KEY;
    else process.env.VAPID_PRIVATE_KEY = vapidBefore.priv;
  }
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
