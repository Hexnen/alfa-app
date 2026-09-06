/**
 * Czyszczenie testowych śmieci i zasianie sensownej bazy demonstracyjnej:
 *   npx tsx scripts/seed-demo-data.ts            # suchy przebieg — pokazuje, co zrobi
 *   npx tsx scripts/seed-demo-data.ts --apply    # zapis
 *
 * Kasuje: kontrahentów, obiekty (i ich historię), zlecenia, wydarzenia kalendarza z notatkami
 * i przypisaniami, realizacje, protokoły, wyceny oraz wpisy activity_log tych encji.
 * NIE rusza: użytkowników, techników, cenników, magazynu, kadr, CMA (monitored_objects) ani
 * ustawień aplikacji.
 *
 * Zasiewa 5 kontrahentów, 9 obiektów i 5 wydarzeń kalendarza; dla dwóch wykonanych wydarzeń
 * tworzy realizację + protokół + wycenę tą samą ścieżką, co produkcja
 * (`ensureRealizationForEvent`), więc dane wyglądają dokładnie tak, jak z aplikacji.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../src/db/index.js";
import type { CalendarEvent, User } from "../src/db/schema.js";
import { ensureRealizationForEvent } from "../src/lib/calendar-realizations.js";

const apply = process.argv.includes("--apply");

const user = db.select().from(schema.users).limit(1).get() as User | undefined;
if (!user) {
  console.error("Brak użytkownika w bazie — przerywam.");
  process.exit(1);
}
const ctx = { user: { id: user.id, email: user.email, displayName: user.displayName } };

// ---------------------------------------------------------------------------
// 1. Co znika
// ---------------------------------------------------------------------------
const count = (t: keyof typeof schema, table: { id: unknown }) =>
  db.select({ id: (table as { id: never }).id }).from(table as never).all().length;

const before = {
  kontrahenci: count("contractors", schema.contractors),
  obiekty: count("objects", schema.objects),
  zlecenia: count("orders", schema.orders),
  wydarzenia: count("calendarEvents", schema.calendarEvents),
  realizacje: count("realizations", schema.realizations),
  protokoly: count("protocols", schema.protocols),
  wyceny: count("quotes", schema.quotes),
};
console.log("Do skasowania:", JSON.stringify(before));

if (!apply) {
  console.log("\nSuchy przebieg — nic nie zapisano. Uruchom z --apply.");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// 2. Czyszczenie (kolejność wg zależności; FK są włączone)
// ---------------------------------------------------------------------------
const LOG_ENTITIES = ["calendar_event", "protocol", "quote", "realization", "object", "contractor", "order"];

db.transaction((tx) => {
  tx.delete(schema.calendarEventNotes).run();
  tx.delete(schema.calendarEventAssignees).run();
  tx.delete(schema.calendarEvents).run();
  tx.delete(schema.calendarSeries).run();
  tx.delete(schema.quotes).run();
  tx.delete(schema.protocols).run();
  tx.delete(schema.realizations).run();
  tx.delete(schema.orders).run();
  tx.delete(schema.objectHistory).run();
  tx.delete(schema.objects).run();
  tx.delete(schema.contractors).run();
  tx.delete(schema.salespeople).run();
  tx.delete(schema.activityLog).where(inArray(schema.activityLog.entityType, LOG_ENTITIES)).run();
});

// ---------------------------------------------------------------------------
// 3. Kontrahenci i obiekty
// ---------------------------------------------------------------------------
interface ContractorSeed {
  key: string;
  name: string;
  nip: string;
  address: string;
  city: string;
  postalCode: string;
  phone: string;
  email: string;
  contactPerson: string;
  notes?: string;
  /** Klucz handlowca z SALESPEOPLE — opiekun tego klienta. */
  salesperson?: string;
}

const CONTRACTORS: ContractorSeed[] = [
  {
    key: "nowak",
    name: "Nowak Logistyka Sp. z o.o.",
    nip: "6751402280",
    address: "ul. Półłanki 112",
    city: "Kraków",
    postalCode: "30-740",
    phone: "12 345 67 80",
    email: "biuro@nowak-logistyka.example",
    contactPerson: "Tomasz Nowak",
    salesperson: "kowalczyk",
    notes: "Umowa monitoringu na dwa magazyny, faktura zbiorcza na koniec miesiąca.",
  },
  {
    key: "galeria",
    name: "Galeria Nowa Aleja Sp. z o.o.",
    nip: "5258713200",
    address: "al. Jerozolimskie 148",
    city: "Warszawa",
    postalCode: "02-326",
    phone: "22 118 40 12",
    email: "techniczny@nowa-aleja.example",
    contactPerson: "Agnieszka Wierzbicka",
    salesperson: "zielinski",
    notes: "Prace wyłącznie poza godzinami otwarcia galerii (po 22:00).",
  },
  {
    key: "vitromet",
    name: "Zakład Produkcyjny VITROMET Sp. z o.o.",
    nip: "6312674510",
    address: "ul. Przemysłowa 41",
    city: "Gliwice",
    postalCode: "44-100",
    phone: "32 776 12 05",
    email: "utrzymanie@vitromet.example",
    contactPerson: "Krzysztof Bąk",
    salesperson: "kowalczyk",
  },
  {
    key: "solaris",
    name: "PV Solaris Energia S.A.",
    nip: "6572981143",
    address: "ul. Zagnańska 84",
    city: "Kielce",
    postalCode: "25-528",
    phone: "41 202 88 30",
    email: "serwis@pvsolaris.example",
    contactPerson: "Marta Ziębicka",
    salesperson: "dabrowa",
    notes: "Farmy PV — dojazd liczony w obie strony, wjazd po uzgodnieniu z ochroną.",
  },
  {
    key: "wspolnota",
    name: "Wspólnota Mieszkaniowa Słoneczna 12",
    nip: "9541123078",
    address: "ul. Słoneczna 12",
    city: "Katowice",
    postalCode: "40-136",
    phone: "600 214 880",
    email: "zarzad@sloneczna12.example",
    contactPerson: "Janusz Malinowski",
    salesperson: "zielinski",
  },
];

interface ObjectSeed {
  key: string;
  contractor: string;
  name: string;
  address: string;
  city: string;
  type: "monitoring" | "physical" | "alarm" | "mixed";
  installationType: "new" | "takeover";
  status: "pending" | "in_progress" | "active" | "inactive";
  department: "sales" | "technical" | "accounting";
  monthlyValue?: number;
  latitude?: number;
  longitude?: number;
  notes?: string;
  /** Handlowiec obiektu; brak = dziedziczy opiekuna kontrahenta. */
  salesperson?: string;
  /** Nazwa spółki grupy ze słownika (ten sam, co w kadrach). */
  company?: string;
}

const OBJECTS: ObjectSeed[] = [
  {
    key: "magazyn-krakow",
    contractor: "nowak",
    company: "ALFA",
    name: "Magazyn Centralny Kraków-Płaszów",
    address: "ul. Półłanki 112",
    city: "Kraków",
    type: "monitoring",
    installationType: "new",
    status: "active",
    department: "technical",
    monthlyValue: 1450,
    latitude: 50.0261,
    longitude: 20.0231,
    notes: "24 kamery IP, rejestrator w serwerowni na parterze.",
  },
  {
    key: "terminal-skawina",
    contractor: "nowak",
    company: "ALFA",
    name: "Terminal przeładunkowy Skawina",
    address: "ul. Piłsudskiego 25",
    city: "Skawina",
    type: "monitoring",
    installationType: "new",
    status: "in_progress",
    department: "technical",
    monthlyValue: 890,
    latitude: 49.9756,
    longitude: 19.8261,
  },
  {
    key: "galeria-poziom",
    contractor: "galeria",
    company: "ALFA S",
    name: "Galeria Nowa Aleja — poziom -1",
    address: "al. Jerozolimskie 148",
    city: "Warszawa",
    type: "mixed",
    installationType: "takeover",
    status: "active",
    department: "technical",
    monthlyValue: 3200,
    latitude: 52.2246,
    longitude: 20.9871,
    salesperson: "dabrowa",
    notes: "Przejęte po poprzednim wykonawcy — dokumentacja niekompletna.",
  },
  {
    key: "galeria-parking",
    contractor: "galeria",
    company: "ALFA S",
    name: "Parking dozorowany Nowa Aleja",
    address: "al. Jerozolimskie 148",
    city: "Warszawa",
    type: "monitoring",
    installationType: "takeover",
    status: "active",
    department: "technical",
    monthlyValue: 1100,
    latitude: 52.2242,
    longitude: 20.9865,
  },
  {
    key: "hala-2",
    contractor: "vitromet",
    company: "ALFA",
    name: "Hala produkcyjna nr 2",
    address: "ul. Przemysłowa 41",
    city: "Gliwice",
    type: "monitoring",
    installationType: "new",
    status: "in_progress",
    department: "technical",
    monthlyValue: 0,
    latitude: 50.2949,
    longitude: 18.6714,
    notes: "Montaż 12 kamer + rozbudowa okablowania; hala pracuje na trzy zmiany.",
  },
  {
    key: "portiernia",
    contractor: "vitromet",
    company: "ALFA",
    name: "Portiernia i brama główna",
    address: "ul. Przemysłowa 41",
    city: "Gliwice",
    type: "alarm",
    installationType: "takeover",
    status: "active",
    department: "technical",
    monthlyValue: 420,
    latitude: 50.2951,
    longitude: 18.6702,
  },
  {
    key: "pv-chmielnik",
    contractor: "solaris",
    company: "CONTROL",
    name: "Farma PV Chmielnik 2 MW",
    address: "Chmielnik, dz. 214/3",
    city: "Chmielnik",
    type: "monitoring",
    installationType: "new",
    status: "active",
    department: "technical",
    monthlyValue: 1600,
    latitude: 50.6103,
    longitude: 20.7211,
    notes: "Kamery na słupach perymetru, zasilanie z kontenera stacji.",
  },
  {
    key: "pv-busko",
    contractor: "solaris",
    company: "CONTROL",
    name: "Farma PV Busko 1,2 MW",
    address: "Busko-Zdrój, dz. 87/1",
    city: "Busko-Zdrój",
    type: "monitoring",
    installationType: "new",
    status: "pending",
    department: "sales",
    latitude: 50.4672,
    longitude: 20.7183,
    notes: "Oferta wysłana, czeka na decyzję inwestora.",
  },
  {
    key: "sloneczna",
    contractor: "wspolnota",
    company: "ALFA",
    name: "Osiedle Słoneczna 12 — klatki A-D",
    address: "ul. Słoneczna 12",
    city: "Katowice",
    type: "monitoring",
    installationType: "takeover",
    status: "active",
    department: "technical",
    monthlyValue: 380,
    latitude: 50.2603,
    longitude: 19.0212,
  },
];

// --- handlowcy (opiekunowie klientów) ---
const SALESPEOPLE = [
  { key: "kowalczyk", firstName: "Anna", lastName: "Kowalczyk", phone: "600 101 201", email: "a.kowalczyk@alfa.example", region: "Małopolska i Śląsk" },
  { key: "zielinski", firstName: "Paweł", lastName: "Zieliński", phone: "600 101 202", email: "p.zielinski@alfa.example", region: "Mazowsze" },
  { key: "dabrowa", firstName: "Marek", lastName: "Dąbrowa", phone: "600 101 203", email: "m.dabrowa@alfa.example", region: "Klienci sieciowi i OZE" },
];

const salespeopleIds = new Map<string, number>();
for (const sp of SALESPEOPLE) {
  const row = db
    .insert(schema.salespeople)
    .values({
      firstName: sp.firstName,
      lastName: sp.lastName,
      phone: sp.phone,
      email: sp.email,
      region: sp.region,
    })
    .returning()
    .get();
  salespeopleIds.set(sp.key, row.id);
}

const contractorIds = new Map<string, number>();
for (const c of CONTRACTORS) {
  const row = db
    .insert(schema.contractors)
    .values({
      name: c.name,
      nip: c.nip,
      address: c.address,
      city: c.city,
      postalCode: c.postalCode,
      phone: c.phone,
      email: c.email,
      contactPerson: c.contactPerson,
      notes: c.notes ?? null,
      salespersonId: c.salesperson ? (salespeopleIds.get(c.salesperson) ?? null) : null,
    })
    .returning()
    .get();
  contractorIds.set(c.key, row.id);
}

/**
 * Spółek NIE czyścimy ani nie tworzymy — to słownik wspólny z kadrami
 * (scripts/seed-companies-from-hr.ts). Tu tylko dowiązujemy obiekty po nazwie.
 */
const companyIdByName = new Map<string, number>(
  db
    .select({ id: schema.companies.id, name: schema.companies.name })
    .from(schema.companies)
    .all()
    .map((c) => [c.name.toLowerCase(), c.id])
);

const objectIds = new Map<string, number>();
for (const o of OBJECTS) {
  const row = db
    .insert(schema.objects)
    .values({
      contractorId: contractorIds.get(o.contractor)!,
      name: o.name,
      address: o.address,
      city: o.city,
      type: o.type,
      installationType: o.installationType,
      status: o.status,
      department: o.department,
      monthlyValue: o.monthlyValue ?? null,
      latitude: o.latitude ?? null,
      longitude: o.longitude ?? null,
      notes: o.notes ?? null,
      salespersonId: o.salesperson ? (salespeopleIds.get(o.salesperson) ?? null) : null,
      companyId: o.company ? (companyIdByName.get(o.company.toLowerCase()) ?? null) : null,
    })
    .returning()
    .get();
  objectIds.set(o.key, row.id);
}

// ---------------------------------------------------------------------------
// 4. Kalendarz — dwa wydarzenia wykonane (z dokumentami) i trzy zaplanowane
// ---------------------------------------------------------------------------
const technicians = db
  .select()
  .from(schema.technicians)
  .where(eq(schema.technicians.active, true))
  .all();
const techId = (i: number) => technicians[i % technicians.length]?.id;

interface EventSeed {
  key: string;
  type: "serwis" | "montaz" | "wizja" | "konserwacja";
  title: string;
  description?: string;
  startAt: string;
  endAt: string;
  allDay?: boolean;
  status: "planned" | "confirmed" | "done";
  billing: "paid" | "warranty" | "free";
  object: string;
  technicians: number[];
  /** true = utwórz realizację + protokół (+ wycenę dla płatnych). */
  documents?: boolean;
}

const EVENTS: EventSeed[] = [
  {
    key: "montaz-hala",
    type: "montaz",
    title: "Montaż 12 kamer — hala nr 2",
    description: "Kamery kopułowe w nawie A i B, trasa kablowa nad suwnicą, konfiguracja rejestratora.",
    startAt: "2026-08-24T07:00",
    endAt: "2026-08-24T15:00",
    status: "done",
    billing: "paid",
    object: "hala-2",
    technicians: [0, 1],
    documents: true,
  },
  {
    key: "serwis-magazyn",
    type: "serwis",
    title: "Serwis gwarancyjny — wymiana kamery przy rampie",
    description: "Kamera nr 7 bez obrazu po burzy; wymiana w ramach gwarancji.",
    startAt: "2026-08-26T09:00",
    endAt: "2026-08-26T12:30",
    status: "done",
    billing: "warranty",
    object: "magazyn-krakow",
    technicians: [2],
    documents: true,
  },
  {
    key: "konserwacja-pv",
    type: "konserwacja",
    title: "Przegląd okresowy monitoringu farmy PV",
    description: "Czyszczenie kloszy, kontrola słupów i zasilania, test nagrań.",
    startAt: "2026-09-02",
    endAt: "2026-09-04",
    allDay: true,
    status: "confirmed",
    billing: "paid",
    object: "pv-chmielnik",
    technicians: [0, 2],
  },
  {
    key: "serwis-galeria",
    type: "serwis",
    title: "Serwis nocny — rejestrator poziom -1",
    description: "Wymiana dysku w rejestratorze, prace po 22:00.",
    startAt: "2026-09-03T22:00",
    endAt: "2026-09-04T02:00",
    status: "planned",
    billing: "paid",
    object: "galeria-poziom",
    technicians: [1],
  },
  {
    key: "wizja-busko",
    type: "wizja",
    title: "Wizja lokalna — farma PV Busko",
    description: "Pomiary tras kablowych i punktów montażowych do oferty.",
    startAt: "2026-09-07T10:00",
    endAt: "2026-09-07T13:00",
    status: "planned",
    billing: "free",
    object: "pv-busko",
    technicians: [0],
  },
];

const created: string[] = [];
for (const e of EVENTS) {
  const ev = db
    .insert(schema.calendarEvents)
    .values({
      type: e.type,
      title: e.title,
      description: e.description ?? null,
      startAt: e.startAt,
      endAt: e.endAt,
      allDay: e.allDay ?? false,
      status: e.status,
      billing: e.billing,
      department: "technical",
      objectId: objectIds.get(e.object)!,
      createdBy: user.id,
      updatedBy: user.id,
    })
    .returning()
    .get();
  for (const idx of e.technicians) {
    const id = techId(idx);
    if (id != null) db.insert(schema.calendarEventAssignees).values({ eventId: ev.id, technicianId: id }).run();
  }
  if (!e.documents) {
    created.push(`${e.title} — wydarzenie (${e.status})`);
    continue;
  }
  const res = db.transaction((tx) => ensureRealizationForEvent(tx, ev as CalendarEvent, ctx, { force: true }));
  created.push(
    res.created
      ? `${e.title} — realizacja #${res.realizationId}` +
        (res.protocolNumber ? `, protokół ${res.protocolNumber}` : "") +
        (res.quoteNumber ? `, wycena ${res.quoteNumber}` : "")
      : `${e.title} — bez dokumentów (${res.reason})`
  );
}

// ---------------------------------------------------------------------------
// 5. Protokół montażu wypełniony jak po robocie (gotowy do podpisu)
// ---------------------------------------------------------------------------
const montazEvent = db
  .select()
  .from(schema.calendarEvents)
  .where(eq(schema.calendarEvents.title, EVENTS[0].title))
  .get();
if (montazEvent?.realizationId != null) {
  const protocol = db
    .select()
    .from(schema.protocols)
    .where(eq(schema.protocols.realizationId, montazEvent.realizationId))
    .get();
  if (protocol) {
    db.update(schema.protocols)
      .set({
        actualKm: 172,
        activities: "Montaż 12 kamer kopułowych, ułożenie tras kablowych, konfiguracja rejestratora i zdalnego podglądu.",
        items: JSON.stringify([
          { name: "KABEL UTP KAT 5E.", serial: "", unit: "MB", qty: "320" },
          { name: "KABEL ZASILAJĄCY", serial: "", unit: "MB", qty: "60" },
          { name: "PESZEL: RURA KARBOWANA", serial: "", unit: "MB", qty: "45" },
        ]),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.protocols.id, protocol.id))
      .run();
    db.update(schema.realizations)
      .set({ actualKm: 172, updatedAt: new Date().toISOString() })
      .where(eq(schema.realizations.id, montazEvent.realizationId))
      .run();
    created.push(`protokół ${protocol.number} wypełniony materiałami i km (do podpisu)`);
  }
}

console.log("\nZasiano:");
console.log(`  handlowcy: ${SALESPEOPLE.length}, kontrahenci: ${CONTRACTORS.length}, obiekty: ${OBJECTS.length}, wydarzenia: ${EVENTS.length}`);
for (const line of created) console.log(`  - ${line}`);
