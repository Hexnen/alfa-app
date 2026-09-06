/**
 * Test automatycznych realizacji z wydarzeń kalendarza na prawdziwej bazie (data/alfa.db):
 *   npx tsx scripts/test-calendar-realizations.ts
 *
 * Zakres (sekcja 5 kontraktu): create serwis → realizacja + protokół; zmiana daty/technika → sync
 * (także protokołu, gdy nie jest podpisany); realizacja zafakturowana → brak sync + ostrzeżenie w logu;
 * anulowanie → usunięcie „nietkniętej”, a z kwotami → zostaje + adnotacja; zmiana typu na nieobjęty
 * → odpięcie; tryb on_done (brak przy planned, powstaje przy done); tryb off; urlop/biuro/przygotowanie
 * nigdy; usunięcie i przywrócenie wydarzenia; ręczne podpięcie realizacji (zajęta → 400); backfill
 * (dry-run + apply); kształt CalendarEventJson.realization; wyceny dla prac płatnych
 * (powstaje z cennika, znika przy zmianie na gwarancyjne, zostaje gdy ma wpisane ilości).
 *
 * Wydarzenia testowe: tytuł z prefiksem ZZ-CALREAL, terminy w 2027-03 (poza danymi produkcyjnymi).
 * Sprząta po sobie HARD (events + assignees + activity_log + realizacje + protokoły + ustawienia
 * calendar.* dodane przez test), także przy błędzie.
 */
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import {
  createEvent,
  deleteEvent,
  moveEvent,
  parseInput,
  restoreEvent,
  updateEvent,
  type MutationCtx,
} from "../src/lib/calendar-mutations.js";
import { loadEvent } from "../src/lib/calendar-queries.js";
import { runBackfill } from "../src/lib/calendar-realizations.js";
import { CALENDAR_FIELDS } from "../src/lib/calendar-config.js";
import { deleteSetting, setSetting } from "../src/lib/settings.js";
import { ApiError } from "../src/lib/calendar-labels.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-CALREAL";

const user = db.select().from(schema.users).where(eq(schema.users.role, "admin")).get();
if (!user) throw new Error("Brak administratora w bazie");
const ctx: MutationCtx = { user };

const techs = db.select({ id: schema.technicians.id, firstName: schema.technicians.firstName, lastName: schema.technicians.lastName }).from(schema.technicians).limit(2).all();
if (techs.length < 2) throw new Error("Potrzeba 2 techników w bazie");
const [t1, t2] = techs;
const name = (t: { firstName: string; lastName: string }) => `${t.firstName} ${t.lastName}`.trim();

/** Realizacje dotknięte przez test (do sprzątania nawet po odpięciu). */
const seenRealizations = new Set<number>();

// ---------------------------------------------------------------------------
// Helpery
// ---------------------------------------------------------------------------

type EventInput = Record<string, unknown>;

function create(input: EventInput): number {
  const id = db.transaction((tx) => createEvent(tx, parseInput(input), ctx).firstId);
  track(id);
  return id;
}

function update(id: number, input: EventInput): void {
  db.transaction((tx) => updateEvent(tx, id, parseInput(input), "this", ctx));
  track(id);
}

function track(id: number) {
  const ev = db.select({ realizationId: schema.calendarEvents.realizationId }).from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get();
  if (ev?.realizationId != null) seenRealizations.add(ev.realizationId);
}

function eventRow(id: number) {
  return db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, id)).get()!;
}

function realization(id: number | null) {
  if (id == null) return undefined;
  return db.select().from(schema.realizations).where(eq(schema.realizations.id, id)).get();
}

function quoteOf(realizationId: number) {
  return db.select().from(schema.quotes).where(eq(schema.quotes.realizationId, realizationId)).get();
}

function setAutoQuote(v: boolean) {
  setSetting(CALENDAR_FIELDS.autoQuote.dbKey, v ? "1" : "0", user!.id);
}

function protocolOf(realizationId: number) {
  return db.select().from(schema.protocols).where(eq(schema.protocols.realizationId, realizationId)).get();
}

function logs(eventId: number) {
  return db
    .select()
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "calendar_event"), eq(schema.activityLog.entityId, eventId)))
    .all();
}

function setMode(v: "on_create" | "on_done" | "off") {
  setSetting(CALENDAR_FIELDS.autoRealization.dbKey, v, user!.id);
}
function setSync(v: boolean) {
  setSetting(CALENDAR_FIELDS.realizationSync.dbKey, v ? "1" : "0", user!.id);
}
function resetSettings() {
  for (const f of Object.values(CALENDAR_FIELDS)) deleteSetting(f.dbKey);
}

const base = (over: EventInput = {}): EventInput => ({
  type: "serwis",
  title: `${PREFIX} Serwis`,
  startAt: "2027-03-10T08:00",
  endAt: "2027-03-10T10:30",
  objectId: null,
  location: "Ul. Testowa 1",
  technicianIds: [t1.id],
  status: "planned",
  ...over,
});

/** Hard delete danych testowych: realizacje + protokoły + wydarzenia + assignees + activity_log. */
function cleanup(): { events: number; realizations: number } {
  const evs = db.select({ id: schema.calendarEvents.id, realizationId: schema.calendarEvents.realizationId }).from(schema.calendarEvents).where(like(schema.calendarEvents.title, `${PREFIX}%`)).all();
  const eventIds = evs.map((e) => e.id);
  for (const e of evs) if (e.realizationId != null) seenRealizations.add(e.realizationId);
  // Realizacje utworzone z wydarzeń testowych (adnotacja „[Kalendarz #id] ZZ-CALREAL …”).
  for (const r of db.select({ id: schema.realizations.id }).from(schema.realizations).where(sql`${schema.realizations.note} LIKE ${`%${PREFIX}%`}`).all()) {
    seenRealizations.add(r.id);
  }
  const realIds = [...seenRealizations];
  if (eventIds.length) {
    db.update(schema.calendarEvents).set({ realizationId: null }).where(inArray(schema.calendarEvents.id, eventIds)).run();
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    db.delete(schema.activityLog).where(and(eq(schema.activityLog.entityType, "calendar_event"), inArray(schema.activityLog.entityId, eventIds))).run();
    db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run();
  }
  if (realIds.length) {
    db.delete(schema.protocols).where(inArray(schema.protocols.realizationId, realIds)).run();
    // Wyceny testowe: kasujemy przed realizacjami (FK dodane przez ALTER TABLE nie ma
    // ON DELETE CASCADE w bazach sprzed migracji 0043).
    const quoteIds = db.select({ id: schema.quotes.id }).from(schema.quotes).where(inArray(schema.quotes.realizationId, realIds)).all().map((q) => q.id);
    if (quoteIds.length) {
      db.update(schema.calendarEvents).set({ quoteId: null }).where(inArray(schema.calendarEvents.quoteId, quoteIds)).run();
      db.delete(schema.quotes).where(inArray(schema.quotes.id, quoteIds)).run();
    }
    db.delete(schema.realizations).where(inArray(schema.realizations.id, realIds)).run();
  }
  resetSettings();
  return { events: eventIds.length, realizations: realIds.length };
}

// ---------------------------------------------------------------------------
try {
  cleanup();
  resetSettings();

  // 1. create serwis → realizacja + protokół (tryb domyślny on_create)
  const ev1 = create(base({ title: `${PREFIX} Serwis 1` }));
  const r1id = eventRow(ev1).realizationId;
  const r1 = realization(r1id);
  ok("create serwis → powstała realizacja", r1 != null, r1id);
  ok("realizacja: date/site/kind/wykonawca/godziny", r1?.date === "2027-03-10" && r1?.site === "Ul. Testowa 1" && r1?.kind === "service" && r1?.contractor1 === name(t1) && r1?.actualHours === 2.5, r1);
  ok("realizacja: kwoty zerowe", (r1?.amountHours ?? -1) === 0 && (r1?.amountMaterial ?? -1) === 0 && (r1?.discount ?? -1) === 0, r1);
  ok("realizacja: adnotacja z prefiksem [Kalendarz #id]", r1?.note?.startsWith(`[Kalendarz #${ev1}] ${PREFIX} Serwis 1`) === true, r1?.note);
  const p1 = protocolOf(r1id!);
  ok("powstał protokół (szkic) dla realizacji", p1 != null && p1.status === "draft" && p1.workDate === "2027-03-10" && p1.workType === "serwis", p1);
  ok("activity_log: wpis linked „Utworzono realizację #…”", logs(ev1).some((l) => l.action === "linked" && /Utworzono realizację #\d+ i protokół P\//.test(l.summary ?? "")), logs(ev1).map((l) => l.summary));
  const j1 = loadEvent(db, ev1);
  ok("CalendarEventJson.realization {id,date,site,kind,invoiced,total}", j1?.realization?.id === r1id && j1?.realization?.date === "2027-03-10" && j1?.realization?.site === "Ul. Testowa 1" && j1?.realization?.kind === "service" && j1?.realization?.invoiced === false && j1?.realization?.total === 0, j1?.realization);
  ok("CalendarEventJson.protocol: protokół realizacji", j1?.protocol?.id === p1?.id, j1?.protocol);
  const q1 = quoteOf(r1id!);
  ok("praca płatna (billing pusty = płatny) → powstała wycena z cennika", q1 != null && /^W\/2027\/03\/\d{3}$/.test(q1.number) && q1.date === "2027-03-10" && q1.site === "Ul. Testowa 1", q1);
  ok("wycena: pozycje bez ilości (szkic do wypełnienia)", JSON.parse(q1?.items ?? "[]").every((i: { qty: string }) => i.qty === ""), q1?.items?.slice(0, 120));
  ok("activity_log: utworzenie wymienia realizację, protokół i wycenę", logs(ev1).some((l) => l.action === "linked" && /Utworzono realizację #\d+ i protokół P\/.+ oraz wycenę W\//.test(l.summary ?? "")), logs(ev1).map((l) => l.summary));
  ok("CalendarEventJson.quote {id,number,date,total,filledItems}", j1?.quote?.id === q1?.id && j1?.quote?.number === q1?.number && j1?.quote?.total === 0 && j1?.quote?.filledItems === 0, j1?.quote);

  // 2. sync: zmiana daty i technika → realizacja + niepodpisany protokół
  update(ev1, base({ title: `${PREFIX} Serwis 1`, startAt: "2027-03-12T09:00", endAt: "2027-03-12T13:00", technicianIds: [t2.id, t1.id] }));
  const r1b = realization(r1id);
  // Kolejność wykonawców = kolejność przypisania techników do wydarzenia (t1 był pierwszy, t2 dopisany).
  ok("sync: data 12.03, godziny 4, wykonawcy w kolejności przypisania", r1b?.date === "2027-03-12" && r1b?.actualHours === 4 && r1b?.contractor1 === name(t1) && r1b?.contractor2 === name(t2), r1b);
  const p1b = protocolOf(r1id!);
  ok("sync: protokół nie podpisany → workDate + contractor", p1b?.workDate === "2027-03-12" && p1b?.contractor === `${name(t1)}, ${name(t2)}`, p1b);
  ok("activity_log: wpis „Zaktualizowano realizację #…”", logs(ev1).some((l) => /Zaktualizowano realizację #\d+/.test(l.summary ?? "")), logs(ev1).map((l) => l.summary));

  // 2b. sync przez move (drag&drop)
  db.transaction((tx) => moveEvent(tx, ev1, { startAt: "2027-03-13T09:00", endAt: "2027-03-13T11:00" }, ctx));
  ok("move: realizacja przesunięta na 13.03, godziny 2", realization(r1id)?.date === "2027-03-13" && realization(r1id)?.actualHours === 2, realization(r1id));

  // 2c. billing=warranty → kind warranty; montaz → installation
  update(ev1, base({ title: `${PREFIX} Serwis 1`, startAt: "2027-03-13T09:00", endAt: "2027-03-13T11:00", billing: "warranty" }));
  ok("sync: billing warranty → kind warranty", realization(r1id)?.kind === "warranty", realization(r1id));
  ok("sync: gwarancja → pusta wycena usunięta", quoteOf(r1id!) == null, quoteOf(r1id!));
  ok("sync: log „Usunięto pustą wycenę …”", logs(ev1).some((l) => /Usunięto pustą wycenę W\//.test(l.summary ?? "")), logs(ev1).map((l) => l.summary));
  update(ev1, base({ title: `${PREFIX} Serwis 1`, startAt: "2027-03-13T09:00", endAt: "2027-03-13T11:00", billing: "paid" }));
  ok("sync: powrót na płatne → wycena powstaje na nowo", quoteOf(r1id!) != null, quoteOf(r1id!));
  update(ev1, base({ title: `${PREFIX} Serwis 1`, startAt: "2027-03-13T09:00", endAt: "2027-03-13T11:00", billing: "warranty" }));
  const evM = create(base({ type: "montaz", title: `${PREFIX} Montaz`, startAt: "2027-03-14T08:00", endAt: "2027-03-14T12:00" }));
  const rM = realization(eventRow(evM).realizationId);
  ok("montaz → kind installation, protokół workType montaz", rM?.kind === "installation" && protocolOf(rM!.id)?.workType === "montaz", rM);

  // 3. realizacja zafakturowana → brak sync + ostrzeżenie w activity_log
  db.update(schema.realizations).set({ invoiced: true, invoicedAt: "2027-03-20" }).where(eq(schema.realizations.id, r1id!)).run();
  const beforeInv = realization(r1id);
  update(ev1, base({ title: `${PREFIX} Serwis 1`, startAt: "2027-03-19T09:00", endAt: "2027-03-19T11:00", billing: "warranty" }));
  const afterInv = realization(r1id);
  ok("zafakturowana: realizacja bez zmian", afterInv?.date === beforeInv?.date && afterInv?.note === beforeInv?.note, afterInv);
  ok("zafakturowana: ostrzeżenie w activity_log", logs(ev1).some((l) => /jest zafakturowana — nie zsynchronizowano/.test(l.summary ?? "")), logs(ev1).map((l) => l.summary));

  // 3b. podpisany protokół → brak sync
  const evS = create(base({ title: `${PREFIX} Podpisany`, startAt: "2027-03-15T08:00", endAt: "2027-03-15T10:00" }));
  const rS = eventRow(evS).realizationId!;
  db.update(schema.protocols).set({ signedAt: "2027-03-15T12:00:00", status: "final", signerName: "Test" }).where(eq(schema.protocols.realizationId, rS)).run();
  update(evS, base({ title: `${PREFIX} Podpisany`, startAt: "2027-03-16T08:00", endAt: "2027-03-16T10:00" }));
  ok("podpisany protokół: realizacja bez zmian + ostrzeżenie", realization(rS)?.date === "2027-03-15" && logs(evS).some((l) => /jest podpisany — nie zsynchronizowano/.test(l.summary ?? "")), realization(rS));

  // 4. anulowanie „nietkniętej” → usunięcie realizacji i protokołu
  const evC = create(base({ title: `${PREFIX} Anulowany`, startAt: "2027-03-17T08:00", endAt: "2027-03-17T10:00" }));
  const rC = eventRow(evC).realizationId!;
  update(evC, base({ title: `${PREFIX} Anulowany`, startAt: "2027-03-17T08:00", endAt: "2027-03-17T10:00", status: "cancelled" }));
  ok("cancel (nietknięta): realizacja i protokół usunięte, event odpięty", realization(rC) == null && protocolOf(rC) == null && eventRow(evC).realizationId === null, eventRow(evC));
  ok("cancel: activity_log unlinked „Usunięto realizację #…”", logs(evC).some((l) => l.action === "unlinked" && /Usunięto realizację #\d+( i wycenę W\/\S+)? \(wydarzenie anulowane\)/.test(l.summary ?? "")), logs(evC).map((l) => l.summary));

  // 5. anulowanie realizacji z kwotami → zostaje + adnotacja
  const evK = create(base({ title: `${PREFIX} Anulowany z kwota`, startAt: "2027-03-18T08:00", endAt: "2027-03-18T10:00" }));
  const rK = eventRow(evK).realizationId!;
  db.update(schema.realizations).set({ amountHours: 500 }).where(eq(schema.realizations.id, rK)).run();
  update(evK, base({ title: `${PREFIX} Anulowany z kwota`, startAt: "2027-03-18T08:00", endAt: "2027-03-18T10:00", status: "cancelled" }));
  const rKa = realization(rK);
  ok("cancel z kwotami: realizacja zostaje, adnotacja „[Wydarzenie anulowane …]”", rKa != null && /\[Wydarzenie anulowane \d{2}\.\d{2}\]/.test(rKa.note ?? ""), rKa?.note);
  ok("cancel z kwotami: powiązanie zachowane + log", eventRow(evK).realizationId === rK && logs(evK).some((l) => /zostawiono ją/.test(l.summary ?? "")), logs(evK).map((l) => l.summary));

  // 6. zmiana typu na nieobjęty → odpięcie; z powrotem na objęty → nowa realizacja
  const evT = create(base({ title: `${PREFIX} Typ`, startAt: "2027-03-19T08:00", endAt: "2027-03-19T10:00" }));
  const rT = eventRow(evT).realizationId!;
  update(evT, base({ type: "biuro", title: `${PREFIX} Typ`, startAt: "2027-03-19T08:00", endAt: "2027-03-19T10:00" }));
  ok("typ → biuro: realizacja usunięta, event odpięty", realization(rT) == null && eventRow(evT).realizationId === null, eventRow(evT));
  update(evT, base({ type: "serwis", title: `${PREFIX} Typ`, startAt: "2027-03-19T08:00", endAt: "2027-03-19T10:00" }));
  const rT2 = eventRow(evT).realizationId;
  ok("biuro → serwis: powstaje NOWA realizacja", rT2 != null && rT2 !== rT, { rT, rT2 });

  // 7. urlop / biuro / przygotowanie — nigdy
  const evU = create({ type: "urlop", title: `${PREFIX} Urlop`, startAt: "2027-03-22", endAt: "2027-03-23", allDay: true, technicianIds: [t1.id] });
  const evB = create(base({ type: "biuro", title: `${PREFIX} Biuro` , startAt: "2027-03-23T08:00", endAt: "2027-03-23T10:00" }));
  const evP = create(base({ type: "przygotowanie", title: `${PREFIX} Przygotowanie`, startAt: "2027-03-24T08:00", endAt: "2027-03-24T10:00" }));
  ok("urlop/biuro/przygotowanie: brak realizacji", eventRow(evU).realizationId === null && eventRow(evB).realizationId === null && eventRow(evP).realizationId === null, [eventRow(evU).realizationId, eventRow(evB).realizationId, eventRow(evP).realizationId]);

  // 8. usunięcie + przywrócenie wydarzenia
  const evD = create(base({ title: `${PREFIX} Usuwany`, startAt: "2027-03-25T08:00", endAt: "2027-03-25T10:00" }));
  const rD = eventRow(evD).realizationId!;
  db.transaction((tx) => deleteEvent(tx, evD, "this", ctx));
  ok("delete: realizacja „nietknięta” usunięta", realization(rD) == null && eventRow(evD).realizationId === null, eventRow(evD));
  db.transaction((tx) => restoreEvent(tx, evD, ctx));
  track(evD);
  const rD2 = eventRow(evD).realizationId;
  ok("restore: powstaje nowa realizacja", rD2 != null && rD2 !== rD, { rD, rD2 });

  // 9. tryb on_done
  setMode("on_done");
  const evO = create(base({ title: `${PREFIX} OnDone`, startAt: "2027-03-26T08:00", endAt: "2027-03-26T10:00" }));
  ok("on_done: brak realizacji przy statusie planned", eventRow(evO).realizationId === null, eventRow(evO));
  update(evO, base({ title: `${PREFIX} OnDone`, startAt: "2027-03-26T08:00", endAt: "2027-03-26T10:00", status: "done" }));
  ok("on_done: realizacja powstaje po statusie done", eventRow(evO).realizationId != null, eventRow(evO));

  // 10. tryb off
  setMode("off");
  const evF = create(base({ title: `${PREFIX} Off`, startAt: "2027-03-27T08:00", endAt: "2027-03-27T10:00" }));
  update(evF, base({ title: `${PREFIX} Off`, startAt: "2027-03-27T08:00", endAt: "2027-03-27T10:00", status: "done" }));
  ok("off: brak realizacji nawet po done", eventRow(evF).realizationId === null, eventRow(evF));

  // 11. realization_sync = false — edycja nie rusza realizacji
  setMode("on_create");
  setSync(false);
  const evN = create(base({ title: `${PREFIX} NoSync`, startAt: "2027-03-28T08:00", endAt: "2027-03-28T10:00" }));
  const rN = eventRow(evN).realizationId!;
  update(evN, base({ title: `${PREFIX} NoSync`, startAt: "2027-03-29T08:00", endAt: "2027-03-29T10:00" }));
  ok("realization_sync=false: realizacja bez zmian", realization(rN)?.date === "2027-03-28", realization(rN));
  setSync(true);

  // 12. ręczne podpięcie realizacji: zajęta → 400
  const rFree = db.transaction((tx) => tx.insert(schema.realizations).values({ date: "2027-03-30", site: `${PREFIX} Ręczna`, kind: "service", note: `${PREFIX} ręczna` }).returning().get());
  seenRealizations.add(rFree.id);
  const evR = create(base({ type: "biuro", title: `${PREFIX} Ręczna`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00", realizationId: rFree.id }));
  ok("ręczne podpięcie do wydarzenia nieobjętego typu: link zachowany", eventRow(evR).realizationId === rFree.id, eventRow(evR));
  let err: unknown = null;
  try {
    create(base({ title: `${PREFIX} Kolizja`, startAt: "2027-03-31T08:00", endAt: "2027-03-31T10:00", realizationId: rFree.id }));
  } catch (e) {
    err = e;
  }
  ok("ręczne podpięcie zajętej realizacji → ApiError 400", err instanceof ApiError && err.status === 400 && /już podpięta do wydarzenia/.test((err as ApiError).message), err instanceof Error ? err.message : err);
  let err2: unknown = null;
  try {
    update(evR, base({ type: "biuro", title: `${PREFIX} Ręczna`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00", realizationId: 999999 }));
  } catch (e) {
    err2 = e;
  }
  ok("podpięcie nieistniejącej realizacji → ApiError 400", err2 instanceof ApiError && err2.status === 400 && /nie istnieje/.test((err2 as ApiError).message), err2 instanceof Error ? err2.message : err2);
  // Odpięcie ręczne (realizationId=null) — realizacja zostaje w module Realizacje
  update(evR, base({ type: "biuro", title: `${PREFIX} Ręczna`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00", realizationId: null }));
  ok("odpięcie ręczne: event bez realizacji, realizacja nadal istnieje", eventRow(evR).realizationId === null && realization(rFree.id) != null, eventRow(evR));

  // 12b. ręczne „Odepnij” w trybie on_create — NIE tworzy nowej realizacji (opt-out)
  const evX = create(base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-02T08:00", endAt: "2027-04-02T10:00" }));
  const rX = eventRow(evX).realizationId!;
  const protoCountBefore = db.select({ id: schema.protocols.id }).from(schema.protocols).all().length;
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-02T08:00", endAt: "2027-04-02T10:00", realizationId: null }));
  ok("Odepnij (on_create): brak nowej realizacji, opt-out ustawiony", eventRow(evX).realizationId === null && eventRow(evX).realizationOptout === true, eventRow(evX));
  // „Odepnij” tylko zrywa powiązanie — realizacja zostaje w module Realizacje (usuwa ją dopiero
  // anulowanie/usunięcie wydarzenia, i tylko gdy jest nietknięta). Żaden nowy protokół nie powstaje.
  ok("Odepnij: realizacja zostaje w Realizacjach, bez nowych protokołów", realization(rX) != null && db.select({ id: schema.protocols.id }).from(schema.protocols).all().length === protoCountBefore, protoCountBefore);
  ok("Odepnij: log „Zmieniono automatyczną realizację…”", logs(evX).some((l) => /automatyczną realizację: włączona → wyłączona/.test(l.summary ?? "")), logs(evX).map((l) => l.summary));
  // kolejny zwykły zapis (bez realizationId w body) też nie tworzy
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00" }));
  ok("Odepnij: kolejny zapis nie tworzy realizacji", eventRow(evX).realizationId === null && eventRow(evX).realizationOptout === true, eventRow(evX));
  // status done też nie
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00", status: "done" }));
  ok("Odepnij: status done nie tworzy realizacji", eventRow(evX).realizationId === null, eventRow(evX));
  // on_done też respektuje opt-out
  setMode("on_done");
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00", status: "done" }));
  ok("Odepnij: tryb on_done też respektuje opt-out", eventRow(evX).realizationId === null, eventRow(evX));
  setMode("on_create");
  // restore po delete też nie tworzy
  db.transaction((tx) => deleteEvent(tx, evX, "this", ctx));
  db.transaction((tx) => restoreEvent(tx, evX, ctx));
  ok("Odepnij: restore nie tworzy realizacji", eventRow(evX).realizationId === null, eventRow(evX));
  // ręczne podpięcie zdejmuje opt-out
  const rManual = db.transaction((tx) => tx.insert(schema.realizations).values({ date: "2027-04-03", site: `${PREFIX} Podpinana`, kind: "service", note: `${PREFIX} podpinana` }).returning().get());
  seenRealizations.add(rManual.id);
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00", realizationId: rManual.id }));
  ok("ręczne podpięcie: opt-out zdjęty, realizacja podpięta", eventRow(evX).realizationId === rManual.id && eventRow(evX).realizationOptout === false, eventRow(evX));
  ok("ręczne podpięcie: sync zaktualizował podpiętą realizację", realization(rManual.id)?.site === "Ul. Testowa 1", realization(rManual.id));
  // jawne realizationOptout: false po odpięciu → automat wraca przy kolejnym zapisie
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00", realizationId: null }));
  ok("ponowne odpięcie: opt-out znowu ustawiony", eventRow(evX).realizationOptout === true, eventRow(evX));
  update(evX, base({ title: `${PREFIX} Odpiety`, startAt: "2027-04-03T08:00", endAt: "2027-04-03T10:00", realizationOptout: false }));
  ok("jawne realizationOptout=false: automat wraca (nowa realizacja)", eventRow(evX).realizationOptout === false && eventRow(evX).realizationId != null, eventRow(evX));
  // odpięcie wydarzenia BEZ realizacji nie ustawia opt-outu
  setMode("off");
  const evY = create(base({ title: `${PREFIX} BezRealizacji`, startAt: "2027-04-04T08:00", endAt: "2027-04-04T10:00" }));
  update(evY, base({ title: `${PREFIX} BezRealizacji`, startAt: "2027-04-04T08:00", endAt: "2027-04-04T10:00", realizationId: null }));
  ok("realizationId=null przy braku powiązania: opt-out NIE ustawiony", eventRow(evY).realizationOptout === false, eventRow(evY));
  setMode("on_create");
  update(evY, base({ title: `${PREFIX} BezRealizacji`, startAt: "2027-04-04T08:00", endAt: "2027-04-04T10:00" }));
  ok("po powrocie do on_create: realizacja powstaje", eventRow(evY).realizationId != null, eventRow(evY));

  // 13. backfill (tryb off, żeby wydarzenia nie dostały realizacji od razu)
  setMode("off");
  const evBF1 = create(base({ title: `${PREFIX} Backfill 1`, startAt: "2027-04-05T08:00", endAt: "2027-04-05T10:00" }));
  const evBF2 = create(base({ type: "konserwacja", title: `${PREFIX} Backfill 2`, startAt: "2027-04-06T08:00", endAt: "2027-04-06T10:00" }));
  const evBF3 = create(base({ title: `${PREFIX} Backfill anulowany`, startAt: "2027-04-07T08:00", endAt: "2027-04-07T10:00", status: "cancelled" }));
  const evBF4 = create(base({ title: `${PREFIX} Backfill odpiety`, startAt: "2027-04-08T08:00", endAt: "2027-04-08T10:00" }));
  db.update(schema.calendarEvents).set({ realizationOptout: true }).where(eq(schema.calendarEvents.id, evBF4)).run();
  const dry = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-01", dryRun: true }));
  ok("backfill dry-run: kandydaci = 4, created undefined", dry.candidates.length === 4 && dry.created === undefined, dry);
  ok("backfill: ręcznie odpięte pominięte z powodem „ręcznie odpięte”", dry.skipped.some((s) => s.eventId === evBF4 && s.reason === "ręcznie odpięte"), dry.skipped);
  ok("backfill dry-run: anulowany na liście pominiętych", dry.skipped.some((s) => s.eventId === evBF3 && /anulowane/.test(s.reason)), dry.skipped);
  ok("backfill dry-run: nic nie zapisano", eventRow(evBF1).realizationId === null, eventRow(evBF1));
  ok("backfill: kandydat ma title/startAt/type/site", dry.candidates.some((x) => x.eventId === evBF2 && x.type === "konserwacja" && x.site === "Ul. Testowa 1" && x.startAt === "2027-04-06T08:00"), dry.candidates);
  const applied = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-01", dryRun: false }));
  track(evBF1);
  track(evBF2);
  ok("backfill apply: utworzono 2 realizacje mimo trybu off", applied.created?.length === 2 && eventRow(evBF1).realizationId != null && eventRow(evBF2).realizationId != null, applied);
  ok("backfill apply: numery protokołów w wyniku", applied.created?.every((x) => typeof x.protocolNumber === "string" && x.protocolNumber.startsWith("P/")) === true, applied.created);
  ok("backfill apply: numery wycen w wyniku (prace płatne)", applied.created?.every((x) => typeof x.quoteNumber === "string" && x.quoteNumber.startsWith("W/")) === true, applied.created);
  ok("backfill apply: ręcznie odpięte nadal bez realizacji", eventRow(evBF4).realizationId === null, eventRow(evBF4));
  const again = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-01", dryRun: false }));
  ok("backfill idempotentny: drugi przebieg nic nie tworzy", (again.created?.length ?? 0) === 0 && again.candidates.length === 2, again);

  // 13. wyceny: ilości chronią przed usunięciem, ustawienie calendar.auto_quote, anulowanie
  setMode("on_create");
  const evQ = create(base({ title: `${PREFIX} Wycena`, startAt: "2027-03-27T08:00", endAt: "2027-03-27T10:00" }));
  const rQ = eventRow(evQ).realizationId!;
  const qQ = quoteOf(rQ)!;
  ok("płatne: wycena podpięta do realizacji", qQ != null && qQ.realizationId === rQ, qQ);
  // Człowiek wpisuje ilość → dokument przestaje być pusty.
  db.update(schema.quotes).set({ items: JSON.stringify([{ name: "RBH", qty: "3", unit: "RBH", price: "120" }]) }).where(eq(schema.quotes.id, qQ.id)).run();
  update(evQ, base({ title: `${PREFIX} Wycena`, startAt: "2027-03-27T08:00", endAt: "2027-03-27T10:00", billing: "free" }));
  ok("wypełniona wycena: zostaje mimo zmiany na darmowe", quoteOf(rQ)?.id === qQ.id, quoteOf(rQ));
  ok("wypełniona wycena: ostrzeżenie w activity_log", logs(evQ).some((l) => /ma już wpisane ilości/.test(l.summary ?? "")), logs(evQ).map((l) => l.summary));
  const jQ = loadEvent(db, evQ);
  ok("CalendarEventJson.quote: suma i liczba wypełnionych pozycji", jQ?.quote?.total === 360 && jQ?.quote?.filledItems === 1, jQ?.quote);
  ok("wypełniona wycena: anulowanie NIE kasuje realizacji", (() => {
    update(evQ, base({ title: `${PREFIX} Wycena`, startAt: "2027-03-27T08:00", endAt: "2027-03-27T10:00", billing: "free", status: "cancelled" }));
    return realization(rQ) != null && quoteOf(rQ) != null;
  })(), { r: realization(rQ), q: quoteOf(rQ) });

  // backfill wycen: płatna realizacja bez wyceny (np. sprzed wpięcia wycen w kalendarz)
  setAutoQuote(false);
  const evBQ = create(base({ title: `${PREFIX} Backfill wyceny`, startAt: "2027-04-09T08:00", endAt: "2027-04-09T10:00" }));
  const rBQ = eventRow(evBQ).realizationId!;
  setAutoQuote(true);
  const dryQ = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-09", dryRun: true }));
  ok("backfill dry-run: liczy wydarzenia bez wyceny", dryQ.quoteCandidates === 1 && dryQ.quotesCreated === undefined, dryQ);
  ok("backfill dry-run: wycena nie powstała", quoteOf(rBQ) == null, quoteOf(rBQ));
  const applyQ = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-09", dryRun: false }));
  ok("backfill apply: brakująca wycena utworzona", applyQ.quotesCreated === 1 && quoteOf(rBQ) != null, applyQ);
  const againQ = db.transaction((tx) => runBackfill(tx, ctx, { from: "2027-04-09", dryRun: false }));
  ok("backfill wycen idempotentny", (againQ.quotesCreated ?? 0) === 0 && againQ.quoteCandidates === 0, againQ);

  // ręczne przypięcie wyceny (jak protokołu): jawny quoteId wygrywa z wyceną realizacji
  const evQP = create(base({ title: `${PREFIX} Wycena pin`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00" }));
  const rQP = eventRow(evQP).realizationId!;
  const ownQuote = quoteOf(rQP)!;
  const foreign = db
    .insert(schema.quotes)
    .values({ number: `W/2027/03/900`, date: "2027-03-30", site: `${PREFIX} obca`, address: "", items: "[]" })
    .returning()
    .get();
  update(evQP, base({ title: `${PREFIX} Wycena pin`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00", quoteId: foreign.id }));
  ok("ręczne przypięcie wyceny: JSON pokazuje przypiętą, nie realizacyjną", loadEvent(db, evQP)?.quote?.id === foreign.id, loadEvent(db, evQP)?.quote);
  update(evQP, base({ title: `${PREFIX} Wycena pin`, startAt: "2027-03-30T08:00", endAt: "2027-03-30T10:00" }));
  ok("odpięcie: wraca wycena realizacji", loadEvent(db, evQP)?.quote?.id === ownQuote.id && eventRow(evQP).quoteId === null, loadEvent(db, evQP)?.quote);
  db.delete(schema.quotes).where(eq(schema.quotes.id, foreign.id)).run();

  // calendar.auto_quote = off → płatne wydarzenie bez wyceny
  setAutoQuote(false);
  const evNQ = create(base({ title: `${PREFIX} Bez wyceny`, startAt: "2027-03-28T08:00", endAt: "2027-03-28T10:00" }));
  const rNQ = eventRow(evNQ).realizationId!;
  ok("auto_quote=off: realizacja i protokół są, wyceny nie ma", realization(rNQ) != null && protocolOf(rNQ) != null && quoteOf(rNQ) == null, quoteOf(rNQ));
  setAutoQuote(true);

  // anulowanie „nietkniętego” płatnego wydarzenia kasuje realizację, protokół i wycenę
  const evQC = create(base({ title: `${PREFIX} Wycena anulowana`, startAt: "2027-03-29T08:00", endAt: "2027-03-29T10:00" }));
  const rQC = eventRow(evQC).realizationId!;
  const qQC = quoteOf(rQC)!;
  update(evQC, base({ title: `${PREFIX} Wycena anulowana`, startAt: "2027-03-29T08:00", endAt: "2027-03-29T10:00", status: "cancelled" }));
  ok("cancel: pusta wycena znika razem z realizacją", realization(rQC) == null && quoteOf(rQC) == null, { r: realization(rQC) });
  ok("cancel: log wymienia numer wyceny", logs(evQC).some((l) => new RegExp(`Usunięto realizację #\\d+ i wycenę ${qQC.number.replace(/\//g, "\\/")}`).test(l.summary ?? "")), logs(evQC).map((l) => l.summary));

  // 14. filtr GET /realizations?source= (logika zapytania)
  setMode("on_create");
} finally {
  const n = cleanup();
  console.log(`\n(posprzątano ${n.events} wydarzeń i ${n.realizations} realizacji testowych; ustawienia calendar.* przywrócone do domyślnych)`);
}
console.log(failures ? `\n${failures} błędów` : "\nWszystkie testy OK");
process.exit(failures ? 1 : 0);
