/**
 * Test wstępnego wypełniania protokołu (src/lib/protocol-prefill.ts + trasy /protocols/:id/prefill)
 * na prawdziwej bazie (data/alfa.db), przez trasy Hono (app.request) z podstawionym userem:
 *   npx tsx scripts/test-protocol-prefill.ts
 *
 * Zakres:
 *   - prefill z łańcucha wydarzenie → obiekt → kontrahent (zleceniodawca, NIP, miejscowość,
 *     adres montażu, kontakt, wykonawcy z wydarzenia, typ prac z typu wydarzenia, data i godziny
 *     z terminu wydarzenia, czynności z tytułu i opisu),
 *   - pozycje: materiały z cennika technika → materiały z cennika domyślnego → DEFAULT_ITEMS,
 *   - brak wydarzenia → dane z realizacji (site jako adres, mapowanie typu z `kind`),
 *   - `createProtocolForRealizationSync` zapisuje prefill i jest idempotentne,
 *   - GET /protocols/:id/prefill: pola puste → confident, pola z inną wartością → confident=false,
 *   - POST /protocols/:id/prefill zapisuje WYŁĄCZNIE wskazane pola, nieznane pole → 400,
 *   - protokół podpisany (i zatwierdzony) → 400 w obie strony.
 *
 * Dane testowe: prefiks ZZ-PREFILL (kontrahent, obiekty, cenniki, technik, realizacje),
 * daty w 2029-09 — poza danymi produkcyjnymi. Sprząta po sobie HARD, także przy błędzie.
 */
import { Hono } from "hono";
import { and, eq, inArray, like } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import protocols, { createProtocolForRealizationSync } from "../src/routes/protocols.js";
import { buildProtocolPrefill, DEFAULT_ITEMS } from "../src/lib/protocol-prefill.js";
import type { CalendarEvent, Realization, User } from "../src/db/schema.js";

let failures = 0;
function ok(label: string, cond: boolean, extra?: unknown) {
  console.log(`${cond ? "OK  " : "FAIL"} ${label}${cond ? "" : `\n     got: ${JSON.stringify(extra)}`}`);
  if (!cond) failures++;
}

const PREFIX = "ZZ-PREFILL";
const NIP = "9999000111";

const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}

// --- Klient HTTP -----------------------------------------------------------
const app = new Hono();
app.use("*", async (c, next) => {
  c.set("user", user);
  return next();
});
app.route("/protocols", protocols);

interface Json {
  status: number;
  success?: boolean;
  data?: unknown;
  error?: string;
  message?: string;
}

async function call(method: string, path: string, body?: unknown): Promise<Json> {
  const res = await app.request(`/protocols${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  const json = (await res.json().catch(() => null)) as Omit<Json, "status"> | null;
  return { status: res.status, ...(json ?? {}) };
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
    db.delete(schema.calendarEventAssignees)
      .where(inArray(schema.calendarEventAssignees.eventId, eventIds))
      .run();
    counts.events = db.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, eventIds)).run().changes;
  }
  if (realizationIds.length) {
    counts.protocols = db
      .delete(schema.protocols)
      .where(inArray(schema.protocols.realizationId, realizationIds))
      .run().changes;
    counts.realizations = db
      .delete(schema.realizations)
      .where(inArray(schema.realizations.id, realizationIds))
      .run().changes;
  }
  counts.technicians = db
    .delete(schema.technicians)
    .where(like(schema.technicians.lastName, `${PREFIX}%`))
    .run().changes;
  if (listIds.length) {
    db.delete(schema.priceList).where(inArray(schema.priceList.priceListId, listIds)).run();
    counts.priceLists = db.delete(schema.priceLists).where(inArray(schema.priceLists.id, listIds)).run().changes;
  }
  // Obiekty lecą kaskadą z kontrahentem, ale kasujemy jawnie (obiekt mógł zostać po błędzie).
  counts.objects = db.delete(schema.objects).where(like(schema.objects.name, `${PREFIX}%`)).run().changes;
  counts.contractors = db
    .delete(schema.contractors)
    .where(like(schema.contractors.name, `${PREFIX}%`))
    .run().changes;
  return counts;
}
cleanup();

// --- Dane testowe ----------------------------------------------------------
interface Fixtures {
  contractorId: number;
  objectId: number;
  techListId: number;
  emptyListId: number;
  technicianId: number;
  plainTechnicianId: number;
}

function seed(): Fixtures {
  const contractor = db
    .insert(schema.contractors)
    .values({
      name: `${PREFIX} Klient Sp. z o.o.`,
      nip: NIP,
      address: "ul. Kontrahencka 1",
      city: "Katowice",
      phone: "600 100 200",
      email: "biuro@prefill.test",
      contactPerson: "Anna Testowa",
    })
    .returning()
    .get();

  const object = db
    .insert(schema.objects)
    .values({
      contractorId: contractor.id,
      name: `${PREFIX} Obiekt Główny`,
      address: "ul. Obiektowa 7",
      city: "Gliwice",
      type: "monitoring",
      installationType: "new",
    })
    .returning()
    .get();

  const techList = db
    .insert(schema.priceLists)
    .values({ name: `${PREFIX} Cennik technika`, description: "", isDefault: false, active: true, position: 900 })
    .returning()
    .get();
  db.insert(schema.priceList)
    .values([
      { priceListId: techList.id, name: `${PREFIX} ROBOCZOGODZINA`, unit: "RBH", kind: "service", price: 100, position: 1, active: true },
      { priceListId: techList.id, name: `${PREFIX} KAMERA IP`, unit: "SZT", kind: "material", price: 500, position: 3, active: true },
      { priceListId: techList.id, name: `${PREFIX} KABEL UTP`, unit: "MB", kind: "material", price: 2, position: 2, active: true },
      { priceListId: techList.id, name: `${PREFIX} NIEAKTYWNY MATERIAL`, unit: "SZT", kind: "material", price: 9, position: 4, active: false },
    ])
    .run();

  const emptyList = db
    .insert(schema.priceLists)
    .values({ name: `${PREFIX} Cennik bez materiałów`, description: "", isDefault: false, active: true, position: 901 })
    .returning()
    .get();
  db.insert(schema.priceList)
    .values({ priceListId: emptyList.id, name: `${PREFIX} DOJAZD`, unit: "KM", kind: "service", price: 3, position: 1, active: true })
    .run();

  const technician = db
    .insert(schema.technicians)
    .values({ firstName: "Marek", lastName: `${PREFIX}owski`, priceListId: techList.id, active: true })
    .returning()
    .get();
  const plain = db
    .insert(schema.technicians)
    .values({ firstName: "Jan", lastName: `${PREFIX}czyk`, priceListId: emptyList.id, active: true })
    .returning()
    .get();

  return {
    contractorId: contractor.id,
    objectId: object.id,
    techListId: techList.id,
    emptyListId: emptyList.id,
    technicianId: technician.id,
    plainTechnicianId: plain.id,
  };
}

function makeRealization(patch: Partial<Realization> & { site: string; date: string }): Realization {
  return db
    .insert(schema.realizations)
    .values({
      date: patch.date,
      site: patch.site,
      kind: patch.kind ?? "service",
      ...(patch.workType ? { workType: patch.workType } : {}),
      note: patch.note ?? null,
      caretaker: patch.caretaker ?? null,
      contractor1: patch.contractor1 ?? null,
      contractor2: patch.contractor2 ?? null,
      actualHours: patch.actualHours ?? 0,
      actualKm: patch.actualKm ?? 0,
    })
    .returning()
    .get();
}

function makeEvent(input: {
  title: string;
  type: "serwis" | "montaz" | "wizja" | "demontaz" | "konserwacja";
  startAt: string;
  endAt: string;
  objectId: number | null;
  realizationId: number | null;
  description?: string;
  technicianIds?: number[];
}): CalendarEvent {
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: input.type,
      title: input.title,
      description: input.description ?? null,
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: false,
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

// --- Testy -----------------------------------------------------------------
async function main(fx: Fixtures) {
  const prodProtocols = db.select({ id: schema.protocols.id }).from(schema.protocols).all().length;
  const prodRealizations = db.select({ id: schema.realizations.id }).from(schema.realizations).all().length;

  // -------------------------------------------------------------------------
  // 1. Prefill z wydarzenia → obiektu → kontrahenta
  // -------------------------------------------------------------------------
  const r1 = makeRealization({
    site: `${PREFIX} Obiekt Główny`,
    date: "2029-09-01",
    kind: "service",
    caretaker: "Opiekun Testowy",
    contractor1: "Ktoś Zdezaktualizowany",
    actualKm: 42,
    note: "stara adnotacja",
  });
  const ev1 = makeEvent({
    title: `${PREFIX} Wymiana rejestratora`,
    type: "montaz",
    startAt: "2029-09-04T08:00",
    endAt: "2029-09-04T11:30",
    objectId: fx.objectId,
    realizationId: r1.id,
    description: "Rejestrator 8-kanałowy, dysk 4 TB",
    technicianIds: [fx.technicianId, fx.plainTechnicianId],
  });

  const p1 = buildProtocolPrefill(db, r1);
  ok("clientName z kontrahenta obiektu", p1.values.clientName === `${PREFIX} Klient Sp. z o.o.`, p1.values.clientName);
  ok("clientNip z kontrahenta", p1.values.clientNip === NIP, p1.values.clientNip);
  ok("clientCity z kontrahenta", p1.values.clientCity === "Katowice", p1.values.clientCity);
  ok(
    "installationAddress = adres obiektu + miasto",
    p1.values.installationAddress === "ul. Obiektowa 7, Gliwice",
    p1.values.installationAddress
  );
  ok(
    "contact = osoba kontaktowa + telefon + e-mail",
    p1.values.contact === "Anna Testowa, 600 100 200, biuro@prefill.test",
    p1.values.contact
  );
  ok(
    "contractor = technicy wydarzenia (nie z realizacji)",
    p1.values.contractor === `Marek ${PREFIX}owski, Jan ${PREFIX}czyk`,
    p1.values.contractor
  );
  ok("workType z typu wydarzenia (montaz)", p1.values.workType === "montaz", p1.values.workType);
  ok("workDate z terminu wydarzenia", p1.values.workDate === "2029-09-04", p1.values.workDate);
  ok("actualHours = długość wydarzenia", p1.values.actualHours === 3.5, p1.values.actualHours);
  ok("actualKm z realizacji", p1.values.actualKm === 42, p1.values.actualKm);
  ok("salesperson = opiekun realizacji", p1.values.salesperson === "Opiekun Testowy", p1.values.salesperson);
  ok(
    "activities = tytuł + opis wydarzenia",
    p1.values.activities === `${PREFIX} Wymiana rejestratora — Rejestrator 8-kanałowy, dysk 4 TB`,
    p1.values.activities
  );
  ok(
    "items z cennika technika (aktywne materiały po position)",
    p1.values.items.length === 2 &&
      p1.values.items[0].name === `${PREFIX} KABEL UTP` &&
      p1.values.items[0].unit === "MB" &&
      p1.values.items[0].qty === "" &&
      p1.values.items[1].name === `${PREFIX} KAMERA IP`,
    p1.values.items
  );
  ok("context.priceList via technik", p1.context.priceList?.via === "technik", p1.context.priceList);
  ok("origins mają źródła", p1.origins.clientName?.source === "kontrahent" && p1.origins.contractor?.source === "kalendarz", p1.origins);

  // Typ „konserwacja” → serwis, „wizja” → wizja, „demontaz” → inne
  db.update(schema.calendarEvents).set({ type: "konserwacja" }).where(eq(schema.calendarEvents.id, ev1.id)).run();
  ok("konserwacja → serwis", buildProtocolPrefill(db, r1).values.workType === "serwis");
  db.update(schema.calendarEvents).set({ type: "demontaz" }).where(eq(schema.calendarEvents.id, ev1.id)).run();
  ok("demontaz → inne", buildProtocolPrefill(db, r1).values.workType === "inne");
  db.update(schema.calendarEvents).set({ type: "wizja" }).where(eq(schema.calendarEvents.id, ev1.id)).run();
  ok("wizja → wizja", buildProtocolPrefill(db, r1).values.workType === "wizja");
  db.update(schema.calendarEvents).set({ type: "montaz" }).where(eq(schema.calendarEvents.id, ev1.id)).run();

  // -------------------------------------------------------------------------
  // 2. Cennik bez materiałów → DEFAULT_ITEMS
  // -------------------------------------------------------------------------
  const r2 = makeRealization({ site: `${PREFIX} Obiekt Główny`, date: "2029-09-05", kind: "installation", workType: "montaz" });
  makeEvent({
    title: `${PREFIX} Przegląd bez materiałów`,
    type: "serwis",
    startAt: "2029-09-05T09:00",
    endAt: "2029-09-05T10:00",
    objectId: fx.objectId,
    realizationId: r2.id,
    technicianIds: [fx.plainTechnicianId],
  });
  const p2 = buildProtocolPrefill(db, r2);
  ok(
    "cennik technika bez materiałów → DEFAULT_ITEMS",
    JSON.stringify(p2.values.items) === JSON.stringify(DEFAULT_ITEMS),
    p2.values.items
  );
  ok("origins.items puste, gdy wzór", p2.origins.items === undefined, p2.origins.items);

  // -------------------------------------------------------------------------
  // 3. Brak wydarzenia → dane z realizacji (+ dopasowanie obiektu po nazwie)
  // -------------------------------------------------------------------------
  const r3 = makeRealization({
    site: `${PREFIX} Nieznany obiekt spoza słownika`,
    date: "2029-09-07",
    kind: "installation",
    workType: "montaz",
    contractor1: "Adam Realizacyjny",
    contractor2: "Ewa Realizacyjna",
    actualHours: 6,
    note: "Wymiana zasilacza",
  });
  const p3 = buildProtocolPrefill(db, r3);
  ok("bez wydarzenia: workDate z realizacji", p3.values.workDate === "2029-09-07", p3.values.workDate);
  ok("bez wydarzenia: workType z realizacji (montaz)", p3.values.workType === "montaz", p3.values.workType);
  ok("bez wydarzenia: wykonawcy z realizacji", p3.values.contractor === "Adam Realizacyjny, Ewa Realizacyjna", p3.values.contractor);
  ok("bez wydarzenia: godziny z realizacji", p3.values.actualHours === 6, p3.values.actualHours);
  ok("bez wydarzenia: adres = site", p3.values.installationAddress === r3.site, p3.values.installationAddress);
  ok("bez wydarzenia: brak danych klienta", p3.values.clientName === "" && p3.values.clientNip === "", p3.values);
  ok("bez wydarzenia: czynności z adnotacji", p3.values.activities === "Wymiana zasilacza", p3.values.activities);
  ok("bez wydarzenia: cennik domyślny", p3.context.priceList?.via === "domyślny", p3.context.priceList);

  // Bez wydarzenia, ale site = nazwa obiektu → dane klienta i tak wchodzą
  const r3b = makeRealization({ site: `${PREFIX} Obiekt Główny`, date: "2029-09-08" });
  const p3b = buildProtocolPrefill(db, r3b);
  ok(
    "bez wydarzenia: obiekt dopasowany po nazwie → klient uzupełniony",
    p3b.values.clientName === `${PREFIX} Klient Sp. z o.o.` && p3b.values.installationAddress === "ul. Obiektowa 7, Gliwice",
    p3b.values
  );

  // -------------------------------------------------------------------------
  // 4. createProtocolForRealizationSync — zapis prefillu i idempotencja
  // -------------------------------------------------------------------------
  const createdProto = db.transaction((tx) => createProtocolForRealizationSync(tx, r1));
  ok("protokół utworzony z prefillem", !!createdProto && createdProto.clientName === `${PREFIX} Klient Sp. z o.o.`, createdProto);
  ok("numer protokołu z daty wydarzenia (2029-09)", createdProto?.number.startsWith("P/2029/09/"), createdProto?.number);
  ok("workDate protokołu = data wydarzenia", createdProto?.workDate === "2029-09-04", createdProto?.workDate);
  ok(
    "items protokołu = materiały cennika",
    JSON.parse(createdProto!.items).length === 2,
    createdProto?.items
  );

  const again = db.transaction((tx) => createProtocolForRealizationSync(tx, r1));
  const protoCount = db
    .select({ id: schema.protocols.id })
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, r1.id))
    .all().length;
  ok("powtórne tworzenie nie duplikuje protokołu", again === undefined && protoCount === 1, { again, protoCount });

  // Protokół dla realizacji bez wydarzenia (do testów sugestii z pustymi polami)
  const proto3 = db.transaction((tx) => createProtocolForRealizationSync(tx, r3))!;
  ok(
    "protokół bez wydarzenia bierze pozycje z cennika domyślnego (albo wzór, gdy ten nie ma materiałów)",
    JSON.stringify(JSON.parse(proto3.items)) === JSON.stringify(p3.values.items),
    proto3.items
  );

  // -------------------------------------------------------------------------
  // 5. GET /:id/prefill — sugestie
  // -------------------------------------------------------------------------
  // Podpinamy wydarzenie do r3 PO utworzeniu protokołu: protokół ma teraz stare dane,
  // a prefill wie już o wydarzeniu, obiekcie i kontrahencie.
  makeEvent({
    title: `${PREFIX} Serwis kamer`,
    type: "serwis",
    startAt: "2029-09-09T10:00",
    endAt: "2029-09-09T12:00",
    objectId: fx.objectId,
    realizationId: r3.id,
    description: "Czyszczenie optyki",
    technicianIds: [fx.technicianId],
  });

  const preview = await call("GET", `/${proto3.id}/prefill`);
  const suggestions = (preview.data as { suggestions: { field: string; confident: boolean; suggested: unknown; current: unknown; source: string }[] })?.suggestions ?? [];
  const byField = new Map(suggestions.map((s) => [s.field, s]));
  ok("GET /prefill → 200", preview.status === 200, preview.error);
  ok(
    "puste pole klienta → sugestia confident",
    byField.get("clientName")?.confident === true && byField.get("clientName")?.suggested === `${PREFIX} Klient Sp. z o.o.`,
    byField.get("clientName")
  );
  ok("pusty NIP → sugestia confident", byField.get("clientNip")?.confident === true, byField.get("clientNip"));
  ok("pusty kontakt → sugestia confident", byField.get("contact")?.confident === true, byField.get("contact"));
  ok(
    "adres montażu inny niż w protokole → confident=false",
    byField.get("installationAddress")?.confident === false &&
      byField.get("installationAddress")?.current === r3.site,
    byField.get("installationAddress")
  );
  ok(
    "wykonawca inny niż w protokole → confident=false",
    byField.get("contractor")?.confident === false,
    byField.get("contractor")
  );
  ok(
    "typ prac z wydarzenia (montaz→serwis) confident, bo w protokole był tylko rodzaj z realizacji",
    byField.get("workType")?.suggested === "serwis" && byField.get("workType")?.confident === true,
    byField.get("workType")
  );
  ok(
    "items z cennika proponowane (wzór DEFAULT_ITEMS jest nietknięty)",
    byField.get("items")?.confident === true && byField.get("items")?.source === "cennik",
    byField.get("items")
  );
  ok(
    "pole zgodne z protokołem nie tworzy sugestii (salesperson pusty w obu)",
    !byField.has("salesperson"),
    byField.get("salesperson")
  );

  // -------------------------------------------------------------------------
  // 6. POST /:id/prefill — zapis tylko wskazanych pól
  // -------------------------------------------------------------------------
  const bad = await call("POST", `/${proto3.id}/prefill`, { fields: ["clientName", "nieistniejące"] });
  ok("nieznane pole → 400", bad.status === 400, bad);
  const empty = await call("POST", `/${proto3.id}/prefill`, { fields: [] });
  ok("pusta lista pól → 400", empty.status === 400, empty);

  const applied = await call("POST", `/${proto3.id}/prefill`, { fields: ["clientName", "clientNip", "items"] });
  ok("POST /prefill → 200", applied.status === 200, applied.error);
  ok(
    "applied = wskazane pola",
    JSON.stringify((applied.data as { applied: string[] })?.applied) === JSON.stringify(["clientName", "clientNip", "items"]),
    (applied.data as { applied: string[] })?.applied
  );
  const after = db.select().from(schema.protocols).where(eq(schema.protocols.id, proto3.id)).get()!;
  ok("clientName zapisany", after.clientName === `${PREFIX} Klient Sp. z o.o.`, after.clientName);
  ok("clientNip zapisany", after.clientNip === NIP, after.clientNip);
  ok("items zapisane z cennika", JSON.parse(after.items).length === 2, after.items);
  ok("clientCity NIEtknięte (nie było na liście)", after.clientCity === "", after.clientCity);
  ok("contact NIEtknięty (nie był na liście)", after.contact === "", after.contact);
  ok("installationAddress NIEtknięty (nie był na liście)", after.installationAddress === r3.site, after.installationAddress);
  ok("activities NIEtknięte", after.activities === "Wymiana zasilacza", after.activities);

  const logged = db
    .select({ id: schema.activityLog.id, summary: schema.activityLog.summary })
    .from(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "protocol"), eq(schema.activityLog.entityId, proto3.id)))
    .all();
  ok("wpis w activity_log", logged.length === 1 && !!logged[0].summary?.includes("Uzupełniono protokół"), logged);
  db.delete(schema.activityLog)
    .where(and(eq(schema.activityLog.entityType, "protocol"), eq(schema.activityLog.entityId, proto3.id)))
    .run();

  // Powtórka: nie ma już czego uzupełniać w tych polach
  const repeat = await call("POST", `/${proto3.id}/prefill`, { fields: ["clientName"] });
  ok(
    "powtórny zapis tego samego pola → brak zmian",
    repeat.status === 200 && (repeat.data as { applied: string[] }).applied.length === 0,
    repeat.data
  );

  // -------------------------------------------------------------------------
  // 7. Protokół podpisany / zatwierdzony → 400
  // -------------------------------------------------------------------------
  db.update(schema.protocols)
    .set({ status: "final", signedAt: new Date().toISOString(), signerName: "Test", signaturePng: "data:image/png;base64,AA" })
    .where(eq(schema.protocols.id, proto3.id))
    .run();
  const signedGet = await call("GET", `/${proto3.id}/prefill`);
  const signedPost = await call("POST", `/${proto3.id}/prefill`, { fields: ["clientCity"] });
  ok("podpisany protokół: GET → 400", signedGet.status === 400, signedGet);
  ok("podpisany protokół: POST → 400", signedPost.status === 400, signedPost);
  const untouched = db.select().from(schema.protocols).where(eq(schema.protocols.id, proto3.id)).get()!;
  ok("podpisany protokół nietknięty", untouched.clientCity === "", untouched.clientCity);

  db.update(schema.protocols)
    .set({ status: "final", signedAt: null, signerName: null, signaturePng: null })
    .where(eq(schema.protocols.id, proto3.id))
    .run();
  const finalPost = await call("POST", `/${proto3.id}/prefill`, { fields: ["clientCity"] });
  ok("zatwierdzony (final) protokół: POST → 400", finalPost.status === 400, finalPost);

  // 404 dla nieistniejącego protokołu
  const missing = await call("GET", "/999999/prefill");
  ok("nieistniejący protokół → 404", missing.status === 404, missing);

  // -------------------------------------------------------------------------
  // 8. Dane produkcyjne nietknięte
  // -------------------------------------------------------------------------
  const testProtocolIds = db
    .select({ id: schema.protocols.id })
    .from(schema.protocols)
    .where(inArray(schema.protocols.realizationId, [r1.id, r2.id, r3.id, r3b.id]))
    .all().length;
  const nowProtocols = db.select({ id: schema.protocols.id }).from(schema.protocols).all().length;
  const nowRealizations = db.select({ id: schema.realizations.id }).from(schema.realizations).all().length;
  ok(
    "liczba protokołów = produkcyjne + testowe",
    nowProtocols === prodProtocols + testProtocolIds,
    { prodProtocols, nowProtocols, testProtocolIds }
  );
  ok("liczba realizacji = produkcyjne + 4 testowe", nowRealizations === prodRealizations + 4, {
    prodRealizations,
    nowRealizations,
  });
  ok("realizacja #1 (produkcyjna) nadal istnieje", !!db.select().from(schema.realizations).where(eq(schema.realizations.id, 1)).get());
}

const fixtures = seed();
main(fixtures)
  .catch((e) => {
    failures++;
    console.error("FAIL (wyjątek):", e);
  })
  .finally(() => {
    const removed = cleanup();
    console.log(`\nSprzątanie: ${JSON.stringify(removed)}`);
    console.log(failures === 0 ? "\nWszystkie testy OK" : `\n${failures} testów nie przeszło`);
    process.exit(failures === 0 ? 0 : 1);
  });
