/**
 * Generator danych deweloperskich — MODUŁ MAGAZYN.
 *
 * Magazyn w bazie jest pusty (jeden magazyn, zero towarów), więc żeby zakładka
 * /technical/magazyn pokazała cokolwiek sensownego, trzeba wygenerować całą
 * ścieżkę: kartotekę towarów → magazyny → dokumenty → ruchy → stany.
 *
 * NAJWAŻNIEJSZA REGUŁA TEGO MODUŁU: magazyn stoi na ledgerze.
 * `warehouse_movements` jest źródłem prawdy, a `warehouse_stock` to CACHE,
 * który zawsze musi być równy SUM(quantity_delta) z ledgera (patrz komentarz
 * przy tabeli w schema.ts i `applyMovementSync()` w src/routes/warehouse.ts).
 * Seed odtwarza dokładnie ten kontrakt:
 *   - dokument `confirmed` → numer z sekwencji + ruchy + delta w cache,
 *   - dokument `draft`     → zero ruchów, zero wpływu na stan, brak numeru.
 * Gdyby seed zapisał stany „na oko", bez ruchów, historia towaru byłaby pusta
 * przy niezerowym stanie — czyli dokładnie ta bzdura, przed którą chroni ledger.
 *
 * Druga pułapka: numeracja. `nextDocNumberSync()` w routes/warehouse.ts nadaje
 * numer UPSERT-em na `warehouse_doc_sequences` (typ × ROK DATY DOKUMENTU).
 * Funkcja nie jest eksportowana (jest lokalna dla routera), więc jest tu
 * odtworzona 1:1 — razem z tabelą sekwencji. Gdyby seed wstawił dokumenty
 * z numerami, nie ruszając sekwencji, pierwszy dokument wystawiony z UI
 * dostałby PZ/2026/001, które już istnieje → UNIQUE constraint w twarz.
 *
 * Trzecia pułapka: ujemne stany. `assertNoNegativeStockSync()` nie pozwala
 * zatwierdzić rozchodu ponad stan, więc dane, które by tego nie spełniały,
 * byłyby nie do odtworzenia z UI. Dlatego dokumenty powstają CHRONOLOGICZNIE,
 * z bieżącym stanem trzymanym w pamięci, a rozchody biorą wyłącznie towary,
 * które w danym magazynie faktycznie leżą.
 */

import { and, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import {
  MARKER,
  PERIOD,
  addDays,
  chance,
  companyName,
  int,
  isWorkday,
  mark,
  num,
  pick,
  pickMany,
  weighted,
} from "./shared.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Login wpisywany w `created_by` — magazyn prowadzi admin. */
const CREATED_BY = "msajdak";

/** Ile dokumentów wygenerować w oknie PERIOD. */
const DOC_COUNT = 80;

/**
 * Ile pierwszych dokumentów jest wymuszonych jako PZ. Bez „rozbiegu" pierwsze
 * rozchody nie miałyby z czego schodzić i degenerowałyby się do przyjęć.
 */
const WARMUP_PZ = 12;

/** Dokumenty w szkicu tworzymy tylko w ostatnich tygodniach — tak jak w życiu. */
const DRAFT_WINDOW_DAYS = 75;

/* ------------------------------------------------------------------ */
/* Magazyny                                                            */
/* ------------------------------------------------------------------ */

/**
 * Cztery magazyny: centralny, dwa busy techników i serwisowy (RMA/naprawy).
 * `parent` wskazuje na indeks magazynu nadrzędnego w tej tablicy — API pilnuje
 * hierarchii max 1 poziom, więc busy wiszą pod centralnym, a nie pod sobą.
 */
const WAREHOUSE_DEFS: Array<{
  name: string;
  code: string;
  type: "main" | "vehicle" | "employee" | "site" | "other";
  parent: number | null;
}> = [
  { name: "Magazyn centralny — Kraków", code: "MAG-KRK", type: "main", parent: null },
  { name: "Bus techniczny TECH-1", code: "TECH-1", type: "vehicle", parent: 0 },
  { name: "Bus techniczny TECH-2", code: "TECH-2", type: "vehicle", parent: 0 },
  { name: "Magazyn serwisowy (RMA)", code: "SERW", type: "other", parent: 0 },
];

/* ------------------------------------------------------------------ */
/* Kartoteka towarów                                                   */
/* ------------------------------------------------------------------ */

interface ItemDef {
  sku: string;
  name: string;
  category: string;
  unit: string;
  /** Cena zakupu netto — baza dla `unit_price` na pozycjach dokumentów. */
  price: number;
  /** Próg alertu niskiego stanu; null dla drogiego sprzętu zamawianego pod projekt. */
  minStock: number | null;
  /** Sprzęt zwrotny (narzędzia) vs materiał zużywalny. */
  isAsset?: boolean;
  /** Ile sztuk wchodzi na jedno PZ (dolna/górna granica) — zależy od jednostki. */
  lot: [number, number];
}

/**
 * Kartoteka firmy montującej CCTV i systemy alarmowe. Ceny netto z okolic
 * dystrybucji zabezpieczeń — nie chodzi o dokładność, tylko o to, żeby
 * wartości dokumentów na liście nie wyglądały jak losowy szum.
 */
const ITEM_DEFS: ItemDef[] = [
  // --- Kamery IP
  { sku: "CAM-001", name: "Kamera IP kopułowa 4MP 2.8mm", category: "Kamery IP", unit: "szt", price: 420, minStock: 3, lot: [4, 20] },
  { sku: "CAM-002", name: "Kamera IP kopułowa 4MP motozoom 2.7-13.5mm", category: "Kamery IP", unit: "szt", price: 690, minStock: 2, lot: [4, 14] },
  { sku: "CAM-003", name: "Kamera IP tubowa 4MP 2.8mm", category: "Kamery IP", unit: "szt", price: 450, minStock: 3, lot: [4, 20] },
  { sku: "CAM-004", name: "Kamera IP tubowa 8MP motozoom", category: "Kamery IP", unit: "szt", price: 1150, minStock: 2, lot: [2, 10] },
  { sku: "CAM-005", name: "Kamera IP bullet 2MP ColorVu", category: "Kamery IP", unit: "szt", price: 560, minStock: 2, lot: [4, 16] },
  { sku: "CAM-006", name: "Kamera IP PTZ 4MP zoom 25x", category: "Kamery IP", unit: "szt", price: 3900, minStock: null, lot: [1, 4] },
  { sku: "CAM-007", name: "Kamera IP fisheye 6MP", category: "Kamery IP", unit: "szt", price: 1450, minStock: null, lot: [1, 6] },
  { sku: "CAM-008", name: "Kamera IP ANPR (odczyt tablic)", category: "Kamery IP", unit: "szt", price: 4200, minStock: null, lot: [1, 3] },
  { sku: "CAM-009", name: "Kamera IP kompaktowa 4MP z mikrofonem", category: "Kamery IP", unit: "szt", price: 520, minStock: 2, lot: [4, 16] },
  { sku: "CAM-010", name: "Kamera IP wandaloodporna 4MP IK10", category: "Kamery IP", unit: "szt", price: 780, minStock: 2, lot: [2, 12] },
  { sku: "CAM-011", name: "Kamera analogowa HD-TVI 2MP", category: "Kamery IP", unit: "szt", price: 210, minStock: 4, lot: [6, 24] },

  // --- Rejestratory i dyski
  { sku: "NVR-001", name: "Rejestrator NVR 8 kanałów PoE", category: "Rejestratory i dyski", unit: "szt", price: 1250, minStock: 2, lot: [2, 8] },
  { sku: "NVR-002", name: "Rejestrator NVR 16 kanałów PoE", category: "Rejestratory i dyski", unit: "szt", price: 2100, minStock: 2, lot: [1, 6] },
  { sku: "NVR-003", name: "Rejestrator NVR 32 kanały", category: "Rejestratory i dyski", unit: "szt", price: 3400, minStock: null, lot: [1, 3] },
  { sku: "NVR-004", name: "Rejestrator DVR 8 kanałów HD-TVI", category: "Rejestratory i dyski", unit: "szt", price: 890, minStock: 2, lot: [1, 6] },
  { sku: "HDD-001", name: "Dysk HDD 4TB Surveillance", category: "Rejestratory i dyski", unit: "szt", price: 520, minStock: 2, lot: [4, 16] },
  { sku: "HDD-002", name: "Dysk HDD 8TB Surveillance", category: "Rejestratory i dyski", unit: "szt", price: 940, minStock: 2, lot: [2, 10] },
  { sku: "HDD-003", name: "Dysk HDD 12TB Surveillance", category: "Rejestratory i dyski", unit: "szt", price: 1380, minStock: null, lot: [1, 6] },

  // --- Zasilanie
  { sku: "PSU-001", name: "Zasilacz 12V 5A w obudowie", category: "Zasilanie", unit: "szt", price: 95, minStock: 5, lot: [10, 40] },
  { sku: "PSU-002", name: "Zasilacz buforowy 12V 10A", category: "Zasilanie", unit: "szt", price: 260, minStock: 3, lot: [4, 20] },
  { sku: "PSU-003", name: "Zasilacz 24V 3A na szynę DIN", category: "Zasilanie", unit: "szt", price: 140, minStock: 3, lot: [4, 18] },
  { sku: "PSU-004", name: "Injector PoE 60W", category: "Zasilanie", unit: "szt", price: 130, minStock: 4, lot: [6, 24] },
  { sku: "UPS-001", name: "Zasilacz awaryjny UPS 650VA", category: "Zasilanie", unit: "szt", price: 380, minStock: 2, lot: [2, 10] },
  { sku: "AKU-001", name: "Akumulator żelowy 12V 7Ah", category: "Zasilanie", unit: "szt", price: 65, minStock: 10, lot: [20, 60] },
  { sku: "AKU-002", name: "Akumulator żelowy 12V 17Ah", category: "Zasilanie", unit: "szt", price: 145, minStock: 5, lot: [8, 30] },
  { sku: "AKU-003", name: "Akumulator litowy 12V 9Ah", category: "Zasilanie", unit: "szt", price: 290, minStock: 2, lot: [2, 12] },

  // --- Sieć
  { sku: "SW-001", name: "Switch PoE 8 portów 120W", category: "Sieć", unit: "szt", price: 420, minStock: 3, lot: [4, 16] },
  { sku: "SW-002", name: "Switch PoE 16 portów 250W", category: "Sieć", unit: "szt", price: 890, minStock: 2, lot: [2, 10] },
  { sku: "SW-003", name: "Switch PoE 24 porty zarządzalny", category: "Sieć", unit: "szt", price: 1980, minStock: null, lot: [1, 5] },
  { sku: "SW-004", name: "Switch niezarządzalny 5 portów", category: "Sieć", unit: "szt", price: 85, minStock: 5, lot: [10, 30] },
  { sku: "NET-001", name: "Media konwerter światłowodowy SFP", category: "Sieć", unit: "szt", price: 160, minStock: 3, lot: [4, 20] },
  { sku: "NET-002", name: "Moduł SFP 1.25G SM 20km", category: "Sieć", unit: "szt", price: 95, minStock: 4, lot: [8, 24] },
  { sku: "NET-003", name: "Router LTE przemysłowy", category: "Sieć", unit: "szt", price: 1150, minStock: null, lot: [1, 5] },
  { sku: "NET-004", name: "Panel krosowy 24 porty RJ45", category: "Sieć", unit: "szt", price: 190, minStock: 2, lot: [2, 10] },

  // --- Okablowanie (metry!)
  { sku: "KAB-001", name: "Skrętka UTP kat.5e drut zewnętrzna", category: "Okablowanie", unit: "m", price: 1.6, minStock: 250, lot: [305, 1525] },
  { sku: "KAB-002", name: "Skrętka UTP kat.6 drut żelowana", category: "Okablowanie", unit: "m", price: 2.9, minStock: 150, lot: [305, 915] },
  { sku: "KAB-003", name: "Skrętka FTP kat.6 ekranowana", category: "Okablowanie", unit: "m", price: 3.4, minStock: 150, lot: [305, 610] },
  { sku: "KAB-004", name: "Przewód zasilający YDY 3x1.5", category: "Okablowanie", unit: "m", price: 4.2, minStock: 100, lot: [100, 500] },
  { sku: "KAB-005", name: "Przewód alarmowy YTDY 6x0.5", category: "Okablowanie", unit: "m", price: 1.3, minStock: 200, lot: [200, 1000] },
  { sku: "KAB-006", name: "Kabel światłowodowy SM 4J zewnętrzny", category: "Okablowanie", unit: "m", price: 3.2, minStock: 100, lot: [200, 1000] },
  { sku: "KAB-007", name: "Rura osłonowa peszel 20mm", category: "Okablowanie", unit: "m", price: 2.1, minStock: 100, lot: [100, 500] },
  { sku: "KAB-008", name: "Patchcord UTP kat.6 2m", category: "Okablowanie", unit: "szt", price: 12, minStock: 15, lot: [20, 100] },

  // --- Złącza i akcesoria montażowe
  { sku: "ZLA-001", name: "Wtyk RJ45 kat.6 ekranowany", category: "Złącza i montaż", unit: "szt", price: 1.8, minStock: 100, lot: [100, 500] },
  { sku: "ZLA-002", name: "Złącze zasilające DC 5.5/2.1 zaciskane", category: "Złącza i montaż", unit: "szt", price: 2.4, minStock: 50, lot: [50, 300] },
  { sku: "ZLA-003", name: "Puszka hermetyczna IP66 100x100", category: "Złącza i montaż", unit: "szt", price: 18, minStock: 10, lot: [20, 80] },
  { sku: "ZLA-004", name: "Uchwyt ścienny do kamery tubowej", category: "Złącza i montaż", unit: "szt", price: 45, minStock: 8, lot: [10, 40] },
  { sku: "ZLA-005", name: "Uchwyt narożny do kamery kopułowej", category: "Złącza i montaż", unit: "szt", price: 78, minStock: 5, lot: [6, 24] },
  { sku: "ZLA-006", name: "Obudowa zewnętrzna na zasilacz IP65", category: "Złącza i montaż", unit: "szt", price: 130, minStock: 4, lot: [4, 20] },
  { sku: "ZLA-007", name: "Opaski kablowe 200mm (op. 100 szt)", category: "Złącza i montaż", unit: "op", price: 14, minStock: 5, lot: [10, 40] },
  { sku: "ZLA-008", name: "Kołki rozporowe z wkrętem 8x60 (op. 100 szt)", category: "Złącza i montaż", unit: "op", price: 26, minStock: 4, lot: [5, 25] },
  { sku: "ZLA-009", name: "Szafka teletechniczna wisząca 6U", category: "Złącza i montaż", unit: "szt", price: 340, minStock: null, lot: [1, 6] },

  // --- Systemy alarmowe
  { sku: "ALM-001", name: "Czujka PIR wewnętrzna", category: "Alarm", unit: "szt", price: 65, minStock: 8, lot: [10, 50] },
  { sku: "ALM-002", name: "Czujka PIR zewnętrzna dualna", category: "Alarm", unit: "szt", price: 320, minStock: 3, lot: [4, 20] },
  { sku: "ALM-003", name: "Czujka kurtynowa PIR", category: "Alarm", unit: "szt", price: 190, minStock: 3, lot: [4, 16] },
  { sku: "ALM-004", name: "Kontaktron natynkowy", category: "Alarm", unit: "szt", price: 12, minStock: 20, lot: [30, 120] },
  { sku: "ALM-005", name: "Centrala alarmowa 8 wejść z obudową", category: "Alarm", unit: "szt", price: 690, minStock: 2, lot: [2, 8] },
  { sku: "ALM-006", name: "Centrala alarmowa 32 wejścia", category: "Alarm", unit: "szt", price: 1450, minStock: null, lot: [1, 4] },
  { sku: "ALM-007", name: "Manipulator LCD do centrali", category: "Alarm", unit: "szt", price: 320, minStock: 2, lot: [2, 12] },
  { sku: "ALM-008", name: "Moduł GSM/LTE do centrali", category: "Alarm", unit: "szt", price: 480, minStock: 2, lot: [2, 10] },
  { sku: "ALM-009", name: "Sygnalizator zewnętrzny optyczno-akustyczny", category: "Alarm", unit: "szt", price: 145, minStock: 3, lot: [4, 20] },
  { sku: "ALM-010", name: "Sygnalizator wewnętrzny piezo", category: "Alarm", unit: "szt", price: 55, minStock: 5, lot: [8, 30] },

  // --- Narzędzia (sprzęt zwrotny — isAsset, bez minStock i bez kodu kreskowego)
  { sku: "NRZ-001", name: "Wiertarko-wkrętarka akumulatorowa", category: "Narzędzia", unit: "szt", price: 890, minStock: null, isAsset: true, lot: [1, 3] },
  { sku: "NRZ-002", name: "Młotowiertarka SDS-Plus", category: "Narzędzia", unit: "szt", price: 1250, minStock: null, isAsset: true, lot: [1, 2] },
  { sku: "NRZ-003", name: 'Tester monitoringu CCTV 4"', category: "Narzędzia", unit: "szt", price: 1650, minStock: null, isAsset: true, lot: [1, 2] },
  { sku: "NRZ-004", name: "Zaciskarka modularna RJ45", category: "Narzędzia", unit: "szt", price: 210, minStock: null, isAsset: true, lot: [1, 4] },
  { sku: "NRZ-005", name: "Spawarka światłowodowa", category: "Narzędzia", unit: "kpl", price: 12800, minStock: null, isAsset: true, lot: [1, 1] },
  { sku: "NRZ-006", name: "Drabina aluminiowa 3x9", category: "Narzędzia", unit: "szt", price: 1450, minStock: null, isAsset: true, lot: [1, 2] },
  { sku: "NRZ-007", name: "Miernik uniwersalny", category: "Narzędzia", unit: "szt", price: 260, minStock: null, isAsset: true, lot: [1, 4] },
];

/**
 * Kod kreskowy EAN-13 z poprawną cyfrą kontrolną — czytniki i walidatory
 * odrzucają byle jakie 13 cyfr, więc syntetyczny kod też musi się liczyć.
 * Prefiks 590 to pula polska; numer bierzemy z indeksu, żeby był deterministyczny.
 */
function ean13(index: number): string {
  const base = `590${String(1000000 + index).padStart(9, "0")}`.slice(0, 12);
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(base[i]) * (i % 2 === 0 ? 1 : 3);
  return base + String((10 - (sum % 10)) % 10);
}

/* ------------------------------------------------------------------ */
/* Kontrahenci i opisy dokumentów                                      */
/* ------------------------------------------------------------------ */

/** Odbiorcy WZ — nazwy obiektów, na które schodzi sprzęt. */
const WZ_SITES = [
  "Galeria Handlowa Podkowa",
  "Centrum logistyczne Skawina",
  "Zakład produkcyjny Wilga 2000",
  "Osiedle Białego Dębu",
  "Terminal przeładunkowy Zegrze",
  "Salon Toyota Blizne",
  "Farma PV Naturagra Siedlce",
  "Biurowiec Puławska 233",
  "Hala Panattoni Suchy Las",
  "Portiernia Odlewnicza 6",
] as const;

/** Powody RW — rozchód wewnętrzny idzie zawsze na konkretną robotę. */
const RW_REASONS = [
  "Montaż systemu CCTV",
  "Rozbudowa monitoringu",
  "Serwis gwarancyjny — wymiana uszkodzonego sprzętu",
  "Przegląd okresowy — materiały eksploatacyjne",
  "Awaria zasilania — wymiana akumulatorów",
  "Doprowadzenie okablowania",
  "Wymiana rejestratora",
  "Montaż systemu alarmowego",
] as const;

/* ------------------------------------------------------------------ */
/* Pomocnicze                                                          */
/* ------------------------------------------------------------------ */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Znacznik czasu w formacie, jaki zapisuje router: pełne ISO z „Z". */
const stampAt = (isoDay: string, hour: number, minute: number): string =>
  `${isoDay}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;

/**
 * Kolejny numer dokumentu — odwzorowanie `nextDocNumberSync()` z
 * src/routes/warehouse.ts (funkcja jest tam lokalna, nie da się jej
 * zaimportować). UPSERT po (typ, rok daty dokumentu) trzyma
 * `warehouse_doc_sequences` w zgodzie z tym, co widzi UI — dokument wystawiony
 * po seedzie dostanie kolejny wolny numer, nie duplikat.
 */
function nextDocNumber(tx: Tx, docType: string, issuedAt: string): string {
  const year = Number(issuedAt.slice(0, 4));
  const row = tx
    .insert(schema.warehouseDocSequences)
    .values({ docType, year, lastNumber: 1 })
    .onConflictDoUpdate({
      target: [schema.warehouseDocSequences.docType, schema.warehouseDocSequences.year],
      set: { lastNumber: sql`${schema.warehouseDocSequences.lastNumber} + 1` },
    })
    .returning({ lastNumber: schema.warehouseDocSequences.lastNumber })
    .get();
  return `${docType}/${year}/${String(row.lastNumber).padStart(3, "0")}`;
}

/** Ilość na pozycji: w metrach zaokrąglana do 5 m, w sztukach do całości. */
function lotQuantity(def: ItemDef): number {
  const [lo, hi] = def.lot;
  const raw = num(lo, hi);
  return def.unit === "m" ? Math.max(5, Math.round(raw / 5) * 5) : Math.max(1, Math.round(raw));
}

/** Cena na pozycji: cennik zakupowy ±8%, groszowo. */
const unitPriceOf = (def: ItemDef): number => round2(def.price * num(0.92, 1.08, 4));

/* ------------------------------------------------------------------ */
/* SEED                                                               */
/* ------------------------------------------------------------------ */

export interface WarehouseSeedCounts {
  warehouses: number;
  items: number;
  documents: number;
  confirmed: number;
  drafts: number;
  documentItems: number;
  movements: number;
  stockRows: number;
}

export async function seedWarehouse(): Promise<WarehouseSeedCounts> {
  const counts: WarehouseSeedCounts = {
    warehouses: 0,
    items: 0,
    documents: 0,
    confirmed: 0,
    drafts: 0,
    documentItems: 0,
    movements: 0,
    stockRows: 0,
  };

  // Daty dokumentów: losowe dni robocze z PERIOD, POSORTOWANE. Chronologia jest
  // tu warunkiem poprawności, nie kosmetyką — rozchód musi widzieć stan
  // zbudowany przez wcześniejsze przyjęcia.
  const days: string[] = [];
  const spanDays = Math.round(
    (Date.parse(`${PERIOD.to}T00:00:00Z`) - Date.parse(`${PERIOD.from}T00:00:00Z`)) / 86400000,
  );
  for (let i = 0; i < DOC_COUNT; i++) {
    let d = addDays(PERIOD.from, int(0, spanDays));
    // dni robocze — magazyn nie wydaje towaru w niedzielę
    let guard = 0;
    while (!isWorkday(d) && guard++ < 7) d = addDays(d, 1);
    if (d > PERIOD.to) d = PERIOD.to;
    days.push(d);
  }
  days.sort();

  const draftFrom = addDays(PERIOD.to, -DRAFT_WINDOW_DAYS);

  db.transaction((tx) => {
    /* --- 1. Magazyny -------------------------------------------------- */
    const warehouseIds: number[] = [];
    for (const def of WAREHOUSE_DEFS) {
      const row = tx
        .insert(schema.warehouses)
        .values({
          // Magazyn nie ma pola na notatkę, więc znacznik idzie w nazwę —
          // dzięki temu `--reset` rozpoznaje swoje wiersze bez zgadywania,
          // a w UI od razu widać, że to magazyn deweloperski.
          name: `${def.name} ${MARKER}`,
          code: def.code,
          type: def.type,
          parentId: def.parent === null ? null : warehouseIds[def.parent],
        })
        .returning({ id: schema.warehouses.id })
        .get();
      warehouseIds.push(row.id);
      counts.warehouses++;
    }
    const MAIN = warehouseIds[0];
    const VEHICLES = [warehouseIds[1], warehouseIds[2]];
    const SERVICE = warehouseIds[3];

    /* --- 2. Kartoteka towarów ---------------------------------------- */
    const itemIds: number[] = [];
    ITEM_DEFS.forEach((def, i) => {
      const row = tx
        .insert(schema.warehouseItems)
        .values({
          sku: def.sku,
          name: def.name,
          category: def.category,
          unit: def.unit,
          // Opis niesie MARKER — to po nim `--reset` znajduje towary seeda.
          description: mark(`${def.category} · cena zakupu ok. ${def.price} zł netto`),
          minStock: def.minStock,
          isAsset: def.isAsset ?? false,
          // Kod kreskowy tylko dla materiałów — narzędzia są ewidencjonowane
          // po numerze inwentarzowym, nie skanowane na wydaniu.
          barcode: def.isAsset ? null : ean13(i + 1),
        })
        .returning({ id: schema.warehouseItems.id })
        .get();
      itemIds.push(row.id);
      counts.items++;
    });

    /* --- 3. Dokumenty w porządku chronologicznym ---------------------- */

    // Bieżący stan trzymany w pamięci: `${magazyn}|${towar}` → ilość.
    // To ten sam stan, który po transakcji ląduje w cache `warehouse_stock`.
    const stock = new Map<string, number>();
    const stockKey = (w: number, it: number) => `${w}|${it}`;
    const stockOf = (w: number, it: number) => stock.get(stockKey(w, it)) ?? 0;
    /** Towary, które faktycznie leżą w danym magazynie (kandydaci na rozchód). */
    const availableIn = (w: number): number[] =>
      itemIds.filter((it) => stockOf(w, it) > 0);

    const movementRows: Array<typeof schema.warehouseMovements.$inferInsert> = [];
    /** Sumaryczna delta na (magazyn, towar) — cache liczony z tych samych ruchów. */
    const stockDelta = new Map<string, { warehouseId: number; itemId: number; qty: number }>();
    const addDelta = (w: number, it: number, qty: number) => {
      const key = stockKey(w, it);
      const cur = stockDelta.get(key) ?? { warehouseId: w, itemId: it, qty: 0 };
      cur.qty += qty;
      stockDelta.set(key, cur);
      stock.set(key, (stock.get(key) ?? 0) + qty);
    };

    days.forEach((issuedAt, idx) => {
      // Rozgrzewka: pierwsze dokumenty to wyłącznie przyjęcia, potem miks.
      // W dalszej części roku przyjęć jest mniej niż rozchodów — magazyn ma
      // żyć, a nie tylko puchnąć.
      let docType: "PZ" | "WZ" | "RW" | "MM" =
        idx < WARMUP_PZ
          ? "PZ"
          : weighted([
              // Przewaga przyjęć nad rozchodami jest celowa: przy 50/50 stan
              // spływa do zera i po roku pół kartoteki wisi pod minimum.
              ["PZ", 36],
              ["RW", 27],
              ["WZ", 17],
              ["MM", 20],
            ] as const);

      // Szkice tylko w ostatnich tygodniach i tylko na rozchodach/przyjęciach
      // (szkic MM w połowie roku wyglądałby jak zapomniany śmieć).
      const isDraft = issuedAt >= draftFrom && chance(0.35);

      let warehouseFromId: number | null = null;
      let warehouseToId: number | null = null;
      let source = MAIN;

      if (docType === "PZ") {
        // Dostawa idzie prawie zawsze na centralny; czasem prosto do busa.
        warehouseToId = chance(0.12) ? pick(VEHICLES) : MAIN;
      } else if (docType === "MM") {
        // Przesunięcia: centralny → bus (zaopatrzenie ekipy) albo bus →
        // serwisowy (sprzęt zdjęty z obiektu, do naprawy).
        source = chance(0.75) ? MAIN : pick(VEHICLES);
        warehouseFromId = source;
        // Z centralnego jedzie głównie zaopatrzenie ekip; magazyn serwisowy
        // ma być małym buforem na naprawy, a nie drugim składem.
        warehouseToId =
          source === MAIN
            ? chance(0.85)
              ? pick(VEHICLES)
              : SERVICE
            : chance(0.6)
              ? SERVICE
              : MAIN;
      } else {
        // WZ wychodzi z centralnego (wydanie na obiekt klienta),
        // RW schodzi najczęściej z busa technika (zużycie na robocie).
        source = docType === "WZ" ? MAIN : chance(0.7) ? pick(VEHICLES) : MAIN;
        warehouseFromId = source;
      }

      // Dobór pozycji. Dla rozchodów wolno brać wyłącznie to, co leży w
      // magazynie źródłowym — inaczej `assertNoNegativeStockSync()` odrzuciłby
      // taki dokument przy próbie zatwierdzenia z UI.
      let pool = docType === "PZ" ? itemIds : availableIn(source);
      if (pool.length === 0) {
        // Pusty magazyn źródłowy: degradujemy dokument do przyjęcia zamiast
        // generować rozchód, którego aplikacja nigdy by nie przyjęła.
        docType = "PZ";
        warehouseFromId = null;
        warehouseToId = MAIN;
        pool = itemIds;
      }

      const lines = pickMany(pool, Math.min(int(2, 8), pool.length));
      const positions = lines.map((itemId, i) => {
        const def = ITEM_DEFS[itemIds.indexOf(itemId)];
        const wanted = lotQuantity(def);
        // Rozchód nigdy ponad stan — bierzemy część tego, co jest.
        const quantity =
          docType === "PZ"
            ? wanted
            : Math.max(
                def.unit === "m" ? 5 : 1,
                // Rozchód bierze ułamek tego, co leży — wydanie 80% stanu na
                // jednym dokumencie zjadłoby magazyn w kilka tygodni i pół
                // kartoteki wisiałoby pod stanem minimalnym.
                Math.min(wanted, Math.round(stockOf(source, itemId) * num(0.08, 0.35, 2))),
              );
        return {
          itemId,
          positionNo: i + 1,
          quantity: Math.min(
            quantity,
            docType === "PZ" ? quantity : stockOf(source, itemId),
          ),
          // MM to ruch wewnętrzny — nie ma tam ceny zakupu; RW rozlicza się
          // ilościowo na realizację, więc cena też zbędna.
          unitPrice: docType === "PZ" || docType === "WZ" ? unitPriceOf(def) : null,
        };
      });

      const contractorName =
        docType === "PZ"
          ? `${companyName()} ${MARKER}`
          : docType === "WZ"
            ? `${pick(WZ_SITES)} ${MARKER}`
            : null;

      const notesText =
        docType === "PZ"
          ? "Dostawa magazynowa"
          : docType === "WZ"
            ? `Wydanie na obiekt: ${contractorName ?? ""}`.trim()
            : docType === "RW"
              ? `${pick(RW_REASONS)} — obiekt ${pick(WZ_SITES)}`
              : "Przesunięcie międzymagazynowe";

      const createdStamp = stampAt(issuedAt, int(7, 15), pick([0, 15, 30, 45]));

      const doc = tx
        .insert(schema.warehouseDocuments)
        .values({
          docType,
          // Numer nadawany WYŁĄCZNIE przy zatwierdzeniu — dokładnie jak
          // w confirmDocumentSync(). Szkic numeru nie ma.
          docNumber: isDraft ? null : nextDocNumber(tx, docType, issuedAt),
          status: isDraft ? "draft" : "confirmed",
          warehouseFromId,
          warehouseToId,
          contractorName,
          invoiceNumber:
            docType === "PZ"
              ? `FV/${String(int(1, 999)).padStart(4, "0")}/${issuedAt.slice(5, 7)}/${issuedAt.slice(0, 4)}`
              : null,
          issuedAt,
          confirmedAt: isDraft ? null : stampAt(issuedAt, int(15, 17), pick([0, 20, 40])),
          // Notatka niesie MARKER — punkt zaczepienia dla `--reset`.
          notes: mark(notesText),
          createdBy: CREATED_BY,
          createdAt: createdStamp,
          updatedAt: createdStamp,
        })
        .returning({ id: schema.warehouseDocuments.id })
        .get();
      counts.documents++;
      if (isDraft) counts.drafts++;
      else counts.confirmed++;

      for (const p of positions) {
        const line = tx
          .insert(schema.warehouseDocumentItems)
          .values({
            documentId: doc.id,
            itemId: p.itemId,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            positionNo: p.positionNo,
          })
          .returning({ id: schema.warehouseDocumentItems.id })
          .get();
        counts.documentItems++;

        // Szkic nie rusza ledgera ani stanów — tak samo jak w aplikacji.
        if (isDraft) continue;

        // Delty jak w `movementDeltas()`: PZ +cel, WZ/RW −źródło,
        // MM dwa wpisy (−źródło, +cel).
        const deltas: Array<{ warehouseId: number; quantityDelta: number }> =
          docType === "PZ"
            ? [{ warehouseId: warehouseToId!, quantityDelta: p.quantity }]
            : docType === "MM"
              ? [
                  { warehouseId: warehouseFromId!, quantityDelta: -p.quantity },
                  { warehouseId: warehouseToId!, quantityDelta: p.quantity },
                ]
              : [{ warehouseId: warehouseFromId!, quantityDelta: -p.quantity }];

        for (const d of deltas) {
          movementRows.push({
            itemId: p.itemId,
            warehouseId: d.warehouseId,
            quantityDelta: d.quantityDelta,
            documentId: doc.id,
            documentItemId: line.id,
            createdAt: stampAt(issuedAt, 15, 30),
            createdBy: CREATED_BY,
          });
          addDelta(d.warehouseId, p.itemId, d.quantityDelta);
        }
      }
    });

    /* --- 4. Ledger ---------------------------------------------------- */
    for (let i = 0; i < movementRows.length; i += 200) {
      tx.insert(schema.warehouseMovements).values(movementRows.slice(i, i + 200)).run();
      counts.movements += Math.min(200, movementRows.length - i);
    }

    /* --- 5. Cache stanów --------------------------------------------- */
    // Upsert z inkrementacją (a nie nadpisaniem) — dokładnie jak
    // applyMovementSync(). Dzięki temu, gdyby w cache siedział już jakiś
    // wiersz z wcześniejszych ruchów, seed go doliczy, a nie skasuje.
    for (const d of stockDelta.values()) {
      tx.insert(schema.warehouseStock)
        .values({ itemId: d.itemId, warehouseId: d.warehouseId, quantity: d.qty })
        .onConflictDoUpdate({
          target: [schema.warehouseStock.itemId, schema.warehouseStock.warehouseId],
          set: { quantity: sql`${schema.warehouseStock.quantity} + ${d.qty}` },
        })
        .run();
      counts.stockRows++;
    }
  });

  return counts;
}

/* ------------------------------------------------------------------ */
/* RESET                                                              */
/* ------------------------------------------------------------------ */

export interface WarehouseResetCounts {
  documents: number;
  documentItems: number;
  movements: number;
  items: number;
  warehouses: number;
  stockRows: number;
  sequences: number;
}

/**
 * Kasuje WYŁĄCZNIE to, co dodał `seedWarehouse()` — rozpoznawane po MARKERze
 * w polach tekstowych: `warehouse_documents.notes`, `warehouse_items.description`
 * i `warehouses.name`. Tabele bez pola tekstowego (pozycje, ruchy, stany,
 * sekwencje) czyszczone są POCHODNIE, po kluczach obcych do skasowanych
 * dokumentów — nigdy „wszystko z tabeli".
 *
 * Kolejność jest odwrotna do zależności: ruchy → pozycje → dokumenty →
 * przeliczenie cache → towary → magazyny → przeliczenie sekwencji. Wiersze
 * niepochodzące z seeda przeżywają każdy z tych kroków, bo:
 *   - stany są PRZELICZANE z pozostałego ledgera (a nie kasowane hurtem),
 *   - towar/magazyn ginie tylko wtedy, gdy nie został po nim ani jeden ruch.
 */
export async function resetWarehouse(): Promise<WarehouseResetCounts> {
  const counts: WarehouseResetCounts = {
    documents: 0,
    documentItems: 0,
    movements: 0,
    items: 0,
    warehouses: 0,
    stockRows: 0,
    sequences: 0,
  };

  db.transaction((tx) => {
    const seededDocs = tx
      .select({ id: schema.warehouseDocuments.id })
      .from(schema.warehouseDocuments)
      .where(like(schema.warehouseDocuments.notes, `%${MARKER}%`))
      .all()
      .map((r) => r.id);

    if (seededDocs.length > 0) {
      for (let i = 0; i < seededDocs.length; i += 200) {
        const chunk = seededDocs.slice(i, i + 200);
        counts.movements += tx
          .delete(schema.warehouseMovements)
          .where(inArray(schema.warehouseMovements.documentId, chunk))
          .run().changes;
        counts.documentItems += tx
          .delete(schema.warehouseDocumentItems)
          .where(inArray(schema.warehouseDocumentItems.documentId, chunk))
          .run().changes;
        counts.documents += tx
          .delete(schema.warehouseDocuments)
          .where(inArray(schema.warehouseDocuments.id, chunk))
          .run().changes;
      }
    }

    // Cache stanów PRZELICZANY z ledgera (jedyne źródło prawdy). Wiersz bez
    // ruchów po czyszczeniu znika; wiersz z ruchami dostaje ich sumę — także
    // wtedy, gdy część ruchów pochodziła spoza seeda.
    const stockRows = tx.select().from(schema.warehouseStock).all();
    for (const s of stockRows) {
      const sum = tx
        .select({ total: sql<number | null>`sum(${schema.warehouseMovements.quantityDelta})` })
        .from(schema.warehouseMovements)
        .where(
          and(
            eq(schema.warehouseMovements.itemId, s.itemId),
            eq(schema.warehouseMovements.warehouseId, s.warehouseId),
          ),
        )
        .get();
      const total = sum?.total ?? null;
      if (total === null) {
        counts.stockRows += tx
          .delete(schema.warehouseStock)
          .where(
            and(
              eq(schema.warehouseStock.itemId, s.itemId),
              eq(schema.warehouseStock.warehouseId, s.warehouseId),
            ),
          )
          .run().changes;
      } else if (total !== s.quantity) {
        tx.update(schema.warehouseStock)
          .set({ quantity: total })
          .where(
            and(
              eq(schema.warehouseStock.itemId, s.itemId),
              eq(schema.warehouseStock.warehouseId, s.warehouseId),
            ),
          )
          .run();
      }
    }

    // Towary seeda — tylko te, po których nie został żaden ruch. Gdyby ktoś
    // wystawił własny dokument na towar z seeda, kartoteka zostaje (inaczej
    // FK by pękło, a historia jego dokumentu przestałaby się spinać).
    const seededItems = tx
      .select({ id: schema.warehouseItems.id })
      .from(schema.warehouseItems)
      .where(like(schema.warehouseItems.description, `%${MARKER}%`))
      .all()
      .map((r) => r.id);
    for (const id of seededItems) {
      const used = tx
        .select({ id: schema.warehouseMovements.id })
        .from(schema.warehouseMovements)
        .where(eq(schema.warehouseMovements.itemId, id))
        .limit(1)
        .get();
      const onDoc = tx
        .select({ id: schema.warehouseDocumentItems.id })
        .from(schema.warehouseDocumentItems)
        .where(eq(schema.warehouseDocumentItems.itemId, id))
        .limit(1)
        .get();
      if (used || onDoc) continue;
      tx.delete(schema.warehouseStock).where(eq(schema.warehouseStock.itemId, id)).run();
      counts.items += tx
        .delete(schema.warehouseItems)
        .where(eq(schema.warehouseItems.id, id))
        .run().changes;
    }

    // Magazyny seeda — analogicznie: tylko puste i nieużywane. Dzieci przed
    // rodzicem (parent_id ma FK), więc najpierw te z parentem.
    const seededWarehouses = tx
      .select({ id: schema.warehouses.id, parentId: schema.warehouses.parentId })
      .from(schema.warehouses)
      .where(like(schema.warehouses.name, `%${MARKER}%`))
      .all()
      .sort((a, b) => (b.parentId ?? 0) - (a.parentId ?? 0));
    for (const w of seededWarehouses) {
      const used = tx
        .select({ id: schema.warehouseMovements.id })
        .from(schema.warehouseMovements)
        .where(eq(schema.warehouseMovements.warehouseId, w.id))
        .limit(1)
        .get();
      const child = tx
        .select({ id: schema.warehouses.id })
        .from(schema.warehouses)
        .where(eq(schema.warehouses.parentId, w.id))
        .limit(1)
        .get();
      if (used || child) continue;
      tx.delete(schema.warehouseStock).where(eq(schema.warehouseStock.warehouseId, w.id)).run();
      counts.warehouses += tx
        .delete(schema.warehouses)
        .where(eq(schema.warehouses.id, w.id))
        .run().changes;
    }

    // Sekwencje numeracji: cofamy licznik do najwyższego numeru, jaki został
    // w dokumentach. Bez tego po resecie sekwencja zostałaby „w przyszłości"
    // i pierwszy dokument z UI dostałby numer z dziurą.
    const seqs = tx.select().from(schema.warehouseDocSequences).all();
    for (const s of seqs) {
      const docs = tx
        .select({ docNumber: schema.warehouseDocuments.docNumber })
        .from(schema.warehouseDocuments)
        .where(
          and(
            eq(schema.warehouseDocuments.docType, s.docType as "PZ" | "WZ" | "RW" | "MM"),
            isNotNull(schema.warehouseDocuments.docNumber),
            like(schema.warehouseDocuments.docNumber, `${s.docType}/${s.year}/%`),
          ),
        )
        .all();
      const max = docs.reduce((m, d) => {
        const n = Number(d.docNumber?.split("/")[2] ?? 0);
        return Number.isFinite(n) ? Math.max(m, n) : m;
      }, 0);
      if (max === 0) {
        counts.sequences += tx
          .delete(schema.warehouseDocSequences)
          .where(
            and(
              eq(schema.warehouseDocSequences.docType, s.docType),
              eq(schema.warehouseDocSequences.year, s.year),
            ),
          )
          .run().changes;
      } else if (max !== s.lastNumber) {
        tx.update(schema.warehouseDocSequences)
          .set({ lastNumber: max })
          .where(
            and(
              eq(schema.warehouseDocSequences.docType, s.docType),
              eq(schema.warehouseDocSequences.year, s.year),
            ),
          )
          .run();
        counts.sequences++;
      }
    }
  });

  return counts;
}
