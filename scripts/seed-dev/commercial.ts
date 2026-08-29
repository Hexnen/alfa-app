/**
 * Handlowy fundament danych deweloperskich: handlowcy → kontrahenci → obiekty →
 * umowy → zlecenia. To pierwszy moduł seeda i najważniejszy, bo wszystko inne
 * (kalendarz, realizacje, magazyn) wiesza się na obiektach, które tu powstają.
 *
 * Trzy zasady z `shared.ts` obowiązują bez wyjątku: losowość idzie wyłącznie
 * przez `rng()`, każdy wiersz niesie MARKER w polu tekstowym, daty siedzą w PERIOD.
 * Wyjątek od trzeciej zasady jest jeden i świadomy — daty umów, patrz sekcja UMOWY.
 *
 * Moduł DOKŁADA do istniejącej bazy (3 handlowców, 5 kontrahentów, 9 obiektów,
 * 30 spółek) i niczego z niej nie kasuje ani nie przepisuje — z jedynym wyjątkiem
 * kosztów trzech pierwotnych handlowców, opisanym przy `updateLegacySalespeople`.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import {
  MARKER,
  type Tx,
  assertNotSeeded,
  dropRegistry,
  readRegistry,
  runInTx,
  writeRegistry,
  PERIOD,
  TODAY,
  addDays,
  addMonths,
  address,
  chance,
  companyName,
  dateBetween,
  email,
  int,
  isSeeded,
  mark,
  money,
  nip,
  personName,
  phone,
  pick,
  rng,
  seed,
  weighted,
  CITIES,
  SITE_KIND,
  STREETS,
} from "./shared.js";

/**
 * Rejestr zmian, które seed wprowadził w CUDZYCH wierszach — patrz
 * `updateLegacySalespeople()`. Bez niego reset nie odróżnia kosztu wpisanego
 * przez seed od kosztu wpisanego przez człowieka.
 */
const REGISTRY_KEY = "dev.seed.commercial";

/** Co seed ustawił handlowcom sprzed seeda: [id, koszt|null, prowizja|null]. */
interface CommercialRegistry {
  legacySalespeople: Array<[number, number | null, number | null]>;
}

const EMPTY_REGISTRY: CommercialRegistry = { legacySalespeople: [] };

/**
 * Ziarno modułu. Seedujemy TUTAJ, a nie licząc na orkiestrator, żeby
 * `seedCommercial()` dawało ten sam wynik niezależnie od tego, co uruchomiło się
 * przed nim — inaczej dołożenie kolejnego modułu przesuwałoby cały strumień
 * losowości i baza zmieniałaby się „sama".
 */
const SEED = 20260829;

/* ------------------------------------------------------------------ */
/* Pomocnicze                                                          */
/* ------------------------------------------------------------------ */

/** Deterministyczne tasowanie (Fisher–Yates na `rng()`). */
function shuffle<T>(arr: readonly T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** Timestamp bazy ("YYYY-MM-DD HH:MM:SS") z godziną w porze pracy. */
const stamp = (iso: string): string =>
  `${iso} ${pad2(int(7, 17))}:${pad2(int(0, 59))}:${pad2(int(0, 59))}`;

/** Dzieli listę na paczki — jeden INSERT na paczkę zamiast jednego na wiersz. */
function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

/**
 * Współrzędne miast ze słownika `CITIES` (WGS84, centrum miejscowości). Obiekt
 * dostaje je z drobnym rozrzutem, żeby pinezki na mapie nie leżały jedna na
 * drugiej, ale nadal wpadały w to miasto, które ma wpisane w adresie — mapa
 * realizacji i liczenie dystansu biuro → obiekt korzystają z tych samych liczb.
 */
const CITY_COORDS: Record<string, readonly [number, number]> = {
  "Kraków": [50.0614, 19.9366],
  "Warszawa": [52.2297, 21.0122],
  "Katowice": [50.2649, 19.0238],
  "Gliwice": [50.2945, 18.6714],
  "Kielce": [50.8661, 20.6286],
  "Tarnów": [50.0121, 20.9858],
  "Rzeszów": [50.0412, 21.9991],
  "Częstochowa": [50.8118, 19.1203],
  "Radom": [51.4027, 21.1471],
  "Skawina": [49.9756, 19.8261],
  "Nowy Sącz": [49.6218, 20.6971],
  "Bochnia": [49.9690, 20.4300],
  "Olkusz": [50.2807, 19.5651],
  "Chrzanów": [50.1358, 19.4014],
  "Busko-Zdrój": [50.4672, 20.7183],
  "Sosnowiec": [50.2863, 19.1040],
  "Bytom": [50.3483, 18.9157],
  "Zabrze": [50.3249, 18.7857],
  "Mielec": [50.2872, 21.4237],
  "Dębica": [50.0516, 21.4111],
  "Wieliczka": [49.9871, 20.0649],
  "Oświęcim": [50.0344, 19.2098],
  "Myślenice": [49.8339, 19.9386],
  "Piaseczno": [52.0810, 21.0245],
};

/** Losowy punkt w promieniu ~0,1° od centrum miasta. */
function coordsFor(city: string): { latitude: number; longitude: number } {
  const base = CITY_COORDS[city] ?? [50.0614, 19.9366];
  return {
    latitude: Math.round((base[0] + (rng() - 0.5) * 0.2) * 10000) / 10000,
    longitude: Math.round((base[1] + (rng() - 0.5) * 0.2) * 10000) / 10000,
  };
}

/** Przycina datę do okna PERIOD — nic nie ma prawa z niego wystać. */
const clampToPeriod = (iso: string): string =>
  iso < PERIOD.from ? PERIOD.from : iso > PERIOD.to ? PERIOD.to : iso;

const postalCode = () => `${pad2(int(20, 44))}-${String(int(100, 999))}`;

/**
 * Kolejne NIP-y z puli 999… — `contractors.nip` ma UNIQUE, a `nip(n)` z shared
 * potrafi przy niedozwolonej cyfrze kontrolnej (10) zwrócić numer wyliczony dla
 * `n+1`, czyli ten sam, co następny kontrahent. Alokator pilnuje unikalności,
 * a że nie sięga po `rng()`, nie rusza strumienia losowości.
 */
function nipAllocator(start: number): () => string {
  const used = new Set<string>();
  let n = start;
  return () => {
    for (;;) {
      const value = nip(n);
      n += 1;
      if (!used.has(value)) {
        used.add(value);
        return value;
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Wynik                                                               */
/* ------------------------------------------------------------------ */

export interface CommercialCounts {
  salespeople: number;
  /** Handlowcy sprzed seeda, którym uzupełniono koszt i prowizję. */
  salespeopleUpdated: number;
  contractors: number;
  objects: number;
  contracts: number;
  orders: number;
  history: number;
}

/* ------------------------------------------------------------------ */
/* 1. HANDLOWCY                                                        */
/* ------------------------------------------------------------------ */

/** Obszary działania — województwa i „klucze" klientów, jak w prawdziwym podziale. */
const REGIONS = [
  "małopolskie — południe",
  "śląskie — aglomeracja",
  "mazowieckie",
  "podkarpackie",
  "świętokrzyskie",
  "klienci sieciowi (cała Polska)",
] as const;

/**
 * Sześciu nowych handlowców. Dwaj archiwalni, bo lista handlowców ma zakładkę
 * „Aktualni / Archiwum" i pusta zakładka niczego nie testuje. Prowizja u części
 * jest NULL-em celowo: nie każdy handlowiec ją ma, a Analityka musi umieć pokazać
 * kreskę zamiast zera — zero prowizji i brak prowizji to dwie różne informacje.
 */
function insertSalespeople(tx: Tx): number[] {
  const rows: (typeof schema.salespeople.$inferInsert)[] = [];
  const active = [true, true, true, true, false, false];

  for (let i = 0; i < 6; i++) {
    const person = personName();
    const [first, last] = person.split(" ");
    const created = stamp(dateBetween(PERIOD.from, addMonths(PERIOD.from, 3)));
    rows.push({
      firstName: first,
      lastName: last,
      phone: phone(),
      email: email(person, "alfa.example"),
      region: REGIONS[i],
      // Koszt własny handlowca (pensja + auto + telefon) — z niego Analityka liczy
      // rentowność portfela, więc musi być wypełniony u każdego.
      monthlyCost: money(2500, 6500, 50),
      // ~60% ma prowizję; reszta pracuje na samej podstawie.
      commissionRate: chance(0.6) ? Math.round(((rng() * 6 + 2) * 10)) / 10 : null,
      notes: mark("Handlowiec z generatora danych deweloperskich."),
      active: active[i],
      createdAt: created,
      updatedAt: created,
    });
  }

  const ids: number[] = [];
  for (const batch of chunks(rows, 20)) {
    ids.push(
      ...tx.insert(schema.salespeople).values(batch).returning({ id: schema.salespeople.id }).all().map((r) => r.id),
    );
  }
  return ids;
}

/**
 * Handlowcom sprzed seeda (bez znacznika) UZUPEŁNIAMY koszt i prowizję — tylko
 * tam, gdzie pole jest puste, i tylko po to, żeby Analityka miała co liczyć.
 *
 * UWAGA — to JEDYNA zmiana seeda w danych sprzed jego uruchomienia i jedyne
 * miejsce, w którym można stracić czyjąś pracę. Dlatego dwa zabezpieczenia:
 *
 *   1. WARUNEK `is null` W SAMYM UPDATE. Kiedyś seed pisał bezwarunkowo, więc
 *      ręcznie wpisany koszt 7777 zł ginął już przy GENEROWANIU, zanim ktokolwiek
 *      pomyślał o resecie. Teraz UPDATE nie ma prawa nadpisać wartości, która tam
 *      jest. Koszt i prowizja idą osobnymi zapytaniami, bo są niezależne:
 *      ktoś mógł wpisać samą prowizję i zostawić koszt pusty.
 *
 *   2. REJESTR. Zapisujemy, co dokładnie ustawiliśmy — reset cofa do NULL
 *      WYŁĄCZNIE te wartości i tylko wtedy, gdy nikt ich w międzyczasie nie
 *      zmienił. Wcześniej reset celował w wiersze „bo nie mają znacznika"
 *      i zerował koszt każdemu prawdziwemu handlowcowi.
 */
function updateLegacySalespeople(
  tx: Tx,
  seededIds: readonly number[],
): { count: number; registry: CommercialRegistry["legacySalespeople"] } {
  const legacy = tx
    .select({
      id: schema.salespeople.id,
      notes: schema.salespeople.notes,
      monthlyCost: schema.salespeople.monthlyCost,
      commissionRate: schema.salespeople.commissionRate,
    })
    .from(schema.salespeople)
    .all()
    .filter((r) => !seededIds.includes(r.id) && !isSeeded(r.notes));

  const registry: CommercialRegistry["legacySalespeople"] = [];
  let count = 0;

  for (const row of legacy) {
    // Losujemy ZAWSZE, także gdy nie będziemy zapisywać — strumień `rng()` jest
    // wspólny dla całego seeda i pominięcie losowania przesunęłoby wszystko dalej.
    const cost = money(3200, 6800, 50);
    const rate = chance(0.7) ? Math.round((rng() * 6 + 2) * 10) / 10 : null;

    const setCost =
      row.monthlyCost === null
        ? tx
            .update(schema.salespeople)
            .set({ monthlyCost: cost })
            .where(and(eq(schema.salespeople.id, row.id), isNull(schema.salespeople.monthlyCost)))
            .run().changes
        : 0;

    // Prowizja NULL bywa świadomą decyzją („ten handlowiec jej nie ma"), więc
    // nie ma tu czego uzupełniać, gdy wylosowało się `null` — zapisujemy tylko
    // wartość, i tylko na puste pole.
    const setRate =
      row.commissionRate === null && rate !== null
        ? tx
            .update(schema.salespeople)
            .set({ commissionRate: rate })
            .where(
              and(eq(schema.salespeople.id, row.id), isNull(schema.salespeople.commissionRate)),
            )
            .run().changes
        : 0;

    if (setCost || setRate) {
      count += 1;
      registry.push([row.id, setCost ? cost : null, setRate ? rate : null]);
    }
  }

  return { count, registry };
}

/* ------------------------------------------------------------------ */
/* 2. KONTRAHENCI                                                      */
/* ------------------------------------------------------------------ */

const NEW_CONTRACTORS = 35;

/**
 * Rozdział kontrahentów między handlowców. Rozkład jest CELOWO nierówny:
 *  - jeden handlowiec dostaje ~40% portfela, bo wykres koncentracji („ilu klientów
 *    wisi na jednej osobie") na równym rozkładzie pokazuje płaską kreskę i nie da
 *    się na nim zobaczyć, czy w ogóle działa,
 *  - trzech kontrahentów zostaje BEZ opiekuna, żeby kubełek „Bez handlowca"
 *    w Analityce nie był pusty — to realny stan po imporcie z arkusza.
 */
function planSalespersonAssignment(salespeople: readonly number[]): (number | null)[] {
  const dominant = salespeople[0];
  const rest = salespeople.slice(1);
  const plan: (number | null)[] = [];

  for (let i = 0; i < 14; i++) plan.push(dominant);
  for (let i = 0; i < 3; i++) plan.push(null);

  // Ogon: 18 kontrahentów na pozostałych handlowców, malejącymi porcjami.
  const tail = [4, 3, 3, 2, 2, 2, 1, 1];
  for (let i = 0; i < tail.length && i < rest.length; i++) {
    for (let k = 0; k < tail[i]; k++) plan.push(rest[i]);
  }
  while (plan.length < NEW_CONTRACTORS) plan.push(rest[plan.length % rest.length]);

  return shuffle(plan.slice(0, NEW_CONTRACTORS));
}

function insertContractors(tx: Tx, salespeople: readonly number[]): number[] {
  const assignment = planSalespersonAssignment(salespeople);
  // Czterech archiwalnych — tyle, żeby zakładka „Archiwum" miała treść, ale nie
  // przesłaniała bieżącego portfela.
  const archived = new Set(shuffle([...Array(NEW_CONTRACTORS).keys()]).slice(0, 4));

  const nextNip = nipAllocator(1000);
  const rows: (typeof schema.contractors.$inferInsert)[] = [];
  for (let i = 0; i < NEW_CONTRACTORS; i++) {
    const [city] = pick(CITIES);
    const contact = personName();
    const created = stamp(dateBetween(PERIOD.from, addMonths(PERIOD.from, 6)));
    rows.push({
      name: companyName(),
      // Prefiks 999 + poprawna cyfra kontrolna — walidator NIP-u w formularzu
      // kontrahenta odrzuciłby losowe dziesięć cyfr.
      nip: nextNip(),
      address: address(),
      city,
      postalCode: postalCode(),
      phone: phone(),
      email: email(contact, "firma.invalid"),
      contactPerson: contact,
      notes: mark("Kontrahent z generatora danych deweloperskich."),
      regon: String(100000000 + int(0, 899999999)),
      // KRS ma tylko część firm — spółki cywilne i JDG go nie mają.
      krs: chance(0.55) ? String(100000000 + int(0, 799999999)) : null,
      vatStatus: "Czynny",
      vatCheckedAt: dateBetween(addMonths(TODAY, -6), TODAY),
      active: !archived.has(i),
      salespersonId: assignment[i],
      createdAt: created,
      updatedAt: created,
    });
  }

  const ids: number[] = [];
  for (const batch of chunks(rows, 40)) {
    ids.push(
      ...tx.insert(schema.contractors).values(batch).returning({ id: schema.contractors.id }).all().map((r) => r.id),
    );
  }
  return ids;
}

/* ------------------------------------------------------------------ */
/* 3. OBIEKTY                                                          */
/* ------------------------------------------------------------------ */

const NEW_OBJECTS = 111;
/** Ile obiektów zostaje bez wpisanego kosztu (~15%). */
const OBJECTS_WITHOUT_COST = 17;
/** Ile obiektów jest realnie stratnych (koszt > abonament). */
const OBJECTS_UNPROFITABLE = 8;
/** Ile obiektów ma własnego handlowca, innego niż opiekun kontrahenta (~15%). */
const OBJECTS_OWN_SALESPERSON = 17;

const OBJECT_SUFFIX = [
  "hala A", "hala B", "sektor 1", "sektor 2", "brama II", "etap I",
  "budynek C", "plac składowy", "strefa chłodni",
] as const;

interface PlannedObject {
  row: typeof schema.objects.$inferInsert;
  createdAt: string;
}

/**
 * Liczba obiektów na kontrahenta. Portfel firmy ochroniarskiej NIE jest płaski:
 * kilku dużych klientów sieciowych ma po kilkanaście lokalizacji, a długi ogon —
 * po jednej. Rankingi „top kontrahentów" i udział TOP-5 w przychodzie na równym
 * rozkładzie nie pokazują niczego, więc rozkład dobieramy skośnie z premedytacją.
 */
function planObjectsPerContractor(contractors: readonly number[]): Map<number, number> {
  const order = shuffle(contractors);
  const plan = new Map<number, number>();
  let assigned = 0;

  // Pięciu dużych klientów: 10, 9, 8, 7, 6 obiektów.
  const big = [10, 9, 8, 7, 6];
  big.forEach((n, i) => {
    plan.set(order[i], n);
    assigned += n;
  });

  // Środek stawki: dwunastu po trzy lokalizacje.
  for (let i = 0; i < 12; i++) {
    plan.set(order[big.length + i], 3);
    assigned += 3;
  }

  // Ogon: po 1–2, aż wypełnimy pulę; kolejni kontrahenci zostają bez nowych obiektów.
  let i = big.length + 12;
  while (assigned < NEW_OBJECTS && i < order.length) {
    const left = NEW_OBJECTS - assigned;
    const n = Math.min(left, left > order.length - i ? 2 : 1);
    plan.set(order[i], n);
    assigned += n;
    i++;
  }
  // Gdyby kontrahenci się skończyli — resztę dokłada największy klient.
  if (assigned < NEW_OBJECTS) plan.set(order[0], (plan.get(order[0]) ?? 0) + (NEW_OBJECTS - assigned));

  return plan;
}

/**
 * Abonament. `rng()` podniesiony do CZWARTEJ potęgi ściska rozkład ku dołowi:
 * mediana ok. 650 zł, połowa portfela poniżej tysiąca, a powyżej 3000 zł zostaje
 * jedna piąta obiektów. Rozkład równomierny dałby sztucznie „bogaty" portfel,
 * w którym ranking TOP-10 kontrahentów i histogram wartości wyglądają tak samo
 * dla każdego cięcia danych — czyli nie testują niczego.
 */
/**
 * Losowy zestaw usług w proporcjach dawnego pola `type`: przewaga samego dozoru
 * wizyjnego, sporo alarmów, garść obiektów mieszanych i najmniej ochrony fizycznej.
 * Zwraca też `type`, bo kolumna jest jeszcze NOT NULL — znika w osobnej migracji.
 */
function serviceMix(): {
  hasCameras: boolean;
  hasSswin: boolean;
  hasOfi: boolean;
  hasVideoreception: boolean;
  type: "monitoring" | "mixed" | "alarm" | "physical";
} {
  const kind = weighted([
    ["monitoring", 50],
    ["mixed", 20],
    ["alarm", 20],
    ["physical", 10],
  ] as const);
  return {
    hasCameras: kind === "monitoring" || kind === "mixed",
    hasSswin: kind === "alarm" || kind === "mixed",
    hasOfi: kind === "physical",
    // Wideorecepcję dokłada moduł `services` — wybiera ją liczbą, nie losem.
    hasVideoreception: false,
    type: kind,
  };
}

function monthlyValueSkewed(): number {
  // Skala dobrana pod PRAWDZIWĄ listę płac w tej bazie (ok. 536 tys. zł netto
  // miesięcznie, po narzucie składek ~860 tys.). Przy pierwotnym zakresie
  // 150–8 000 zł łączny przychód wychodził 165 tys. i marża spadała do −43%:
  // nie dlatego, że coś liczy się źle, tylko dlatego, że syntetyczny przychód
  // zestawiony z realnymi wynagrodzeniami nie mógł się spiąć. Rozkład zostaje
  // skośny (dużo małych obiektów, długi ogon) — rośnie tylko skala.
  const v = 400 + Math.pow(rng(), 4) * 24600;
  return Math.round(v / 10) * 10;
}

function insertObjects(
  tx: Tx,
  contractors: readonly number[],
  salespeople: readonly number[],
  companyIds: readonly number[],
): { ids: number[]; planned: PlannedObject[]; contractorOf: Map<number, number> } {
  const perContractor = planObjectsPerContractor(contractors);

  // Statusy rozdajemy z góry ustaloną pulą, a nie losowaniem per wiersz: chcemy
  // DOKŁADNIE 8 archiwalnych (zakładka „Archiwum" listy obiektów) i przewidywalną
  // liczbę obiektów w toku, żeby dało się je policzyć w teście.
  const statusPool: Array<"active" | "pending" | "in_progress" | "inactive"> = [
    ...Array<"inactive">(8).fill("inactive"),
    ...Array<"pending">(11).fill("pending"),
    ...Array<"in_progress">(11).fill("in_progress"),
    ...Array<"active">(NEW_OBJECTS - 30).fill("active"),
  ];
  const statuses = shuffle(statusPool);

  // Kto ma własnego handlowca — dokładnie ~15%. Reszta dziedziczy po kontrahencie
  // i to jest właściwy test reguły „efektywnego handlowca" (COALESCE obiekt→kontrahent).
  const ownSalesperson = new Set(shuffle([...Array(NEW_OBJECTS).keys()]).slice(0, OBJECTS_OWN_SALESPERSON));

  const planned: PlannedObject[] = [];
  let idx = 0;

  for (const contractorId of contractors) {
    const count = perContractor.get(contractorId) ?? 0;
    for (let k = 0; k < count; k++) {
      const [city] = pick(CITIES);
      const kind = pick(SITE_KIND);
      const status = statuses[idx];
      const created = dateBetween(PERIOD.from, addDays(TODAY, -14));

      // Obiekt „pending" bywa jeszcze bez abonamentu — oferta wisi u klienta.
      // To karmi kubełek „bez przychodu" w Analityce.
      const monthlyValue = status === "pending" && chance(0.35) ? null : monthlyValueSkewed();

      planned.push({
        createdAt: created,
        row: {
          contractorId,
          name: chance(0.35) ? `${kind} ${city} — ${pick(OBJECT_SUFFIX)}` : `${kind} ${city}`,
          address: address(),
          city,
          // USŁUGI — od nich zależy, którą drogą liczy się koszt osobowy:
          // OFI bierze godziny pracowników TEGO obiektu, a kamery/SSWiN/
          // wideorecepcja udział w puli centrum monitorowania. Rozkład jak
          // w dawnym polu `type`, tylko rozbity na niezależne flagi; ilość kamer
          // uzupełnia moduł `services` (rozkładem z prawdziwego rejestru CMA).
          ...serviceMix(),
          // @deprecated — kolumna jest jeszcze NOT NULL, więc trzymamy ją spójną
          // z usługami, dopóki nie zniknie ze schematu.
          installationType: chance(0.7) ? "new" : "takeover",
          status,
          department:
            status === "pending"
              ? "sales"
              : status === "in_progress"
                ? weighted([["technical", 7], ["sales", 3]] as const)
                : weighted([["technical", 6], ["accounting", 3], ["sales", 1]] as const),
          monthlyValue,
          // Koszty dosypujemy niżej, na całej puli naraz — inaczej nie da się
          // utrzymać dokładnych proporcji „bez kosztu" i „stratnych".
          monthlyCost: null,
          setupCost: null,
          notes: mark(`${kind} — obiekt z generatora danych deweloperskich.`),
          ...coordsFor(city),
          companyId: pick(companyIds),
          salespersonId: ownSalesperson.has(idx) ? pick(salespeople) : null,
          createdAt: stamp(created),
          updatedAt: stamp(created),
        },
      });
      idx++;
    }
  }

  assignEconomics(planned);

  const ids: number[] = [];
  for (const batch of chunks(planned.map((p) => p.row), 30)) {
    ids.push(
      ...tx.insert(schema.objects).values(batch).returning({ id: schema.objects.id }).all().map((r) => r.id),
    );
  }

  const contractorOf = new Map<number, number>();
  ids.forEach((id, i) => contractorOf.set(id, planned[i].row.contractorId));

  return { ids, planned, contractorOf };
}

/**
 * Ekonomia obiektów — sedno całego seeda, bo to na niej stoi moduł Analityki.
 *
 * Dobór proporcji nie jest przypadkowy:
 *  - ~15% obiektów BEZ kosztu, bo NULL to nie zero. Analityka liczy „pokrycie
 *    danymi kosztowymi" i odmawia policzenia marży wiersza, w którym nie zna ani
 *    jednego kosztu; przy 100% wypełnieniu ta cała gałąź kodu jest martwa i nikt
 *    nie zobaczy, że kreska zamiast „100% marży" w ogóle działa,
 *  - 8 obiektów stratnych (koszt > abonament), bo bez nich nie ma czerwonych
 *    słupków, kubełka marży „<0%", licznika „nierentowne" ani lewego dolnego
 *    kwadrantu na wykresie punktowym. Osiem to mniej niż 10% portfela — realny
 *    rząd wielkości dla umów przejętych po innym wykonawcy,
 *  - koszt pozostałych to 35–95% abonamentu, czyli marża 5–65%: rozpiętość, na
 *    której widać różnicę między klientem dobrym a ledwie wychodzącym na zero.
 *
 * Nakład wdrożeniowy (`setupCost`) dobieramy WSTECZ od zwrotu: losujemy pasmo
 * (≤12 / 13–24 / >24 miesięcy) i mnożymy przez zysk. Losowanie kwoty wprost dałoby
 * zwroty skupione w jednym paśmie, a histogram payback ma pokazywać trzy.
 */
function assignEconomics(planned: PlannedObject[]): void {
  const all = [...Array(planned.length).keys()];

  // Obiekty bez abonamentu nie mają też wpisanego kosztu — nikt nie liczy kosztu
  // lokalizacji, która jeszcze nie ruszyła. Wchodzą do puli „bez kosztu".
  const noValue = all.filter((i) => planned[i].row.monthlyValue == null);
  const costCandidates = shuffle(all.filter((i) => !noValue.includes(i)));
  const withoutCost = new Set([...noValue, ...costCandidates.slice(0, Math.max(0, OBJECTS_WITHOUT_COST - noValue.length))]);

  // Stratne wybieramy tylko spośród obiektów NIE-archiwalnych: domyślny zakres
  // Analityki pomija status „inactive", więc strata schowana w archiwum nie
  // pokazałaby się na żadnym wykresie.
  const lossCandidates = shuffle(
    all.filter((i) => !withoutCost.has(i) && planned[i].row.status !== "inactive"),
  );
  const lossy = new Set(lossCandidates.slice(0, OBJECTS_UNPROFITABLE));

  for (const i of all) {
    const row = planned[i].row;
    const value = row.monthlyValue ?? 0;

    if (withoutCost.has(i)) {
      row.monthlyCost = null;
    } else if (lossy.has(i)) {
      // Strata 5–60% ponad abonament — tyle, ile potrafi zjeść dojazd grupy
      // interwencyjnej do obiektu wycenionego „na wejście".
      row.monthlyCost = Math.round((value * (1.05 + rng() * 0.55)) / 10) * 10;
    } else {
      row.monthlyCost = Math.round((value * (0.35 + rng() * 0.6)) / 10) * 10;
    }

    // 60% obiektów ma wdrożenie; reszta to przejęcia bez nakładu albo obiekty,
    // przy których nikt nie wpisał kwoty.
    if (!chance(0.6)) {
      row.setupCost = null;
      continue;
    }

    const profit = value - (row.monthlyCost ?? 0);
    if (profit <= 0) {
      // Obiekt bez zysku nigdy się nie zwróci — i o to chodzi, pasmo „nigdy"
      // też musi mieć swoich przedstawicieli.
      row.setupCost = money(4000, 45000, 500);
      continue;
    }

    const months = weighted([
      [int(4, 12), 40],
      [int(13, 24), 30],
      [int(25, 48), 30],
    ] as const);
    const raw = Math.round((profit * months) / 100) * 100;
    // Dolny próg 2000 zł: poniżej tego nie robi się osobnego wdrożenia, więc przy
    // drobnych obiektach zwrot naturalnie wypada dłuższy niż wylosowane pasmo.
    row.setupCost = Math.min(60000, Math.max(2000, raw));
  }
}

/* ------------------------------------------------------------------ */
/* 4. UMOWY                                                            */
/* ------------------------------------------------------------------ */

const NEW_CONTRACTS = 70;

/**
 * Umowy dla obiektów czynnych i wdrażanych.
 *
 * ODSTĘPSTWO OD OKNA PERIOD, świadome: część umów zaczyna się PRZED oknem, a część
 * kończy PO nim. Umowa ochrony ma horyzont 2–3 lat, więc portfel, w którym wszystko
 * zaczęło się w ostatnich dwunastu miesiącach, jest po prostu nieprawdziwy —
 * i uniemożliwia przetestowanie statusu „wygasła".
 *
 * Znacznik idzie w `file_path`, bo `contracts` NIE MA kolumny na notatkę ani opis.
 * Pole jest w API, ale front go nie renderuje, więc znacznik nie zaśmieca ekranu,
 * a `--reset` ma po czym rozpoznać swoje wiersze.
 */
function insertContracts(
  tx: Tx,
  objects: readonly { id: number; status: string; monthlyValue: number | null }[],
): number {
  const eligible = shuffle(objects.filter((o) => o.status === "active" || o.status === "in_progress"));
  const chosen = eligible.slice(0, NEW_CONTRACTS);

  const rows: (typeof schema.contracts.$inferInsert)[] = [];
  chosen.forEach((obj, i) => {
    // 30% umów startuje przed oknem — to portfel odziedziczony, nie świeża sprzedaż.
    const startDate = chance(0.3)
      ? dateBetween(addMonths(PERIOD.from, -30), PERIOD.from)
      : dateBetween(PERIOD.from, addDays(TODAY, -7));

    // 20% bezterminowych (aneksowane co roku), reszta na 12/24/36 miesięcy.
    const lengthMonths = weighted([[12, 3], [24, 5], [36, 2]] as const);
    const endDate = chance(0.2) ? null : addMonths(startDate, lengthMonths);
    const expired = endDate != null && endDate < TODAY;

    const monthly = obj.monthlyValue ?? money(300, 2500);
    // Wartość roczna spójna z abonamentem ±15% — rabaty i indeksacja.
    const value = Math.round((monthly * 12 * (0.85 + rng() * 0.3)) / 10) * 10;

    const year = startDate.slice(0, 4);
    rows.push({
      objectId: obj.id,
      contractNumber: `UM/${year}/${String(i + 1).padStart(4, "0")}`,
      startDate,
      endDate,
      value,
      filePath: mark(),
      // Status musi być SPÓJNY z datą końca: „wygasła" wyłącznie wtedy, gdy
      // faktycznie minął termin — umowa oznaczona jako wygasła z datą w przyszłości
      // to dokładnie ten rodzaj sprzeczności, który przy debugowaniu kosztuje godzinę.
      status: expired
        ? "expired"
        : weighted([["active", 80], ["draft", 8], ["terminated", 6]] as const),
      createdAt: stamp(startDate < PERIOD.from ? PERIOD.from : startDate),
    });
  });

  let inserted = 0;
  for (const batch of chunks(rows, 60)) {
    tx.insert(schema.contracts).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/* ------------------------------------------------------------------ */
/* 5. ZLECENIA (ZDW)                                                   */
/* ------------------------------------------------------------------ */

const NEW_ORDERS = 45;

/**
 * Zlecenia montażu z formularza ZDW. Część ma już `object_id` — to te
 * „przekonwertowane" na obiekt w kartotece; reszta wisi jako zgłoszenie, bo
 * właśnie ten przepływ (zlecenie → obiekt) testuje lista zleceń.
 */
function insertOrders(
  tx: Tx,
  contractors: readonly { id: number; name: string; nip: string; city: string | null }[],
  objectsByContractor: Map<number, number[]>,
): number {
  const rows: (typeof schema.orders.$inferInsert)[] = [];

  for (let i = 0; i < NEW_ORDERS; i++) {
    const payer = pick(contractors);
    const requester = personName();
    const contact = personName();
    const created = dateBetween(PERIOD.from, addDays(TODAY, -3));
    const city = payer.city ?? pick(CITIES)[0];
    const kind = pick(SITE_KIND);

    const status = weighted([
      ["completed", 40],
      ["in_progress", 25],
      ["new", 20],
      ["cancelled", 15],
    ] as const);

    // Obiekt w kartotece dostają tylko zlecenia zrealizowane — reszta go jeszcze
    // nie ma albo już nie będzie miała (odrzucone).
    const candidates = objectsByContractor.get(payer.id) ?? [];
    const objectId = status === "completed" && candidates.length ? pick(candidates) : null;

    const cameras = chance(0.75);
    rows.push({
      orderNumber: `ZDW/${created.slice(0, 4)}/${String(i + 1).padStart(4, "0")}`,
      requesterName: requester,
      requesterPhone: phone(),
      requesterEmail: email(requester, "firma.invalid"),
      payerName: payer.name,
      payerNip: payer.nip,
      payerInvoiceEmail: email(`faktury ${payer.name.split(" ")[0]}`, "firma.invalid"),
      payerContractorId: payer.id,
      objectName: `${kind} ${city}`,
      objectKind: kind,
      objectAddress: `${pick(STREETS)} ${int(1, 150)}`,
      objectCity: city,
      objectLocationUrl: null,
      objectId,
      contactPerson: contact,
      contactPhone: phone(),
      contactEmail: email(contact, "firma.invalid"),
      isCameraInstallation: cameras,
      cameraCount: cameras ? int(2, 24) : null,
      megaphoneCount: cameras && chance(0.4) ? int(1, 4) : null,
      vtoolsOfferNumber: chance(0.3) ? `VT/${created.slice(0, 4)}/${int(100, 999)}` : null,
      internetIncluded: chance(0.5),
      interventionGroup: chance(0.35),
      videoReception: cameras && chance(0.6),
      monthlyAmount: money(250, 3500),
      contractLengthMonths: weighted([[12, 2], [24, 5], [36, 3]] as const),
      rentalAmount: chance(0.4) ? money(150, 1200) : null,
      rentalLengthMonths: chance(0.4) ? weighted([[24, 3], [36, 2]] as const) : null,
      invoiceIssuer: null,
      status,
      // Usługa rusza kilka tygodni po zgłoszeniu — tyle trwa montaż i podpisanie umowy.
      // `clampToPeriod`, bo zlecenie z końca sierpnia + 45 dni wypadłoby POZA okno
      // i wywaliło się z widoków miesięcznych, które liczą tylko PERIOD.
      serviceStartDate: status === "new" ? null : clampToPeriod(addDays(created, int(7, 45))),
      installationStartDate: status === "new" ? null : clampToPeriod(addDays(created, int(3, 30))),
      notes: mark("Zlecenie z generatora danych deweloperskich."),
      createdAt: stamp(created),
      updatedAt: stamp(created),
    });
  }

  let inserted = 0;
  for (const batch of chunks(rows, 25)) {
    tx.insert(schema.orders).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/* ------------------------------------------------------------------ */
/* 6. HISTORIA OBIEKTU                                                 */
/* ------------------------------------------------------------------ */

/**
 * Historia obiektu — wpis „created" dla każdego, a dla części dodatkowo przejście
 * statusu. Opis niesie MARKER, bo to po nim `--reset` rozpoznaje swoje wiersze
 * (kaskada z `objects` i tak by je zabrała, ale kolejność kasowania ma być jawna).
 */
function insertHistory(tx: Tx, ids: readonly number[], planned: readonly PlannedObject[]): number {
  const rows: (typeof schema.objectHistory.$inferInsert)[] = [];

  ids.forEach((objectId, i) => {
    const p = planned[i];
    rows.push({
      objectId,
      action: "created",
      description: mark(`Obiekt utworzony w dziale: ${p.row.department}`),
      newValue: JSON.stringify({ status: p.row.status, department: p.row.department }),
      changedBy: "seed",
      createdAt: stamp(p.createdAt),
    });

    // Ok. 40% obiektów przeszło przez proces (sprzedaż → wdrożenie → obsługa),
    // więc ma w historii ślad zmiany statusu.
    if (p.row.status !== "pending" && chance(0.55)) {
      const from = p.row.status === "inactive" ? "active" : "in_progress";
      const when = addDays(p.createdAt, int(5, 90));
      rows.push({
        objectId,
        action: "transition",
        description: mark(`Status: ${from} → ${p.row.status}`),
        oldValue: JSON.stringify({ status: from, department: "sales" }),
        newValue: JSON.stringify({ status: p.row.status, department: p.row.department }),
        changedBy: "seed",
        createdAt: stamp(when > TODAY ? TODAY : when),
      });
    }
  });

  let inserted = 0;
  for (const batch of chunks(rows, 80)) {
    tx.insert(schema.objectHistory).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/* ------------------------------------------------------------------ */
/* Wejście publiczne                                                   */
/* ------------------------------------------------------------------ */

export function seedCommercial(outerTx?: Tx): CommercialCounts {
  seed(SEED);

  // Drugi przebieg bez resetu wywaliłby się dopiero na UNIQUE (`contractors.nip`,
  // `orders.order_number`) w środku transakcji — komunikat sterownika nic wtedy nie
  // mówi o przyczynie, więc sprawdzamy to sami i od razu podpowiadamy `--reset`.
  assertNotSeeded(
    "commercial",
    db
      .select({ notes: schema.contractors.notes })
      .from(schema.contractors)
      .all()
      .some((r) => isSeeded(r.notes)),
  );

  const companyIds = db.select({ id: schema.companies.id }).from(schema.companies).all().map((r) => r.id);
  if (companyIds.length === 0) throw new Error("Brak spółek w bazie — uruchom najpierw seed spółek.");

  // Cały moduł w jednej transakcji: ~270 wierszy to jeden fsync zamiast 270.
  // Gdy orkiestrator prowadzi własną transakcję dla całego przebiegu, piszemy w niej.
  return runInTx(outerTx, (tx) => {
    const newSalespeople = insertSalespeople(tx);
    const legacy = updateLegacySalespeople(tx, newSalespeople);
    // Rejestr piszemy od razu: gdyby dalsza część przebiegu padła, transakcja
    // cofnie i zmiany, i rejestr — jedno i drugie albo nic.
    writeRegistry(REGISTRY_KEY, {
      legacySalespeople: [
        ...readRegistry(REGISTRY_KEY, EMPTY_REGISTRY).legacySalespeople,
        ...legacy.registry,
      ],
    } satisfies CommercialRegistry);
    const salespeopleUpdated = legacy.count;

    // Do przypisań bierzemy WSZYSTKICH handlowców (także trzech pierwotnych) —
    // inaczej portfel sprzed seeda zostałby odcięty od nowych kontrahentów.
    const allSalespeople = tx.select({ id: schema.salespeople.id }).from(schema.salespeople).all().map((r) => r.id);

    const newContractors = insertContractors(tx, allSalespeople);

    // Obiekty rozdzielamy po wszystkich kontrahentach — również po tych pięciu
    // sprzed seeda, żeby nie wyglądali na martwe konta obok świeżego portfela.
    const allContractors = tx
      .select({
        id: schema.contractors.id,
        name: schema.contractors.name,
        nip: schema.contractors.nip,
        city: schema.contractors.city,
      })
      .from(schema.contractors)
      .all();

    const { ids: objectIds, planned } = insertObjects(
      tx,
      allContractors.map((c) => c.id),
      allSalespeople,
      companyIds,
    );

    const history = insertHistory(tx, objectIds, planned);

    const contractsCount = insertContracts(
      tx,
      objectIds.map((id, i) => ({
        id,
        status: planned[i].row.status ?? "active",
        monthlyValue: planned[i].row.monthlyValue ?? null,
      })),
    );

    const objectsByContractor = new Map<number, number[]>();
    objectIds.forEach((id, i) => {
      const key = planned[i].row.contractorId;
      const list = objectsByContractor.get(key) ?? [];
      list.push(id);
      objectsByContractor.set(key, list);
    });

    const ordersCount = insertOrders(tx, allContractors, objectsByContractor);

    return {
      salespeople: newSalespeople.length,
      salespeopleUpdated,
      contractors: newContractors.length,
      objects: objectIds.length,
      contracts: contractsCount,
      orders: ordersCount,
      history,
    };
  });
}

/**
 * Kasuje WYŁĄCZNIE to, co zasiał `seedCommercial()` — rozpoznanie po MARKER-ze
 * w polu tekstowym, nigdy po zakresie identyfikatorów. Kolejność jest odwrotna do
 * zależności FK (`foreign_keys = ON`), bo zlecenia trzymają referencję do obiektu
 * BEZ kaskady i skasowanie obiektu przed zleceniem wywróciłoby transakcję.
 *
 * ZNACZNIK TO ZA MAŁO, gdy wiersz jest RODZICEM. `objects.contractor_id` kaskaduje,
 * więc kontrahent z seeda kasuje ze sobą obiekty — także te dopisane przez
 * użytkownika. Dlatego rodzic (kontrahent) ginie dopiero wtedy, gdy nie zostało
 * po nim ani jedno dziecko, a obiekt trzymany cudzym zleceniem zostaje w bazie.
 * Zasada ogólna: reset wolno zostawić NIEDOKOŃCZONY, ale nigdy nie wolno mu
 * zabrać czegoś, czego sam nie stworzył.
 */
export function resetCommercial(outerTx?: Tx): CommercialCounts {
  return runInTx(outerTx, (tx) => {
    // WSZYSTKIE liczniki idą z `.changes` sterownika, nigdy z długości listy
    // identyfikatorów. To nie kosmetyka raportu: przy kaskadzie FK jedno DELETE
    // zabiera więcej wierszy, niż było na liście, a raport „objects: 111" przy
    // 112 faktycznie skasowanych obiektach ukrywał dokładnie tę stratę.
    const counts: CommercialCounts = {
      salespeople: 0,
      salespeopleUpdated: 0,
      contractors: 0,
      objects: 0,
      contracts: 0,
      orders: 0,
      history: 0,
    };

    const historyIds = tx
      .select({ id: schema.objectHistory.id, description: schema.objectHistory.description })
      .from(schema.objectHistory)
      .all()
      .filter((r) => isSeeded(r.description))
      .map((r) => r.id);
    for (const batch of chunks(historyIds, 200)) {
      counts.history += tx
        .delete(schema.objectHistory)
        .where(inArray(schema.objectHistory.id, batch))
        .run().changes;
    }

    const contractIds = tx
      .select({ id: schema.contracts.id, filePath: schema.contracts.filePath })
      .from(schema.contracts)
      .all()
      .filter((r) => isSeeded(r.filePath))
      .map((r) => r.id);
    for (const batch of chunks(contractIds, 200)) {
      counts.contracts += tx
        .delete(schema.contracts)
        .where(inArray(schema.contracts.id, batch))
        .run().changes;
    }

    const orderIds = tx
      .select({ id: schema.orders.id, notes: schema.orders.notes })
      .from(schema.orders)
      .all()
      .filter((r) => isSeeded(r.notes))
      .map((r) => r.id);
    for (const batch of chunks(orderIds, 200)) {
      counts.orders += tx.delete(schema.orders).where(inArray(schema.orders.id, batch)).run().changes;
    }

    // Zlecenia, które ZOSTAŁY — czyje? Użytkownika. `orders.object_id` oraz
    // `orders.payer_contractor_id` nie mają ON DELETE, więc obiekt i kontrahent,
    // na których takie zlecenie wisi, muszą przeżyć reset; inaczej cała
    // transakcja wywraca się na „FOREIGN KEY constraint failed".
    const keptOrders = tx
      .select({ objectId: schema.orders.objectId, contractorId: schema.orders.payerContractorId })
      .from(schema.orders)
      .all();
    const objectsInUse = new Set(keptOrders.map((r) => r.objectId).filter((v): v is number => v != null));
    const contractorsInUse = new Set(
      keptOrders.map((r) => r.contractorId).filter((v): v is number => v != null),
    );

    // Umowy, które ZOSTAŁY po czyszczeniu, też trzymają swój obiekt przy życiu:
    // `contracts.object_id` kaskaduje, a umowa to dokument z plikiem, nie zapis
    // pomocniczy. Historii obiektu świadomie NIE liczymy do tej ochrony — to log
    // zmian samego obiektu, bez niego bezużyteczny, a wpisy dorabia aplikacja przy
    // każdej edycji, więc reset nie miałby czego posprzątać.
    const objectsWithContracts = new Set(
      tx
        .select({ objectId: schema.contracts.objectId })
        .from(schema.contracts)
        .all()
        .map((r) => r.objectId)
        .filter((v): v is number => v != null),
    );

    const objectIds = tx
      .select({ id: schema.objects.id, notes: schema.objects.notes })
      .from(schema.objects)
      .all()
      .filter((r) => isSeeded(r.notes) && !objectsInUse.has(r.id) && !objectsWithContracts.has(r.id))
      .map((r) => r.id);
    for (const batch of chunks(objectIds, 200)) {
      counts.objects += tx.delete(schema.objects).where(inArray(schema.objects.id, batch)).run().changes;
    }

    // KONTRAHENCI — tu leżała największa mina. Znacznik NIE wystarcza:
    // `objects.contractor_id` ma ON DELETE CASCADE, a za obiektem kaskadują
    // umowy i historia. Kontrahent z seeda, pod którego ktoś dopisał WŁASNY
    // obiekt, zabierał go ze sobą razem z całą jego dokumentacją — i to po
    // cichu (121 obiektów przed resetem → 9 po, przy raporcie „objects: 111").
    //
    // Dlatego kolejność jest odwrotna do intuicyjnej: najpierw znikają obiekty
    // ZE ZNACZNIKIEM (wyżej), a kontrahent ginie dopiero wtedy, gdy nic po nim
    // nie zostało. Kontrahent z cudzym obiektem zostaje w bazie — z widocznym
    // znacznikiem, ale to znacznie mniejszy problem niż skasowany obiekt.
    const contractorsWithObjects = new Set(
      tx
        .select({ contractorId: schema.objects.contractorId })
        .from(schema.objects)
        .all()
        .map((r) => r.contractorId)
        .filter((v): v is number => v != null),
    );
    const contractorIds = tx
      .select({ id: schema.contractors.id, notes: schema.contractors.notes })
      .from(schema.contractors)
      .all()
      .filter(
        (r) => isSeeded(r.notes) && !contractorsWithObjects.has(r.id) && !contractorsInUse.has(r.id),
      )
      .map((r) => r.id);
    for (const batch of chunks(contractorIds, 200)) {
      counts.contractors += tx
        .delete(schema.contractors)
        .where(inArray(schema.contractors.id, batch))
        .run().changes;
    }

    const salespersonIds = tx
      .select({ id: schema.salespeople.id, notes: schema.salespeople.notes })
      .from(schema.salespeople)
      .all()
      .filter((r) => isSeeded(r.notes))
      .map((r) => r.id);
    for (const batch of chunks(salespersonIds, 200)) {
      counts.salespeople += tx
        .delete(schema.salespeople)
        .where(inArray(schema.salespeople.id, batch))
        .run().changes;
    }

    // Handlowcy sprzed seeda: cofamy WYŁĄCZNIE to, co seed sam ustawił, i tylko
    // wtedy, gdy wartość nadal jest tą, którą wpisał — z rejestru, a nie „bo
    // wiersz nie ma znacznika". Poprzednia wersja celowała w BRAK znacznika,
    // czyli w prawdziwych handlowców, i zerowała im ręcznie wpisany koszt
    // i prowizję (7777 zł / 9,9% → NULL/NULL).
    const registry = readRegistry(REGISTRY_KEY, EMPTY_REGISTRY);
    for (const [id, cost, rate] of registry.legacySalespeople) {
      let touched = 0;
      if (cost !== null) {
        touched += tx
          .update(schema.salespeople)
          .set({ monthlyCost: null })
          .where(and(eq(schema.salespeople.id, id), eq(schema.salespeople.monthlyCost, cost)))
          .run().changes;
      }
      if (rate !== null) {
        touched += tx
          .update(schema.salespeople)
          .set({ commissionRate: null })
          .where(and(eq(schema.salespeople.id, id), eq(schema.salespeople.commissionRate, rate)))
          .run().changes;
      }
      if (touched > 0) counts.salespeopleUpdated += 1;
    }
    dropRegistry(REGISTRY_KEY);

    return counts;
  });
}

/** Nazwa modułu w logach orkiestratora. */
export const COMMERCIAL_MODULE = `handel (${MARKER})`;
