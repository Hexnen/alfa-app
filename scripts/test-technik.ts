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
import { and, eq, inArray, like, or } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import technikRoutes from "../src/routes/technik.js";
import objectsRoutes from "../src/routes/objects.js";
import calendarRoutes from "../src/routes/calendar.js";
import adminRoutes from "../src/routes/admin.js";
import adminTechnikRoutes from "../src/routes/admin-technik.js";
import { TECHNIK_ACTIVITIES_KEY } from "../src/lib/technik-config.js";
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

/** Klient panelu technika: kontekst jak po requireAuth + oba prawdziwe strażniki. */
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

  const badSign = await T("POST", `/protocols/${protocolId}/sign`, { signaturePng: "nie-png", signerName: "Jan" });
  ok("podpis: bez PNG → 400", badSign.status === 400, badSign);

  const sign = await T("POST", `/protocols/${protocolId}/sign`, {
    signaturePng: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    signerName: "Klient Odbierający",
  });
  ok("podpis: 200 i status final", sign.status === 200 && (sign.data as { status?: string })?.status === "final", sign);
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
  });
  const afterSign = systemNotes();
  ok("notatka protokołu: po podpisie nadal JEDNA notatka", afterSign.length === 1, afterSign.length);
  ok(
    "notatka protokołu: po podpisie „podpisany” i nazwisko odbierającego",
    afterSign[0].text.includes("podpisany") && afterSign[0].text.includes("Anna Odbierająca"),
    afterSign[0]?.text
  );
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  restoreActivitiesSetting();
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
