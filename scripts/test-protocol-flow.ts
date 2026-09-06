/**
 * Test przepływu „wszystko zmierza do protokołu, z protokołu wycena”:
 *   npx tsx scripts/test-protocol-flow.ts
 *
 * Zakres:
 *   1. wydarzenie CAŁODNIOWE → protokół powstaje BEZ godzin, a norma dnia
 *      (`company.work_day_hours`) wraca wyłącznie jako sugestia `confident: false`,
 *   2. wydarzenie z godzinami → godziny wchodzą do szkicu od razu (regresja),
 *   3. `fillProtocolFromRealizationSync`: km i godziny doliczone w realizacji lądują
 *      w NIEPODPISANYM protokole i tylko w polach zerowych (ręczny wpis zostaje),
 *      protokół podpisany/zatwierdzony jest nietykalny,
 *   4. `syncRealizationFromEvent`: przesunięcie terminu dopisuje godziny do protokołu,
 *      który ich nie ma, i nie rusza tych, które ktoś wpisał,
 *   5. `refreshQuoteFromProtocolSync`: nietknięta wycena przelicza się z protokołu
 *      (materiały z ilością + robocizna + dojazd), a wycena z wpisaną ilością zostaje.
 *
 * Dane testowe: prefiks ZZ-FLOW, daty 2029-10 — poza danymi produkcyjnymi. Sprząta HARD.
 */
import { eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import type { CalendarEvent, Realization, User } from "../src/db/schema.js";
import { createProtocolForRealizationSync } from "../src/routes/protocols.js";
import { refreshQuoteFromProtocolSync } from "../src/routes/quotes.js";
import {
  buildProtocolPrefill,
  fillProtocolFromRealizationSync,
  protocolPrefillSuggestions,
} from "../src/lib/protocol-prefill.js";
import { syncRealizationFromEvent } from "../src/lib/calendar-realizations.js";
import { getCompanyConfig } from "../src/lib/company-config.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-FLOW";
const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}

// --- Sprzątanie ------------------------------------------------------------
function cleanup(): Record<string, number> {
  const realizationIds = db
    .select({ id: schema.realizations.id })
    .from(schema.realizations)
    .where(like(schema.realizations.site, `${PREFIX}%`))
    .all()
    .map((r) => r.id);
  const eventIds = db
    .select({ id: schema.calendarEvents.id })
    .from(schema.calendarEvents)
    .where(like(schema.calendarEvents.title, `${PREFIX}%`))
    .all()
    .map((e) => e.id);
  const listIds = db
    .select({ id: schema.priceLists.id })
    .from(schema.priceLists)
    .where(like(schema.priceLists.name, `${PREFIX}%`))
    .all()
    .map((l) => l.id);

  const counts: Record<string, number> = {};
  if (eventIds.length) {
    db.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, eventIds)).run();
    counts.events = db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run().changes;
  }
  if (realizationIds.length) {
    counts.quotes = db.delete(schema.quotes).where(inArray(schema.quotes.realizationId, realizationIds)).run().changes;
    counts.protocols = db
      .delete(schema.protocols)
      .where(inArray(schema.protocols.realizationId, realizationIds))
      .run().changes;
    counts.realizations = db
      .delete(schema.realizations)
      .where(inArray(schema.realizations.id, realizationIds))
      .run().changes;
  }
  counts.technicians = db.delete(schema.technicians).where(like(schema.technicians.lastName, `${PREFIX}%`)).run().changes;
  if (listIds.length) {
    db.delete(schema.priceList).where(inArray(schema.priceList.priceListId, listIds)).run();
    counts.priceLists = db.delete(schema.priceLists).where(inArray(schema.priceLists.id, listIds)).run().changes;
  }
  counts.objects = db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run().changes;
  counts.contractors = db.delete(schema.contractors).where(like(schema.contractors.name, `${PREFIX}%`)).run().changes;
  return counts;
}
cleanup();

// --- Dane testowe ----------------------------------------------------------
interface Fixtures {
  objectId: number;
  listId: number;
  technicianId: number;
}

function seed(): Fixtures {
  const contractor = db
    .insert(schema.contractors)
    .values({ name: `${PREFIX} Klient S.A.`, nip: "9990001112", address: "ul. Testowa 2", city: "Kraków" })
    .returning()
    .get();
  const object = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Obiekt`,
      address: "ul. Obiektowa 1",
      city: "Kraków",
      type: "monitoring",
      installationType: "new",
    })
    .returning()
    .get();
  const list = db
    .insert(schema.priceLists)
    .values({ name: `${PREFIX} Cennik`, description: "", isDefault: false, active: true, position: 950 })
    .returning()
    .get();
  db.insert(schema.priceList)
    .values([
      { priceListId: list.id, name: `${PREFIX} ROBOCZOGODZINA`, unit: "RBH", kind: "service", price: 120, position: 1, active: true },
      { priceListId: list.id, name: `${PREFIX} DOJAZD`, unit: "KM", kind: "service", price: 2.5, position: 2, active: true },
      { priceListId: list.id, name: `${PREFIX} KAMERA IP`, unit: "SZT", kind: "material", price: 500, position: 3, active: true },
      { priceListId: list.id, name: `${PREFIX} KABEL UTP`, unit: "MB", kind: "material", price: 2, position: 4, active: true },
    ])
    .run();
  const technician = db
    .insert(schema.technicians)
    .values({ firstName: "Ewa", lastName: `${PREFIX}ska`, priceListId: list.id, active: true })
    .returning()
    .get();
  return { objectId: object.id, listId: list.id, technicianId: technician.id };
}

function makeRealization(patch: Partial<Realization> & { site: string; date: string }): Realization {
  return db
    .insert(schema.realizations)
    .values({
      date: patch.date,
      site: patch.site,
      kind: patch.kind ?? "service",
      ...(patch.workType ? { workType: patch.workType } : {}),
      contractor1: patch.contractor1 ?? null,
      actualHours: patch.actualHours ?? 0,
      actualKm: patch.actualKm ?? 0,
    })
    .returning()
    .get();
}

function makeEvent(input: {
  title: string;
  startAt: string;
  endAt: string;
  allDay: boolean;
  objectId: number;
  realizationId: number | null;
  technicianIds?: number[];
}): CalendarEvent {
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: "serwis",
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: input.allDay,
      status: "planned",
      department: "technical",
      objectId: input.objectId,
      realizationId: input.realizationId,
    })
    .returning()
    .get();
  for (const id of input.technicianIds ?? []) {
    db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
  }
  return ev;
}

const protocolById = (id: number) => db.select().from(schema.protocols).where(eq(schema.protocols.id, id)).get()!;

// --- Testy -----------------------------------------------------------------
function main(fx: Fixtures) {
  const cfg = getCompanyConfig().values;
  const norm = cfg.workDayHours;

  // -------------------------------------------------------------------------
  // 1. Wydarzenie całodniowe → godziny tylko jako sugestia
  // -------------------------------------------------------------------------
  const r1 = makeRealization({ site: `${PREFIX} Obiekt`, date: "2029-10-05" });
  const ev1 = makeEvent({
    title: `${PREFIX} Serwis całodniowy`,
    startAt: "2029-10-05",
    endAt: "2029-10-07",
    allDay: true,
    objectId: fx.objectId,
    realizationId: r1.id,
    technicianIds: [fx.technicianId],
  });

  const prefill1 = buildProtocolPrefill(db, r1, { event: ev1 });
  ok("all-day: values.actualHours = 2 dni × norma", prefill1.values.actualHours === 2 * norm, {
    got: prefill1.values.actualHours,
    norm,
  });
  ok("all-day: origin oznaczony jako szacunek", prefill1.origins.actualHours?.assumed === true, prefill1.origins.actualHours);

  const proto1 = db.transaction((tx) => createProtocolForRealizationSync(tx, r1, ev1))!;
  ok("all-day: szkic protokołu powstaje BEZ godzin", proto1.actualHours === 0, proto1.actualHours);

  const sug1 = protocolPrefillSuggestions(proto1, prefill1, { realization: r1 });
  const hoursSug = sug1.find((s) => s.field === "actualHours");
  ok("all-day: sugestia godzin istnieje", !!hoursSug, sug1.map((s) => s.field));
  ok("all-day: sugestia NIE jest confident", hoursSug?.confident === false, hoursSug);
  ok("all-day: sugerowana wartość = dni × norma", hoursSug?.suggested === 2 * norm, hoursSug?.suggested);

  // -------------------------------------------------------------------------
  // 2. Wydarzenie z godzinami → godziny w szkicu od razu
  // -------------------------------------------------------------------------
  const r2 = makeRealization({ site: `${PREFIX} Obiekt`, date: "2029-10-08" });
  const ev2 = makeEvent({
    title: `${PREFIX} Serwis 8:00-12:30`,
    startAt: "2029-10-08T08:00",
    endAt: "2029-10-08T12:30",
    allDay: false,
    objectId: fx.objectId,
    realizationId: r2.id,
    technicianIds: [fx.technicianId],
  });
  const proto2 = db.transaction((tx) => createProtocolForRealizationSync(tx, r2, ev2))!;
  ok("godzinowe: 4,5 godz. w szkicu protokołu", proto2.actualHours === 4.5, proto2.actualHours);

  // -------------------------------------------------------------------------
  // 3. Km i godziny doliczone w realizacji → protokół (tylko pola zerowe)
  // -------------------------------------------------------------------------
  db.update(schema.realizations).set({ actualKm: 611, actualHours: 8 }).where(eq(schema.realizations.id, r1.id)).run();
  const r1full = db.select().from(schema.realizations).where(eq(schema.realizations.id, r1.id)).get()!;
  const filled = db.transaction((tx) => fillProtocolFromRealizationSync(tx, r1full, { user, reason: "test" }));
  ok("dosypanie: zapisano godziny i km", filled?.applied.join(",") === "actualHours,actualKm", filled);
  const proto1after = protocolById(proto1.id);
  ok("dosypanie: km w protokole", proto1after.actualKm === 611, proto1after.actualKm);
  ok("dosypanie: godziny w protokole", proto1after.actualHours === 8, proto1after.actualHours);

  // ręczny wpis nie do ruszenia
  db.update(schema.protocols).set({ actualHours: 3 }).where(eq(schema.protocols.id, proto2.id)).run();
  db.update(schema.realizations).set({ actualHours: 9, actualKm: 0 }).where(eq(schema.realizations.id, r2.id)).run();
  const r2full = db.select().from(schema.realizations).where(eq(schema.realizations.id, r2.id)).get()!;
  const filled2 = db.transaction((tx) => fillProtocolFromRealizationSync(tx, r2full, { user, reason: "test" }));
  ok("dosypanie: pole z wartością zostaje nietknięte", filled2 === null, filled2);
  ok("dosypanie: godziny w protokole bez zmian", protocolById(proto2.id).actualHours === 3, protocolById(proto2.id).actualHours);

  // podpisany protokół nietykalny
  const r3 = makeRealization({ site: `${PREFIX} Obiekt`, date: "2029-10-09", actualHours: 5, actualKm: 100 });
  const ev3 = makeEvent({
    title: `${PREFIX} Serwis podpisany`,
    startAt: "2029-10-09",
    endAt: "2029-10-10",
    allDay: true,
    objectId: fx.objectId,
    realizationId: r3.id,
  });
  const proto3 = db.transaction((tx) => createProtocolForRealizationSync(tx, r3, ev3))!;
  db.update(schema.protocols)
    .set({ signedAt: new Date().toISOString(), signerName: "Klient", signaturePng: "data:image/png;base64,AAAA" })
    .where(eq(schema.protocols.id, proto3.id))
    .run();
  const filled3 = db.transaction((tx) => fillProtocolFromRealizationSync(tx, r3, { user, reason: "test" }));
  ok("dosypanie: protokół podpisany pomijany", filled3 === null, filled3);
  ok("dosypanie: podpisany protokół nadal bez godzin", protocolById(proto3.id).actualHours === 0, protocolById(proto3.id).actualHours);

  // -------------------------------------------------------------------------
  // 4. Zmiana terminu wydarzenia → godziny do protokołu, który ich nie ma
  // -------------------------------------------------------------------------
  const r4 = makeRealization({ site: `${PREFIX} Obiekt`, date: "2029-10-12" });
  const ev4 = makeEvent({
    title: `${PREFIX} Serwis do przesunięcia`,
    startAt: "2029-10-12",
    endAt: "2029-10-13",
    allDay: true,
    objectId: fx.objectId,
    realizationId: null,
    technicianIds: [fx.technicianId],
  });
  db.update(schema.calendarEvents).set({ realizationId: r4.id }).where(eq(schema.calendarEvents.id, ev4.id)).run();
  const proto4 = db.transaction((tx) => createProtocolForRealizationSync(tx, r4, ev4))!;
  ok("sync: szkic bez godzin (all-day)", proto4.actualHours === 0, proto4.actualHours);

  db.update(schema.calendarEvents)
    .set({ allDay: false, startAt: "2029-10-13T07:00", endAt: "2029-10-13T13:00" })
    .where(eq(schema.calendarEvents.id, ev4.id))
    .run();
  const ev4moved = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev4.id)).get()!;
  db.transaction((tx) => syncRealizationFromEvent(tx, ev4moved, { user }));
  ok("sync: 6 godz. z nowego terminu w protokole", protocolById(proto4.id).actualHours === 6, protocolById(proto4.id).actualHours);

  db.update(schema.protocols).set({ actualHours: 2 }).where(eq(schema.protocols.id, proto4.id)).run();
  db.update(schema.calendarEvents)
    .set({ startAt: "2029-10-14T07:00", endAt: "2029-10-14T15:00" })
    .where(eq(schema.calendarEvents.id, ev4.id))
    .run();
  const ev4moved2 = db.select().from(schema.calendarEvents).where(eq(schema.calendarEvents.id, ev4.id)).get()!;
  db.transaction((tx) => syncRealizationFromEvent(tx, ev4moved2, { user }));
  ok("sync: ręczne godziny w protokole zostają", protocolById(proto4.id).actualHours === 2, protocolById(proto4.id).actualHours);

  // -------------------------------------------------------------------------
  // 5. Wycena z protokołu
  // -------------------------------------------------------------------------
  db.update(schema.protocols)
    .set({
      actualHours: 5,
      actualKm: 120,
      items: JSON.stringify([
        { name: `${PREFIX} KAMERA IP`, serial: "SN-1", unit: "SZT", qty: "2" },
        { name: `${PREFIX} KABEL UTP`, serial: "", unit: "MB", qty: "50" },
        { name: `${PREFIX} PESZEL`, serial: "", unit: "MB", qty: "10" },
        { name: `${PREFIX} KAMERA IP`, serial: "", unit: "SZT", qty: "" },
      ]),
    })
    .where(eq(schema.protocols.id, proto2.id))
    .run();
  const quote = db
    .insert(schema.quotes)
    .values({
      number: `W/2029/10/${PREFIX}`,
      date: "2029-10-08",
      site: `${PREFIX} Obiekt`,
      address: "ul. Obiektowa 1",
      items: JSON.stringify([{ name: `${PREFIX} KAMERA IP`, qty: "", unit: "SZT", price: "500" }]),
      realizationId: r2.id,
    })
    .returning()
    .get();

  const res = db.transaction((tx) => refreshQuoteFromProtocolSync(tx, r2.id, user));
  ok("wycena: status updated", res.status === "updated", res.status);
  const items = res.items ?? [];
  const byName = (needle: string) => items.find((i) => i.name.includes(needle));
  const markup = 1 + cfg.materialMarkup / 100;
  ok("wycena: kamera 2 szt. po cenie z cennika", byName("KAMERA")?.qty === "2" && byName("KAMERA")?.price === String(Math.round(500 * markup * 100) / 100), byName("KAMERA"));
  ok("wycena: kabel 50 mb", byName("KABEL")?.qty === "50", byName("KABEL"));
  ok("wycena: pozycja spoza cennika z pustą ceną", byName("PESZEL")?.price === "", byName("PESZEL"));
  ok("wycena: pozycja protokołu bez ilości pominięta", items.filter((i) => i.name.includes("KAMERA")).length === 1, items);
  ok("wycena: robocizna 5 RBH × 120", byName("ROBOCZOGODZINA")?.qty === "5" && byName("ROBOCZOGODZINA")?.price === "120", byName("ROBOCZOGODZINA"));
  ok("wycena: dojazd 120 km × 2,5", byName("DOJAZD")?.qty === "120" && byName("DOJAZD")?.price === "2.5", byName("DOJAZD"));
  ok("wycena: ostrzeżenie o pozycji bez ceny", res.warnings.some((w) => w.includes("PESZEL")), res.warnings);

  // wycena tknięta przez człowieka zostaje
  const touched = db.transaction((tx) => refreshQuoteFromProtocolSync(tx, r2.id, user));
  ok("wycena: druga próba nie rusza wpisanych ilości", touched.status === "touched", touched.status);
  const stored = db.select().from(schema.quotes).where(eq(schema.quotes.id, quote.id)).get()!;
  ok("wycena: pozycje w bazie = przeliczone z protokołu", JSON.parse(stored.items).length === items.length, stored.items);
}

const fixtures = seed();
try {
  main(fixtures);
} catch (e) {
  failures++;
  console.error("FAIL (wyjątek):", e);
} finally {
  const removed = cleanup();
  console.log(`\nSprzątanie: ${JSON.stringify(removed)}`);
  console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} testów nie przeszło`);
  process.exit(failures === 0 ? 0 : 1);
}
