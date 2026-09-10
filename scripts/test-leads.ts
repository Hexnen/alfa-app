/**
 * Lejek handlowy — routery `/leads` i `/contacts` przez `app.request`, z podstawionym
 * userem w kontekście i PRAWDZIWYM `tabPermissionGuard`:
 *   npx tsx scripts/test-on-copy.ts scripts/test-leads.ts
 *   npx tsx scripts/test-leads.ts            # na data/alfa.db (sprząta po sobie)
 *
 * Co jest tu pilnowane (§3.1/§3.2 planu):
 *   • CRUD szansy, filtry (q, etap, handlowiec `me`/`none`, usługa, zamknięte), paginacja,
 *   • `nextActivity` i „gnicie” — jedno źródło prawdy: dopisanie aktywności w kalendarzu
 *     gasi bursztynową krawędź, usunięcie jej zapala z powrotem (`rotReason: no_activity`),
 *   • `PATCH /stage` — wpis `stage_changed` w dzienniku, „przegrany” WYMAGA powodu,
 *     cofnięcie do otwartego etapu czyści `wonAt`/`lostAt`,
 *   • konwersja: kontrahent po NIP-ie, obiekt `department='sales'`/`status='pending'`,
 *     przepięcie osób kontaktowych do kartoteki klienta,
 *   • soft delete + restore (szansa z kosza znika z listy, wraca po przywróceniu),
 *   • kontakty: jeden „główny” na kontrahenta, 409 przy usuwaniu używanego kontaktu,
 *   • 403 dla konta bez `handlowy/leady` (strażnik prefiksu, nie sam router),
 *   • `recomputeLastActivity` — czy `touchLead` naprawdę odbija znacznik.
 *
 * Sprząta po sobie HARD (wydarzenia, szanse, kontakty, obiekty, kontrahenci, handlowcy,
 * konta, dziennik), także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like, or } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import leadsRoutes from "../src/routes/leads.js";
import contactsRoutes from "../src/routes/contacts.js";
import calendarRoutes from "../src/routes/calendar.js";
import { tabPermissionGuard } from "../src/middleware/auth.js";
import { recomputeLastActivity } from "../src/lib/sales-leads.js";
import { validateNIP } from "../src/utils/nip.js";
import type { PermissionMap } from "../src/lib/auth/permissions.js";
import type { User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "__LEADS_TEST__";

/** Dzień „za trzy dni” — aktywność w przyszłości gasi gnicie. */
function plusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sprzątanie (na starcie i w finally)
// ---------------------------------------------------------------------------

function cleanup(): void {
  const leadIds = db
    .select({ id: schema.leads.id })
    .from(schema.leads)
    .where(like(schema.leads.title, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(
      leadIds.length
        ? or(like(schema.calendarEvents.title, `%${PREFIX}%`), inArray(schema.calendarEvents.leadId, leadIds))
        : like(schema.calendarEvents.title, `%${PREFIX}%`)
    )
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
  if (leadIds.length) {
    db.delete(schema.contacts).where(inArray(schema.contacts.leadId, leadIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "lead"), inArray(schema.activityLog.entityId, leadIds)))
      .run();
    db.delete(schema.leads).where(inArray(schema.leads.id, leadIds)).run();
  }
  // Obiekty i kontakty kontrahenta znikają kaskadą razem z kontrahentem.
  const contractorIds = db
    .select({ id: schema.contractors.id })
    .from(schema.contractors)
    .where(like(schema.contractors.name, `%${PREFIX}%`))
    .all()
    .map((r) => r.id);
  if (contractorIds.length) {
    const objIds = db
      .select({ id: schema.objects.id })
      .from(schema.objects)
      .where(inArray(schema.objects.contractorId, contractorIds))
      .all()
      .map((r) => r.id);
    if (objIds.length) {
      db.delete(schema.objectHistory).where(inArray(schema.objectHistory.objectId, objIds)).run();
      db.delete(schema.objects).where(inArray(schema.objects.id, objIds)).run();
    }
    db.delete(schema.contacts).where(inArray(schema.contacts.contractorId, contractorIds)).run();
    db.delete(schema.contractors).where(inArray(schema.contractors.id, contractorIds)).run();
  }
  db.delete(schema.salespeople).where(like(schema.salespeople.lastName, `${PREFIX}%`)).run();
  for (const u of db.select().from(schema.users).where(like(schema.users.email, `${PREFIX}%`)).all()) {
    db.delete(schema.sessions).where(eq(schema.sessions.userId, u.id)).run();
  }
  db.delete(schema.users).where(like(schema.users.email, `${PREFIX}%`)).run();
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
  app.route("/api/leads", leadsRoutes);
  app.route("/api/contacts", contactsRoutes);
  app.route("/api/calendar", calendarRoutes);
  return async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await app.request(`/api${path}`, {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    });
    const json = (await res.json().catch(() => null)) as Omit<Res, "status"> | null;
    return { status: res.status, ...(json ?? {}) };
  };
}

/** NIP z poprawną sumą kontrolną, którego NIE ma jeszcze w kartotece. */
function freshNip(): string {
  for (let base = 1_000_000_00; base < 1_000_100_00; base++) {
    for (let check = 0; check <= 9; check++) {
      const nip = `${base}${check}`;
      if (nip.length !== 10 || !validateNIP(nip)) continue;
      const exists = db.select({ id: schema.contractors.id }).from(schema.contractors).where(eq(schema.contractors.nip, nip)).get();
      if (!exists) return nip;
    }
  }
  throw new Error("Nie udało się wygenerować wolnego NIP-u");
}

const salesUser = makeUser("sales", { "handlowy/leady": "edit", "handlowy/kontakty": "edit", "handlowy/kalendarz": "edit" });
const viewerUser = makeUser("viewer", { "handlowy/leady": "view" });
const outsiderUser = makeUser("outsider", { "technical/kalendarz": "edit" });

const S = clientFor(salesUser);
const V = clientFor(viewerUser);
const X = clientFor(outsiderUser);

const salesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Anna", lastName: `${PREFIX}Kowalska`, userId: salesUser.id })
  .returning()
  .get();
const otherSalesperson = db
  .insert(schema.salespeople)
  .values({ firstName: "Piotr", lastName: `${PREFIX}Nowak` })
  .returning()
  .get();

const leadOf = (r: Res) => r.data as { id: number; [k: string]: unknown };
const listItems = (r: Res) => ((r.data as { items?: { id: number }[] } | undefined)?.items ?? []);

try {
  // =========================================================================
  // 1. CRUD
  // =========================================================================
  const created = await S("POST", "/leads", {
    title: `${PREFIX} Biurowiec Centrum`,
    stage: "nowy",
    source: "polecenie",
    prospectName: `${PREFIX} Prospekt sp. z o.o.`,
    city: "Katowice",
    address: "ul. Testowa 1",
    services: ["kamery", "sswin"],
    estimatedMonthly: 1200,
    estimatedSetup: 18000,
    probability: 40,
    salespersonId: salesperson.id,
    expectedCloseDate: plusDays(30),
  });
  ok("POST /leads → 201", created.status === 201, created);
  const leadId = leadOf(created).id;
  ok("nowa szansa: clientLabel z prospektu", leadOf(created).clientLabel === `${PREFIX} Prospekt sp. z o.o.`, created.data);
  ok("nowa szansa: services wracają tablicą", JSON.stringify(leadOf(created).services) === '["kamery","sswin"]', created.data);
  ok("nowa szansa: handlowiec rozwiązany po nazwie", leadOf(created).salespersonName === `Anna ${PREFIX}Kowalska`, created.data);

  const other = await S("POST", "/leads", {
    title: `${PREFIX} Magazyn Wschód`,
    stage: "oferta",
    services: ["ofi"],
    estimatedMonthly: 800,
    salespersonId: otherSalesperson.id,
  });
  ok("POST drugiej szansy → 201", other.status === 201, other);
  const otherId = leadOf(other).id;

  const nameless = await S("POST", "/leads", { stage: "nowy" });
  ok("POST bez tytułu → 400", nameless.status === 400, nameless);
  const badRef = await S("POST", "/leads", { title: `${PREFIX} Zły ref`, salespersonId: 999_999 });
  ok("POST z nieistniejącym handlowcem → 400", badRef.status === 400, badRef);

  const updated = await S("PUT", `/leads/${leadId}`, { probability: 60, city: "Gliwice" });
  ok("PUT /leads/:id → 200", updated.status === 200, updated);
  ok("PUT zapisał zmiany", leadOf(updated).probability === 60 && leadOf(updated).city === "Gliwice", updated.data);
  const diffs = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "lead"), eq(schema.activityLog.entityId, leadId)))
    .all();
  ok(
    "PUT: dziennik ma wpis o prawdopodobieństwie i mieście",
    diffs.some((d) => d.field === "probability") && diffs.some((d) => d.field === "city"),
    diffs.map((d) => d.field)
  );

  const card = await S("GET", `/leads/${leadId}`);
  ok("GET /leads/:id → 200", card.status === 200, card);
  const detail = card.data as {
    contacts: unknown[];
    offers: unknown[];
    orders: unknown[];
    activities: { overdue: unknown[]; upcoming: unknown[]; done: unknown[] };
    history: unknown[];
  };
  ok(
    "karta: komplet sekcji (kontakty, oferty, zlecenia, aktywności, oś czasu)",
    Array.isArray(detail.contacts) &&
      Array.isArray(detail.offers) &&
      Array.isArray(detail.orders) &&
      Array.isArray(detail.activities.upcoming) &&
      detail.history.length > 0,
    Object.keys(detail)
  );
  ok("GET nieistniejącej szansy → 404", (await S("GET", "/leads/99999999")).status === 404);

  // =========================================================================
  // 2. Filtry i paginacja
  // =========================================================================
  const all = await S("GET", "/leads?q=" + encodeURIComponent(PREFIX));
  ok("lista: szukajka po tytule znajduje obie szanse", listItems(all).length === 2, listItems(all).map((i) => i.id));
  const summary = (all.data as { summary: { count: number; monthly: number; weightedMonthly: number } }).summary;
  ok("lista: summary sumuje MRR całego zbioru", summary.count === 2 && summary.monthly === 2000, summary);
  ok("lista: weightedMonthly liczy P%", Math.round(summary.weightedMonthly) === 720, summary);

  const byStage = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&stage=oferta`);
  ok("filtr etapu", listItems(byStage).map((i) => i.id).join() === String(otherId), byStage);
  const byService = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&service=sswin`);
  ok("filtr usługi", listItems(byService).map((i) => i.id).join() === String(leadId), byService);
  const mine = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&salespersonId=me`);
  ok("salespersonId=me po salespeople.user_id", listItems(mine).map((i) => i.id).join() === String(leadId), mine);
  const notMine = await V("GET", `/leads?q=${encodeURIComponent(PREFIX)}&salespersonId=me`);
  ok("salespersonId=me bez konta handlowca → pusto (nie błąd)", notMine.status === 200 && listItems(notMine).length === 0, notMine);
  const noneOwner = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&salespersonId=none`);
  ok("salespersonId=none → szanse bez opiekuna", listItems(noneOwner).length === 0, noneOwner);

  const paged = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&pageSize=1&page=2&sort=title&dir=asc`);
  const pagedBody = paged.data as { total: number; page: number; pageSize: number };
  ok(
    "paginacja: total z całego zbioru, strona 2 ma jedną pozycję",
    pagedBody.total === 2 && pagedBody.page === 2 && listItems(paged).length === 1,
    pagedBody
  );

  // =========================================================================
  // 3. Następna aktywność i „gnicie”
  // =========================================================================
  const fresh = listItems(all).find((i) => i.id === leadId) as unknown as {
    rotting: boolean;
    rotReason: string | null;
    nextActivity: unknown;
  };
  ok("szansa bez aktywności gnije (no_activity)", fresh.rotting === true && fresh.rotReason === "no_activity", fresh);

  const day = plusDays(3);
  const evRes = await S("POST", "/calendar/events", {
    type: "telefon",
    title: `${PREFIX} Telefon do klienta`,
    startAt: `${day}T10:00`,
    endAt: `${day}T10:30`,
    allDay: false,
    status: "planned",
    department: "handlowy",
    technicianIds: [],
    salespersonIds: [salesperson.id],
    leadId,
  });
  ok("POST /calendar/events (handlowy, z szansą) → 201", evRes.status === 201, evRes);
  const eventId = (evRes.data as { id: number }).id;

  const afterEvent = await S("GET", `/leads/${leadId}`);
  const withNext = afterEvent.data as { rotting: boolean; rotReason: string | null; nextActivity: { id: number; type: string } | null };
  ok("po zaplanowaniu aktywności szansa przestaje gnić", withNext.rotting === false && withNext.rotReason === null, withNext);
  ok("nextActivity wskazuje właśnie to wydarzenie", withNext.nextActivity?.id === eventId && withNext.nextActivity?.type === "telefon", withNext.nextActivity);
  const rottingOnly = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&rotting=1`);
  ok(
    "filtr ?rotting=1 nie pokazuje szansy z zaplanowanym krokiem",
    !listItems(rottingOnly).some((i) => i.id === leadId),
    listItems(rottingOnly).map((i) => i.id)
  );

  // `touchLead` z mutacji kalendarza — znacznik musi się zgadzać z danymi źródłowymi.
  const stored = db.select({ ts: schema.leads.lastActivityAt }).from(schema.leads).where(eq(schema.leads.id, leadId)).get();
  const recomputed = recomputeLastActivity(db, [leadId]).get(leadId);
  const drift =
    stored?.ts && recomputed
      ? Math.abs(Date.parse(`${stored.ts.replace(" ", "T")}Z`) - Date.parse(`${recomputed.replace(" ", "T")}Z`))
      : Number.NaN;
  ok("last_activity_at zgodne z recomputeLastActivity (±2 s)", drift <= 2000, { stored: stored?.ts, recomputed });

  const del = await S("DELETE", `/calendar/events/${eventId}`);
  ok("DELETE wydarzenia → 200", del.status === 200, del);
  const afterDelete = await S("GET", `/leads/${leadId}`);
  const rotAgain = afterDelete.data as { rotting: boolean; rotReason: string | null; nextActivity: unknown };
  ok(
    "po usunięciu jedynej aktywności szansa znów gnije",
    rotAgain.rotting === true && rotAgain.rotReason === "no_activity" && rotAgain.nextActivity === null,
    rotAgain
  );

  // =========================================================================
  // 4. Zmiana etapu
  // =========================================================================
  const toWizja = await S("PATCH", `/leads/${leadId}/stage`, { stage: "wizja" });
  ok("PATCH /stage → 200", toWizja.status === 200 && leadOf(toWizja).stage === "wizja", toWizja);
  const stageLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "lead"), eq(schema.activityLog.entityId, leadId), eq(schema.activityLog.action, "stage_changed")))
    .all();
  ok("PATCH /stage: wpis stage_changed w dzienniku", stageLog.length === 1 && stageLog[0].summary?.includes("Nowy → Wizja") === true, stageLog);

  const lostNoReason = await S("PATCH", `/leads/${otherId}/stage`, { stage: "przegrany" });
  ok("„przegrany” bez powodu → 400", lostNoReason.status === 400, lostNoReason);
  const lost = await S("PATCH", `/leads/${otherId}/stage`, { stage: "przegrany", lostReason: "cena", lostNote: "za drogo" });
  ok("„przegrany” z powodem → 200 + lostAt", lost.status === 200 && !!leadOf(lost).lostAt, lost);
  const lostLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "lead"), eq(schema.activityLog.entityId, otherId), eq(schema.activityLog.action, "lost")))
    .all();
  ok("„przegrany”: wpis lost w dzienniku", lostLog.length === 1, lostLog);
  const openList = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}`);
  ok(
    "domyślna lista nie pokazuje zamkniętych",
    !listItems(openList).some((i) => i.id === otherId),
    listItems(openList).map((i) => i.id)
  );
  const closedList = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&includeClosed=1`);
  ok("includeClosed=1 pokazuje przegraną", listItems(closedList).some((i) => i.id === otherId), listItems(closedList).map((i) => i.id));

  const reopened = await S("PATCH", `/leads/${otherId}/stage`, { stage: "negocjacje" });
  ok(
    "powrót do otwartego etapu czyści lostAt/lostReason",
    reopened.status === 200 && leadOf(reopened).lostAt === null && leadOf(reopened).lostReason === null,
    reopened.data
  );

  // =========================================================================
  // 5. Kanban i statystyki
  // =========================================================================
  const board = await S("GET", `/leads/board?q=${encodeURIComponent(PREFIX)}`);
  const columns = (board.data as { columns: { stage: string; count: number; items: { id: number }[] }[] }).columns;
  ok("GET /leads/board zwraca kolumnę na etap", board.status === 200 && columns.length === 7, columns?.map((c) => c.stage));
  ok(
    "kanban: szansa siedzi w kolumnie swojego etapu",
    columns.find((c) => c.stage === "wizja")?.items.some((i) => i.id === leadId) === true,
    columns.find((c) => c.stage === "wizja")
  );
  const pipeline = await S("GET", "/leads/stats/pipeline?salespersonId=me");
  const stats = pipeline.data as { byStage: unknown[]; rotting: number; noNextActivity: number };
  ok("GET /leads/stats/pipeline → 200", pipeline.status === 200 && stats.byStage.length === 7, pipeline);
  ok("pipeline: liczy szanse bez następnej aktywności", stats.noNextActivity >= 1, stats);

  // =========================================================================
  // 6. Kontakty
  // =========================================================================
  const nipA = freshNip();
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Klient S.A.`, nip: nipA, salespersonId: salesperson.id })
    .returning()
    .get();

  const c1 = await S("POST", "/contacts", {
    contractorId: contractor.id,
    firstName: "Jan",
    lastName: `${PREFIX}Nowicki`,
    role: "kierownik obiektu",
    phone: "600100200",
    isPrimary: true,
  });
  ok("POST /contacts → 201", c1.status === 201, c1);
  const contact1 = (c1.data as { id: number; isPrimary: boolean; fullName: string }).id;
  ok("kontakt: fullName składany na backendzie", (c1.data as { fullName: string }).fullName === `Jan ${PREFIX}Nowicki`, c1.data);

  const noRef = await S("POST", "/contacts", { lastName: `${PREFIX}Sierota` });
  ok("kontakt bez powiązania → 400", noRef.status === 400, noRef);
  const noName = await S("POST", "/contacts", { contractorId: contractor.id, firstName: "Bez" });
  ok("kontakt bez nazwiska → 400", noName.status === 400, noName);

  const c2 = await S("POST", "/contacts", {
    contractorId: contractor.id,
    firstName: "Ewa",
    lastName: `${PREFIX}Zielona`,
    isPrimary: true,
  });
  ok("POST drugiego kontaktu „głównego” → 201", c2.status === 201, c2);
  const contact2 = (c2.data as { id: number }).id;
  const primaries = db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.contractorId, contractor.id), eq(schema.contacts.isPrimary, true)))
    .all();
  ok("główny kontakt jest dokładnie jeden i to ten nowy", primaries.length === 1 && primaries[0].id === contact2, primaries);

  const backToFirst = await S("PUT", `/contacts/${contact1}`, { isPrimary: true });
  ok("PUT isPrimary przenosi flagę", backToFirst.status === 200, backToFirst);
  const primariesAfter = db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.contractorId, contractor.id), eq(schema.contacts.isPrimary, true)))
    .all();
  ok("po przeniesieniu wciąż jeden główny", primariesAfter.length === 1 && primariesAfter[0].id === contact1, primariesAfter);

  const listContacts = await S("GET", `/contacts?contractorId=${contractor.id}`);
  ok("GET /contacts?contractorId → 2 pozycje", (listContacts.data as unknown[]).length === 2, listContacts);

  // Kontakt użyty w kalendarzu nie daje się usunąć (409 → „ustaw nieaktywny”).
  // Wydarzenie przyjmuje osobę kontaktową tylko wtedy, gdy należy ona do szansy
  // albo do JEJ kontrahenta — więc najpierw wiążemy szansę z kartoteką.
  ok("PUT: podpięcie kontrahenta do szansy", (await S("PUT", `/leads/${leadId}`, { contractorId: contractor.id })).status === 200);
  const meetingDay = plusDays(5);
  const meeting = await S("POST", "/calendar/events", {
    type: "spotkanie",
    title: `${PREFIX} Spotkanie u klienta`,
    startAt: `${meetingDay}T12:00`,
    endAt: `${meetingDay}T13:00`,
    allDay: false,
    department: "handlowy",
    technicianIds: [],
    salespersonIds: [salesperson.id],
    leadId,
    contactId: contact1,
  });
  ok("wydarzenie z osobą kontaktową → 201", meeting.status === 201, meeting);
  const del409 = await S("DELETE", `/contacts/${contact1}`);
  ok("DELETE używanego kontaktu → 409", del409.status === 409, del409);
  const del200 = await S("DELETE", `/contacts/${contact2}`);
  ok("DELETE nieużywanego kontaktu → 200", del200.status === 200, del200);

  // =========================================================================
  // 7. Konwersja szansy
  // =========================================================================
  const leadWithContact = await S("POST", "/leads", {
    title: `${PREFIX} Szansa do konwersji`,
    prospectName: `${PREFIX} Nowy Klient`,
    salespersonId: salesperson.id,
    estimatedMonthly: 990,
    estimatedSetup: 5000,
    services: ["kamery"],
    address: "ul. Konwersyjna 5",
    city: "Zabrze",
  });
  const convLeadId = leadOf(leadWithContact).id;
  const convContact = await S("POST", "/contacts", {
    leadId: convLeadId,
    firstName: "Marek",
    lastName: `${PREFIX}Konwersyjny`,
    phone: "601202303",
  });
  ok("kontakt przy szansie (bez kontrahenta) → 201", convContact.status === 201, convContact);
  const convContactId = (convContact.data as { id: number }).id;

  const badNip = await S("POST", `/leads/${convLeadId}/convert`, {
    contractor: { name: `${PREFIX} Zły NIP`, nip: "1234567890" },
    object: { name: `${PREFIX} Obiekt` },
  });
  ok("konwersja z błędnym NIP-em → 400", badNip.status === 400, badNip);

  const nipB = freshNip();
  const conv = await S("POST", `/leads/${convLeadId}/convert`, {
    contractor: { name: `${PREFIX} Nowy Klient sp. z o.o.`, nip: nipB },
    object: { name: `${PREFIX} Obiekt z konwersji`, hasCameras: true, monthlyZdw: 990 },
    markWon: true,
  });
  ok("POST /leads/:id/convert → 200", conv.status === 200, conv);
  const convResult = conv.data as { contractorId: number; objectId: number; lead: { stage: string; wonAt: string | null; objectId: number | null } };
  ok("konwersja: szansa wygrana i podpięta do obiektu", convResult.lead.stage === "wygrany" && !!convResult.lead.wonAt && convResult.lead.objectId === convResult.objectId, convResult.lead);
  const newObject = db.select().from(schema.objects).where(eq(schema.objects.id, convResult.objectId)).get();
  ok(
    "konwersja: obiekt w dziale handlowym, status pending, z handlowcem",
    newObject?.department === "sales" && newObject?.status === "pending" && newObject?.salespersonId === salesperson.id,
    newObject
  );
  const movedContact = db.select().from(schema.contacts).where(eq(schema.contacts.id, convContactId)).get();
  ok("konwersja: kontakt przepięty do kontrahenta i obiektu", movedContact?.contractorId === convResult.contractorId && movedContact?.objectId === convResult.objectId, movedContact);
  const convLog = db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "lead"), eq(schema.activityLog.entityId, convLeadId), eq(schema.activityLog.action, "converted")))
    .all();
  ok("konwersja: wpis converted w dzienniku", convLog.length === 1, convLog);
  const objHistory = db.select().from(schema.objectHistory).where(eq(schema.objectHistory.objectId, convResult.objectId)).all();
  ok("konwersja: wpis w historii obiektu", objHistory.length === 1, objHistory);

  // Prefill zlecenia z tej samej szansy.
  const prefill = await S("GET", `/leads/${convLeadId}/order-prefill`);
  const pf = prefill.data as { payerNip: string; contactPhone: string; objectServices: { service: string }[]; isCameraInstallation: boolean };
  ok("order-prefill: płatnik z kontrahenta konwersji", prefill.status === 200 && pf.payerNip === nipB, prefill);
  ok("order-prefill: telefon z osoby kontaktowej", pf.contactPhone === "601202303", pf);
  ok("order-prefill: usługi mapowane na obiektowe", pf.objectServices.map((s) => s.service).join() === "kamery" && pf.isCameraInstallation === true, pf);

  // =========================================================================
  // 8. Kosz
  // =========================================================================
  ok("DELETE /leads/:id → 200", (await S("DELETE", `/leads/${otherId}`)).status === 200);
  const afterSoftDelete = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&includeClosed=1`);
  ok(
    "usunięta szansa znika z listy",
    !listItems(afterSoftDelete).some((i) => i.id === otherId),
    listItems(afterSoftDelete).map((i) => i.id)
  );
  const trash = await S("GET", `/leads?q=${encodeURIComponent(PREFIX)}&includeClosed=1&includeDeleted=1`);
  ok("includeDeleted=1 pokazuje kosz", listItems(trash).some((i) => i.id === otherId), listItems(trash).map((i) => i.id));
  ok("GET usuniętej szansy → 404", (await S("GET", `/leads/${otherId}`)).status === 404);
  const restored = await S("POST", `/leads/${otherId}/restore`);
  ok("POST /leads/:id/restore → 200", restored.status === 200 && leadOf(restored).deletedAt === null, restored);
  ok("drugie przywrócenie → 409", (await S("POST", `/leads/${otherId}/restore`)).status === 409);

  // =========================================================================
  // 9. Uprawnienia (strażnik prefiksu)
  // =========================================================================
  ok("konto bez handlowy/* : GET /leads → 403", (await X("GET", "/leads")).status === 403);
  ok("konto bez handlowy/* : GET /contacts → 403", (await X("GET", "/contacts")).status === 403);
  ok("podgląd (view): GET /leads → 200", (await V("GET", "/leads")).status === 200);
  ok("podgląd (view): POST /leads → 403", (await V("POST", "/leads", { title: `${PREFIX} Nie powinno powstać` })).status === 403);
  ok("podgląd (view): PATCH /stage → 403", (await V("PATCH", `/leads/${leadId}/stage`, { stage: "oferta" })).status === 403);
} finally {
  cleanup();
}

console.log(failures === 0 ? "\nWszystkie testy przeszły." : `\n${failures} test(ów) nie przeszło.`);
process.exit(failures === 0 ? 0 : 1);
