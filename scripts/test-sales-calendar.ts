/**
 * Kalendarz handlowy — trasy `/calendar`, `/leads` i `/analytics/lejek` przez `app.request`,
 * z podstawionym userem w kontekście i PRAWDZIWYM `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-sales-calendar.ts
 *   npx tsx scripts/test-sales-calendar.ts        # na data/alfa.db (sprząta po sobie)
 *
 * Bliźniak `scripts/test-sales-calendar-perms.ts` pilnuje IZOLACJI działów (kto czego
 * nie widzi). Tutaj chodzi o DZIAŁANIE działu handlowego — że kalendarz, na którym
 * stoi cały moduł, robi to, co obiecuje plan (§3.3):
 *   • CRUD wydarzeń handlowych i rozłączność typów (montaż w handlowym / telefon
 *     w technicznym to zawsze pomyłka klienta, nie „prawie dobrze”),
 *   • przypisania handlowców (`salespersonIds`) z wpisami assigned/unassigned,
 *   • `salespersonId=me` po `salespeople.user_id` — a konto bez powiązania dostaje
 *     PUSTY zbiór, nie cudzy kalendarz,
 *   • kolizje po handlowcach, dostępność `?department=handlowy` (urlop handlowy
 *     wymaga handlowca i pokazuje się w jego wierszu),
 *   • kafelek notatki dziedziczy dział i szansę ze źródła,
 *   • walidacja `leadId`/`contactId` (kontakt musi należeć do szansy albo jej kontrahenta),
 *   • `touchLead` przy tworzeniu, przesuwaniu, notatce i usuwaniu — zgodnie
 *     z `recomputeLastActivity` (denormalizacja nie ma prawa się rozjechać),
 *   • ICS handlowca: własne wydarzenia handlowe, bez technicznych i bez cudzych,
 *   • serie handlowe i edycja `scope=future`,
 *   • dym pod `GET /analytics/lejek`: kohorta, konwersja, win rate, powód przegranej.
 *
 * Sprząta po sobie HARD (wydarzenia, serie, notatki, przypisania, dziennik, szanse,
 * kontakty, kontrahenci, handlowcy, konta), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import calendarRoutes, { calendarPublicRoutes } from "../src/routes/calendar.js";
import leadsRoutes from "../src/routes/leads.js";
import analyticsRoutes from "../src/routes/analytics.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { recomputeLastActivity } from "../src/lib/sales-leads.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__SCAL_TEST__";
/** Dzień testowy — w przyszłości, żeby wydarzenia liczyły się jako „następna aktywność”. */
const DAY = "2026-11-18";
const DAY2 = "2026-11-19";

/** Data przesunięta o `n` dni od `DAY` (YYYY-MM-DD). */
function day(n: number): string {
  return new Date(Date.parse(`${DAY}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): number {
  const spIds = db
    .select({ id: schema.salespeople.id })
    .from(schema.salespeople)
    .where(like(schema.salespeople.lastName, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const leadIds = db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(like(schema.leads.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);

  // Wydarzenia łapiemy TRZEMA drogami, bo tytuł nie zawsze niesie prefiks:
  // urlop dostaje tytuł z nazwiska handlowca, a kafelek notatki z jej treści.
  const eventIds = new Set<number>(
    db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(like(schema.calendarEvents.title, `%${PREFIX}%`))
      .all()
      .map((r) => r.id)
  );
  if (spIds.length) {
    for (const r of db
      .select({ id: schema.calendarEventSalespeople.eventId })
      .from(schema.calendarEventSalespeople)
      .where(inArray(schema.calendarEventSalespeople.salespersonId, spIds))
      .all()) {
      eventIds.add(r.id);
    }
  }
  if (leadIds.length) {
    for (const r of db
      .select({ id: schema.calendarEvents.id })
      .from(schema.calendarEvents)
      .where(inArray(schema.calendarEvents.leadId, leadIds))
      .all()) {
      eventIds.add(r.id);
    }
  }

  const ids = [...eventIds];
  if (ids.length) {
    const seriesIds = [
      ...new Set(
        db
          .select({ seriesId: schema.calendarEvents.seriesId })
          .from(schema.calendarEvents)
          .where(inArray(schema.calendarEvents.id, ids))
          .all()
          .map((r) => r.seriesId)
          .filter((v): v is number => v != null)
      ),
    ];
    const noteIds = db
      .select({ id: schema.calendarEventNotes.id })
      .from(schema.calendarEventNotes)
      .where(inArray(schema.calendarEventNotes.eventId, ids))
      .all()
      .map((r) => r.id);
    if (noteIds.length) {
      db.delete(schema.calendarNoteAttachments).where(inArray(schema.calendarNoteAttachments.noteId, noteIds)).run();
    }
    db.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.eventId, ids)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, ids)).run();
    db.delete(schema.calendarEventSalespeople).where(inArray(schema.calendarEventSalespeople.eventId, ids)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, ids)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, ids)).run();
    if (seriesIds.length) db.delete(schema.calendarSeries).where(inArray(schema.calendarSeries.id, seriesIds)).run();
  }

  if (leadIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.leadId, leadIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "lead"), inArray(schema.activityLog.entityId, leadIds)))
      .run();
    db.delete(schema.leads).where(inArray(schema.leads.id, leadIds)).run();
  }
  const contractorIds = db
    .select({ id: schema.contractors.id })
    .from(schema.contractors)
    .where(like(schema.contractors.name, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (contractorIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.contractorId, contractorIds)).run();
    db.delete(schema.contractors).where(inArray(schema.contractors.id, contractorIds)).run();
  }
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
  return ids.length;
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

type Res = { status: number; success?: boolean; data?: unknown; error?: string };

/** Klient HTTP dla usera: kontekst jak po requireAuth + prawdziwy strażnik zakładek. */
function clientFor(user: User) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("user", user);
    return next();
  });
  app.use("*", tabPermissionGuard);
  app.route("/api/calendar", calendarRoutes);
  app.route("/api/leads", leadsRoutes);
  app.route("/api/analytics", analyticsRoutes);
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as Omit<Res, "status"> | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** Publiczny feed ICS — poza sesją, autoryzacja wyłącznie tokenem. */
const publicApp = new Hono();
publicApp.route("/api/calendar", calendarPublicRoutes);
async function feed(token: string): Promise<{ status: number; text: string }> {
  const res = await publicApp.request(`/api/calendar/feed.ics?token=${token}`);
  return { status: res.status, text: await res.text() };
}

const SALES_PERMS: PermissionMap = {
  "handlowy/kalendarz": "edit",
  "handlowy/leady": "edit",
  "handlowy/kontakty": "edit",
  "analityka/handlowcy": "view",
};

const salesUser = makeUser("sales", SALES_PERMS);
/** Konto handlowe BEZ wiersza w słowniku handlowców — sprawdza „Moje” bez powiązania. */
const looseUser = makeUser("loose", { "handlowy/kalendarz": "edit" });
const techUser = makeUser("tech", { "technical/kalendarz": "edit" });
const otherSalesUser = makeUser("sales2", { "handlowy/kalendarz": "edit" });
/** Konto z OBOMA kalendarzami — sprawdza nazwę feedu ICS („Alfa — kalendarz”). */
const bothUser = makeUser("both", { "handlowy/kalendarz": "edit", "technical/kalendarz": "edit" });

const S = clientFor(salesUser);
const U = clientFor(looseUser);
const T = clientFor(techUser);
const O = clientFor(otherSalesUser);

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
/** Osobny opiekun wyłącznie dla lejka — kohorta `?salespersonId=` ma być czysta. */
const funnelSalesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Ewa", lastName: `${PREFIX}Lejek` })
  .returning()
  .get();

/** NIP-y są wymagane i unikalne w kartotece — bierzemy pierwsze wolne z puli testowej. */
function freeNip(): string {
  for (let n = 9_000_000_000; n < 9_000_001_000; n++) {
    const nip = String(n);
    const taken = db.select({ id: schema.contractors.id }).from(schema.contractors).where(eq(schema.contractors.nip, nip)).get();
    if (!taken) return nip;
  }
  throw new Error("Brak wolnego NIP-u testowego");
}

const contractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Kontrahent sp. z o.o.`, nip: freeNip() })
  .returning()
  .get();
const otherContractor = db
  .insert(schema.contractors)
  .values({ name: `${PREFIX} Obcy sp. z o.o.`, nip: freeNip() })
  .returning()
  .get();

const lead = db
  .insert(schema.leads)
  .values({
    title: `${PREFIX} Szansa główna`,
    stage: "nowy",
    contractorId: contractor.id,
    salespersonId: salesperson.id,
    createdBy: salesUser.id,
  })
  .returning()
  .get();

/** Kontakt szansy, kontakt jej kontrahenta i kontakt zupełnie obcy. */
const leadContact = db
  .insert(schema.contacts)
  .values({ leadId: lead.id, contractorId: contractor.id, firstName: "Jan", lastName: `${PREFIX}Szansowy` })
  .returning()
  .get();
const contractorContact = db
  .insert(schema.contacts)
  .values({ contractorId: contractor.id, firstName: "Maria", lastName: `${PREFIX}Kartotekowa` })
  .returning()
  .get();
const foreignContact = db
  .insert(schema.contacts)
  .values({ contractorId: otherContractor.id, firstName: "Zbigniew", lastName: `${PREFIX}Obcy` })
  .returning()
  .get();

const ids = (r: Res) => ((r.data as { id: number }[] | undefined) ?? []).map((e) => e.id);
const one = (r: Res) => (r.data ?? {}) as Record<string, unknown>;
const eventRow = (id: number) =>
  db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
const leadRow = (id: number) => db.select().from(schema.leads).where(eq(schema.leads.id, id)).get();
const logOf = (eventId: number) =>
  db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, eventId)))
    .all();

try {
  // =========================================================================
  // 1. CRUD wydarzenia handlowego i rozłączność typów
  // =========================================================================
  const created = await S("POST", "/calendar/events", {
    department: "handlowy",
    type: "spotkanie",
    title: `${PREFIX} Spotkanie u klienta`,
    startAt: `${DAY}T10:00`,
    endAt: `${DAY}T11:00`,
    location: "Katowice, ul. Testowa 1",
    salespersonIds: [salesperson.id],
    leadId: lead.id,
    contactId: leadContact.id,
  });
  ok("POST wydarzenia handlowego → 201", created.status === 201, created);
  const meetingId = Number(one(created).id);
  ok("…dział handlowy w odpowiedzi", one(created).department === "handlowy", one(created).department);
  ok("…szansa i kontakt rozwiązane po nazwie",
    one(created).leadId === lead.id && one(created).contactId === leadContact.id &&
      String(one(created).leadTitle).includes("Szansa główna") && String(one(created).contactName).includes("Szansowy"),
    one(created));
  ok("…handlowiec przypisany",
    ((one(created).salespeople as { id: number }[]) ?? []).map((s) => s.id).join() === String(salesperson.id),
    one(created).salespeople);
  ok("…technicy puści w dziale handlowym", ((one(created).technicians as unknown[]) ?? []).length === 0, one(created).technicians);

  // Wszystkie typy handlowe muszą przechodzić — inaczej chipy w UI kłamią.
  for (const type of ["telefon", "email", "zadanie", "prezentacja", "termin", "wizja"] as const) {
    const r = await S("POST", "/calendar/events", {
      department: "handlowy",
      type,
      title: `${PREFIX} ${type}`,
      startAt: `${DAY2}T09:00`,
      endAt: `${DAY2}T09:30`,
    });
    ok(`POST typu „${type}” w dziale handlowym → 201`, r.status === 201, r);
  }
  const badSales = await S("POST", "/calendar/events", {
    department: "handlowy", type: "montaz", title: `${PREFIX} zły typ`, startAt: `${DAY}T12:00`, endAt: `${DAY}T13:00`,
  });
  ok("typ techniczny (montaż) w dziale handlowym → 400", badSales.status === 400, badSales);
  const badTech = await T("POST", "/calendar/events", {
    department: "technical", type: "telefon", title: `${PREFIX} zły typ`, startAt: `${DAY}T12:00`, endAt: `${DAY}T13:00`,
  });
  ok("typ handlowy (telefon) w dziale technicznym → 400", badTech.status === 400, badTech);

  const got = await S("GET", `/calendar/events/${meetingId}`);
  ok("GET wydarzenia handlowego → 200", got.status === 200 && one(got).id === meetingId, got);

  const put = await S("PUT", `/calendar/events/${meetingId}`, {
    department: "handlowy",
    type: "spotkanie",
    title: `${PREFIX} Spotkanie u klienta (po zmianie)`,
    startAt: `${DAY}T10:00`,
    endAt: `${DAY}T12:00`,
    status: "done",
    salespersonIds: [salesperson.id],
    leadId: lead.id,
  });
  ok("PUT wydarzenia handlowego → 200", put.status === 200, put);
  ok("…status i tytuł zapisane", one(put).status === "done" && String(one(put).title).includes("po zmianie"), one(put));
  ok("…kontakt wyczyszczony przez pominięcie pola", one(put).contactId === null, one(put).contactId);

  const moved = await S("PATCH", `/calendar/events/${meetingId}/move`, { startAt: `${DAY2}T14:00`, endAt: `${DAY2}T15:00` });
  ok("PATCH move → 200 i nowa data", moved.status === 200 && String(one(moved).startAt).startsWith(DAY2), moved);

  const del = await S("DELETE", `/calendar/events/${meetingId}`);
  ok("DELETE (soft) → 200", del.status === 200, del);
  ok("…wiersz ma deleted_at", eventRow(meetingId)?.deletedAt != null);
  const restored = await S("POST", `/calendar/events/${meetingId}/restore`);
  ok("POST restore → 200", restored.status === 200 && eventRow(meetingId)?.deletedAt == null, restored);

  // =========================================================================
  // 2. Przypisania handlowców — dziennik assigned/unassigned
  // =========================================================================
  const reassigned = await S("PUT", `/calendar/events/${meetingId}`, {
    department: "handlowy",
    type: "spotkanie",
    title: `${PREFIX} Spotkanie u klienta (po zmianie)`,
    startAt: `${DAY2}T14:00`,
    endAt: `${DAY2}T15:00`,
    salespersonIds: [otherSalesperson.id],
    leadId: lead.id,
  });
  ok("PUT podmieniający handlowca → 200", reassigned.status === 200, reassigned);
  ok("…w odpowiedzi tylko nowy handlowiec",
    ((one(reassigned).salespeople as { id: number }[]) ?? []).map((s) => s.id).join() === String(otherSalesperson.id),
    one(reassigned).salespeople);
  const assignLog = logOf(meetingId).filter((l) => l.field === "salesperson");
  ok("…dziennik ma wpis assigned i unassigned",
    assignLog.some((l) => l.action === "assigned" && Number(l.newValue) === otherSalesperson.id) &&
      assignLog.some((l) => l.action === "unassigned" && Number(l.oldValue) === salesperson.id),
    assignLog.map((l) => `${l.action}:${l.oldValue ?? ""}→${l.newValue ?? ""}`));
  // Wracamy do pierwotnego handlowca — reszta testów liczy na jego kalendarz.
  await S("PUT", `/calendar/events/${meetingId}`, {
    department: "handlowy", type: "spotkanie", title: `${PREFIX} Spotkanie u klienta`,
    startAt: `${DAY}T10:00`, endAt: `${DAY}T11:00`, salespersonIds: [salesperson.id], leadId: lead.id,
  });
  const nonExisting = await S("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} zły handlowiec`,
    startAt: `${DAY}T16:00`, endAt: `${DAY}T16:30`, salespersonIds: [999_999],
  });
  ok("POST z nieistniejącym handlowcem → 400", nonExisting.status === 400, nonExisting);

  // =========================================================================
  // 3. salespersonId=me — po `salespeople.user_id`, bez heurystyki nazwiskowej
  // =========================================================================
  const foreignEv = await O("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} Telefon cudzy`,
    startAt: `${DAY}T08:00`, endAt: `${DAY}T08:30`, salespersonIds: [otherSalesperson.id],
  });
  ok("POST cudzego wydarzenia handlowego → 201", foreignEv.status === 201, foreignEv);
  const foreignId = Number(one(foreignEv).id);

  const range = `?from=${DAY}&to=${day(3)}`;
  const mine = await S("GET", `/calendar/events${range}&salespersonId=me`);
  ok("salespersonId=me: własne wydarzenie jest", ids(mine).includes(meetingId), ids(mine));
  ok("salespersonId=me: cudzego nie ma", !ids(mine).includes(foreignId), ids(mine));
  const looseMine = await U("GET", `/calendar/events${range}&salespersonId=me`);
  ok("salespersonId=me bez wiersza w słowniku → pusto (200)", looseMine.status === 200 && ids(looseMine).length === 0, looseMine);
  const byId = await S("GET", `/calendar/events${range}&salespersonId=${otherSalesperson.id}`);
  ok("salespersonId=<id>: zawęża do wskazanego handlowca", ids(byId).includes(foreignId) && !ids(byId).includes(meetingId), ids(byId));
  const byLead = await S("GET", `/calendar/events${range}&leadId=${lead.id}`);
  ok("leadId: zawęża do aktywności szansy", ids(byLead).includes(meetingId) && !ids(byLead).includes(foreignId), ids(byLead));

  // =========================================================================
  // 4. Kolizje po handlowcach
  // =========================================================================
  const conflicts = await S("GET", `/calendar/conflicts?salespersonIds=${salesperson.id}&startAt=${DAY}T10:30&endAt=${DAY}T11:30`);
  ok("kolizje: wykrywają wydarzenie handlowca", ids(conflicts).includes(meetingId), conflicts);
  ok("kolizje: cudze wydarzenie nie wchodzi", !ids(conflicts).includes(foreignId), ids(conflicts));
  const excluded = await S(
    "GET",
    `/calendar/conflicts?salespersonIds=${salesperson.id}&startAt=${DAY}T10:30&endAt=${DAY}T11:30&excludeId=${meetingId}`
  );
  ok("kolizje: excludeId pomija edytowane wydarzenie", !ids(excluded).includes(meetingId), excluded);
  const noOverlap = await S("GET", `/calendar/conflicts?salespersonIds=${salesperson.id}&startAt=${DAY}T18:00&endAt=${DAY}T19:00`);
  ok("kolizje: rozłączne godziny → pusto", ids(noOverlap).length === 0, noOverlap);

  // =========================================================================
  // 5. Urlop handlowy i dostępność ?department=handlowy
  // =========================================================================
  const urlopNoOne = await S("POST", "/calendar/events", {
    department: "handlowy", type: "urlop", startAt: day(5), endAt: day(7),
  });
  ok("urlop handlowy bez handlowca → 400", urlopNoOne.status === 400, urlopNoOne);
  const urlop = await S("POST", "/calendar/events", {
    department: "handlowy", type: "urlop", startAt: day(5), endAt: day(7), salespersonIds: [salesperson.id],
  });
  ok("urlop handlowy z handlowcem → 201", urlop.status === 201, urlop);
  ok("…tytuł wygenerowany z nazwiska handlowca", String(one(urlop).title).startsWith("Urlop — Anna"), one(urlop).title);
  const avail = await S("GET", `/calendar/availability?from=${day(4)}&to=${day(8)}&department=handlowy`);
  const availRows = (avail.data as { salespersonId: number; leaves: { eventId: number }[] }[]) ?? [];
  const mineLeave = availRows.find((r) => r.salespersonId === salesperson.id);
  ok("availability?department=handlowy: wiersz handlowca z urlopem",
    avail.status === 200 && mineLeave != null && mineLeave.leaves.some((l) => l.eventId === Number(one(urlop).id)),
    availRows);
  ok("availability handlowa: wiersze mają salespersonId, nie technicianId",
    availRows.every((r) => typeof r.salespersonId === "number" && !("technicianId" in r)),
    availRows[0]);

  // =========================================================================
  // 6. Kafelek notatki dziedziczy dział i szansę
  // =========================================================================
  const note = await S("POST", `/calendar/events/${meetingId}/notes`, {
    text: `${PREFIX} ustalenia — oddzwonić @jutro`,
  });
  ok("POST notatki na wydarzeniu handlowym → 201", note.status === 201, note);
  const noteId = Number(one(note).id);
  const tile = db
    .select()
    .from(schema.calendarEvents)
    .where(and(eq(schema.calendarEvents.noteId, noteId), eq(schema.calendarEvents.type, "notatka")))
    .get();
  ok("wzmianka @jutro utworzyła kafelek notatki", tile != null, tile);
  ok("kafelek dziedziczy dział handlowy", tile?.department === "handlowy", tile?.department);
  ok("kafelek dziedziczy szansę ze źródła", tile?.leadId === lead.id, tile?.leadId);

  // =========================================================================
  // 7. Walidacja leadId / contactId
  // =========================================================================
  const badLead = await S("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} zła szansa`,
    startAt: `${DAY}T17:00`, endAt: `${DAY}T17:30`, leadId: 999_999,
  });
  ok("leadId nieistniejący → 400", badLead.status === 400, badLead);
  const badContact = await S("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} obcy kontakt`,
    startAt: `${DAY}T17:00`, endAt: `${DAY}T17:30`, leadId: lead.id, contactId: foreignContact.id,
  });
  ok("kontakt spoza szansy i jej kontrahenta → 400", badContact.status === 400, badContact);
  const okContact = await S("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} kontakt z kartoteki`,
    startAt: `${DAY}T17:00`, endAt: `${DAY}T17:30`, leadId: lead.id, contactId: contractorContact.id,
  });
  ok("kontakt kontrahenta szansy → 201", okContact.status === 201, okContact);
  const techWithLead = await T("POST", "/calendar/events", {
    department: "technical", type: "serwis", title: `${PREFIX} techniczne z szansą`,
    startAt: `${DAY}T18:00`, endAt: `${DAY}T19:00`, leadId: lead.id, contactId: leadContact.id,
  });
  ok("wydarzenie techniczne ignoruje leadId/contactId → 201 i NULL-e",
    techWithLead.status === 201 && one(techWithLead).leadId === null && one(techWithLead).contactId === null,
    one(techWithLead));
  const techEventId = Number(one(techWithLead).id);

  // =========================================================================
  // 8. touchLead — tworzenie, notatka, przesuwanie, usuwanie
  // =========================================================================
  const stampBefore = leadRow(lead.id)?.lastActivityAt ?? "";
  ok("touchLead: znacznik szansy ustawiony po mutacjach kalendarza", stampBefore !== "", stampBefore);
  const phone = await S("POST", "/calendar/events", {
    department: "handlowy", type: "telefon", title: `${PREFIX} Telefon kontrolny`,
    startAt: `${day(2)}T09:00`, endAt: `${day(2)}T09:30`, salespersonIds: [salesperson.id], leadId: lead.id,
  });
  const phoneId = Number(one(phone).id);
  const afterCreate = leadRow(lead.id)?.lastActivityAt ?? "";
  ok("touchLead po utworzeniu aktywności", afterCreate >= stampBefore && afterCreate !== "", { stampBefore, afterCreate });
  await S("PATCH", `/calendar/events/${phoneId}/move`, { startAt: `${day(2)}T11:00`, endAt: `${day(2)}T11:30` });
  const afterMove = leadRow(lead.id)?.lastActivityAt ?? "";
  ok("touchLead po przesunięciu", afterMove >= afterCreate, { afterCreate, afterMove });
  await S("POST", `/calendar/events/${phoneId}/notes`, { text: `${PREFIX} klient prosi o ofertę` });
  const afterNote = leadRow(lead.id)?.lastActivityAt ?? "";
  ok("touchLead po notatce", afterNote >= afterMove, { afterMove, afterNote });
  await S("DELETE", `/calendar/events/${phoneId}`);
  const afterDelete = leadRow(lead.id)?.lastActivityAt ?? "";
  ok("touchLead po usunięciu aktywności", afterDelete >= afterNote, { afterNote, afterDelete });

  // Denormalizacja musi zgadzać się z odtworzeniem ze źródeł (z dokładnością do sekundy).
  const recomputed = recomputeLastActivity(db, [lead.id]).get(lead.id) ?? "";
  ok("recomputeLastActivity zgadza się z last_activity_at",
    Math.abs(Date.parse(`${afterDelete.replace(" ", "T")}Z`) - Date.parse(`${recomputed.replace(" ", "T")}Z`)) <= 2000,
    { afterDelete, recomputed });

  // =========================================================================
  // 9. Feed ICS handlowca
  // =========================================================================
  const salesFeed = await feed(salesUser.calendarToken!);
  ok("ICS handlowca: 200", salesFeed.status === 200, salesFeed.status);
  ok("ICS handlowca: zawiera własne spotkanie", salesFeed.text.includes("Spotkanie u klienta"), salesFeed.text.slice(0, 300));
  ok("ICS handlowca: NIE zawiera technicznych", !salesFeed.text.includes("techniczne z szansą"));
  ok("ICS handlowca: NIE zawiera cudzego wydarzenia handlowego", !salesFeed.text.includes("Telefon cudzy"));
  ok("ICS handlowca: opis niesie szansę", salesFeed.text.includes("Szansa:"), salesFeed.text.slice(0, 600));
  const looseFeed = await feed(looseUser.calendarToken!);
  ok("ICS konta bez wiersza handlowca: tylko własne wpisy (bez cudzych)",
    !looseFeed.text.includes("Spotkanie u klienta") && !looseFeed.text.includes("Telefon cudzy"),
    looseFeed.text.slice(0, 300));

  // Nazwa subskrypcji w kliencie (X-WR-CALNAME) idzie za DZIAŁAMI feedu — konto
  // handlowe nie może podpisywać się „kalendarz techniczny”.
  const calName = (text: string) => /X-WR-CALNAME:(.*)/.exec(text)?.[1]?.trim() ?? "";
  ok("ICS handlowca: nazwa „Alfa — kalendarz handlowy”",
    calName(salesFeed.text) === "Alfa — kalendarz handlowy", calName(salesFeed.text));
  const techFeed = await feed(techUser.calendarToken!);
  ok("ICS technika: nazwa „Alfa — kalendarz techniczny”",
    calName(techFeed.text) === "Alfa — kalendarz techniczny", calName(techFeed.text));
  const bothFeed = await feed(bothUser.calendarToken!);
  ok("ICS konta z obydwoma działami: nazwa „Alfa — kalendarz”",
    calName(bothFeed.text) === "Alfa — kalendarz", calName(bothFeed.text));

  // =========================================================================
  // 10. Serie handlowe i edycja scope=future
  // =========================================================================
  const series = await S("POST", "/calendar/events", {
    department: "handlowy",
    type: "zadanie",
    title: `${PREFIX} Cykliczne zadanie`,
    startAt: `${day(10)}T08:00`,
    endAt: `${day(10)}T08:30`,
    salespersonIds: [salesperson.id],
    leadId: lead.id,
    recurrence: { freq: "weekly", count: 4 },
  });
  ok("POST serii handlowej → 201", series.status === 201, series);
  ok("…cztery wystąpienia", one(series).occurrencesCount === 4, one(series));
  const seriesId = one(series).seriesId as number;
  const seriesEvents = db
    .select({ id: schema.calendarEvents.id, startAt: schema.calendarEvents.startAt })
    .from(schema.calendarEvents)
    .where(eq(schema.calendarEvents.seriesId, seriesId))
    .orderBy(schema.calendarEvents.startAt)
    .all();
  ok("…wszystkie wystąpienia są handlowe i mają szansę",
    seriesEvents.length === 4 &&
      seriesEvents.every((e) => eventRow(e.id)?.department === "handlowy" && eventRow(e.id)?.leadId === lead.id),
    seriesEvents.length);
  const second = seriesEvents[1];
  const futureEdit = await S("PUT", `/calendar/events/${second.id}?scope=future`, {
    department: "handlowy",
    type: "zadanie",
    title: `${PREFIX} Cykliczne zadanie (nowa nazwa)`,
    startAt: second.startAt,
    endAt: `${second.startAt.slice(0, 11)}09:00`,
    salespersonIds: [salesperson.id],
    leadId: lead.id,
  });
  ok("PUT ?scope=future na serii handlowej → 200", futureEdit.status === 200, futureEdit);
  ok("…objęło to i kolejne wystąpienia (3 z 4)", one(futureEdit).affectedCount === 3, one(futureEdit).affectedCount);
  ok("…pierwsze wystąpienie zostało nietknięte",
    !String(eventRow(seriesEvents[0].id)?.title).includes("nowa nazwa"),
    eventRow(seriesEvents[0].id)?.title);
  ok("…ostatnie wystąpienie ma nowy tytuł",
    String(eventRow(seriesEvents[3].id)?.title).includes("nowa nazwa"),
    eventRow(seriesEvents[3].id)?.title);

  // =========================================================================
  // 11. GET /analytics/lejek — dym po kohorcie własnego opiekuna
  // =========================================================================
  const mkLead = async (title: string, monthly: number) =>
    S("POST", "/leads", {
      title: `${PREFIX} ${title}`,
      stage: "nowy",
      salespersonId: funnelSalesperson.id,
      estimatedMonthly: monthly,
      estimatedSetup: monthly * 10,
    });
  const wonLead = Number(one(await mkLead("Lejek wygrany", 1200)).id);
  const lostLead = Number(one(await mkLead("Lejek przegrany", 800)).id);
  const openLead = Number(one(await mkLead("Lejek otwarty", 500)).id);
  ok("szanse lejka utworzone", wonLead > 0 && lostLead > 0 && openLead > 0, { wonLead, lostLead, openLead });

  for (const stage of ["kontakt", "wizja", "oferta", "wygrany"]) {
    const r = await S("PATCH", `/leads/${wonLead}/stage`, { stage });
    ok(`PATCH etapu → ${stage}`, r.status === 200, r);
  }
  await S("PATCH", `/leads/${lostLead}/stage`, { stage: "kontakt" });
  const lostNoReason = await S("PATCH", `/leads/${lostLead}/stage`, { stage: "przegrany" });
  ok("przegrany bez powodu → 400", lostNoReason.status === 400, lostNoReason);
  const lostOk = await S("PATCH", `/leads/${lostLead}/stage`, { stage: "przegrany", lostReason: "cena" });
  ok("przegrany z powodem → 200", lostOk.status === 200, lostOk);

  const funnelRes = await S("GET", `/analytics/lejek?salespersonId=${funnelSalesperson.id}`);
  ok("GET /analytics/lejek → 200", funnelRes.status === 200, funnelRes);
  const f = funnelRes.data as {
    leads: number;
    funnel: { stage: string; reached: number; current: number; conversion: number | null; avgDays: number | null; avgDaysSamples: number; monthly: number }[];
    won: { count: number; monthly: number; setup: number; medianDaysToWin: number | null };
    lost: { count: number; byReason: { reason: string | null; count: number }[] };
    winRate: number | null;
    bySalesperson: { salespersonId: number | null; name: string; leads: number; won: number; lost: number; open: number; winRate: number | null }[];
    rotting: number;
    openNow: number;
    coverage: { leadsWithHistory: number; leads: number };
  };
  const stageOf = (s: string) => f.funnel.find((r) => r.stage === s);
  ok("lejek: kohorta to trzy szanse opiekuna", f.leads === 3, f.leads);
  ok("lejek: etapy w kolejności nowy…wygrany",
    f.funnel.map((r) => r.stage).join(",") === "nowy,kontakt,wizja,oferta,negocjacje,wygrany",
    f.funnel.map((r) => r.stage));
  ok("lejek: „nowy” osiągnęły wszystkie trzy", stageOf("nowy")?.reached === 3, stageOf("nowy"));
  ok("lejek: „kontakt” osiągnęły dwie", stageOf("kontakt")?.reached === 2, stageOf("kontakt"));
  ok("lejek: „wizja” i „oferta” po jednej", stageOf("wizja")?.reached === 1 && stageOf("oferta")?.reached === 1, [stageOf("wizja"), stageOf("oferta")]);
  ok("lejek: „negocjacje” pominięte (zero dotarć)", stageOf("negocjacje")?.reached === 0, stageOf("negocjacje"));
  ok("lejek: „wygrany” osiągnęła jedna", stageOf("wygrany")?.reached === 1, stageOf("wygrany"));
  ok("lejek: konwersja nowy→kontakt = 2/3", Math.abs((stageOf("nowy")?.conversion ?? 0) - 66.6667) < 0.01, stageOf("nowy")?.conversion);
  ok("lejek: konwersja oferta→negocjacje = 0%", stageOf("oferta")?.conversion === 0, stageOf("oferta")?.conversion);
  ok("lejek: ostatni etap bez konwersji", stageOf("wygrany")?.conversion === null, stageOf("wygrany")?.conversion);
  ok("lejek: „nowy” ma dwie próbki czasu w etapie", stageOf("nowy")?.avgDaysSamples === 2, stageOf("nowy"));
  ok("lejek: stan bieżący — jedna szansa nadal „nowy”", stageOf("nowy")?.current === 1, stageOf("nowy")?.current);
  ok("lejek: wartość szans, które dotarły do „kontaktu”", stageOf("kontakt")?.monthly === 2000, stageOf("kontakt")?.monthly);
  ok("lejek: wygrane 1 szt. i 1200 zł MRR", f.won.count === 1 && f.won.monthly === 1200 && f.won.setup === 12000, f.won);
  ok("lejek: mediana dni do wygranej policzona", f.won.medianDaysToWin !== null && f.won.medianDaysToWin! >= 0, f.won.medianDaysToWin);
  ok("lejek: przegrane 1 szt. z powodem „cena”",
    f.lost.count === 1 && f.lost.byReason.length === 1 && f.lost.byReason[0].reason === "cena" && f.lost.byReason[0].count === 1,
    f.lost);
  ok("lejek: win rate = 50%", f.winRate === 50, f.winRate);
  ok("lejek: wiersz opiekuna z win rate",
    f.bySalesperson.length === 1 &&
      f.bySalesperson[0].salespersonId === funnelSalesperson.id &&
      f.bySalesperson[0].won === 1 && f.bySalesperson[0].lost === 1 && f.bySalesperson[0].open === 1 &&
      f.bySalesperson[0].winRate === 50,
    f.bySalesperson);
  ok("lejek: pokrycie historią (dwie szanse zmieniały etap)", f.coverage.leadsWithHistory === 2 && f.coverage.leads === 3, f.coverage);
  ok("lejek: otwarta szansa bez aktywności gnije", f.openNow === 1 && f.rotting === 1, { openNow: f.openNow, rotting: f.rotting });

  // Zakres dat wycina kohortę — szanse z dzisiaj nie należą do zeszłego roku.
  const oldRange = await S("GET", `/analytics/lejek?salespersonId=${funnelSalesperson.id}&from=2020-01-01&to=2020-12-31`);
  const oldData = oldRange.data as { leads: number; funnel: { reached: number }[]; won: { count: number } };
  ok("lejek: zakres from/to zawęża kohortę do zera", oldRange.status === 200 && oldData.leads === 0 && oldData.won.count === 0, oldData);
  ok("lejek: pusta kohorta i tak zwraca wszystkie etapy", oldData.funnel.length === 6, oldData.funnel.length);

  void techEventId;
  void foreignId;
} catch (err) {
  console.error("BŁĄD:", err);
  failures++;
} finally {
  const n = cleanup();
  console.log(`(posprzątano ${n} wydarzeń testowych)`);
}

console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} test(ów) nie przeszło`);
process.exit(failures === 0 ? 0 : 1);
