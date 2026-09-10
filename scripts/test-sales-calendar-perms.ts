/**
 * Izolacja działów w kalendarzu (technical ↔ handlowy) — trasy Hono przez `app.request`,
 * z podstawionym userem w kontekście i PRAWDZIWYM `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-sales-calendar-perms.ts
 *   npx tsx scripts/test-sales-calendar-perms.ts            # na data/alfa.db (sprząta po sobie)
 *
 * Prefiks `/calendar` w API_TAB_MAP jest tylko grubą bramką — wpuszcza posiadacza
 * DOWOLNEGO klucza kalendarza. Właściwa kontrola jest wierszowa (src/lib/calendar-scope.ts)
 * i to ona jest tu sprawdzana, w OBIE strony:
 *   • user z samym `handlowy/kalendarz` nie widzi ani nie tyka wydarzeń technicznych,
 *   • user z samym `technical/kalendarz` nie widzi ani nie tyka handlowych,
 *   • dotyczy to też notatek, wyszukiwarki notatek, kolizji, dostępności, wydarzeń
 *     obiektu i feedu ICS (który chodzi POZA sesją, po tokenie),
 *   • `handlowy/leady: edit` daje prawo edycji kalendarza handlowego (planowanie
 *     następnej aktywności jest częścią pracy na szansie),
 *   • zmiana działu istniejącego wydarzenia jest zabroniona (400).
 *
 * Sprząta po sobie HARD (wydarzenia, notatki, przypisania, dziennik, szanse, handlowcy,
 * konta), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import calendarRoutes, { calendarPublicRoutes } from "../src/routes/calendar.js";
import contractorsRoutes from "../src/routes/contractors.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__SCP_TEST__";
const DAY = "2026-10-14";

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
  if (eventIds.length) {
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.calendarEventSalespeople).where(inArray(schema.calendarEventSalespeople.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  db.delete(schema.leads).where(like(schema.leads.title, `${PREFIX}%`)).run();
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
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

function makeUser(suffix: string, permissions: PermissionMap): User {
  return db
    .insert(schema.users)
    .values({
      email: `${PREFIX}${suffix}@example.invalid`,
      passwordHash: "x", // konto nigdy się nie loguje — kontekst podstawiamy wprost
      displayName: `${PREFIX}${suffix}`,
      role: "user",
      permissions: JSON.stringify(permissions),
      calendarToken: `${PREFIX}${suffix}${"0".repeat(24)}`.slice(0, 40),
    })
    .returning()
    .get();
}

/** Klient HTTP dla usera: kontekst jak po requireAuth + prawdziwy strażnik zakładek. */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/calendar", calendarRoutes);
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/calendar${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as { success?: boolean; data?: unknown; error?: string } | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/**
 * Klient kartoteki kontrahentów dla usera — ten sam strażnik, inny router.
 * Handlowiec z samymi kluczami `handlowy/*` MUSI móc przeczytać słownik do
 * selecta (`/contractors/catalog`), ale NIE całą kartotekę.
 */
function contractorsFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/contractors", contractorsRoutes);
  return async (method: string, path: string) => {
    const res = await app.request(`/api/contractors${path}`, { method });
    return { status: res.status };
  };
}

/** Publiczny feed ICS — poza sesją, autoryzacja wyłącznie tokenem. */
const publicApp = new Hono();
publicApp.route("/api/calendar", calendarPublicRoutes);
async function feed(token: string): Promise<{ status: number; text: string }> {
  const res = await publicApp.request(`/api/calendar/feed.ics?token=${token}`);
  return { status: res.status, text: await res.text() };
}

const techUser = makeUser("tech", { "technical/kalendarz": "edit" });
const salesUser = makeUser("sales", { "handlowy/kalendarz": "edit" });
const leadsUser = makeUser("leads", { "handlowy/leady": "edit" });
const salesViewer = makeUser("view", { "handlowy/kalendarz": "view" });
const otherSalesUser = makeUser("sales2", { "handlowy/kalendarz": "edit" });

const T = clientFor(techUser);
const S = clientFor(salesUser);
const L = clientFor(leadsUser);
const V = clientFor(salesViewer);

// Handlowcy: jeden przypięty do konta (filtr „Moje” i ICS), drugi obcy.
const salesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Anna", lastName: `${PREFIX}Kowalska`, userId: salesUser.id })
  .returning()
  .get();
const otherSalesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Piotr", lastName: `${PREFIX}Nowak`, userId: otherSalesUser.id })
  .returning()
  .get();

const lead = db
  .insert(schema.leads)
  .values({ title: `${PREFIX} Szansa`, stage: "nowy", salespersonId: salesperson.id, createdBy: salesUser.id })
  .returning()
  .get();

const objectId = db.select({ id: schema.objects.id }).from(schema.objects).limit(1).get()?.id ?? null;

function insertEvent(p: {
  department: "technical" | "handlowy";
  type: "serwis" | "telefon" | "spotkanie";
  title: string;
  createdBy: number;
  leadId?: number | null;
  salespersonId?: number | null;
  startAt?: string;
}) {
  const startAt = p.startAt ?? `${DAY}T09:00`;
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: p.type,
      title: `${PREFIX} ${p.title}`,
      startAt,
      endAt: `${startAt.slice(0, 10)}T${String(Number(startAt.slice(11, 13)) + 1).padStart(2, "0")}:00`,
      allDay: false,
      status: "planned",
      department: p.department,
      objectId,
      leadId: p.leadId ?? null,
      createdBy: p.createdBy,
      updatedBy: p.createdBy,
    })
    .returning()
    .get();
  if (p.salespersonId) {
    db.insert(schema.calendarEventSalespeople).values({ eventId: ev.id, salespersonId: p.salespersonId }).run();
  }
  return ev.id;
}

function addNoteRow(eventId: number, user: User, text: string): number {
  return db
    .insert(schema.calendarEventNotes)
    .values({ eventId, userId: user.id, userLabel: user.displayName, source: "user", text })
    .returning()
    .get().id;
}

const ids = (r: { data?: unknown }) => ((r.data as { id: number }[] | undefined) ?? []).map((e) => e.id);

try {
  const techEv = insertEvent({ department: "technical", type: "serwis", title: "Serwis techniczny", createdBy: techUser.id });
  const salesEv = insertEvent({
    department: "handlowy",
    type: "telefon",
    title: "Telefon do klienta",
    createdBy: salesUser.id,
    leadId: lead.id,
    salespersonId: salesperson.id,
    startAt: `${DAY}T11:00`,
  });
  const otherSalesEv = insertEvent({
    department: "handlowy",
    type: "spotkanie",
    title: "Spotkanie cudze",
    createdBy: otherSalesUser.id,
    salespersonId: otherSalesperson.id,
    startAt: `${DAY}T13:00`,
  });
  const techNote = addNoteRow(techEv, techUser, `${PREFIX} notatka techniczna — poufne`);
  const salesNote = addNoteRow(salesEv, salesUser, `${PREFIX} notatka handlowa — poufne`);

  const range = `?from=${DAY}&to=2026-10-15`;

  // =========================================================================
  // 1. Lista wydarzeń — w obie strony
  // =========================================================================
  const techList = await T("GET", `/events${range}`);
  ok("technik: lista zawiera wydarzenie techniczne", ids(techList).includes(techEv), techList);
  ok("technik: lista NIE zawiera handlowych", !ids(techList).includes(salesEv) && !ids(techList).includes(otherSalesEv), ids(techList));
  const salesList = await S("GET", `/events${range}`);
  ok("handlowiec: lista zawiera wydarzenia handlowe", ids(salesList).includes(salesEv) && ids(salesList).includes(otherSalesEv), salesList);
  ok("handlowiec: lista NIE zawiera technicznych", !ids(salesList).includes(techEv), ids(salesList));

  ok("technik: ?department=handlowy → 403", (await T("GET", `/events${range}&department=handlowy`)).status === 403);
  ok("handlowiec: ?department=technical → 403", (await S("GET", `/events${range}&department=technical`)).status === 403);
  ok("nieznany dział → 400", (await S("GET", `/events${range}&department=ksiegowosc`)).status === 400);

  // Filtr „Moje” po salespeople.user_id; bez powiązania — pusty zbiór, nie błąd.
  const mine = await S("GET", `/events${range}&salespersonId=me`);
  ok("salespersonId=me: tylko własne wydarzenia handlowca", ids(mine).join() === String(salesEv), mine);
  const notMine = await L("GET", `/events${range}&salespersonId=me`);
  ok("salespersonId=me bez konta handlowca → pusto (nie błąd)", notMine.status === 200 && ids(notMine).length === 0, notMine);
  const byLead = await S("GET", `/events${range}&leadId=${lead.id}`);
  ok("filtr leadId zawęża do aktywności szansy", ids(byLead).join() === String(salesEv), byLead);

  // =========================================================================
  // 2. Pojedyncze wydarzenie
  // =========================================================================
  ok("technik: GET własnego wydarzenia → 200", (await T("GET", `/events/${techEv}`)).status === 200);
  ok("technik: GET handlowego → 403", (await T("GET", `/events/${salesEv}`)).status === 403);
  ok("handlowiec: GET technicznego → 403", (await S("GET", `/events/${techEv}`)).status === 403);
  ok("handlowiec: GET własnego → 200", (await S("GET", `/events/${salesEv}`)).status === 200);

  // =========================================================================
  // 3. Mutacje na cudzym dziale
  // =========================================================================
  const putBody = { type: "telefon", department: "handlowy", title: `${PREFIX} podmiana`, startAt: `${DAY}T11:00`, endAt: `${DAY}T12:00` };
  ok("technik: PUT na handlowym → 403", (await T("PUT", `/events/${salesEv}`, putBody)).status === 403);
  ok("technik: PATCH move na handlowym → 403", (await T("PATCH", `/events/${salesEv}/move`, { startAt: `${DAY}T15:00` })).status === 403);
  ok("technik: DELETE handlowego → 403", (await T("DELETE", `/events/${salesEv}`)).status === 403);
  ok("technik: POST notatki do handlowego → 403", (await T("POST", `/events/${salesEv}/notes`, { text: "hack" })).status === 403);

  const techPut = { type: "serwis", title: `${PREFIX} podmiana`, startAt: `${DAY}T09:00`, endAt: `${DAY}T10:00` };
  ok("handlowiec: PUT na technicznym → 403", (await S("PUT", `/events/${techEv}`, techPut)).status === 403);
  ok("handlowiec: PATCH move na technicznym → 403", (await S("PATCH", `/events/${techEv}/move`, { startAt: `${DAY}T15:00` })).status === 403);
  ok("handlowiec: DELETE technicznego → 403", (await S("DELETE", `/events/${techEv}`)).status === 403);
  ok("handlowiec: POST notatki do technicznego → 403", (await S("POST", `/events/${techEv}/notes`, { text: "hack" })).status === 403);

  // =========================================================================
  // 4. Tworzenie: dział z ciała musi być w zasięgu uprawnień
  // =========================================================================
  const techCreatesSales = await T("POST", "/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} nieautoryzowane`, startAt: `${DAY}T16:00`, endAt: `${DAY}T16:30`,
  });
  ok("technik: POST wydarzenia handlowego → 403", techCreatesSales.status === 403, techCreatesSales);
  const salesCreatesTech = await S("POST", "/events", {
    department: "technical", type: "serwis", title: `${PREFIX} nieautoryzowane`, startAt: `${DAY}T16:00`, endAt: `${DAY}T16:30`,
  });
  ok("handlowiec: POST wydarzenia technicznego → 403", salesCreatesTech.status === 403, salesCreatesTech);

  const created = await S("POST", "/events", {
    department: "handlowy", type: "spotkanie", title: `${PREFIX} spotkanie własne`, startAt: `${DAY}T17:00`, endAt: `${DAY}T18:00`,
    salespersonIds: [salesperson.id], leadId: lead.id,
  });
  ok("handlowiec: POST własnego działu → 201", created.status === 201, created);
  const createdId = (created.data as { id?: number } | undefined)?.id ?? 0;
  ok("…z przypisanym handlowcem i szansą", (created.data as { salespeople?: unknown[]; leadId?: number })?.salespeople?.length === 1 && (created.data as { leadId?: number })?.leadId === lead.id, created.data);
  ok("…touchLead odbił last_activity_at szansy",
    db.select({ ts: schema.leads.lastActivityAt }).from(schema.leads).where(eq(schema.leads.id, lead.id)).get()?.ts != null);

  // Typ spoza działu — jedna reguła dla obu stron.
  const wrongType = await S("POST", "/events", {
    department: "handlowy", type: "montaz", title: `${PREFIX} zły typ`, startAt: `${DAY}T19:00`, endAt: `${DAY}T20:00`,
  });
  ok("typ techniczny w dziale handlowym → 400", wrongType.status === 400, wrongType);

  // Zmiana działu istniejącego wydarzenia — zabroniona (400, nie 403).
  const switchDept = await S("PUT", `/events/${salesEv}`, {
    type: "serwis", department: "technical", title: `${PREFIX} przeniesione`, startAt: `${DAY}T11:00`, endAt: `${DAY}T12:00`,
  });
  ok("PUT zmieniający dział → 400", switchDept.status === 400, switchDept);

  // =========================================================================
  // 5. Klucz `handlowy/leady` też otwiera edycję kalendarza handlowego
  // =========================================================================
  const leadsCreate = await L("POST", "/events", {
    department: "handlowy", type: "zadanie", title: `${PREFIX} zadanie z leadów`, startAt: `${DAY}T20:00`, endAt: `${DAY}T20:30`,
  });
  ok("handlowy/leady: POST wydarzenia handlowego → 201", leadsCreate.status === 201, leadsCreate);
  ok("handlowy/leady: GET technicznego nadal 403", (await L("GET", `/events/${techEv}`)).status === 403);

  // Poziom „view” w kalendarzu handlowym: czyta, ale nie zapisuje (bramka prefiksu).
  ok("handlowy/kalendarz: view czyta listę", (await V("GET", `/events${range}`)).status === 200);
  const viewerWrite = await V("POST", "/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} z podglądu`, startAt: `${DAY}T21:00`, endAt: `${DAY}T21:30`,
  });
  ok("handlowy/kalendarz: view nie zapisuje → 403", viewerWrite.status === 403, viewerWrite);

  // =========================================================================
  // 6. Notatki: odczyt, edycja i WYSZUKIWARKA
  // =========================================================================
  ok("technik: GET notatek handlowego → 403", (await T("GET", `/events/${salesEv}/notes`)).status === 403);
  ok("handlowiec: GET notatek technicznego → 403", (await S("GET", `/events/${techEv}/notes`)).status === 403);
  ok("technik: PUT cudzej notatki handlowej → 403", (await T("PUT", `/notes/${salesNote}`, { text: "hack" })).status === 403);
  ok("handlowiec: DELETE notatki technicznej → 403", (await S("DELETE", `/notes/${techNote}`)).status === 403);

  const techSearch = await T("GET", `/notes/search?q=${encodeURIComponent(PREFIX)}`);
  const techFound = ((techSearch.data as { id: number }[] | undefined) ?? []).map((n) => n.id);
  ok("technik: wyszukiwarka notatek widzi techniczną", techFound.includes(techNote), techFound);
  ok("technik: …i NIE widzi handlowej", !techFound.includes(salesNote), techFound);
  const salesSearch = await S("GET", `/notes/search?q=${encodeURIComponent(PREFIX)}`);
  const salesFound = ((salesSearch.data as { id: number }[] | undefined) ?? []).map((n) => n.id);
  ok("handlowiec: wyszukiwarka notatek widzi handlową", salesFound.includes(salesNote), salesFound);
  ok("handlowiec: …i NIE widzi technicznej", !salesFound.includes(techNote), salesFound);

  // Własna notatka na własnym wydarzeniu przechodzi (i odbija znacznik szansy).
  const noteAdd = await S("POST", `/events/${salesEv}/notes`, { text: `${PREFIX} rozmowa odbyta` });
  ok("handlowiec: notatka na własnym wydarzeniu → 201", noteAdd.status === 201, noteAdd);

  // =========================================================================
  // 7. Kolizje, dostępność, wydarzenia obiektu
  // =========================================================================
  const conflicts = await S("GET", `/conflicts?salespersonIds=${salesperson.id}&startAt=${DAY}T10:30&endAt=${DAY}T12:30`);
  ok("kolizje handlowców: wykrywa własne wydarzenie", ids(conflicts).includes(salesEv), conflicts);
  const techConflicts = await T("GET", `/conflicts?salespersonIds=${salesperson.id}&startAt=${DAY}T10:30&endAt=${DAY}T12:30`);
  ok("technik: kolizje handlowca nie wyciekają", ids(techConflicts).length === 0, techConflicts);

  ok("technik: availability?department=handlowy → 403", (await T("GET", `/availability?from=${DAY}&to=2026-10-15&department=handlowy`)).status === 403);
  const salesAvail = await S("GET", `/availability?from=${DAY}&to=2026-10-15&department=handlowy`);
  ok("handlowiec: availability handlowa → 200 (wiersze per handlowiec)",
    salesAvail.status === 200 && Array.isArray(salesAvail.data), salesAvail);
  ok("handlowiec: availability bez działu (techniczna) → 403", (await S("GET", `/availability?from=${DAY}&to=2026-10-15`)).status === 403);

  if (objectId != null) {
    const techObj = await T("GET", `/objects/${objectId}/events`);
    ok("technik: wydarzenia obiektu bez handlowych", !ids(techObj).includes(salesEv) && ids(techObj).includes(techEv), ids(techObj));
    const salesObj = await S("GET", `/objects/${objectId}/events`);
    ok("handlowiec: wydarzenia obiektu bez technicznych", !ids(salesObj).includes(techEv) && ids(salesObj).includes(salesEv), ids(salesObj));
  }

  // =========================================================================
  // 8. Feed ICS (poza sesją — uprawnienia z konta właściciela tokenu)
  // =========================================================================
  const techFeed = await feed(techUser.calendarToken!);
  ok("ICS technika: 200", techFeed.status === 200, techFeed.status);
  ok("ICS technika: zawiera wydarzenie techniczne", techFeed.text.includes("Serwis techniczny"), techFeed.text.slice(0, 200));
  ok("ICS technika: NIE zawiera handlowych", !techFeed.text.includes("Telefon do klienta") && !techFeed.text.includes("Spotkanie cudze"));

  const salesFeed = await feed(salesUser.calendarToken!);
  ok("ICS handlowca: zawiera własne wydarzenie", salesFeed.text.includes("Telefon do klienta"), salesFeed.text.slice(0, 200));
  ok("ICS handlowca: NIE zawiera technicznych", !salesFeed.text.includes("Serwis techniczny"));
  ok("ICS handlowca: NIE zawiera cudzego wydarzenia handlowego", !salesFeed.text.includes("Spotkanie cudze"), salesFeed.text.slice(0, 400));

  ok("ICS: zły token → 401", (await feed("x".repeat(40))).status === 401);

  // =========================================================================
  // 9. Słownik kontrahentów dla modułu handlowego (GET /contractors/catalog)
  // =========================================================================
  // Bez osobnej reguły w API_TAB_MAP handlowiec z samym `handlowy/leady` nie mógł
  // podpiąć szansy ani kontaktu pod istniejącą kartotekę — select leciał na 403.
  const LC = contractorsFor(leadsUser);
  ok("handlowy/leady: GET /contractors/catalog → 200", (await LC("GET", "/catalog")).status === 200);
  ok("handlowy/leady: GET /contractors (pełna kartoteka) → 403", (await LC("GET", "")).status === 403);
  ok("handlowy/leady: GET /contractors/by-nip → 403", (await LC("GET", "/by-nip/0000000000")).status === 403);
  const SC = contractorsFor(salesUser);
  ok("handlowy/kalendarz: GET /contractors/catalog → 200", (await SC("GET", "/catalog")).status === 200);
  const TC = contractorsFor(techUser);
  ok("technical/kalendarz: GET /contractors/catalog → 403", (await TC("GET", "/catalog")).status === 403);
  ok("catalog jest tylko do odczytu: POST → 403", (await LC("POST", "/catalog")).status === 403);

  // Sprzątanie wydarzeń utworzonych trasami (mają PREFIX w tytule → łapie je cleanup()).
  void createdId;
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
