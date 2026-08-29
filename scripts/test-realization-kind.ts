/**
 * Test rozdzielenia „typu” realizacji na RODZAJ (`work_type`) i TYP ROZLICZENIA (`billing`)
 * na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-realization-kind.ts
 *
 * Zakres:
 *  - migracja danych: każdy wiersz ma znane wartości `work_type`/`billing`, a zgodnościowe
 *    `kind` zgadza się z parą; realizacje z kalendarza mają rodzaj i typ wydarzenia,
 *  - helpery `src/lib/realization-kind.ts` (rozbicie starego `kind`, wyliczanie nowego),
 *  - API: POST/PUT przyjmuje `workType`/`billing`, waliduje enumy (400) i wylicza `kind`,
 *    starszy klient z samym `kind` nadal działa,
 *  - wydarzenie → realizacja: mapowanie przy tworzeniu i synchronizacja przy edycji,
 *  - GET /summary liczone po nowych polach daje te same liczby, co stara formuła po `kind`.
 *
 * Dane testowe: obiekt z prefiksem ZZ-RKIND, terminy w 2028-05 (poza danymi produkcyjnymi).
 * Sprząta po sobie HARD (realizacje + protokoły + wydarzenia + assignees + activity_log),
 * także przy błędzie.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import realizationsApp from "../src/routes/realizations.js";
import { createEvent, parseInput, updateEvent, type MutationCtx } from "../src/lib/calendar-mutations.js";
import { mapEventToRealization, realizationKindOf } from "../src/lib/calendar-realizations.js";
import {
  isRealizationBilling,
  isRealizationWorkType,
  realizationBillingOf,
  realizationKindFrom,
  realizationWorkTypeOf,
  splitLegacyKind,
} from "../src/lib/realization-kind.js";
import { CALENDAR_FIELDS } from "../src/lib/calendar-config.js";
import { deleteSetting, setSetting } from "../src/lib/settings.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-RKIND";

const user = db.select().from(schema.users).where(eq(schema.users.role, "admin")).get();
if (!user) throw new Error("Brak administratora w bazie");
const ctx: MutationCtx = { user };

/** Realizacje utworzone przez test (także te powstałe z wydarzeń). */
const seen = new Set<number>();

type Body = Record<string, unknown>;

async function post(path: string, body: Body) {
  const res = await realizationsApp.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function put(path: string, body: Body) {
  const res = await realizationsApp.request(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function get(path: string) {
  const res = await realizationsApp.request(path);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const realizationBody = (over: Body = {}): Body => ({
  date: "2028-05-10",
  site: `${PREFIX} Obiekt`,
  workType: "serwis",
  billing: "paid",
  amountHours: 100,
  amountMaterial: 0,
  amountKm: 0,
  discount: 0,
  invoiced: false,
  actualHours: 2,
  actualKm: 10,
  hourlyCost: 40,
  ...over,
});

/** Tworzy realizację przez API i zapamiętuje ją do sprzątania. */
async function createRealization(over: Body = {}) {
  const res = await post("/", realizationBody(over));
  const data = res.json.data as { id?: number } | undefined;
  if (data?.id) seen.add(data.id);
  return res;
}

function rowOf(id: number) {
  return db.select().from(schema.realizations).where(eq(schema.realizations.id, id)).get()!;
}

function eventRow(id: number) {
  return db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get()!;
}

const eventInput = (over: Body = {}): Body => ({
  type: "serwis",
  title: `${PREFIX} Wydarzenie`,
  startAt: "2028-05-12T08:00",
  endAt: "2028-05-12T10:00",
  objectId: null,
  location: `${PREFIX} Obiekt`,
  technicianIds: [],
  status: "planned",
  ...over,
});

function createEv(input: Body): number {
  const id = db.transaction((tx) => createEvent(tx, parseInput(input), ctx).firstId);
  const rid = eventRow(id).realizationId;
  if (rid != null) seen.add(rid);
  return id;
}

function updateEv(id: number, input: Body): void {
  db.transaction((tx) => updateEvent(tx, id, parseInput(input), "this", ctx));
  const rid = eventRow(id).realizationId;
  if (rid != null) seen.add(rid);
}

function cleanup(): { events: number; realizations: number } {
  const evs = db
    .select({ id: schema.calendarEvents.id, realizationId: schema.calendarEvents.realizationId })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all();
  const eventIds = evs.map((e) => e.id);
  for (const e of evs) if (e.realizationId != null) seen.add(e.realizationId);
  for (const r of db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(sql`${schema.realizations.site} LIKE ${`${PREFIX}%`}`)
    .all()) {
    seen.add(r.id);
  }
  const realIds = [...seen];
  if (eventIds.length) {
    db.update(schema.calendarEvents).set({ realizationId: null }).where(inArray(schema.calendarEvents.id, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog)
      .where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds)))
      .run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (realIds.length) {
    db.delete(schema.protocols).where(inArray(schema.protocols.realizationId, realIds)).run();
    // Wyceny prac płatnych (src/lib/calendar-realizations.ts) — przed realizacjami:
    // FK `quotes.realization_id` dodany przez ALTER TABLE nie ma ON DELETE CASCADE
    // w bazach sprzed migracji 0043.
    const quoteIds = db.select({ id: schema.quotes.id }).from(schema.quotes).where(inArray(schema.quotes.realizationId, realIds)).all().map((q) => q.id);
    if (quoteIds.length) {
      db.update(schema.calendarEvents).set({ quoteId: null }).where(inArray(schema.calendarEvents.quoteId, quoteIds)).run();
      db.delete(schema.quotes).where(inArray(schema.quotes.id, quoteIds)).run();
    }
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realIds)).run();
  }
  for (const f of Object.values(CALENDAR_FIELDS)) deleteSetting(f.dbKey);
  return { events: eventIds.length, realizations: realIds.length };
}

try {
  // -------------------------------------------------------------------------
  // 1. Helpery
  // -------------------------------------------------------------------------
  ok("splitLegacyKind: service → (serwis, paid)", JSON.stringify(splitLegacyKind("service")) === JSON.stringify({ workType: "serwis", billing: "paid" }), splitLegacyKind("service"));
  ok("splitLegacyKind: installation → (montaz, paid)", JSON.stringify(splitLegacyKind("installation")) === JSON.stringify({ workType: "montaz", billing: "paid" }), splitLegacyKind("installation"));
  ok("splitLegacyKind: warranty → (serwis, warranty)", JSON.stringify(splitLegacyKind("warranty")) === JSON.stringify({ workType: "serwis", billing: "warranty" }), splitLegacyKind("warranty"));
  ok("splitLegacyKind: śmieć → (serwis, paid)", JSON.stringify(splitLegacyKind("xxx")) === JSON.stringify({ workType: "serwis", billing: "paid" }), splitLegacyKind("xxx"));

  ok("kind: gwarancja wygrywa z rodzajem", realizationKindFrom("montaz", "warranty") === "warranty");
  ok("kind: płatny montaż → installation", realizationKindFrom("montaz", "paid") === "installation");
  ok("kind: darmowy montaż zostaje montażem", realizationKindFrom("montaz", "free") === "installation");
  ok("kind: konserwacja płatna → service", realizationKindFrom("konserwacja", "paid") === "service");
  ok("kind: wizja darmowa → service", realizationKindFrom("wizja", "free") === "service");

  ok("rodzaj z typu wydarzenia: konserwacja", realizationWorkTypeOf("konserwacja") === "konserwacja");
  ok("rodzaj z typu wydarzenia: biuro → inne", realizationWorkTypeOf("biuro") === "inne");
  ok("rozliczenie z wydarzenia: NULL → paid", realizationBillingOf(null) === "paid");
  ok("rozliczenie z wydarzenia: free → free", realizationBillingOf("free") === "free");
  ok("walidatory enumów", isRealizationWorkType("demontaz") && !isRealizationWorkType("urlop") && isRealizationBilling("free") && !isRealizationBilling("none"));

  // -------------------------------------------------------------------------
  // 2. Migracja danych — cała tabela
  // -------------------------------------------------------------------------
  // Tylko dane produkcyjne — wiersze `ZZ-*` należą do innych testów i mogą akurat
  // istnieć w bazie (wstawiane wprost, z pominięciem API, więc bez wyliczania `kind`).
  const all = db
    .select()
    .from(schema.realizations)
    .all()
    .filter((r) => !r.site.startsWith("ZZ"));
  ok("migracja: wszystkie wiersze mają znany rodzaj", all.every((r) => isRealizationWorkType(r.workType)), all.filter((r) => !isRealizationWorkType(r.workType)).slice(0, 3));
  ok("migracja: wszystkie wiersze mają znany typ rozliczenia", all.every((r) => isRealizationBilling(r.billing)), all.filter((r) => !isRealizationBilling(r.billing)).slice(0, 3));
  ok(
    "migracja: `kind` zgodne z parą (rodzaj, typ)",
    all.every((r) => r.kind === realizationKindFrom(r.workType, r.billing)),
    all.filter((r) => r.kind !== realizationKindFrom(r.workType, r.billing)).slice(0, 3),
  );
  const legacyOnly = all.filter((r) => {
    const s = splitLegacyKind(r.kind);
    return r.workType === s.workType && r.billing === s.billing;
  });
  ok("migracja: rozkład sensowny (są wiersze z rodzaju odtworzonego z `kind`)", legacyOnly.length > 0, { legacyOnly: legacyOnly.length, all: all.length });

  const linked = db
    .select({ r: schema.realizations, type: schema.calendarEvents.type, billing: schema.calendarEvents.billing })
    .from(schema.realizations)
    .innerJoin(
      schema.calendarEvents,
      and(eq(schema.calendarEvents.realizationId, schema.realizations.id), sql`${schema.calendarEvents.deletedAt} IS NULL`),
    )
    .all()
    .filter((x) => !x.r.site.startsWith("ZZ"));
  ok(
    "migracja: realizacje z kalendarza mają rodzaj i typ wydarzenia",
    linked.every((x) => x.r.workType === realizationWorkTypeOf(x.type) && x.r.billing === realizationBillingOf(x.billing)),
    linked.filter((x) => x.r.workType !== realizationWorkTypeOf(x.type) || x.r.billing !== realizationBillingOf(x.billing)),
  );

  // -------------------------------------------------------------------------
  // 3. API — walidacja i wyliczanie `kind`
  // -------------------------------------------------------------------------
  const created = await createRealization({ workType: "konserwacja", billing: "warranty" });
  const createdRow = created.json.data as Record<string, unknown>;
  ok("POST: zapisuje rodzaj i typ", created.status === 201 && createdRow.workType === "konserwacja" && createdRow.billing === "warranty", created.json);
  ok("POST: `kind` wyliczone (gwarancja → warranty)", createdRow.kind === "warranty", createdRow.kind);
  ok("POST: protokół powstał razem z realizacją", !!createdRow.protocol, createdRow.protocol);

  const badWorkType = await post("/", realizationBody({ workType: "urlop" }));
  ok("POST: nieznany rodzaj → 400", badWorkType.status === 400 && /rodzaj/i.test(String(badWorkType.json.error)), badWorkType.json);
  const badBilling = await post("/", realizationBody({ billing: "gratis" }));
  ok("POST: nieznany typ rozliczenia → 400", badBilling.status === 400 && /rozliczen/i.test(String(badBilling.json.error)), badBilling.json);

  // starszy klient: samo `kind`
  const legacy = await post("/", { ...realizationBody(), workType: undefined, billing: undefined, kind: "installation" });
  const legacyRow = legacy.json.data as Record<string, unknown>;
  if (typeof legacyRow?.id === "number") seen.add(legacyRow.id);
  ok("POST bez nowych pól: `kind` rozbite na (montaz, paid)", legacy.status === 201 && legacyRow.workType === "montaz" && legacyRow.billing === "paid", legacy.json);
  const legacyBad = await post("/", { ...realizationBody(), workType: undefined, billing: undefined, kind: "xxx" });
  ok("POST bez nowych pól: nieznane `kind` → 400", legacyBad.status === 400, legacyBad.json);

  const id = createdRow.id as number;
  const edited = await put(`/${id}`, realizationBody({ workType: "montaz", billing: "paid", expectedUpdatedAt: createdRow.updatedAt }));
  const editedRow = edited.json.data as Record<string, unknown>;
  ok("PUT: zmiana rodzaju i typu", edited.status === 200 && editedRow.workType === "montaz" && editedRow.billing === "paid", edited.json);
  ok("PUT: `kind` przeliczone (płatny montaż → installation)", editedRow.kind === "installation", editedRow.kind);
  ok("PUT: w bazie to samo", rowOf(id).kind === "installation" && rowOf(id).workType === "montaz", rowOf(id));

  const badPut = await put(`/${id}`, realizationBody({ workType: "serwis", billing: "nope", expectedUpdatedAt: editedRow.updatedAt }));
  ok("PUT: nieznany typ rozliczenia → 400", badPut.status === 400, badPut.json);

  const listed = await get("/?year=2028&month=5");
  const listRows = (listed.json.data as Record<string, unknown>[]) ?? [];
  ok("GET /: lista zwraca oba pola", listRows.length > 0 && listRows.every((r) => typeof r.workType === "string" && typeof r.billing === "string"), listRows[0]);

  // -------------------------------------------------------------------------
  // 4. Wydarzenie → realizacja (mapowanie + synchronizacja)
  // -------------------------------------------------------------------------
  setSetting(CALENDAR_FIELDS.autoRealization.dbKey, "on_create", user.id);
  setSetting(CALENDAR_FIELDS.realizationSync.dbKey, "1", user.id);

  const ev = createEv(eventInput({ type: "wizja", billing: "warranty" }));
  const evRealId = eventRow(ev).realizationId!;
  const evReal = rowOf(evRealId);
  ok("wydarzenie → realizacja: rodzaj z typu wydarzenia", evReal.workType === "wizja", evReal);
  ok("wydarzenie → realizacja: typ z rozliczenia wydarzenia", evReal.billing === "warranty", evReal);
  ok("wydarzenie → realizacja: `kind` wyliczone", evReal.kind === "warranty" && evReal.kind === realizationKindOf(eventRow(ev)), evReal);

  updateEv(ev, eventInput({ type: "montaz", billing: "paid" }));
  const synced = rowOf(evRealId);
  ok("sync: rodzaj podąża za typem wydarzenia", synced.workType === "montaz", synced);
  ok("sync: typ podąża za rozliczeniem wydarzenia", synced.billing === "paid", synced);
  ok("sync: `kind` przeliczone na installation", synced.kind === "installation", synced);
  ok(
    "sync: protokół dostał typ prac montaż",
    db.select().from(schema.protocols).where(eq(schema.protocols.realizationId, evRealId)).get()?.workType === "montaz",
    db.select().from(schema.protocols).where(eq(schema.protocols.realizationId, evRealId)).get(),
  );

  const mapped = mapEventToRealization(db, eventRow(ev));
  ok("mapEventToRealization: zwraca komplet (rodzaj, typ, kind)", mapped.workType === "montaz" && mapped.billing === "paid" && mapped.kind === "installation", mapped);

  // wydarzenie bez rozliczenia (NULL) → realizacja płatna
  const evNull = createEv(eventInput({ type: "demontaz", startAt: "2028-05-13T08:00", endAt: "2028-05-13T10:00", billing: null }));
  const evNullReal = rowOf(eventRow(evNull).realizationId!);
  ok("wydarzenie bez rozliczenia: realizacja płatna, rodzaj demontaż", evNullReal.billing === "paid" && evNullReal.workType === "demontaz", evNullReal);

  // -------------------------------------------------------------------------
  // 5. Summary — nowe pola dają te same liczby, co stara formuła po `kind`
  // -------------------------------------------------------------------------
  await createRealization({ date: "2028-05-15", workType: "montaz", billing: "paid", amountHours: 500 });
  await createRealization({ date: "2028-05-16", workType: "serwis", billing: "warranty", amountHours: 300, actualHours: 3, hourlyCost: 40 });
  await createRealization({ date: "2028-05-17", workType: "wizja", billing: "paid", amountHours: 200 });

  const summaryRes = await get("/summary?year=2028&month=5");
  const summary = summaryRes.json.data as Record<string, unknown>;
  const monthRows = db
    .select()
    .from(schema.realizations)
    .where(like(schema.realizations.date, "2028-05-%"))
    .all();

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const total = (r: (typeof monthRows)[number]) => r.amountHours + r.amountMaterial + r.amountKm - r.discount;
  const labour = (r: (typeof monthRows)[number]) => r.actualHours * r.hourlyCost;
  // Stara formuła (po zgodnościowym `kind`) — dla tych danych musi dać to samo.
  let oldPaid = 0;
  let oldInst = 0;
  let oldFree = 0;
  let oldFreeCost = 0;
  const oldCounts = { service: 0, warranty: 0, installation: 0 };
  for (const r of monthRows) {
    oldCounts[r.kind] += 1;
    if (r.kind === "service") oldPaid += total(r);
    else if (r.kind === "installation") oldInst += total(r);
    else {
      oldFree += total(r);
      oldFreeCost += labour(r);
    }
  }
  ok("summary: paidServices jak w starej formule", summary.paidServices === round2(oldPaid), { got: summary.paidServices, want: round2(oldPaid) });
  ok("summary: installations jak w starej formule", summary.installations === round2(oldInst), { got: summary.installations, want: round2(oldInst) });
  ok("summary: freePotential jak w starej formule", summary.freePotential === round2(oldFree), { got: summary.freePotential, want: round2(oldFree) });
  ok("summary: freeCost jak w starej formule", summary.freeCost === round2(oldFreeCost), { got: summary.freeCost, want: round2(oldFreeCost) });
  ok("summary: counts w dotychczasowym kształcie", JSON.stringify(summary.counts) === JSON.stringify(oldCounts), { got: summary.counts, want: oldCounts });

  const byWorkType = summary.byWorkType as Record<string, number>;
  const byBilling = summary.byBilling as Record<string, number>;
  ok("summary: byWorkType sumuje się do liczby realizacji", Object.values(byWorkType).reduce((a, b) => a + b, 0) === monthRows.length, byWorkType);
  ok("summary: byBilling sumuje się do liczby realizacji", Object.values(byBilling).reduce((a, b) => a + b, 0) === monthRows.length, byBilling);
  ok(
    "summary: byWorkType zgodne z bazą",
    Object.entries(byWorkType).every(([k, v]) => monthRows.filter((r) => r.workType === k).length === v),
    byWorkType,
  );
  ok(
    "summary: byBilling zgodne z bazą",
    Object.entries(byBilling).every(([k, v]) => monthRows.filter((r) => r.billing === k).length === v),
    byBilling,
  );
  ok(
    "summary: darmowe wchodzą do kubełka bezpłatnych",
    (() => {
      const free = monthRows.filter((r) => r.billing === "warranty" || r.billing === "free").length;
      return (summary.counts as { warranty: number }).warranty === free;
    })(),
    summary.counts,
  );
} finally {
  const n = cleanup();
  console.log(`\n(posprzątano ${n.events} wydarzeń i ${n.realizations} realizacji testowych; ustawienia calendar.* przywrócone)`);
}

console.log(failures ? `\n${failures} błędów` : "\nWszystkie testy OK");
process.exit(failures ? 1 : 0);
