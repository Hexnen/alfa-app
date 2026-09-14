/**
 * Panel technika (/api/technik) — trasy Hono przez `app.request`, z podstawionym
 * userem w kontekście i PRAWDZIWYMI strażnikami (`technikRoleGuard`,
 * `tabPermissionGuard`):
 *   npx tsx scripts/test-on-copy.ts scripts/test-technik.ts
 *   npx tsx scripts/test-technik.ts            # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane:
 *   • technik widzi WYŁĄCZNIE zlecenia, do których jest przypisany — cudze 404,
 *   • dział handlowy, urlopy, anulowane i usunięte nie wchodzą na listę
 *     (router świadomie nie używa calendar-scope, patrz src/routes/technik.ts),
 *   • „Rozpocznij" jest idempotentne i podbija planned → confirmed,
 *   • „Zakończ" idzie wspólną ścieżką mutacji: wydarzenie dostaje realizację
 *     (dowód, że zadziałało `onEventUpdated`, a nie surowy UPDATE),
 *   • protokół: 201 z numerem, drugi raz 409; PUT + podpis → status final
 *     i `content_hash`; PUT po podpisie 409; cudzy protokół 404,
 *   • rola `technik` nie wychodzi poza swój moduł (objects / admin / calendar → 403),
 *   • konto `user` bez klucza → 403, z `view` → GET 200 / POST 403, z `edit` → 200,
 *   • konto bez powiązania z kartoteką → `linked: false`, pusta lista, mutacje 409.
 *
 * Sprząta po sobie HARD (wydarzenia, notatki, przypisania, realizacje z protokołami
 * i wycenami, obiekt, kontrahent, technicy, konta, dziennik), także przy błędzie.
 */
import { Hono } from "hono";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { and, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import technikRoutes from "../src/routes/technik.js";
import objectsRoutes from "../src/routes/objects.js";
import calendarRoutes from "../src/routes/calendar.js";
import adminRoutes from "../src/routes/admin.js";
import protocolsRoutes from "../src/routes/protocols.js";
import adminTechnikRoutes from "../src/routes/admin-technik.js";
import { TECHNIK_ACTIVITIES_KEY } from "../src/lib/technik-config.js";
import { removeEventAttachmentDir, resolveStoredPath } from "../src/lib/calendar-attachments.js";
import { addNote, createEvent, deleteEvent, deleteNote, moveEvent, parseInput, updateNote } from "../src/lib/calendar-mutations.js";
import { flushPush, notifyTechnicians, setPushTransport, type PushPayload } from "../src/lib/push.js";
import { deleteSetting, getSetting, setSetting } from "../src/lib/settings.js";
import { tabPermissionGuard, technikRoleGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__TECHNIK_TEST__";
const DAY = "2026-11-10";
const RANGE = `?from=${DAY}&to=2026-11-12`;

/**
 * Dni liczone od DZISIAJ — „Inna godzina” z definicji dotyczy chwili, która już
 * była (backend odrzuca przyszłość), a stałe fikstury stoją w listopadzie.
 */
function dayOffset(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
const PAST_DAY = dayOffset(-1);
const FUTURE_DAY = dayOffset(1);

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): number {
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  // Realizacje założone automatem: w notatce mają „[Kalendarz #id] <tytuł>".
  const realizationIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(or(like(schema.realizations.note, `%${PREFIX}%`), like(schema.realizations.site, `%${PREFIX}%`)))
    .all()
    .map((r) => r.id);

  if (eventIds.length) {
    // Zdjęcia z notatek leżą na dysku (<DATA_DIR>/attachments/<eventId>) — same
    // z kasowaniem wierszy nie znikną, a test nie ma zostawiać śmieci.
    for (const id of eventIds) removeEventAttachmentDir(id);
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (realizationIds.length) {
    const protocolIds = db
      .select({ id: schema.protocols.id })
      .from(schema.protocols)
      .where(inArray(schema.protocols.realizationId, realizationIds))
      .all()
      .map((r) => r.id);
    if (protocolIds.length) {
      db.delete(schema.activityLog)
        .where(and(eq(schema.activityLog.entityType, "protocol"), inArray(schema.activityLog.entityId, protocolIds)))
        .run();
    }
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "realization"), inArray(schema.activityLog.entityId, realizationIds)))
      .run();
    // protocols / quotes wiszą na realizacji przez ON DELETE CASCADE.
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realizationIds)).run();
  }
  db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run();
  const objectIds = db
    .select({ id: schema.objects.id })
    .from(schema.objects)
    .where(like(schema.objects.name, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (objectIds.length) {
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "object"), inArray(schema.activityLog.entityId, objectIds)))
      .run();
    db.delete(schema.objects).where(inArray(schema.objects.id, objectIds)).run();
  }
  db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
    // Subskrypcje push wiszą na koncie przez ON DELETE CASCADE, ale kasujemy je
    // jawnie — skrypt musi sprzątać także wtedy, gdy klucze obce są wyłączone.
    db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
  return eventIds.length;
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

/** Aplikacja panelu technika: kontekst jak po requireAuth + oba prawdziwe strażniki. */
function panelAppFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.use("*", tabPermissionGuard);
  app.route("/api/technik", technikRoutes);
  return app;
}

/**
 * Klient panelu — JSON albo multipart (`FormData`, np. zdjęcie z tabletu).
 * Odpowiedzi binarne (plik załącznika) czyta się przez `panelAppFor` wprost.
 */
function clientFor(user: User) {
  const app = panelAppFor(user);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/technik${path}`, {
      method,
      ...(body instanceof FormData
        ? { body }
        : body !== undefined
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; error?: string; message?: string }
      | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/**
 * Panel admina → Panel technika. Ta sama kolejność middleware co w
 * src/routes/index.ts: najpierw `technikRoleGuard` (odcina rolę `technik` od
 * całego /api poza /api/technik/*), potem router z własnym `requireAdmin`.
 */
function adminTechnikFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.route("/api/admin/technik", adminTechnikRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/admin/technik${path}`, {
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

/**
 * Biurowa trasa protokołów (`/api/protocols`) z kontekstem admina — tą samą
 * drogą, którą chodzi dialog na desktopie. Panel i biuro dzielą jedno ciało
 * logiki (src/lib/protocols.ts), więc notatka systemowa musi się aktualizować
 * z OBU wejść.
 */
function officeProtocolsFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.route("/api/protocols", protocolsRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/protocols${path}`, {
      method,
      ...(body !== undefined
        ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
        : {}),
    });
    const json = (await res.json().catch(() => null)) as
      | { success?: boolean; data?: unknown; error?: string; message?: string }
      | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Ten sam zestaw strażników, ale inne moduły — czy technik z nich nie wyjdzie. */
function outsideFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", technikRoleGuard);
  app.route("/api/admin", adminRoutes);
  app.use("*", tabPermissionGuard);
  app.route("/api/objects", objectsRoutes);
  app.route("/api/calendar", calendarRoutes);
  return async (path: string) => ({ status: (await app.request(path)).status });
}

const techUser = makeUser("tech", "technik");
const otherUser = makeUser("other", "technik");
const unlinkedUser = makeUser("nolink", "technik");
const viewUser = makeUser("view", "user", { technik: "view" });
const editUser = makeUser("edit", "user", { technik: "edit" });
const noKeyUser = makeUser("nokey", "user", { objects: "edit" });
const adminUser = makeUser("admin", "admin");

const tech = makeTechnician("Adam", techUser.id);
const otherTech = makeTechnician("Bogdan", otherUser.id);
const viewTech = makeTechnician("Celina", viewUser.id);
const editTech = makeTechnician("Damian", editUser.id);

const T = clientFor(techUser);
const O = clientFor(otherUser);
const N = clientFor(unlinkedUser);
const V = clientFor(viewUser);
const E = clientFor(editUser);
const K = clientFor(noKeyUser);
const A = adminTechnikFor(adminUser);
const TA = adminTechnikFor(techUser);
/** Surowa aplikacja technika — do odpowiedzi, które nie są JSON-em (pliki załączników). */
const TRaw = panelAppFor(techUser);

/**
 * Słownik czynności żyje w `app_settings` — wspólnej tabeli, nie w wierszach
 * z prefiksem testowym. Zapamiętujemy stan sprzed testu i oddajemy go w finally,
 * żeby przejechanie skryptu po prawdziwej bazie nie skasowało ustawień admina.
 */
const activitiesBefore =
  db.select().from(schema.appSettings).where(eq(schema.appSettings.key, TECHNIK_ACTIVITIES_KEY)).get() ?? null;

function restoreActivitiesSetting() {
  db.delete(schema.appSettings).where(eq(schema.appSettings.key, TECHNIK_ACTIVITIES_KEY)).run();
  if (activitiesBefore) db.insert(schema.appSettings).values(activitiesBefore).run();
  db.delete(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "app_settings"), eq(schema.activityLog.field, TECHNIK_ACTIVITIES_KEY)))
    .run();
}

/**
 * Dystans z czasem przejazdu testujemy BEZ SIECI: biuro dostaje współrzędne
 * wprost, a `company.km_source` na czas testu to „linia prosta” (OSRM wyszedłby
 * do internetu). Ustawienia firmy są wspólne dla całej aplikacji — zapamiętujemy
 * je tak samo jak słownik czynności i oddajemy w finally.
 */
const COMPANY_KEYS = ["company.office_lat", "company.office_lng", "company.km_source"] as const;
const companyBefore = new Map<string, string | null>(COMPANY_KEYS.map((k) => [k, getSetting(k)]));

function restoreCompanySettings() {
  for (const [key, value] of companyBefore) {
    if (value === null) deleteSetting(key);
    else setSetting(key, value, null);
  }
}

/**
 * Klucz publiczny VAPID do testów. Prawdziwa para nie jest tu do niczego
 * potrzebna — wysyłka idzie przez podstawiony transport, a klucz sprawdzamy
 * tylko jako wartość przepisywaną z env do odpowiedzi `push/config`.
 */
const TEST_VAPID_PUBLIC = "BHeY6wM8hTPdvjAOacOvbuZJsf5gHibjKgRLKgY-NpO0EidxCWVeMaKrNszZrGXftTHjjKSrqs34tAgYgTOsBzo";

/** Klucze VAPID sprzed testu — skrypt na prawdziwej bazie nie może zmienić env procesu na trwałe. */
const pushEnvBefore = {
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT,
};

function restorePushEnv() {
  for (const [k, v] of Object.entries(pushEnvBefore)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// Skrypt uruchamiany lokalnie mógłby mieć klucze z `.env` — sekcja push ma
// zaczynać od stanu „push wyłączony", niezależnie od środowiska.
delete process.env.VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

/** Subskrypcje push danego konta. */
function subsOf(userId: number) {
  return db
    .select()
    .from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.userId, userId))
    .all();
}

const contractor = db
  .insert(schema.contractors)
  .values({
    name: `${PREFIX} Kontrahent`,
    nip: `9${String(Date.now()).slice(-9)}`,
    contactPerson: "Pani Basia",
    phone: "600100200",
    city: "Poznań",
  })
  .returning()
  .get();

const object = db
  .insert(schema.objects)
  .values({
    contractorId: contractor.id,
    name: `${PREFIX} Obiekt`,
    address: "Testowa 1",
    city: "Poznań",
    type: "monitoring",
    installationType: "new",
    mapsUrl: "https://maps.google.com/?q=test",
  })
  .returning()
  .get();

function insertEvent(p: {
  title: string;
  type: "serwis" | "montaz" | "urlop" | "spotkanie";
  department?: "technical" | "handlowy";
  status?: "planned" | "confirmed" | "done" | "cancelled";
  technicianIds: number[];
  deleted?: boolean;
  hour?: number;
  withObject?: boolean;
  /** Dzień wydarzenia (domyślnie DAY) — testy „innej godziny” potrzebują przeszłości. */
  day?: string;
}) {
  const h = String(p.hour ?? 9).padStart(2, "0");
  const day = p.day ?? DAY;
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: p.type,
      title: `${PREFIX} ${p.title}`,
      description: "Wymiana kamery przy bramie",
      startAt: `${day}T${h}:00`,
      endAt: `${day}T${String(Number(h) + 1).padStart(2, "0")}:00`,
      allDay: false,
      status: p.status ?? "planned",
      department: p.department ?? "technical",
      objectId: p.withObject === false ? null : object.id,
      createdBy: techUser.id,
      updatedBy: techUser.id,
      ...(p.deleted ? { deletedAt: new Date().toISOString() } : {}),
    })
    .returning()
    .get();
  for (const id of p.technicianIds) {
    db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
  }
  return ev.id;
}

const ids = (r: { data?: unknown }) => ((r.data as { id: number }[] | undefined) ?? []).map((e) => e.id);

try {
  const job = insertEvent({ title: "Serwis mój", type: "serwis", technicianIds: [tech.id, viewTech.id, editTech.id] });
  const jobStart = insertEvent({ title: "Do rozpoczęcia", type: "serwis", technicianIds: [tech.id], hour: 10 });
  const jobFinish = insertEvent({ title: "Do zakonczenia", type: "montaz", technicianIds: [tech.id], hour: 11 });
  const jobProtocol = insertEvent({ title: "Do protokolu", type: "serwis", technicianIds: [tech.id], hour: 12 });
  const otherJob = insertEvent({ title: "Serwis cudzy", type: "serwis", technicianIds: [otherTech.id], hour: 13 });
  const salesJob = insertEvent({
    title: "Spotkanie handlowe",
    type: "spotkanie",
    department: "handlowy",
    technicianIds: [tech.id],
    hour: 14,
  });
  const vacationJob = insertEvent({ title: "Urlop", type: "urlop", technicianIds: [tech.id], hour: 15 });
  const cancelledJob = insertEvent({ title: "Anulowane", type: "serwis", status: "cancelled", technicianIds: [tech.id], hour: 16 });
  const deletedJob = insertEvent({ title: "Usuniete", type: "serwis", technicianIds: [tech.id], deleted: true, hour: 17 });

  // =========================================================================
  // 1. GET /me — powiązanie i liczniki
  // =========================================================================
  const me = await T("GET", "/me");
  const meData = me.data as { linked?: boolean; technician?: { id: number }; counts?: Record<string, number> };
  ok("me: konto powiązane z technikiem", me.status === 200 && meData?.linked === true, me);
  ok("me: zwraca powiązanego technika", meData?.technician?.id === tech.id, meData?.technician);
  ok("me: liczniki są liczbami", typeof meData?.counts?.today === "number" && typeof meData?.counts?.inProgress === "number", meData?.counts);

  // Żółta plakietka: zmiany od `seenToday`, ale tylko cudzą ręką.
  const past = new Date(Date.now() - 3600_000).toISOString();
  const future = new Date(Date.now() + 3600_000).toISOString();
  const counts = async (q: string) =>
    ((await T("GET", `/me${q}`)).data as { counts: Record<string, number> }).counts;
  ok("me: bez znacznika changedToday = 0", (await counts(""))?.changedToday === 0);
  ok("me: własne zmiany nie liczą się jako nowe", (await counts(`?seenToday=${past}`))?.changedToday === 0);
  // Fikstury stoją w listopadzie, a okno „dziś” liczy się od prawdziwej daty —
  // stąd osobne, dzisiejsze zlecenie zmienione „ręką biura” (otherUser).
  const todayJob = insertEvent({ title: "Serwis dzisiejszy", type: "serwis", technicianIds: [tech.id], day: dayOffset(0), hour: 20 });
  db.update(schema.calendarEvents)
    .set({ updatedBy: otherUser.id, updatedAt: sql`(datetime('now'))` })
    .where(eq(schema.calendarEvents.id, todayJob))
    .run();
  const c1 = await counts(`?seenToday=${past}&seenUpcoming=${past}`);
  ok("me: zmiana cudzą ręką po znaczniku liczy się (dziś)", c1?.changedToday === 1, c1);
  ok("me: …i w oknie nadchodzących", c1?.changedUpcoming === 1, c1);
  ok("me: znacznik z przyszłości = nic nowego", (await counts(`?seenToday=${future}`))?.changedToday === 0);
  ok("me: śmieć w znaczniku = 0, nie 400", (await T("GET", "/me?seenToday=abc")).status === 200);

  // =========================================================================
  // 2. Lista zleceń — tylko własne przypisania i tylko prace na obiekcie
  // =========================================================================
  const list = await T("GET", `/jobs${RANGE}`);
  const listIds = ids(list);
  ok("lista: zawiera własne zlecenia", [job, jobStart, jobFinish, jobProtocol].every((id) => listIds.includes(id)), listIds);
  ok("lista: NIE zawiera cudzego zlecenia", !listIds.includes(otherJob), listIds);
  ok("lista: NIE zawiera wydarzenia handlowego", !listIds.includes(salesJob), listIds);
  ok("lista: NIE zawiera urlopu", !listIds.includes(vacationJob), listIds);
  ok("lista: NIE zawiera anulowanego", !listIds.includes(cancelledJob), listIds);
  ok("lista: NIE zawiera usuniętego", !listIds.includes(deletedJob), listIds);

  const first = ((list.data as Record<string, unknown>[]) ?? []).find((j) => j.id === job);
  ok("JobJson: obiekt, adres i kontakt z kartoteki", first?.objectName === `${PREFIX} Obiekt` && first?.address === "Testowa 1, Poznań" && first?.contactPerson === "Pani Basia", first);
  ok("JobJson: bez kwot i rozliczenia", first != null && !("billing" in first) && !("amountHours" in first), Object.keys(first ?? {}));
  ok("JobJson: pozostali technicy na zleceniu", Array.isArray(first?.coTechnicians) && (first?.coTechnicians as string[]).length === 2, first?.coTechnicians);

  // =========================================================================
  // 3. Szczegóły zlecenia — cudze 404
  // =========================================================================
  const detail = await T("GET", `/jobs/${job}`);
  ok("szczegóły: własne zlecenie → 200 z notatkami", detail.status === 200 && Array.isArray((detail.data as { notes?: unknown[] })?.notes), detail);
  ok("szczegóły: cudze zlecenie → 404", (await T("GET", `/jobs/${otherJob}`)).status === 404);
  ok("szczegóły: wydarzenie handlowe → 404", (await T("GET", `/jobs/${salesJob}`)).status === 404);
  ok("szczegóły: urlop → 404", (await T("GET", `/jobs/${vacationJob}`)).status === 404);

  // =========================================================================
  // 4. Rozpocznij — idempotentne, planned → confirmed
  // =========================================================================
  const start1 = await T("POST", `/jobs/${jobStart}/start`);
  const started = start1.data as { status?: string; startedAt?: string | null };
  ok("start: 200 i znacznik rozpoczęcia", start1.status === 200 && !!started?.startedAt, start1);
  ok("start: planned → confirmed", started?.status === "confirmed", started);
  const start2 = await T("POST", `/jobs/${jobStart}/start`);
  const started2 = start2.data as { startedAt?: string | null };
  ok("start: drugi raz nie przestawia godziny (idempotentnie)", start2.status === 200 && started2?.startedAt === started?.startedAt, start2);
  const startNotes = db
    .select({ id: schema.calendarEventNotes.id })
    .from(schema.calendarEventNotes)
    .where(eq(schema.calendarEventNotes.eventId, jobStart))
    .all();
  ok("start: dokładnie jedna notatka systemowa", startNotes.length === 1, startNotes.length);
  ok("start: cudze zlecenie → 404", (await T("POST", `/jobs/${otherJob}/start`)).status === 404);

  // =========================================================================
  // 5. Zakończ — status done + realizacja (dowód na onEventUpdated)
  // =========================================================================
  const finish = await T("POST", `/jobs/${jobFinish}/finish`, { note: "Wymieniono kamerę" });
  const finished = finish.data as { status?: string; finishedAt?: string | null };
  ok("finish: 200, status done i znacznik zakończenia", finish.status === 200 && finished?.status === "done" && !!finished?.finishedAt, finish);
  const finishedRow = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, jobFinish)).get();
  ok("finish: wspólna ścieżka mutacji założyła realizację", finishedRow?.realizationId != null, finishedRow?.realizationId);
  ok("finish: startedAt uzupełniony mimo braku „Rozpocznij”", finishedRow?.startedAt != null, finishedRow?.startedAt);

  // =========================================================================
  // 6. Protokół — 201, drugi raz 409
  // =========================================================================
  const proto1 = await T("POST", `/jobs/${jobProtocol}/protocol`);
  const protoBrief = (proto1.data as { protocol?: { id: number; number: string } })?.protocol;
  ok("protokół: 201 z numerem", proto1.status === 201 && !!protoBrief?.number, proto1);
  const proto2 = await T("POST", `/jobs/${jobProtocol}/protocol`);
  ok("protokół: drugi raz → 409", proto2.status === 409, proto2);
  const protocolId = protoBrief?.id ?? 0;

  ok("protokół: cudze zlecenie → 404", (await T("POST", `/jobs/${otherJob}/protocol`)).status === 404);

  // =========================================================================
  // 7. Protokół: GET / PUT / podpis
  // =========================================================================
  const getProto = await T("GET", `/protocols/${protocolId}`);
  ok("protokół: GET własnego → 200", getProto.status === 200, getProto);
  ok("protokół: cudzy → 404", (await O("GET", `/protocols/${protocolId}`)).status === 404);

  const put = await T("PUT", `/protocols/${protocolId}`, {
    workDate: DAY,
    workType: "serwis",
    actualHours: 2,
    actualKm: 15,
    activities: "Wymiana kamery, test nagrań",
    items: [{ name: "Kamera IP", serial: "SN-1", unit: "szt.", qty: "1" }],
  });
  ok("protokół: PUT zapisuje treść", put.status === 200 && (put.data as { activities?: string })?.activities === "Wymiana kamery, test nagrań", put);
  ok("protokół: PUT zapisuje pozycje", ((put.data as { items?: unknown[] })?.items ?? []).length === 1, (put.data as { items?: unknown[] })?.items);

  ok("protokół: cudzy PUT → 404", (await O("PUT", `/protocols/${protocolId}`, { activities: "hack" })).status === 404);

  const badSign = await T("POST", `/protocols/${protocolId}/sign`, {
    signaturePng: "nie-png",
    signerName: "Jan",
    expectedUpdatedAt: (put.data as { updatedAt: string }).updatedAt,
  });
  ok("podpis: bez PNG → 400", badSign.status === 400, badSign);

  // --- K2: PUT zmienia TYLKO to, co przyszło w ciele -----------------------
  const putBase = put.data as { updatedAt: string; activities: string; actualKm: number };
  const partial = await T("PUT", `/protocols/${protocolId}`, { actualHours: 3 });
  const partialData = partial.data as { activities?: string; actualKm?: number; actualHours?: number };
  ok(
    "K2 protokół: PUT z jednym polem nie zeruje pozostałych",
    partial.status === 200 &&
      partialData?.activities === putBase.activities &&
      partialData?.actualKm === putBase.actualKm &&
      partialData?.actualHours === 3,
    partial
  );
  ok(
    "K2 protokół: PUT z pozycjami nietkniętymi zostawia listę materiałów",
    ((partial.data as { items?: unknown[] })?.items ?? []).length === 1,
    (partial.data as { items?: unknown[] })?.items
  );
  const nullBody = await T("PUT", `/protocols/${protocolId}`, null);
  ok("K2 protokół: ciało `null` → 400, nie 500", nullBody.status === 400, nullBody);
  const arrayBody = await T("PUT", `/protocols/${protocolId}`, [1, 2, 3]);
  ok("K2 protokół: ciało nie-obiekt → 400", arrayBody.status === 400, arrayBody);

  // Panel nie ma prawa podmienić danych klienta — nawet gdy je przyśle.
  const clientBefore = db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get();
  const hack = await T("PUT", `/protocols/${protocolId}`, {
    clientName: "PODMIENIONY",
    clientNip: "0000000000",
    installationAddress: "",
    contractor: "",
    activities: "Wymiana kamery, test nagrań",
  });
  const afterHack = db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get();
  ok(
    "K2 protokół: panel NIE nadpisuje pól klienta (lockClientFields)",
    hack.status === 200 &&
      afterHack?.clientName === clientBefore?.clientName &&
      afterHack?.clientNip === clientBefore?.clientNip &&
      afterHack?.installationAddress === clientBefore?.installationAddress &&
      afterHack?.contractor === clientBefore?.contractor,
    { before: clientBefore?.clientName, after: afterHack?.clientName }
  );

  // --- N6: uszkodzony JSON pozycji nie wywraca odczytu ---------------------
  db.update(schema.protocols).set({ items: '{"nie":"tablica"}' }).where(eq(schema.protocols.id, protocolId)).run();
  const broken = await T("GET", `/protocols/${protocolId}`);
  ok(
    "N6 protokół: items nie będące tablicą → pusta lista, nie 500",
    broken.status === 200 && Array.isArray((broken.data as { items?: unknown[] })?.items) &&
      ((broken.data as { items?: unknown[] }).items ?? []).length === 0,
    broken
  );
  db.update(schema.protocols)
    .set({ items: JSON.stringify([{ name: "Kamera IP", serial: "SN-1", unit: "szt.", qty: "1" }]) })
    .where(eq(schema.protocols.id, protocolId))
    .run();

  // --- W3: podpis wymaga znacznika wersji ----------------------------------
  const freshProto = () =>
    db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get()!;
  const SIGN_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const signNoStamp = await T("POST", `/protocols/${protocolId}/sign`, {
    signaturePng: SIGN_PNG,
    signerName: "Klient Odbierający",
  });
  ok(
    "W3 podpis: bez expectedUpdatedAt → 400 (nie poświadczamy nieznanej treści)",
    signNoStamp.status === 400 && /znacznika wersji/i.test(signNoStamp.error ?? ""),
    signNoStamp
  );
  const signStale = await T("POST", `/protocols/${protocolId}/sign`, {
    signaturePng: SIGN_PNG,
    signerName: "Klient Odbierający",
    expectedUpdatedAt: "2000-01-01T00:00:00.000Z",
  });
  ok("W3 podpis: nieaktualny expectedUpdatedAt → 409", signStale.status === 409, signStale);
  ok(
    "N4 podpis: puste imię i nazwisko → 400",
    (
      await T("POST", `/protocols/${protocolId}/sign`, {
        signaturePng: SIGN_PNG,
        signerName: "   ",
        expectedUpdatedAt: freshProto().updatedAt,
      })
    ).status === 400
  );

  const sign = await T("POST", `/protocols/${protocolId}/sign`, {
    signaturePng: SIGN_PNG,
    // N5: nazwisko dłuższe niż limit ma być przycięte, a nie odrzucone.
    signerName: `Klient Odbierający ${"x".repeat(300)}`,
    expectedUpdatedAt: freshProto().updatedAt,
  });
  ok("podpis: 200 i status final", sign.status === 200 && (sign.data as { status?: string })?.status === "final", sign);
  ok(
    "N5 podpis: nazwisko przycięte do 120 znaków",
    (db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get()?.signerName ?? "").length === 120,
    db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get()?.signerName?.length
  );
  const signedRow = db.select().from(schema.protocols).where(eq(schema.protocols.id, protocolId)).get();
  ok("podpis: content_hash zapisany", !!signedRow?.contentHash, signedRow?.contentHash);
  ok("podpis: odpowiedź bez kwot i wyceny", sign.data != null && !("quote" in (sign.data as object)) && !("autofill" in (sign.data as object)), Object.keys(sign.data as object));

  const putAfterSign = await T("PUT", `/protocols/${protocolId}`, { activities: "podmiana po podpisie" });
  ok("protokół: PUT po podpisie → 409", putAfterSign.status === 409, putAfterSign);

  // =========================================================================
  // 8. Rola technik nie wychodzi poza swój moduł
  // =========================================================================
  const outsideTech = outsideFor(techUser);
  ok("technik: /api/objects → 403", (await outsideTech("/api/objects")).status === 403);
  ok("technik: /api/admin/users → 403", (await outsideTech("/api/admin/users")).status === 403);
  ok("technik: /api/calendar/events → 403", (await outsideTech(`/api/calendar/events${RANGE}`)).status === 403);

  // =========================================================================
  // 9. Konta roli `user`: brak klucza / view / edit
  // =========================================================================
  ok("user bez klucza: lista → 403", (await K("GET", `/jobs${RANGE}`)).status === 403);
  const viewList = await V("GET", `/jobs${RANGE}`);
  ok("user z „view”: GET listy → 200 i widzi swoje zlecenie", viewList.status === 200 && ids(viewList).includes(job), viewList);
  const viewWrite = await V("POST", `/jobs/${job}/notes`, { text: "z podglądu" });
  ok("user z „view”: POST → 403", viewWrite.status === 403, viewWrite);
  const editWrite = await E("POST", `/jobs/${job}/notes`, { text: `${PREFIX} notatka z panelu` });
  ok("user z „edit”: POST notatki → 201", editWrite.status === 201, editWrite);

  // =========================================================================
  // 10. Konto bez powiązania z kartoteką techników
  // =========================================================================
  const noLinkMe = await N("GET", "/me");
  ok("bez powiązania: linked = false", noLinkMe.status === 200 && (noLinkMe.data as { linked?: boolean })?.linked === false, noLinkMe);
  const noLinkJobs = await N("GET", `/jobs${RANGE}`);
  ok("bez powiązania: pusta lista (nie błąd)", noLinkJobs.status === 200 && ids(noLinkJobs).length === 0, noLinkJobs);
  const noLinkStart = await N("POST", `/jobs/${job}/start`);
  ok("bez powiązania: mutacja → 409", noLinkStart.status === 409, noLinkStart);

  // =========================================================================
  // 11. „Inna godzina” — start/finish z podaną chwilą
  // =========================================================================
  const atJob = insertEvent({ title: "Z godzina", type: "serwis", technicianIds: [tech.id], hour: 8, day: PAST_DAY });
  ok(
    "start z at: zły format → 400",
    (await T("POST", `/jobs/${atJob}/start`, { at: "wczoraj o 8" })).status === 400
  );
  ok(
    "start z at: godzina z przyszłości → 400",
    (await T("POST", `/jobs/${atJob}/start`, { at: `${FUTURE_DAY}T10:00` })).status === 400
  );
  const startAt = await T("POST", `/jobs/${atJob}/start`, { at: `${PAST_DAY}T08:30` });
  const startedRow = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, atJob)).get();
  ok(
    "start z at: 200 i znacznik z podanej chwili",
    startAt.status === 200 && new Date(startedRow?.startedAt ?? 0).getHours() === 8,
    { status: startAt.status, startedAt: startedRow?.startedAt }
  );
  const atNote = db
    .select()
    .from(schema.calendarEventNotes)
    .where(eq(schema.calendarEventNotes.eventId, atJob))
    .all();
  ok(
    "start z at: notatka z datą i godziną (inny dzień niż dziś)",
    atNote.length === 1 && /Rozpoczęto .*08:30/.test(atNote[0].text),
    atNote.map((n) => n.text)
  );
  const finishBefore = await T("POST", `/jobs/${atJob}/finish`, { at: `${PAST_DAY}T07:00` });
  ok(
    "finish z at przed rozpoczęciem → 400",
    finishBefore.status === 400 && /przed rozpocz/i.test(finishBefore.error ?? ""),
    finishBefore
  );
  const finishAt = await T("POST", `/jobs/${atJob}/finish`, { at: `${PAST_DAY}T09:45` });
  ok("finish z at: 200 i status done", finishAt.status === 200 && (finishAt.data as { status?: string })?.status === "done", finishAt);

  // =========================================================================
  // 12. Słownik czynności — technik czyta, admin edytuje
  // =========================================================================
  const acts = await T("GET", "/activities");
  ok(
    "czynności: technik dostaje 200 i tablicę",
    acts.status === 200 && Array.isArray(acts.data) && (acts.data as string[]).length > 0,
    acts
  );
  ok("czynności: rola technik NIE wchodzi do /admin/technik → 403", (await TA("GET", "/activities")).status === 403);

  const adminGet = await A("GET", "/activities");
  ok(
    "czynności: admin czyta słownik (values + sources)",
    adminGet.status === 200 &&
      Array.isArray((adminGet.data as { values?: { activities?: string[] } })?.values?.activities),
    adminGet
  );

  const newList = ["Czynność testowa A", "Czynność testowa B"];
  const adminPut = await A("PUT", "/activities", { activities: newList });
  ok(
    "czynności: admin zapisuje listę",
    adminPut.status === 200 &&
      JSON.stringify((adminPut.data as { values: { activities: string[] } }).values.activities) ===
        JSON.stringify(newList),
    adminPut
  );
  const adminAfter = await A("GET", "/activities");
  ok(
    "czynności: GET zwraca zapisaną listę (źródło: db)",
    JSON.stringify((adminAfter.data as { values: { activities: string[] } }).values.activities) ===
      JSON.stringify(newList) &&
      (adminAfter.data as { sources?: { activities?: string } }).sources?.activities === "db",
    adminAfter
  );
  const techAfter = await T("GET", "/activities");
  ok(
    "czynności: technik widzi to, co zapisał admin",
    JSON.stringify(techAfter.data) === JSON.stringify(newList),
    techAfter
  );
  ok("czynności: pusta pozycja → 400", (await A("PUT", "/activities", { activities: ["  "] })).status === 400);
  ok("czynności: nie-tablica → 400", (await A("PUT", "/activities", { activities: "nie tablica" })).status === 400);

  // =========================================================================
  // 12. Dystans do protokołu — bez obiektu odpowiedź jest pusta, nie błędna
  // =========================================================================
  const noObjectJob = insertEvent({
    title: "Bez obiektu",
    type: "serwis",
    technicianIds: [tech.id],
    hour: 18,
    withObject: false,
  });
  const dist = await T("GET", `/jobs/${noObjectJob}/distance`);
  const distData = dist.data as { km: number | null; reason?: string };
  ok(
    "dystans: zlecenie bez obiektu → 200 z km: null i powodem",
    dist.status === 200 && distData?.km === null && typeof distData?.reason === "string",
    dist
  );
  ok("dystans: cudze zlecenie → 404", (await T("GET", `/jobs/${otherJob}/distance`)).status === 404);

  // =========================================================================
  // 13. Notatka systemowa ze streszczeniem protokołu (jedna, aktualizowana)
  // =========================================================================
  const noteJob = insertEvent({ title: "Protokol z notatka", type: "serwis", technicianIds: [tech.id], hour: 19 });
  const np = await T("POST", `/jobs/${noteJob}/protocol`);
  const npBrief = (np.data as { protocol?: { id: number; number: string } })?.protocol;
  const npId = npBrief?.id ?? 0;
  const systemNotes = () =>
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(and(eq(schema.calendarEventNotes.eventId, noteJob), eq(schema.calendarEventNotes.source, "system")))
      .all();

  const afterCreate = systemNotes();
  ok(
    "notatka protokołu: jedna, systemowa, z numerem i „NIEPODPISANY”",
    afterCreate.length === 1 &&
      afterCreate[0].text.includes(npBrief?.number ?? "???") &&
      afterCreate[0].text.includes("NIEPODPISANY"),
    afterCreate.map((n) => n.text)
  );
  ok(
    "notatka protokołu: link do protokołu w treści",
    afterCreate[0]?.text.includes(`</technical/protokoly?protocol=${npId}>`) &&
      !afterCreate[0].text.includes("http"),
    afterCreate[0]?.text
  );

  await T("PUT", `/protocols/${npId}`, {
    workDate: DAY,
    workType: "serwis",
    actualHours: 1,
    actualKm: 10,
    activities: "Wymiana czujki\nTest torów alarmowych",
    items: [{ name: "Czujka PIR", serial: "SN-77", unit: "szt.", qty: "2" }],
  });
  const afterPut = systemNotes();
  ok("notatka protokołu: po zapisie nadal JEDNA notatka", afterPut.length === 1, afterPut.length);
  ok(
    "notatka protokołu: zawiera czynności i urządzenie",
    afterPut[0].text.includes("Wymiana czujki") &&
      afterPut[0].text.includes("Test torów alarmowych") &&
      afterPut[0].text.includes("Czujka PIR") &&
      afterPut[0].text.includes("SN-77"),
    afterPut[0]?.text
  );

  await T("POST", `/protocols/${npId}/sign`, {
    signaturePng:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    signerName: "Anna Odbierająca",
    expectedUpdatedAt: db.select().from(schema.protocols).where(eq(schema.protocols.id, npId)).get()?.updatedAt,
  });
  const afterSign = systemNotes();
  ok("notatka protokołu: po podpisie nadal JEDNA notatka", afterSign.length === 1, afterSign.length);
  ok(
    "notatka protokołu: po podpisie „podpisany” i nazwisko odbierającego",
    afterSign[0].text.includes("podpisany") && afterSign[0].text.includes("Anna Odbierająca"),
    afterSign[0]?.text
  );

  // =========================================================================
  // 14. Pogoda (batch) — cudze id odfiltrowane, brak sieci to nie 500
  //
  // `GEO_OFFLINE=1` na czas sekcji: trasa ma działać bez internetu i bez
  // sekundowej kolejki geokodera. Obiekt testowy nie ma jeszcze współrzędnych,
  // więc każdy skrót wraca jako `null` — i to jest poprawna odpowiedź, nie błąd.
  // =========================================================================
  const weatherJob = insertEvent({
    title: "Pogoda jutro",
    type: "serwis",
    technicianIds: [tech.id],
    hour: 8,
    day: FUTURE_DAY,
  });

  const itemsOf = (r: { data?: unknown }) =>
    ((r.data as { items?: Record<string, unknown> } | undefined)?.items ?? {}) as Record<string, unknown>;

  process.env.GEO_OFFLINE = "1";
  const wx = await T("GET", `/jobs/weather?ids=${weatherJob},${job},${otherJob}`);
  const wxItems = itemsOf(wx);
  ok(
    "pogoda: batch → 200 z mapą items i listą retry",
    wx.status === 200 &&
      wx.success === true &&
      Array.isArray((wx.data as { retry?: unknown })?.retry),
    wx
  );
  ok(
    "pogoda: moje zlecenia w items, cudze odfiltrowane",
    String(weatherJob) in wxItems && String(job) in wxItems && !(String(otherJob) in wxItems),
    Object.keys(wxItems)
  );
  ok(
    "pogoda: brak współrzędnych i brak sieci → same null (nie 500)",
    Object.values(wxItems).every((v) => v === null),
    wxItems
  );

  const wxOther = await T("GET", `/jobs/weather?ids=${otherJob}`);
  ok(
    "pogoda: same cudze id → pusta mapa w 200",
    wxOther.status === 200 && Object.keys(itemsOf(wxOther)).length === 0,
    wxOther
  );
  // Gdyby `/jobs/weather` wpadło w `/jobs/:id`, dostalibyśmy 400 „Nieprawidłowe id”.
  ok("pogoda: trasa nie wpada w /jobs/:id (nie 400)", wxOther.status !== 400, wxOther.status);

  const wxNoIds = await T("GET", "/jobs/weather");
  ok(
    "pogoda: bez parametru ids → pusta mapa w 200",
    wxNoIds.status === 200 && Object.keys(itemsOf(wxNoIds)).length === 0,
    wxNoIds
  );
  const wxBadIds = await T("GET", "/jobs/weather?ids=abc,-5,0");
  ok(
    "pogoda: śmieci w ids → pusta mapa w 200",
    wxBadIds.status === 200 && Object.keys(itemsOf(wxBadIds)).length === 0,
    wxBadIds
  );
  const wxUnlinked = await N("GET", `/jobs/weather?ids=${weatherJob}`);
  ok(
    "pogoda: konto bez powiązania → pusta mapa w 200",
    wxUnlinked.status === 200 && Object.keys(itemsOf(wxUnlinked)).length === 0,
    wxUnlinked
  );
  ok(
    "pogoda: konto bez klucza `technik` → 403 (strażnik zakładki)",
    (await K("GET", `/jobs/weather?ids=${weatherJob}`)).status === 403
  );

  // =========================================================================
  // 15. Dystans niesie też czas przejazdu (linijka pod „Nawiguj”)
  //
  // Wszystko liczone offline: biuro ze współrzędnych w ustawieniach, obiekt ze
  // swoich kolumn lat/lng, `km_source = straight` (bez OSRM). Czas jest wtedy
  // z szacunku, więc `minutesEstimated` MUSI być true — front pokazuje „≈”.
  // =========================================================================
  setSetting("company.office_lat", "52.4064", null);
  setSetting("company.office_lng", "16.9252", null);
  setSetting("company.km_source", "straight", null);
  db.update(schema.objects)
    .set({ latitude: 52.3500, longitude: 17.0500 })
    .where(eq(schema.objects.id, object.id))
    .run();

  const dist2 = await T("GET", `/jobs/${job}/distance`);
  const d2 = dist2.data as {
    km: number | null;
    minutes?: number;
    minutesEstimated?: boolean;
    method?: string;
  };
  ok(
    "dystans: km i czas przejazdu w jednej odpowiedzi",
    dist2.status === 200 && typeof d2?.km === "number" && typeof d2?.minutes === "number" && d2.minutes > 0,
    dist2
  );
  ok(
    "dystans: czas z szacunku (linia prosta) oznaczony jako przybliżony",
    d2?.minutesEstimated === true && d2?.method === "straight",
    d2
  );
  delete process.env.GEO_OFFLINE;

  // =========================================================================
  // 16. POWIADOMIENIA PUSH — subskrypcje i kto dostaje ładunek
  //
  // Wysyłka idzie przez WSTRZYKNIĘTY transport (`setPushTransport`): prawdziwy
  // strzał wymagałby push service Google/Mozilli i sieci, a sprawdzić chcemy
  // nie szyfrowanie, tylko REGUŁY — kto dostaje powiadomienie, o czym i z jakim
  // adresem. Klucze VAPID podstawiamy w env na czas tej sekcji, bo bez nich
  // moduł jest (celowo) no-opem.
  // =========================================================================
  const cfgNoKeys = await T("GET", "/push/config");
  ok(
    "push/config: bez kluczy VAPID → enabled:false i brak klucza publicznego",
    cfgNoKeys.status === 200 &&
      (cfgNoKeys.data as { enabled: boolean; publicKey: string | null })?.enabled === false &&
      (cfgNoKeys.data as { publicKey: string | null })?.publicKey === null,
    cfgNoKeys
  );

  const SUB_A = {
    endpoint: "https://push.example.invalid/__TECHNIK_TEST__/a",
    keys: { p256dh: "BFakeP256dhKeyForTests0000000000", auth: "FakeAuthSecret00" },
  };
  const SUB_B = {
    endpoint: "https://push.example.invalid/__TECHNIK_TEST__/b",
    keys: { p256dh: "BFakeP256dhKeyForTests1111111111", auth: "FakeAuthSecret11" },
  };

  ok(
    "push/subscribe: bez kluczy na serwerze → 503, nie cichy zapis w próżnię",
    (await T("POST", "/push/subscribe", SUB_A)).status === 503
  );

  process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
  process.env.VAPID_PRIVATE_KEY = "0bw6pjCvok_06kE6DrpV2AclukIo2cHuLjXW5rqrwE0";
  process.env.VAPID_SUBJECT = "mailto:test@example.invalid";

  const cfgKeys = await T("GET", "/push/config");
  ok(
    "push/config: z kluczami → enabled:true i klucz publiczny do subscribe()",
    cfgKeys.status === 200 &&
      (cfgKeys.data as { enabled: boolean; publicKey: string })?.enabled === true &&
      (cfgKeys.data as { publicKey: string })?.publicKey === TEST_VAPID_PUBLIC,
    cfgKeys
  );

  ok("push/subscribe: zapis → 201", (await T("POST", "/push/subscribe", SUB_A)).status === 201);
  await T("POST", "/push/subscribe", { ...SUB_A, keys: { ...SUB_A.keys, auth: "RotatedAuth000" } });
  const mine = subsOf(techUser.id);
  ok(
    "push/subscribe: ten sam endpoint drugi raz → UPSERT, nie duplikat",
    mine.length === 1 && mine[0].auth === "RotatedAuth000",
    mine
  );

  ok("push/subscribe: drugie konto zapisuje własny endpoint", (await O("POST", "/push/subscribe", SUB_B)).status === 201);
  const foreign = await T("DELETE", "/push/subscribe", { endpoint: SUB_B.endpoint });
  ok(
    "push/subscribe DELETE: cudzej subskrypcji nie da się skasować",
    foreign.status === 200 &&
      (foreign.data as { removed: boolean })?.removed === false &&
      subsOf(otherUser.id).length === 1,
    foreign
  );

  // --- Kto dostaje ładunek -------------------------------------------------
  const sent: PushPayload[] = [];
  const restoreTransport = setPushTransport(async (_target, payload) => {
    sent.push(payload);
  });
  try {
    const pushEventId = db.transaction((tx) =>
      createEvent(
        tx,
        parseInput({
          type: "serwis",
          title: `${PREFIX} Push nowe zlecenie`,
          department: "technical",
          startAt: `${FUTURE_DAY}T09:00`,
          endAt: `${FUTURE_DAY}T10:00`,
          objectId: object.id,
          technicianIds: [tech.id],
        }),
        { user: adminUser }
      ).firstId
    );
    await flushPush();
    ok(
      "push: nowe zlecenie z przypisanym technikiem → 1 ładunek z adresem zlecenia",
      sent.length === 1 &&
        sent[0].title === "Nowe zlecenie" &&
        sent[0].url === `/technik/zlecenie/${pushEventId}` &&
        sent[0].body.startsWith("Serwis — "),
      sent
    );

    // Zmiana robiona Z PANELU przez samego technika nie ma prawa wrócić do
    // niego powiadomieniem — to jego własne kliknięcie.
    sent.length = 0;
    await T("POST", `/jobs/${pushEventId}/start`);
    await T("POST", `/jobs/${pushEventId}/finish`);
    await flushPush();
    ok("push: zmiana z panelu przez samego technika → 0 ładunków", sent.length === 0, sent);

    // Ta sama operacja z biura (inny użytkownik) już powiadamia.
    sent.length = 0;
    db.transaction((tx) =>
      moveEvent(tx, pushEventId, { startAt: `${FUTURE_DAY}T14:00`, endAt: `${FUTURE_DAY}T15:00` }, { user: adminUser })
    );
    await flushPush();
    ok(
      "push: przesunięcie terminu przez biuro → „Zmiana terminu”",
      sent.length === 1 && sent[0].title === "Zmiana terminu" && sent[0].url === `/technik/zlecenie/${pushEventId}`,
      sent
    );

    // …ale to samo przesunięcie zrobione przez konto technika — już nie.
    sent.length = 0;
    db.transaction((tx) =>
      moveEvent(tx, pushEventId, { startAt: `${FUTURE_DAY}T16:00`, endAt: `${FUTURE_DAY}T17:00` }, { user: techUser })
    );
    await flushPush();
    ok("push: przesunięcie zrobione przez samego technika → 0 ładunków", sent.length === 0, sent);

    sent.length = 0;
    db.transaction((tx) => deleteEvent(tx, pushEventId, "this", { user: adminUser }));
    await flushPush();
    ok(
      "push: usunięcie wydarzenia → „Zlecenie odwołane”",
      sent.length === 1 && sent[0].title === "Zlecenie odwołane",
      sent
    );

    // Typy spoza protokołu i cudze działy nie są zleceniem technika.
    sent.length = 0;
    db.transaction((tx) =>
      createEvent(
        tx,
        parseInput({
          type: "biuro",
          title: `${PREFIX} Push biuro`,
          department: "technical",
          startAt: `${FUTURE_DAY}T11:00`,
          endAt: `${FUTURE_DAY}T12:00`,
          technicianIds: [tech.id],
        }),
        { user: adminUser }
      )
    );
    await flushPush();
    ok("push: typ spoza protokołów (biuro) → 0 ładunków", sent.length === 0, sent);
  } finally {
    restoreTransport();
  }

  const removedMine = await T("DELETE", "/push/subscribe", { endpoint: SUB_A.endpoint });
  ok(
    "push/subscribe DELETE: własna subskrypcja znika",
    removedMine.status === 200 &&
      (removedMine.data as { removed: boolean })?.removed === true &&
      subsOf(techUser.id).length === 0,
    removedMine
  );

  // =========================================================================
  // 17. ZDJĘCIA W NOTATKACH — multipart z tabletu i własne trasy plików
  //
  // Panel serwuje załączniki sam, bo rola `technik` nie ma wstępu do
  // /api/calendar/*. Pilnujemy: zapisu (WebP, url panelu), odczytu, granicy
  // cudzych zleceń (404, nie 403), limitu plików i trybu tylko-do-odczytu.
  // =========================================================================
  const photoJob = insertEvent({ title: "Zdjecia", type: "serwis", technicianIds: [tech.id], hour: 20 });
  // Małe PNG-i generowane w teście — żadnych plików binarnych w repo.
  const png = async (r: number) =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: { r, g: 10, b: 10 } } })
      .png()
      .toBuffer();
  const photoForm = (text: string | null, files: { name: string; type: string; data: Buffer }[]) => {
    const fd = new FormData();
    if (text !== null) fd.set("text", text);
    for (const f of files) fd.append("files", new File([new Uint8Array(f.data)], f.name, { type: f.type }));
    return fd;
  };

  const upload = await T(
    "POST",
    `/jobs/${photoJob}/notes`,
    photoForm("Kamera przy bramie", [
      { name: "kamera 1.png", type: "image/png", data: await png(200) },
      { name: "kamera 2.png", type: "image/png", data: await png(30) },
    ])
  );
  const uploaded = upload.data as
    | { id: number; text: string; mine?: boolean; attachments?: { id: number; kind: string; mime: string; url: string; fileName: string }[] }
    | undefined;
  const atts = uploaded?.attachments ?? [];
  ok(
    "notatka multipart: 201, 2 załączniki jako WebP",
    upload.status === 201 &&
      atts.length === 2 &&
      atts.every((a) => a.kind === "image" && a.mime === "image/webp"),
    upload
  );
  ok(
    "notatka multipart: url wskazuje na trasę panelu, nie kalendarza",
    atts.every((a) => a.url === `/api/technik/attachments/${a.id}`),
    atts.map((a) => a.url)
  );
  ok("notatka multipart: tekst zapisany obok zdjęć", uploaded?.text === "Kamera przy bramie", uploaded?.text);

  const detailPhotos = await T("GET", `/jobs/${photoJob}`);
  const detailNotes = (detailPhotos.data as { notes?: Array<{ id: number; mine?: boolean; attachments?: unknown[] }> })?.notes ?? [];
  ok(
    "GET /jobs/:id: notatka wraca z załącznikami i flagą „moja”",
    detailNotes[0]?.attachments?.length === 2 && detailNotes[0]?.mine === true,
    detailNotes[0]
  );

  // Notatka bez tekstu, za to ze zdjęciem — zdjęcie samo jest treścią wpisu.
  const photoOnly = await T("POST", `/jobs/${photoJob}/notes`, photoForm("", [{ name: "tablica.png", type: "image/png", data: await png(90) }]));
  ok(
    "notatka z samym zdjęciem (pusty tekst) → 201",
    photoOnly.status === 201 && (photoOnly.data as { text?: string })?.text === "",
    photoOnly
  );
  const noText = await T("POST", `/jobs/${photoJob}/notes`, photoForm("   ", []));
  ok("multipart bez tekstu i bez plików → 400", noText.status === 400, noText);

  const fileRes = await TRaw.request(`/api/technik/attachments/${atts[0]?.id}`);
  const fileBody = Buffer.from(await fileRes.arrayBuffer());
  ok(
    "GET załącznika: 200, image/webp, inline",
    fileRes.status === 200 &&
      fileRes.headers.get("content-type") === "image/webp" &&
      /^inline;/.test(fileRes.headers.get("content-disposition") ?? "") &&
      fileBody.subarray(8, 12).toString() === "WEBP",
    { status: fileRes.status, headers: Object.fromEntries(fileRes.headers) }
  );
  const dlRes = await TRaw.request(`/api/technik/attachments/${atts[0]?.id}?download=1`);
  ok(
    "GET ?download=1 → Content-Disposition: attachment",
    dlRes.status === 200 && /^attachment;/.test(dlRes.headers.get("content-disposition") ?? ""),
    dlRes.headers.get("content-disposition")
  );
  ok("GET nieistniejącego załącznika → 404", (await T("GET", "/attachments/99999999")).status === 404);

  // Cudze zdjęcie: inny technik, inne zlecenie — ma nie istnieć, nie „być zabronione”.
  const otherUpload = await O("POST", `/jobs/${otherJob}/notes`, photoForm("Cudze", [{ name: "cudze.png", type: "image/png", data: await png(120) }]));
  const otherAtt = ((otherUpload.data as { attachments?: { id: number }[] })?.attachments ?? [])[0];
  ok("cudza notatka ze zdjęciem: 201 u właściciela", otherUpload.status === 201 && !!otherAtt, otherUpload);
  ok("GET cudzego załącznika → 404", (await T("GET", `/attachments/${otherAtt?.id}`)).status === 404);
  ok("DELETE cudzego załącznika → 404", (await T("DELETE", `/attachments/${otherAtt?.id}`)).status === 404);

  // Rola `technik` nie może obejść panelu i wejść po plik przez kalendarz.
  ok(
    "technik: /api/calendar/attachments/:id → 403",
    (await outsideTech(`/api/calendar/attachments/${atts[0]?.id}`)).status === 403
  );

  const limitForm = photoForm(
    "za dużo",
    await Promise.all(Array.from({ length: 16 }, async (_, i) => ({ name: `p${i}.png`, type: "image/png", data: await png(i * 5) })))
  );
  const overLimit = await T("POST", `/jobs/${photoJob}/notes`, limitForm);
  ok("16 plików → 400 „Maksymalnie 15 plików”", overLimit.status === 400 && overLimit.error === "Maksymalnie 15 plików", overLimit);

  // Tryb tylko-do-odczytu obejmuje także zdjęcia.
  const viewPhoto = await V("POST", `/jobs/${job}/notes`, photoForm("z podglądu", [{ name: "v.png", type: "image/png", data: await png(60) }]));
  ok("user z „view”: POST zdjęcia → 403", viewPhoto.status === 403, viewPhoto);

  // Usunięcie własnego: wiersz i plik z dysku znikają.
  const storedPath = db
    .select()
    .from(schema.calendarNoteAttachments)
    .where(eq(schema.calendarNoteAttachments.id, atts[1]?.id ?? 0))
    .get()?.storedPath;
  const absBefore = storedPath ? resolveStoredPath(storedPath) : null;
  const del = await T("DELETE", `/attachments/${atts[1]?.id}`);
  const rowAfter = db
    .select()
    .from(schema.calendarNoteAttachments)
    .where(eq(schema.calendarNoteAttachments.id, atts[1]?.id ?? 0))
    .get();
  ok(
    "DELETE własnego załącznika → 200, wiersz i plik znikają",
    del.status === 200 && !rowAfter && !!absBefore && !existsSync(absBefore),
    { del, rowAfter, absBefore }
  );
  ok("DELETE już usuniętego → 404", (await T("DELETE", `/attachments/${atts[1]?.id}`)).status === 404);
  // Cudza (biurowa) notatka w MOIM zleceniu: plik widzę, ale go nie skasuję.
  const officeUpload = await E("POST", `/jobs/${job}/notes`, photoForm("Z biura", [{ name: "biuro.png", type: "image/png", data: await png(150) }]));
  const officeAtt = ((officeUpload.data as { attachments?: { id: number }[] })?.attachments ?? [])[0];
  ok("DELETE załącznika z cudzej notatki (moje zlecenie) → 403", (await T("DELETE", `/attachments/${officeAtt?.id}`)).status === 403);
  ok("GET załącznika z cudzej notatki (moje zlecenie) → 200", (await TRaw.request(`/api/technik/attachments/${officeAtt?.id}`)).status === 200);

  // =========================================================================
  // 19. Pinezki dla zakładki „Mapa”
  //
  // `JobJson` niesie współrzędne OBIEKTU wprost z `objects.latitude/longitude`
  // (ustawione w sekcji 15) — bez geokodowania adresu w locie. Zlecenie bez
  // obiektu ma lat/lng null i mapa pokazuje je na liście „bez lokalizacji”,
  // zamiast zgadywać, gdzie stoi. Biuro wraca w `/me`, bo rola `technik` nie
  // ma wstępu do `GET /company/office`.
  // =========================================================================
  const mapList = await T("GET", `/jobs${RANGE}`);
  const mapJobs = (mapList.data as { id: number; lat: number | null; lng: number | null }[]) ?? [];
  const pinned = mapJobs.find((j) => j.id === job);
  ok(
    "JobJson: lat/lng z obiektu zlecenia",
    pinned?.lat === 52.35 && pinned?.lng === 17.05,
    pinned
  );
  const unpinned = mapJobs.find((j) => j.id === noObjectJob);
  ok(
    "JobJson: zlecenie bez obiektu → lat/lng null",
    !!unpinned && unpinned.lat === null && unpinned.lng === null,
    unpinned
  );

  db.update(schema.objects).set({ latitude: null, longitude: null }).where(eq(schema.objects.id, object.id)).run();
  const noCoords = await T("GET", `/jobs${RANGE}`);
  const afterClear = ((noCoords.data as { id: number; lat: number | null }[]) ?? []).find((j) => j.id === job);
  ok("JobJson: obiekt bez współrzędnych → lat/lng null", afterClear?.lat === null, afterClear);
  db.update(schema.objects).set({ latitude: 52.35, longitude: 17.05 }).where(eq(schema.objects.id, object.id)).run();

  const meMap = await T("GET", "/me");
  const meOffice = (meMap.data as { office?: { lat: number; lng: number } | null })?.office;
  ok(
    "GET /me: współrzędne biura dla mapy panelu",
    meOffice?.lat === 52.4064 && meOffice?.lng === 16.9252,
    meOffice
  );

  // =========================================================================
  // 19b. Lista „do kogo zadzwonić” — kontakty zlecenia
  // =========================================================================
  // Kontrahent ma osobę kontaktową (contact_person + phone); dokładamy dwa
  // kontakty z kartoteki: jeden z TYM SAMYM numerem kontrahenta zapisanym
  // inaczej (ma się nie dublować) i jeden bez telefonu (ma nie wejść).
  const contractorPhone = db
    .select({ phone: schema.contractors.phone })
    .from(schema.contractors)
    .where(eq(schema.contractors.id, contractor.id))
    .get()?.phone;
  db.update(schema.contractors)
    .set({ contactPerson: `${PREFIX} Osoba Kontrahenta`, phone: "+48 600 100 200" })
    .where(eq(schema.contractors.id, contractor.id))
    .run();
  const kc1 = db
    .insert(schema.contacts)
    .values({ contractorId: contractor.id, objectId: object.id, firstName: PREFIX, lastName: "Portier", role: "portiernia", phone: "+48 500 000 111", isPrimary: true, active: true })
    .returning()
    .get();
  const kc2 = db
    .insert(schema.contacts)
    .values({ contractorId: contractor.id, firstName: PREFIX, lastName: "Dubel", phone: "0048600100200", active: true })
    .returning()
    .get();
  const kc3 = db
    .insert(schema.contacts)
    .values({ contractorId: contractor.id, firstName: PREFIX, lastName: "BezTelefonu", phone: null, active: true })
    .returning()
    .get();
  try {
    const det = await T("GET", `/jobs/${job}`);
    const contacts = ((det.data as { contacts?: { name: string; phone: string; source: string }[] })?.contacts) ?? [];
    ok("kontakty: osoba kontrahenta pierwsza", contacts[0]?.source === "contractor" && contacts[0]?.phone === "+48 600 100 200", contacts);
    ok("kontakty: kontakt z kartoteki (obiekt, główny) na liście", contacts.some((k) => k.name.includes("Portier") && k.source === "contact"), contacts);
    ok("kontakty: ten sam numer zapisany inaczej nie dubluje się", !contacts.some((k) => k.name.includes("Dubel")), contacts);
    ok("kontakty: bez telefonu nie wchodzi", !contacts.some((k) => k.name.includes("BezTelefonu")), contacts);
    ok("kontakty: dokładnie 2 pozycje", contacts.length === 2, contacts.length);
  } finally {
    db.delete(schema.contacts).where(inArray(schema.contacts.id, [kc1.id, kc2.id, kc3.id])).run();
    db.update(schema.contractors).set({ contactPerson: null, phone: contractorPhone ?? null }).where(eq(schema.contractors.id, contractor.id)).run();
  }

  // =========================================================================
  // 20. Fala 1 — znaczniki czasu, liczniki i granice okien
  // =========================================================================

  // --- W1/W2: „Zakończ" bez „Rozpocznij" i drugie tapnięcie ---------------
  const finishJob = insertEvent({ title: "Finish idempotent", type: "serwis", technicianIds: [tech.id], hour: 7, day: PAST_DAY });
  const fin1 = await T("POST", `/jobs/${finishJob}/finish`, { note: "Gotowe" });
  const finRow1 = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, finishJob)).get();
  ok(
    "W1 finish: startedAt z planu zapisany jako ISO UTC (nie lokalny zapis kalendarza)",
    fin1.status === 200 && /Z$/.test(finRow1?.startedAt ?? ""),
    finRow1?.startedAt
  );
  ok(
    "W1 finish: startedAt nie jest późniejszy niż finishedAt",
    Date.parse(finRow1?.startedAt ?? "") <= Date.parse(finRow1?.finishedAt ?? ""),
    { startedAt: finRow1?.startedAt, finishedAt: finRow1?.finishedAt }
  );
  const fin2 = await T("POST", `/jobs/${finishJob}/finish`, { note: "Drugi raz" });
  const finRow2 = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, finishJob)).get();
  ok(
    "W2 finish: drugie tapnięcie nie przestawia znacznika",
    fin2.status === 200 && finRow2?.finishedAt === finRow1?.finishedAt,
    { first: finRow1?.finishedAt, second: finRow2?.finishedAt }
  );
  const finNotes = db
    .select()
    .from(schema.calendarEventNotes)
    .where(eq(schema.calendarEventNotes.eventId, finishJob))
    .all();
  ok("W2 finish: brak zdublowanej notatki", finNotes.length === 1, finNotes.map((n) => n.text));
  // …ale jawna poprawka godziny („Inna godzina") przechodzi.
  const finFix = await T("POST", `/jobs/${finishJob}/finish`, { at: `${PAST_DAY}T18:30` });
  const finRow3 = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, finishJob)).get();
  ok(
    "W2 finish: poprawka z `at` mimo to zapisuje nową godzinę",
    finFix.status === 200 && finRow3?.finishedAt !== finRow1?.finishedAt,
    finRow3?.finishedAt
  );

  // Zlecenie z JUTRA zamknięte dziś — nie ma prawa dostać 400 ani ujemnego czasu.
  const earlyJob = insertEvent({ title: "Zrobione przed terminem", type: "serwis", technicianIds: [tech.id], hour: 9, day: FUTURE_DAY });
  const early = await T("POST", `/jobs/${earlyJob}/finish`);
  const earlyRow = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, earlyJob)).get();
  ok(
    "W1 finish: zlecenie z jutra zamknięte dziś → 200 i startedAt ≤ finishedAt",
    early.status === 200 && Date.parse(earlyRow?.startedAt ?? "") <= Date.parse(earlyRow?.finishedAt ?? ""),
    { status: early.status, startedAt: earlyRow?.startedAt, finishedAt: earlyRow?.finishedAt }
  );

  // --- N10: wydarzenie kończące się o 00:00 nie wchodzi na następny dzień --
  const midnightDay = dayOffset(3);
  const midnightJob = insertEvent({ title: "Do polnocy", type: "serwis", technicianIds: [tech.id], hour: 22, day: dayOffset(2) });
  db.update(schema.calendarEvents)
    .set({ endAt: `${midnightDay}T00:00` })
    .where(eq(schema.calendarEvents.id, midnightJob))
    .run();
  const nextDay = await T("GET", `/jobs?from=${midnightDay}&to=${dayOffset(4)}`);
  ok(
    "N10 lista: zlecenie kończące się o 00:00 nie wisi w następnym dniu",
    !ids(nextDay).includes(midnightJob),
    ids(nextDay)
  );
  const ownDay = await T("GET", `/jobs?from=${dayOffset(2)}&to=${midnightDay}`);
  ok("N10 lista: …ale w swoim dniu jest", ids(ownDay).includes(midnightJob), ids(ownDay));

  // --- W4: licznik „Nadchodzące" pokrywa się z listą (dziś + 15 wyłącznie) -
  const edgeJob = insertEvent({ title: "Na granicy okna", type: "serwis", technicianIds: [tech.id], hour: 9, day: dayOffset(14) });
  const upcomingList = await T("GET", `/jobs?from=${dayOffset(0)}&to=${dayOffset(15)}`);
  const meUpcoming = (await T("GET", "/me")).data as { counts: Record<string, number>; now?: string };
  ok(
    "W4 /me: licznik upcoming = długość listy z tego samego okna",
    meUpcoming.counts.upcoming === ids(upcomingList).length &&
      ids(upcomingList).includes(edgeJob),
    { licznik: meUpcoming.counts.upcoming, lista: ids(upcomingList).length }
  );

  // --- N12: /me oddaje czas serwera --------------------------------------
  ok(
    "N12 /me: odpowiedź niesie `now` serwera",
    typeof meUpcoming.now === "string" && Number.isFinite(Date.parse(meUpcoming.now ?? "")),
    meUpcoming.now
  );

  // --- N13: „w toku" liczone w oknie, nie przez całą historię -------------
  const oldStarted = insertEvent({ title: "Stare rozpoczete", type: "serwis", technicianIds: [tech.id], hour: 9, day: dayOffset(-120) });
  db.update(schema.calendarEvents)
    .set({ startedAt: new Date(Date.now() - 120 * 86400_000).toISOString(), status: "confirmed" })
    .where(eq(schema.calendarEvents.id, oldStarted))
    .run();
  const meInProgress = ((await T("GET", "/me")).data as { counts: Record<string, number> }).counts;
  ok(
    "N13 /me: zapomniane „Rozpocznij” sprzed pół roku nie pompuje licznika",
    meInProgress.inProgress === 0,
    meInProgress
  );

  // --- N8: zlecenie ręcznie odpięte od realizacji -------------------------
  const optoutJob = insertEvent({ title: "Odpięte od realizacji", type: "serwis", technicianIds: [tech.id], hour: 6 });
  db.update(schema.calendarEvents)
    .set({ realizationOptout: true })
    .where(eq(schema.calendarEvents.id, optoutJob))
    .run();
  const optout = await T("POST", `/jobs/${optoutJob}/protocol`);
  ok(
    "N8 protokół: ręcznie odpięte → komunikat po ludzku, nie „ręcznie odpięte”",
    optout.status === 409 && /zadzwoń do biura/i.test(optout.error ?? ""),
    optout
  );

  // --- S3: notatka biura zapala żółtą plakietkę --------------------------
  // Notatkę pisze konto biurowe (editUser), więc musi być na zleceniu — ale
  // plakietkę liczymy dla technika (techUser), czyli „cudzą ręką”.
  const badgeJob = insertEvent({ title: "Notatka biura", type: "serwis", technicianIds: [tech.id, editTech.id], hour: 9, day: dayOffset(0) });
  db.update(schema.calendarEvents)
    .set({ updatedBy: techUser.id, updatedAt: sql`(datetime('now','-1 hour'))` })
    .where(eq(schema.calendarEvents.id, badgeJob))
    .run();
  const seenBefore = new Date(Date.now() - 60_000).toISOString();
  const beforeNote = ((await T("GET", `/me?seenToday=${seenBefore}`)).data as { counts: Record<string, number> }).counts;
  await E("POST", `/jobs/${badgeJob}/notes`, { text: `${PREFIX} pilne — klient prosi o telefon` });
  const afterNote = ((await T("GET", `/me?seenToday=${seenBefore}`)).data as { counts: Record<string, number> }).counts;
  ok(
    "S3 notatka biura podbija updated_at wydarzenia (plakietka „zmiany”)",
    afterNote.changedToday === beforeNote.changedToday + 1,
    { przed: beforeNote.changedToday, po: afterNote.changedToday }
  );
  // Notatka systemowa (Rozpocznij) tego NIE robi — to echo własnego kliknięcia.
  const sysBefore = ((await T("GET", `/me?seenToday=${seenBefore}`)).data as { counts: Record<string, number> }).counts;
  await T("POST", `/jobs/${badgeJob}/start`);
  const sysAfter = ((await T("GET", `/me?seenToday=${seenBefore}`)).data as { counts: Record<string, number> }).counts;
  ok(
    "S3 własne „Rozpocznij” nie zapala plakietki (licznik nie rośnie)",
    sysAfter.changedToday <= sysBefore.changedToday,
    { przed: sysBefore.changedToday, po: sysAfter.changedToday }
  );

  // =========================================================================
  // 21. Notatka protokołu: biuro, edycja ręczna, usunięcie (S4/S5/S7, N9)
  // =========================================================================
  const officeJob = insertEvent({ title: "Protokol biurowy", type: "serwis", technicianIds: [tech.id], hour: 9, day: dayOffset(5) });
  const opRes = await T("POST", `/jobs/${officeJob}/protocol`);
  const opId = ((opRes.data as { protocol?: { id: number; number: string } })?.protocol?.id ?? 0);
  const opNumber = (opRes.data as { protocol?: { number: string } })?.protocol?.number ?? "";
  const opNotes = () =>
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(and(eq(schema.calendarEventNotes.eventId, officeJob), isNull(schema.calendarEventNotes.deletedAt)))
      .all();

  ok(
    "N9 notatka protokołu: świeży protokół BEZ sekcji „Wykonane czynności”",
    opNotes().length === 1 && !opNotes()[0].text.includes("Wykonane czynności"),
    opNotes()[0]?.text
  );

  // Biuro zapisuje protokół swoją trasą — notatka ma pójść za treścią (S4).
  const officeApi = officeProtocolsFor(adminUser);
  const opRow = () => db.select().from(schema.protocols).where(eq(schema.protocols.id, opId)).get()!;
  const officePut = await officeApi("PUT", `/${opId}`, {
    workDate: DAY,
    workType: "serwis",
    actualHours: 2,
    actualKm: 8,
    activities: "Przegląd central\nWymiana akumulatora",
    items: [{ name: "Akumulator 7Ah", serial: "AK-1", unit: "szt.", qty: "1" }],
    expectedUpdatedAt: opRow().updatedAt,
  });
  ok(
    "S4 notatka protokołu: zapis Z BIURA aktualizuje notatkę w kalendarzu",
    officePut.status === 200 &&
      opNotes().length === 1 &&
      opNotes()[0].text.includes("Wymiana akumulatora") &&
      opNotes()[0].text.includes("Akumulator 7Ah"),
    opNotes()[0]?.text
  );

  const officeSign = await officeApi("POST", `/${opId}/sign`, {
    signaturePng:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    signerName: "Biurowy Odbiór",
    expectedUpdatedAt: opRow().updatedAt,
  });
  ok(
    "S4 notatka protokołu: podpis Z BIURA przestawia notatkę na „podpisany”",
    officeSign.status === 200 && opNotes()[0].text.includes("podpisany") && opNotes()[0].text.includes("Biurowy Odbiór"),
    { status: officeSign.status, text: opNotes()[0]?.text }
  );
  const officeUnsign = await officeApi("POST", `/${opId}/unsign`, { expectedUpdatedAt: opRow().updatedAt });
  ok(
    "S4 notatka protokołu: zdjęcie podpisu wraca do „NIEPODPISANY”",
    officeUnsign.status === 200 && opNotes()[0].text.includes("NIEPODPISANY"),
    { status: officeUnsign.status, text: opNotes()[0]?.text }
  );

  // S7: biuro dopisało coś do notatki — kolejna synchronizacja NIE kasuje edycji.
  const editedNoteId = opNotes()[0].id;
  db.update(schema.calendarEventNotes)
    .set({ text: `${opNotes()[0].text}\nUWAGA BIURA: klient dopłaci gotówką`, updatedAt: sql`(datetime('now','+1 minute'))` })
    .where(eq(schema.calendarEventNotes.id, editedNoteId))
    .run();
  await officeApi("PUT", `/${opId}`, {
    activities: "Przegląd central\nWymiana akumulatora\nTest syreny",
    expectedUpdatedAt: opRow().updatedAt,
  });
  const afterEdit = opNotes();
  const keptEdited = afterEdit.find((n) => n.id === editedNoteId);
  ok(
    "S7 notatka protokołu: edycja biura zostaje, streszczenie ląduje w NOWEJ notatce",
    afterEdit.length === 2 &&
      keptEdited?.text.includes("UWAGA BIURA") &&
      afterEdit.some((n) => n.id !== editedNoteId && n.text.includes("Test syreny")),
    afterEdit.map((n) => n.text)
  );
  ok(
    "S7 notatka protokołu: protocols.note_id wskazuje na nową notatkę",
    opRow().noteId != null && opRow().noteId !== editedNoteId,
    { noteId: opRow().noteId, edited: editedNoteId }
  );

  // S5: usunięcie protokołu chowa AKTUALNĄ notatkę systemową (ta z dopiskiem
  // biura zostaje — to już nie jest nasze lustro) i NIE zwalnia numeru.
  const numberBefore = opNumber;
  const systemNoteId = opRow().noteId;
  const delRes = await officeApi("DELETE", `/${opId}`);
  const deletedNote = db
    .select()
    .from(schema.calendarEventNotes)
    .where(eq(schema.calendarEventNotes.id, systemNoteId ?? 0))
    .get();
  ok(
    "S5 protokół: DELETE soft-usuwa notatkę systemową (bez martwego linku)",
    delRes.status === 200 && systemNoteId != null && deletedNote?.deletedAt != null,
    { status: delRes.status, systemNoteId, deletedAt: deletedNote?.deletedAt }
  );
  ok(
    "S5 protokół: notatka z dopiskiem biura przeżywa usunięcie protokołu",
    opNotes().some((n) => n.id === editedNoteId && n.text.includes("UWAGA BIURA")),
    opNotes().map((n) => n.id)
  );
  const reJob = insertEvent({ title: "Protokol po usunieciu", type: "serwis", technicianIds: [tech.id], hour: 10, day: dayOffset(5) });
  const reProto = await T("POST", `/jobs/${reJob}/protocol`);
  const reNumber = (reProto.data as { protocol?: { number: string } })?.protocol?.number ?? "";
  ok(
    "S5 numeracja: numer usuniętego protokołu nie jest wydawany drugi raz",
    reNumber !== "" && reNumber !== numberBefore,
    { usuniety: numberBefore, nowy: reNumber }
  );

  // =========================================================================
  // 21b. FALA 2 — protokół z panelu, wznawianie i odwołane zlecenia
  // =========================================================================

  // --- S1: „final” nadaje wyłącznie podpis --------------------------------
  const statusJob = insertEvent({ title: "Status protokolu", type: "serwis", technicianIds: [tech.id], hour: 11, day: dayOffset(6) });
  const statusProtoId =
    ((await T("POST", `/jobs/${statusJob}/protocol`)).data as { protocol?: { id: number } })?.protocol?.id ?? 0;
  const statusRow = () => db.select().from(schema.protocols).where(eq(schema.protocols.id, statusProtoId)).get()!;
  const fakeFinal = await T("PUT", `/protocols/${statusProtoId}`, { status: "final", activities: "coś tam" });
  ok(
    "S1 protokół: PUT {status:'final'} z panelu NIE robi z brudnopisu podpisanego",
    fakeFinal.status === 200 && statusRow().status === "draft" && statusRow().signaturePng == null,
    { status: statusRow().status, signed: statusRow().signaturePng != null }
  );
  const officeFinal = await officeProtocolsFor(adminUser)("PUT", `/${statusProtoId}`, {
    status: "final",
    expectedUpdatedAt: statusRow().updatedAt,
  });
  ok(
    "S1 protokół: to samo z BIURA — status zostaje `draft`",
    officeFinal.status === 200 && statusRow().status === "draft",
    statusRow().status
  );

  // --- N3: obecny klucz z bezsensowną wartością → 400, nie ciche 200 ------
  const beforeGarbage = statusRow();
  ok(
    "N3 protokół: items nie będące tablicą → 400",
    (await T("PUT", `/protocols/${statusProtoId}`, { items: "kamera" })).status === 400
  );
  ok(
    "N3 protokół: actualHours: null → 400 (kolumna NOT NULL, nie „0”)",
    (await T("PUT", `/protocols/${statusProtoId}`, { actualHours: null })).status === 400
  );
  ok(
    "N3 protokół: actualKm jako tekst bez liczby → 400",
    (await T("PUT", `/protocols/${statusProtoId}`, { actualKm: "dużo" })).status === 400
  );
  ok(
    "N3 protokół: activities jako liczba → 400",
    (await T("PUT", `/protocols/${statusProtoId}`, { activities: 42 })).status === 400
  );
  ok(
    "N3 protokół: po każdym 400 dokument bez zmian",
    statusRow().actualHours === beforeGarbage.actualHours && statusRow().items === beforeGarbage.items,
    { hours: statusRow().actualHours }
  );
  const clearContact = await T("PUT", `/protocols/${statusProtoId}`, { contact: null });
  ok(
    "N3 protokół: `null` w polu NULLABLE czyści kolumnę (a nie wpisuje pusty string)",
    clearContact.status === 200 && statusRow().contact === null,
    statusRow().contact
  );

  // --- N4: data wykonania z panelu trzyma się terminu zlecenia ------------
  const jobDay = dayOffset(6);
  ok(
    "N4 protokół: data wykonania sprzed lat → 400",
    (await T("PUT", `/protocols/${statusProtoId}`, { workDate: "2019-03-04" })).status === 400
  );
  ok(
    "N4 protokół: data o 8 dni od terminu → 400",
    (await T("PUT", `/protocols/${statusProtoId}`, { workDate: dayOffset(14) })).status === 400
  );
  const nearDate = await T("PUT", `/protocols/${statusProtoId}`, { workDate: dayOffset(3) });
  ok(
    "N4 protokół: data w oknie ±7 dni przechodzi",
    nearDate.status === 200 && statusRow().workDate === dayOffset(3),
    statusRow().workDate
  );
  // Biuro tego limitu NIE ma — poprawka daty wstecz to jego normalna praca.
  const officeFar = await officeProtocolsFor(adminUser)("PUT", `/${statusProtoId}`, {
    workDate: "2019-03-04",
    expectedUpdatedAt: statusRow().updatedAt,
  });
  ok(
    "N4 protokół: biuro dalej może wpisać dowolną datę",
    officeFar.status === 200 && statusRow().workDate === "2019-03-04",
    statusRow().workDate
  );
  db.update(schema.protocols).set({ workDate: jobDay }).where(eq(schema.protocols.id, statusProtoId)).run();

  // --- W1: dopisek biura wykrywany po TREŚCI, nie po znaczniku czasu ------
  //
  // Stare porównanie `updated_at` notatki z `updated_at` protokołu było martwe:
  // notatkę odświeżamy w tej samej transakcji, ZARAZ PO zapisie protokołu, więc
  // wychodziło „to nadal nasza notatka" i dopisek biura ginął bez śladu.
  // Tutaj dopisek idzie BEZ ruszania znacznika — czyli dokładnie tak, jak
  // wyglądał przypadek, który stara heurystyka przepuszczała.
  const hashJob = insertEvent({ title: "Notatka hash", type: "serwis", technicianIds: [tech.id], hour: 12, day: dayOffset(6) });
  const hashProtoId =
    ((await T("POST", `/jobs/${hashJob}/protocol`)).data as { protocol?: { id: number } })?.protocol?.id ?? 0;
  const hashRow = () => db.select().from(schema.protocols).where(eq(schema.protocols.id, hashProtoId)).get()!;
  const hashNotes = () =>
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(and(eq(schema.calendarEventNotes.eventId, hashJob), isNull(schema.calendarEventNotes.deletedAt)))
      .all();
  await T("PUT", `/protocols/${hashProtoId}`, { activities: "Pierwszy zapis" });
  ok(
    "W1 notatka: po pierwszym zapisie jest jedna notatka i zapisany odcisk treści",
    hashNotes().length === 1 && !!hashRow().noteHash,
    { notes: hashNotes().length, hash: hashRow().noteHash }
  );
  const ownNoteId = hashRow().noteId;
  await T("PUT", `/protocols/${hashProtoId}`, { activities: "Drugi zapis" });
  ok(
    "W1 notatka: własny kolejny zapis PODMIENIA tę samą notatkę",
    hashNotes().length === 1 && hashRow().noteId === ownNoteId && hashNotes()[0].text.includes("Drugi zapis"),
    hashNotes().map((n) => n.id)
  );
  // Biuro dopisuje zdanie — bez dotykania `updated_at` notatki.
  db.update(schema.calendarEventNotes)
    .set({ text: `${hashNotes()[0].text}\nUWAGA BIURA: klient zapłaci gotówką` })
    .where(eq(schema.calendarEventNotes.id, ownNoteId ?? 0))
    .run();
  await T("PUT", `/protocols/${hashProtoId}`, { activities: "Trzeci zapis" });
  const afterOfficeEdit = hashNotes();
  ok(
    "W1 notatka: dopisek biura bez zmiany updated_at ZOSTAJE, streszczenie idzie do nowej notatki",
    afterOfficeEdit.length === 2 &&
      afterOfficeEdit.some((n) => n.id === ownNoteId && n.text.includes("UWAGA BIURA")) &&
      afterOfficeEdit.some((n) => n.id !== ownNoteId && n.text.includes("Trzeci zapis")),
    afterOfficeEdit.map((n) => ({ id: n.id, t: n.text.slice(0, 40) }))
  );
  ok(
    "W1 notatka: note_id i odcisk przepięte na nową notatkę",
    hashRow().noteId !== ownNoteId && !!hashRow().noteHash,
    { noteId: hashRow().noteId, was: ownNoteId }
  );

  // --- N8: notatka protokołu nie ląduje w USUNIĘTYM wydarzeniu ------------
  {
    const { eventIdForProtocol } = await import("../src/lib/protocols.js");
    const protoRow = hashRow();
    const liveId = eventIdForProtocol(db, protoRow);
    ok("N8 notatka: wydarzenie protokołu znalezione", liveId === hashJob, { liveId, hashJob });
    db.update(schema.calendarEvents)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(schema.calendarEvents.id, hashJob))
      .run();
    ok(
      "N8 notatka: po usunięciu wydarzenia nie ma dokąd pisać (null, nie kosz)",
      eventIdForProtocol(db, protoRow) === null,
      eventIdForProtocol(db, protoRow)
    );
    db.update(schema.calendarEvents)
      .set({ deletedAt: null })
      .where(eq(schema.calendarEvents.id, hashJob))
      .run();
  }

  // --- N7: nieudany insert protokołu nie zjada numeru ---------------------
  const seqDay = dayOffset(7);
  const seqJobA = insertEvent({ title: "Numeracja A", type: "serwis", technicianIds: [tech.id], hour: 8, day: seqDay });
  const seqJobB = insertEvent({ title: "Numeracja B", type: "serwis", technicianIds: [tech.id], hour: 9, day: seqDay });
  const numberOf = (r: { data?: unknown }) =>
    ((r.data as { protocol?: { number: string } })?.protocol?.number ?? "");
  const seqA = numberOf(await T("POST", `/jobs/${seqJobA}/protocol`));
  // Drugie żądanie odbija się o „to zlecenie ma już protokół" — licznik NIE
  // ma prawa się przy tym ruszyć (wcześniej podbijał się przed insertem).
  ok("N7 numeracja: drugi protokół tego samego zlecenia → 409", (await T("POST", `/jobs/${seqJobA}/protocol`)).status === 409);
  const seqB = numberOf(await T("POST", `/jobs/${seqJobB}/protocol`));
  const seqNum = (n: string) => parseInt(n.slice(n.lastIndexOf("/") + 1), 10);
  ok(
    "N7 numeracja: kolejny protokół dostaje numer +1, bez dziury po nieudanym zapisie",
    !!seqA && !!seqB && seqNum(seqB) === seqNum(seqA) + 1,
    { seqA, seqB }
  );
  const seqKey = `protocols.lastSeq.${seqDay.slice(0, 4)}-${seqDay.slice(5, 7)}`;
  ok(
    "N7 numeracja: wysoki stan w app_settings zgadza się z ostatnim WYDANYM numerem",
    parseInt(getSetting(seqKey) ?? "", 10) === seqNum(seqB),
    { stored: getSetting(seqKey), seqB }
  );
  const seqSetting = db.select().from(schema.appSettings).where(eq(schema.appSettings.key, seqKey)).get();
  ok(
    "N7 numeracja: wpis licznika jest podpisany kontem, nie NULL-em",
    seqSetting?.updatedBy === techUser.id,
    seqSetting?.updatedBy
  );

  // --- N6: „Wznów” po omyłkowym „Zakończ” --------------------------------
  const reopenJob = insertEvent({ title: "Do wznowienia", type: "serwis", technicianIds: [tech.id], hour: 8, day: PAST_DAY });
  const reopenRow = () => db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, reopenJob)).get()!;
  ok(
    "N6 wznów: zlecenie niezakończone → 409",
    (await T("POST", `/jobs/${reopenJob}/reopen`)).status === 409
  );
  await T("POST", `/jobs/${reopenJob}/finish`);
  const realizationAfterFinish = reopenRow().realizationId;
  ok("N6 wznów: po „Zakończ” jest realizacja i status done", realizationAfterFinish != null && reopenRow().status === "done", reopenRow());
  const reopened = await T("POST", `/jobs/${reopenJob}/reopen`);
  ok(
    "N6 wznów: 200, finishedAt wyczyszczony, status wraca na `confirmed`",
    reopened.status === 200 && reopenRow().finishedAt == null && reopenRow().status === "confirmed",
    { status: reopenRow().status, finishedAt: reopenRow().finishedAt }
  );
  ok(
    "N6 wznów: w dzienniku notatka „Wznowiono…”",
    db
      .select()
      .from(schema.calendarEventNotes)
      .where(eq(schema.calendarEventNotes.eventId, reopenJob))
      .all()
      .some((n) => n.text.startsWith("Wznowiono")),
    db.select().from(schema.calendarEventNotes).where(eq(schema.calendarEventNotes.eventId, reopenJob)).all().map((n) => n.text)
  );
  ok(
    "N6 wznów: realizacja ZOSTAJE ta sama (nie odpięta, nie skasowana)",
    reopenRow().realizationId === realizationAfterFinish,
    { przed: realizationAfterFinish, po: reopenRow().realizationId }
  );
  // Ponowne „Zakończ” po wznowieniu ma działać i NIE może założyć drugiej realizacji.
  const refinish = await T("POST", `/jobs/${reopenJob}/finish`);
  ok(
    "N6 wznów: ponowne „Zakończ” przechodzi (finishedAt był wyczyszczony)",
    refinish.status === 200 && reopenRow().status === "done" && reopenRow().finishedAt != null,
    refinish
  );
  ok(
    "N6 wznów: ponowne „Zakończ” NIE zakłada drugiej realizacji",
    reopenRow().realizationId === realizationAfterFinish,
    { przed: realizationAfterFinish, po: reopenRow().realizationId }
  );
  const protocolsOfRealization = db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, realizationAfterFinish ?? 0))
    .all();
  ok(
    "N6 wznów: realizacja ma dokładnie jeden protokół",
    protocolsOfRealization.length === 1,
    protocolsOfRealization.map((p) => p.number)
  );
  // Po dobie wznawianie jest już dla biura.
  db.update(schema.calendarEvents)
    .set({ finishedAt: new Date(Date.now() - 30 * 3600_000).toISOString() })
    .where(eq(schema.calendarEvents.id, reopenJob))
    .run();
  const tooLate = await T("POST", `/jobs/${reopenJob}/reopen`);
  ok(
    "N6 wznów: ponad dobę po zakończeniu → 409 z odesłaniem do biura",
    tooLate.status === 409 && /biura/i.test(tooLate.error ?? ""),
    tooLate
  );
  ok(
    "N6 wznów: tryb tylko-do-odczytu nie wznawia (403)",
    (await V("POST", `/jobs/${job}/reopen`)).status === 403
  );

  // --- N11: idempotencja „Zakończ” po cofnięciu statusu przez biuro -------
  const idemJob = insertEvent({ title: "Idempotencja finish", type: "serwis", technicianIds: [tech.id], hour: 7, day: PAST_DAY });
  await T("POST", `/jobs/${idemJob}/finish`);
  const idemRow = () => db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, idemJob)).get()!;
  const idemFinishedAt = idemRow().finishedAt;
  // Biuro cofa status (ale `finished_at` zostaje) — drugie tapnięcie technika
  // nie ma prawa dołożyć drugiego „Zakończono o…”.
  db.update(schema.calendarEvents).set({ status: "confirmed" }).where(eq(schema.calendarEvents.id, idemJob)).run();
  const idemAgain = await T("POST", `/jobs/${idemJob}/finish`, { note: "Drugi raz" });
  const idemNotes = db
    .select()
    .from(schema.calendarEventNotes)
    .where(eq(schema.calendarEventNotes.eventId, idemJob))
    .all();
  ok(
    "N11 finish: po cofnięciu statusu drugie tapnięcie jest bezczynne",
    idemAgain.status === 200 &&
      /już zakończone/i.test(idemAgain.message ?? "") &&
      idemRow().finishedAt === idemFinishedAt,
    { message: idemAgain.message, finishedAt: idemRow().finishedAt }
  );
  ok(
    "N11 finish: bez zdublowanej notatki „Zakończono”",
    idemNotes.filter((n) => n.text.startsWith("Zakończono")).length === 1,
    idemNotes.map((n) => n.text)
  );

  // --- N5: poprawka i usunięcie notatki też zapalają plakietkę -----------
  const noteBadgeJob = insertEvent({ title: "Plakietka notatki", type: "serwis", technicianIds: [tech.id, editTech.id], hour: 13, day: dayOffset(0) });
  const seenNote = new Date(Date.now() - 60_000).toISOString();
  const badgeCount = async () =>
    ((await T("GET", `/me?seenToday=${seenNote}`)).data as { counts: Record<string, number> }).counts.changedToday;
  const officeNote = await E("POST", `/jobs/${noteBadgeJob}/notes`, { text: `${PREFIX} pierwsza wersja` });
  const officeNoteId = (officeNote.data as { id: number })?.id ?? 0;
  db.update(schema.calendarEvents)
    .set({ updatedBy: techUser.id, updatedAt: sql`(datetime('now','-1 hour'))` })
    .where(eq(schema.calendarEvents.id, noteBadgeJob))
    .run();
  const beforeEdit = await badgeCount();
  db.transaction((tx) => updateNote(tx, officeNoteId, `${PREFIX} jednak o 8:00`, { user: editUser }));
  ok("N5 notatka: POPRAWKA notatki biura podbija updated_at zlecenia", (await badgeCount()) === beforeEdit + 1, {
    przed: beforeEdit,
    po: await badgeCount(),
  });
  db.update(schema.calendarEvents)
    .set({ updatedBy: techUser.id, updatedAt: sql`(datetime('now','-1 hour'))` })
    .where(eq(schema.calendarEvents.id, noteBadgeJob))
    .run();
  const beforeDelete = await badgeCount();
  db.transaction((tx) => deleteNote(tx, officeNoteId, { user: editUser }));
  ok("N5 notatka: USUNIĘCIE notatki też podbija updated_at zlecenia", (await badgeCount()) === beforeDelete + 1, {
    przed: beforeDelete,
    po: await badgeCount(),
  });

  // --- Odwołane zlecenie: widoczne pojedynczo, nietykalne -----------------
  const cancelDetail = await T("GET", `/jobs/${cancelledJob}`);
  ok(
    "odwołane: GET /jobs/:id → 200 ze statusem `cancelled` (push prowadzi wprost tutaj)",
    cancelDetail.status === 200 && (cancelDetail.data as { status?: string })?.status === "cancelled",
    cancelDetail
  );
  ok(
    "odwołane: lista nadal go nie pokazuje",
    !ids(await T("GET", `/jobs${RANGE}`)).includes(cancelledJob)
  );
  for (const [label, path, body] of [
    ["Rozpocznij", `/jobs/${cancelledJob}/start`, undefined],
    ["Zakończ", `/jobs/${cancelledJob}/finish`, undefined],
    ["notatka", `/jobs/${cancelledJob}/notes`, { text: "cokolwiek" }],
    ["protokół", `/jobs/${cancelledJob}/protocol`, undefined],
    ["Wznów", `/jobs/${cancelledJob}/reopen`, undefined],
  ] as const) {
    const res = await T("POST", path, body);
    ok(
      `odwołane: ${label} → 409 „Zlecenie zostało odwołane”`,
      res.status === 409 && /odwołane/i.test(res.error ?? ""),
      res
    );
  }
  ok("odwołane: cudze odwołane zlecenie dalej 404", (await O("GET", `/jobs/${cancelledJob}`)).status === 404);

  // „x nowych notatek”: kafelek dostaje czasy CUDZYCH nie-systemowych notatek.
  {
    const fnJob = insertEvent({ title: "Nowe notatki", type: "serwis", technicianIds: [tech.id], hour: 19 });
    db.transaction((tx) => {
      addNote(tx, { eventId: fnJob, text: "moja własna", ctx: { user: techUser } });
      addNote(tx, { eventId: fnJob, text: "z biura", ctx: { user: otherUser } });
      addNote(tx, { eventId: fnJob, text: "Rozpoczęto o 10:00", source: "system", ctx: { user: techUser } });
    });
    const lst = await T("GET", `/jobs${RANGE}`);
    const row = ((lst.data as { id: number; notesCount: number; foreignNotesAt: string[] }[]) ?? []).find((j) => j.id === fnJob);
    ok("nowe notatki: notesCount liczy wszystkie żywe", row?.notesCount === 3, row);
    ok("nowe notatki: foreignNotesAt tylko cudze nie-systemowe", row?.foreignNotesAt?.length === 1, row?.foreignNotesAt);
  }

  // Protokół założony PRZED odwołaniem: ekran odwołanego zlecenia ma go dalej
  // pokazać (odczyt 200), ale nic już w nim nie zmieni (zapis/podpis 409).
  const cancelLater = insertEvent({ title: "Odwołane po protokole", type: "serwis", technicianIds: [tech.id], hour: 18 });
  const cancelProto = await T("POST", `/jobs/${cancelLater}/protocol`);
  const cancelProtoId = (cancelProto.data as { protocol?: { id: number } } | undefined)?.protocol?.id;
  ok("odwołane: protokół założony przed odwołaniem", cancelProto.status === 201 && !!cancelProtoId, cancelProto);
  db.update(schema.calendarEvents).set({ status: "cancelled" }).where(eq(schema.calendarEvents.id, cancelLater)).run();
  if (cancelProtoId) {
    const rd = await T("GET", `/protocols/${cancelProtoId}`);
    ok("odwołane: GET protokołu odwołanego zlecenia → 200", rd.status === 200, rd);
    const wr = await T("PUT", `/protocols/${cancelProtoId}`, { activities: "x", expectedUpdatedAt: (rd.data as { updatedAt?: string })?.updatedAt });
    ok("odwołane: PUT protokołu → 409", wr.status === 409, wr);
    const sg = await T("POST", `/protocols/${cancelProtoId}/sign`, { signaturePng: "data:image/png;base64,iVBORw0KGgo=", signerName: "X", expectedUpdatedAt: (rd.data as { updatedAt?: string })?.updatedAt });
    ok("odwołane: podpis protokołu → 409", sg.status === 409, sg);
  }

  // =========================================================================
  // 22. PUSH — seria, pary znoszące się i próg awarii (W8, N16, S16)
  // =========================================================================
  process.env.VAPID_PUBLIC_KEY = TEST_VAPID_PUBLIC;
  process.env.VAPID_PRIVATE_KEY = "0bw6pjCvok_06kE6DrpV2AclukIo2cHuLjXW5rqrwE0";
  await T("POST", "/push/subscribe", SUB_A);

  // --- W7: stan subskrypcji czytamy z BAZY, nie z przeglądarki ------------
  const mineState = await T("GET", `/push/subscribe?endpoint=${encodeURIComponent(SUB_A.endpoint)}`);
  ok(
    "W7 push: własny endpoint → subscribed: true",
    mineState.status === 200 && (mineState.data as { subscribed?: boolean })?.subscribed === true,
    mineState
  );
  const foreignState = await O("GET", `/push/subscribe?endpoint=${encodeURIComponent(SUB_A.endpoint)}`);
  ok(
    "W7 push: cudzy endpoint → subscribed: false (nie potwierdzamy cudzego wiersza)",
    foreignState.status === 200 && (foreignState.data as { subscribed?: boolean })?.subscribed === false,
    foreignState
  );
  ok(
    "W7 push: bez parametru endpoint → subscribed: false",
    ((await T("GET", "/push/subscribe")).data as { subscribed?: boolean })?.subscribed === false
  );
  // S1: konto „tylko do odczytu" też musi móc włączyć sobie powiadomienia.
  ok(
    "S1 push: konto z „view” zapisuje subskrypcję (własna preferencja, nie edycja)",
    (await V("POST", "/push/subscribe", { endpoint: `${SUB_A.endpoint}/view`, keys: SUB_A.keys })).status === 201
  );

  const seriesSent: PushPayload[] = [];
  const restoreSeries = setPushTransport(async (_t, payload) => {
    seriesSent.push(payload);
  });
  try {
    // --- W8: jedna operacja na serii = JEDNO powiadomienie ---------------
    const seriesIds = db.transaction((tx) => {
      const res = createEvent(
        tx,
        parseInput({
          type: "serwis",
          title: `${PREFIX} Seria serwisowa`,
          department: "technical",
          startAt: `${dayOffset(2)}T09:00`,
          endAt: `${dayOffset(2)}T10:00`,
          objectId: object.id,
          technicianIds: [tech.id],
          recurrence: { freq: "weekly", interval: 1, count: 10 },
        }),
        { user: adminUser }
      );
      return res;
    });
    await flushPush();
    ok(
      "W8 push: utworzenie serii ×10 → 1 zbiorczy ładunek, nie 10",
      seriesSent.length === 1 && /10 termin/.test(seriesSent[0].body) && seriesSent[0].tag?.startsWith("series-"),
      seriesSent
    );
    ok("W8 push: seria ma 10 terminów", seriesIds.occurrencesCount === 10, seriesIds.occurrencesCount);

    seriesSent.length = 0;
    db.transaction((tx) => deleteEvent(tx, seriesIds.firstId, "all", { user: adminUser }));
    await flushPush();
    ok(
      "W8 push: odwołanie całej serii → 1 zbiorczy ładunek „odwołano”",
      seriesSent.length === 1 &&
        seriesSent[0].title === "Zlecenie odwołane" &&
        /10 termin(ów)? odwołano/.test(seriesSent[0].body),
      seriesSent
    );

    // --- N16: nowe + odwołane w jednym tyknięciu znoszą się --------------
    seriesSent.length = 0;
    db.transaction((tx) => {
      const id = createEvent(
        tx,
        parseInput({
          type: "serwis",
          title: `${PREFIX} Pomylka biura`,
          department: "technical",
          startAt: `${FUTURE_DAY}T09:00`,
          endAt: `${FUTURE_DAY}T10:00`,
          objectId: object.id,
          technicianIds: [tech.id],
        }),
        { user: adminUser }
      ).firstId;
      deleteEvent(tx, id, "this", { user: adminUser });
    });
    await flushPush();
    ok(
      "N16 push: zlecenie założone i odwołane w jednym tyknięciu → 0 ładunków",
      seriesSent.length === 0,
      seriesSent
    );
  } finally {
    restoreSeries();
  }

  // --- S2 (fala 2): co kasuje subskrypcję, a co tylko liczy ---------------
  //
  // Kasuje WYŁĄCZNIE jednoznaczna odpowiedź push service (401/403/404/410).
  // Awaria bez statusu („socket hang up") i 5xx to problem po drugiej stronie:
  // wcześniej po dziesiątej takiej próbie wiersz znikał i technik przestawał
  // dostawać powiadomienia na zawsze — cicho, bo przełącznik w panelu dalej
  // pokazywał „włączone".
  const failEndpoint = "https://push.example.invalid/__TECHNIK_TEST__/fail";
  const withTransport = async (err: unknown) => {
    // Rzuca WYŁĄCZNIE dla badanego endpointu: `notifyTechnicians` strzela do
    // wszystkich subskrypcji technika, a pozostałe (SUB_A) są potrzebne dalej.
    const restore = setPushTransport(async (target) => {
      if (target.endpoint === failEndpoint) throw err;
    });
    try {
      await notifyTechnicians([tech.id], { title: "x", body: "y", url: "/technik" }, {});
    } finally {
      restore();
    }
  };
  const failRowOf = () => subsOf(techUser.id).find((s) => s.endpoint === failEndpoint);
  const primeFailures = async (failures: number) => {
    db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, failEndpoint)).run();
    await T("POST", "/push/subscribe", { endpoint: failEndpoint, keys: SUB_A.keys });
    db.update(schema.pushSubscriptions)
      .set({ failures })
      .where(eq(schema.pushSubscriptions.id, failRowOf()?.id ?? 0))
      .run();
  };

  await primeFailures(99);
  await withTransport(new Error("socket hang up"));
  ok(
    "S2 push: błąd bez statusu (socket hang up) NIE kasuje subskrypcji, tylko liczy",
    failRowOf()?.failures === 100,
    failRowOf()
  );
  await withTransport(Object.assign(new Error("bad gateway"), { statusCode: 502 }));
  ok(
    "S2 push: 5xx po stronie push service też nie kasuje wiersza",
    failRowOf()?.failures === 101,
    failRowOf()
  );

  await primeFailures(0);
  await withTransport(Object.assign(new Error("VAPID key mismatch"), { statusCode: 403 }));
  ok(
    "S2 push: 403 (rotacja kluczy VAPID) kasuje wiersz OD RAZU, bez czekania na próg",
    failRowOf() == null,
    subsOf(techUser.id).map((s) => ({ e: s.endpoint, f: s.failures }))
  );
  await primeFailures(0);
  await withTransport(Object.assign(new Error("gone"), { statusCode: 410 }));
  ok("S2 push: 410 kasuje wiersz", failRowOf() == null, failRowOf());
  await primeFailures(0);
  await withTransport(Object.assign(new Error("unauthorized"), { statusCode: 401 }));
  ok("S2 push: 401 kasuje wiersz", failRowOf() == null, failRowOf());
  db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, failEndpoint)).run();

  // --- N9 (fala 2): zwinięcie serii liczy terminy PER TECHNIK -------------
  //
  // Seria bywa obsadzona nierówno. Wcześniej zbiorczy ładunek szedł z sumą
  // WSZYSTKICH zdarzeń w grupie, więc technik z jednym terminem dostawał
  // „10 terminów przesunięto" — informację o cudzych zleceniach.
  const perTech = new Map<string, PushPayload[]>();
  const restorePerTech = setPushTransport(async (target, payload) => {
    const list = perTech.get(target.endpoint) ?? [];
    list.push(payload);
    perTech.set(target.endpoint, list);
  });
  const SUB_SOLO = {
    endpoint: "https://push.example.invalid/__TECHNIK_TEST__/solo",
    keys: SUB_A.keys,
  };
  await O("POST", "/push/subscribe", SUB_SOLO);
  try {
    const seriesStart = dayOffset(6);
    const series = db.transaction((tx) =>
      createEvent(
        tx,
        parseInput({
          type: "serwis",
          title: `${PREFIX} Seria nierówno obsadzona`,
          department: "technical",
          startAt: `${seriesStart}T09:00`,
          endAt: `${seriesStart}T10:00`,
          objectId: object.id,
          technicianIds: [tech.id],
          recurrence: { freq: "weekly", interval: 1, count: 4 },
        }),
        { user: adminUser }
      )
    );
    await flushPush();
    perTech.clear();
    // Drugi technik (otherTech) wchodzi tylko na PIERWSZY termin serii.
    db.insert(schema.calendarEventAssignees)
      .values({ eventId: series.firstId, technicianId: otherTech.id })
      .run();
    // Odwołanie całej serii: obsadzony na wszystkich dostaje zbiorcze
    // „4 terminy odwołano", dopisany do jednego — powiadomienie o tym jednym.
    db.transaction((tx) => deleteEvent(tx, series.firstId, "all", { user: adminUser }));
    await flushPush();
    const fullPayloads = perTech.get(SUB_A.endpoint) ?? [];
    const soloPayloads = perTech.get(SUB_SOLO.endpoint) ?? [];
    ok(
      "N9 push: technik z całą serią dostaje ZBIORCZE powiadomienie o 4 terminach",
      fullPayloads.length === 1 && /4 termin(y|ów)? odwołano/.test(fullPayloads[0]?.body ?? ""),
      fullPayloads
    );
    ok(
      "N9 push: technik z JEDNYM terminem nie dostaje liczby cudzych zleceń",
      soloPayloads.length === 1 && !/4 termin/.test(soloPayloads[0]?.body ?? ""),
      soloPayloads
    );
  } finally {
    restorePerTech();
    db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.endpoint, SUB_SOLO.endpoint)).run();
  }
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  restorePushEnv();
  restoreActivitiesSetting();
  restoreCompanySettings();
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
