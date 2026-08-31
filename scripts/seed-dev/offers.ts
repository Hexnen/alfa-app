/**
 * Generator danych deweloperskich — MODUŁ OFERTY.
 *
 * Zasiewa trzy warstwy, w tej kolejności, bo każda następna stoi na poprzedniej:
 *   1. KATALOG USŁUG (`services`) — robocizna i abonamenty z kosztem własnym,
 *   2. BIBLIOTEKA PAKIETÓW (`offer_packages`) — przepisy: „CCTV Dahua, N kamer",
 *   3. OFERTY (`offers`) w różnych stanach, złożone z tych pakietów.
 *
 * DLACZEGO USTAWIA NARZUT FIRMOWY. Cena sprzedaży towaru bez własnej ceny liczy
 * się z `company.warehouse_markup`; przy domyślnym zerze cała kartoteka
 * sprzedawałaby się po cenie zakupu, a każda oferta miałaby marżę 0% — czyli
 * moduł wyglądałby na zepsuty. Seed ustawia więc narzut i próg ostrzeżenia,
 * ale robi to przez REJESTR (`readRegistry`/`writeRegistry` z shared.ts):
 * zapisuje poprzednią wartość i cofa ją przy `--reset`, i tylko wtedy, gdy
 * w bazie nadal stoi to, co sam wpisał. Bez tego reset kasowałby ustawienie
 * użytkownika, którego nigdy nie dotykał.
 *
 * CENY POZYCJI SĄ MIGAWKĄ. Oferta zapisuje `unit_price`/`unit_cost` w chwili
 * dodania pozycji — tak jak robi to API. Seed liczy je tak samo (cena własna
 * towaru albo zakup + narzut), więc dokumenty są spójne z tym, co pokazałby
 * ekran, a przycisk „Przelicz ceny" nie ma czego poprawiać.
 *
 * CZEGO NIE ROBI. Nie akceptuje ofert przez API, więc nie powstają z nich
 * zlecenia ani dokumenty WZ — zaakceptowana oferta w danych deweloperskich ma
 * sam status. Tworzenie zlecenia to ścieżka z ekranu i ma zostać czymś, co
 * człowiek robi świadomie; seed nie ma prawa zaśmiecać rejestru zleceń.
 */

import { and, eq, inArray, like } from "drizzle-orm";
import { schema } from "../../src/db/index.js";
import {
  MARKER,
  addDays,
  dropRegistry,
  mark,
  pick,
  readRegistry,
  runInTx,
  TODAY,
  writeRegistry,
  assertNotSeeded,
  type Tx,
} from "./shared.js";

/** Narzut i próg wpisywane przez seed — patrz nagłówek pliku. */
const WAREHOUSE_MARKUP = "35";
const MIN_MARGIN_PCT = "20";

const REGISTRY_KEY = "seed.offers.settings";

interface SettingsRegistry {
  /** Poprzednie wartości: null = klucza w ogóle nie było. */
  warehouseMarkup: string | null;
  minMarginPct: string | null;
  /** Czy seed faktycznie je nadpisał (false = zastał już swoje). */
  applied: boolean;
}

const EMPTY_REGISTRY: SettingsRegistry = {
  warehouseMarkup: null,
  minMarginPct: null,
  applied: false,
};

export interface OffersCounts {
  services: number;
  packages: number;
  packageItems: number;
  offers: number;
  sections: number;
  items: number;
}

export interface OffersResetCounts {
  offers: number;
  packages: number;
  services: number;
  settings: number;
}

/* ------------------------------------------------------------------ */
/* 1. Katalog usług                                                     */
/* ------------------------------------------------------------------ */

interface ServiceDef {
  name: string;
  category: "montaz" | "uruchomienie" | "konfiguracja" | "serwis" | "projekt" | "abonament" | "inne";
  system: "cctv" | "sswin" | "kd" | "ppoz" | "sieci" | "inne" | null;
  unit: string;
  /** Koszt własny netto — robocizna technika, opłata hurtowa za łącze itd. */
  cost: number;
  price: number;
}

/**
 * Robocizna wyceniana od SZTUKI, nie od godziny — tak wygląda oferta na montaż
 * („montaż kamery: 150 zł"), i tylko tak da się ją przeskalować parametrem
 * pakietu. Stawka godzinowa zostaje w Cenniku, przy wycenach powykonawczych.
 */
const SERVICE_DEFS: ServiceDef[] = [
  // --- CCTV
  { name: "Montaż kamery IP", category: "montaz", system: "cctv", unit: "szt", cost: 60, price: 150 },
  { name: "Montaż kamery na słupie / wysięgniku", category: "montaz", system: "cctv", unit: "szt", cost: 120, price: 280 },
  { name: "Montaż i konfiguracja rejestratora", category: "montaz", system: "cctv", unit: "szt", cost: 90, price: 240 },
  { name: "Uruchomienie systemu CCTV", category: "uruchomienie", system: "cctv", unit: "kpl", cost: 180, price: 450 },
  { name: "Konfiguracja zdalnego podglądu", category: "konfiguracja", system: "cctv", unit: "kpl", cost: 70, price: 190 },
  { name: "Ustawienie stref detekcji i analityki", category: "konfiguracja", system: "cctv", unit: "szt", cost: 40, price: 110 },

  // --- SSWiN
  { name: "Montaż czujki ruchu", category: "montaz", system: "sswin", unit: "szt", cost: 45, price: 120 },
  { name: "Montaż kontaktronu", category: "montaz", system: "sswin", unit: "szt", cost: 25, price: 70 },
  { name: "Montaż centrali alarmowej z manipulatorem", category: "montaz", system: "sswin", unit: "kpl", cost: 150, price: 380 },
  { name: "Montaż sygnalizatora zewnętrznego", category: "montaz", system: "sswin", unit: "szt", cost: 70, price: 180 },
  { name: "Uruchomienie i programowanie centrali", category: "uruchomienie", system: "sswin", unit: "kpl", cost: 200, price: 490 },
  { name: "Podłączenie systemu do centrum monitorowania", category: "konfiguracja", system: "sswin", unit: "kpl", cost: 90, price: 250 },

  // --- Kontrola dostępu i sieci
  { name: "Montaż czytnika kontroli dostępu", category: "montaz", system: "kd", unit: "szt", cost: 80, price: 210 },
  { name: "Montaż zwory elektromagnetycznej", category: "montaz", system: "kd", unit: "szt", cost: 90, price: 230 },
  { name: "Konfiguracja kontrolera dostępu", category: "konfiguracja", system: "kd", unit: "kpl", cost: 120, price: 300 },
  { name: "Ułożenie okablowania w korycie", category: "montaz", system: "sieci", unit: "mb", cost: 4, price: 12 },
  { name: "Wykonanie przewiertu przez ścianę", category: "montaz", system: "sieci", unit: "szt", cost: 25, price: 65 },
  { name: "Montaż szafy teletechnicznej", category: "montaz", system: "sieci", unit: "szt", cost: 110, price: 280 },

  // --- Projekt i serwis
  { name: "Projekt techniczny systemu", category: "projekt", system: null, unit: "kpl", cost: 400, price: 1200 },
  { name: "Wizja lokalna i pomiary", category: "projekt", system: null, unit: "kpl", cost: 150, price: 350 },
  { name: "Przegląd okresowy systemu", category: "serwis", system: null, unit: "kpl", cost: 120, price: 320 },
  { name: "Dojazd serwisowy", category: "serwis", system: null, unit: "km", cost: 1.2, price: 2.5 },

  // --- Abonamenty (pozycje MIESIĘCZNE — drugi strumień pieniędzy na ofercie)
  { name: "Abonament: analityka obrazu", category: "abonament", system: "cctv", unit: "mies.", cost: 18, price: 60 },
  { name: "Abonament: internet LTE do obiektu", category: "abonament", system: "sieci", unit: "mies.", cost: 30, price: 80 },
  { name: "Abonament: grupa interwencyjna", category: "abonament", system: "sswin", unit: "mies.", cost: 140, price: 320 },
  { name: "Abonament: monitoring sygnałów alarmowych", category: "abonament", system: "sswin", unit: "mies.", cost: 25, price: 90 },
  { name: "Abonament: zdalny dozór wideo (wideoweryfikacja)", category: "abonament", system: "cctv", unit: "mies.", cost: 95, price: 260 },
];

/* ------------------------------------------------------------------ */
/* 2. Pakiety                                                           */
/* ------------------------------------------------------------------ */

/** Pozycja przepisu: skąd wziąć towar/usługę i jak przeskalować ilość. */
interface PkgItemDef {
  /** Fragment nazwy towaru w magazynie (wraz z marką) albo nazwa usługi. */
  match: string;
  /** Marka, gdy nazwa sama nie wystarcza do rozróżnienia (kamery, rejestratory). */
  brand?: string;
  kind: "material" | "labour" | "subscription";
  billing?: "one_time" | "monthly";
  qtyBase?: number;
  qtyPerParam?: number;
  round?: "none" | "up";
}

interface PkgDef {
  name: string;
  category: "cctv" | "sswin" | "kd" | "wideoweryfikacja" | "abonament" | "inne";
  manufacturer: string | null;
  description: string;
  mode: "parametric" | "fixed";
  param?: { key: string; label: string; default: number; min: number; max: number };
  items: PkgItemDef[];
}

/**
 * Przepisy odwzorowują to, jak instalacja naprawdę się skaluje:
 * kamera i jej montaż idą sztuka w sztukę, rejestrator i dysk co osiem kamer
 * (`round: "up"`), a uruchomienie systemu jest jedno, niezależnie od wielkości.
 */
const PACKAGE_DEFS: PkgDef[] = [
  {
    name: "CCTV Dahua — instalacja podstawowa",
    category: "cctv",
    manufacturer: "Dahua",
    description: "Kamery kopułowe 4MP, rejestrator PoE i dysk. Rejestrator i dysk dobierają się co osiem kamer.",
    mode: "parametric",
    param: { key: "cameras", label: "Liczba kamer", default: 8, min: 1, max: 64 },
    items: [
      { match: "Kamera IP kopułowa 4MP 2.8mm", brand: "Dahua", kind: "material", qtyPerParam: 1 },
      { match: "Rejestrator NVR 8 kanałów PoE", brand: "Dahua", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Dysk HDD 4TB Surveillance", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Switch PoE 8 portów 120W", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Skrętka UTP kat.6 drut żelowana", kind: "material", qtyPerParam: 35 },
      { match: "Montaż kamery IP", kind: "labour", qtyPerParam: 1 },
      { match: "Montaż i konfiguracja rejestratora", kind: "labour", qtyPerParam: 0.125, round: "up" },
      { match: "Uruchomienie systemu CCTV", kind: "labour", qtyBase: 1 },
      { match: "Konfiguracja zdalnego podglądu", kind: "labour", qtyBase: 1 },
    ],
  },
  {
    name: "CCTV Hikvision — instalacja podstawowa",
    category: "cctv",
    manufacturer: "Hikvision",
    description: "Ten sam zakres co pakiet Dahua, na sprzęcie Hikvision — do zestawiania wariantów w ofercie.",
    mode: "parametric",
    param: { key: "cameras", label: "Liczba kamer", default: 8, min: 1, max: 64 },
    items: [
      { match: "Kamera IP tubowa 4MP 2.8mm", brand: "Hikvision", kind: "material", qtyPerParam: 1 },
      { match: "Rejestrator NVR 16 kanałów PoE", brand: "Hikvision", kind: "material", qtyPerParam: 0.0625, round: "up" },
      { match: "Dysk HDD 4TB Surveillance", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Switch PoE 8 portów 120W", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Skrętka UTP kat.6 drut żelowana", kind: "material", qtyPerParam: 35 },
      { match: "Montaż kamery IP", kind: "labour", qtyPerParam: 1 },
      { match: "Montaż i konfiguracja rejestratora", kind: "labour", qtyPerParam: 0.0625, round: "up" },
      { match: "Uruchomienie systemu CCTV", kind: "labour", qtyBase: 1 },
    ],
  },
  {
    name: "CCTV Dahua — obiekt zewnętrzny (słupy)",
    category: "cctv",
    manufacturer: "Dahua",
    description: "Kamery tubowe na wysięgnikach, zasilanie buforowe i droższy montaż wysokościowy.",
    mode: "parametric",
    param: { key: "cameras", label: "Liczba kamer", default: 6, min: 1, max: 32 },
    items: [
      { match: "Kamera IP tubowa 8MP motozoom", brand: "Dahua", kind: "material", qtyPerParam: 1 },
      { match: "Uchwyt ścienny do kamery tubowej", kind: "material", qtyPerParam: 1 },
      { match: "Rejestrator NVR 8 kanałów PoE", brand: "Dahua", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Dysk HDD 8TB Surveillance", kind: "material", qtyPerParam: 0.125, round: "up" },
      { match: "Zasilacz buforowy 12V 10A", kind: "material", qtyPerParam: 0.25, round: "up" },
      { match: "Skrętka UTP kat.5e drut zewnętrzna", kind: "material", qtyPerParam: 60 },
      { match: "Montaż kamery na słupie / wysięgniku", kind: "labour", qtyPerParam: 1 },
      { match: "Uruchomienie systemu CCTV", kind: "labour", qtyBase: 1 },
    ],
  },
  {
    name: "SSWiN Satel — system alarmowy",
    category: "sswin",
    manufacturer: "Satel",
    description: "Centrala z manipulatorem, czujki i sygnalizator. Skaluje się liczbą czujek.",
    mode: "parametric",
    param: { key: "detectors", label: "Liczba czujek", default: 8, min: 1, max: 64 },
    items: [
      { match: "Centrala alarmowa 8 wejść z obudową", brand: "Satel", kind: "material", qtyBase: 1 },
      { match: "Manipulator LCD do centrali", kind: "material", qtyBase: 1 },
      { match: "Czujka PIR wewnętrzna", brand: "Satel", kind: "material", qtyPerParam: 1 },
      { match: "Kontaktron natynkowy", kind: "material", qtyPerParam: 0.5, round: "up" },
      { match: "Sygnalizator zewnętrzny optyczno-akustyczny", kind: "material", qtyBase: 1 },
      { match: "Akumulator żelowy 12V 17Ah", kind: "material", qtyBase: 1 },
      { match: "Przewód alarmowy YTDY 6x0.5", kind: "material", qtyPerParam: 25 },
      { match: "Montaż centrali alarmowej z manipulatorem", kind: "labour", qtyBase: 1 },
      { match: "Montaż czujki ruchu", kind: "labour", qtyPerParam: 1 },
      { match: "Montaż sygnalizatora zewnętrznego", kind: "labour", qtyBase: 1 },
      { match: "Uruchomienie i programowanie centrali", kind: "labour", qtyBase: 1 },
    ],
  },
  {
    name: "SSWiN Satel — rozszerzenie o strefy",
    category: "sswin",
    manufacturer: "Satel",
    description: "Sztywny zestaw do rozbudowy istniejącego systemu o kolejną strefę.",
    mode: "fixed",
    items: [
      { match: "Czujka PIR zewnętrzna dualna", kind: "material", qtyBase: 2 },
      { match: "Czujka kurtynowa PIR", kind: "material", qtyBase: 2 },
      { match: "Moduł GSM/LTE do centrali", kind: "material", qtyBase: 1 },
      { match: "Montaż czujki ruchu", kind: "labour", qtyBase: 4 },
      { match: "Uruchomienie i programowanie centrali", kind: "labour", qtyBase: 1 },
    ],
  },
  {
    name: "Kontrola dostępu — jedno przejście",
    category: "kd",
    manufacturer: null,
    description: "Sztywny zestaw na jedne drzwi: czytnik, zwora, zasilanie i konfiguracja.",
    mode: "fixed",
    items: [
      { match: "Montaż czytnika kontroli dostępu", kind: "labour", qtyBase: 1 },
      { match: "Montaż zwory elektromagnetycznej", kind: "labour", qtyBase: 1 },
      { match: "Konfiguracja kontrolera dostępu", kind: "labour", qtyBase: 1 },
      { match: "Zasilacz buforowy 12V 10A", kind: "material", qtyBase: 1 },
      { match: "Puszka hermetyczna IP66 100x100", kind: "material", qtyBase: 1 },
      { match: "Przewód alarmowy YTDY 6x0.5", kind: "material", qtyBase: 40 },
    ],
  },
  {
    name: "Abonament: dozór wideo z interwencją",
    category: "abonament",
    manufacturer: null,
    description: "Pozycje MIESIĘCZNE: analityka, łącze i grupa interwencyjna.",
    mode: "fixed",
    items: [
      { match: "Abonament: analityka obrazu", kind: "subscription", billing: "monthly", qtyBase: 1 },
      { match: "Abonament: internet LTE do obiektu", kind: "subscription", billing: "monthly", qtyBase: 1 },
      { match: "Abonament: grupa interwencyjna", kind: "subscription", billing: "monthly", qtyBase: 1 },
    ],
  },
  {
    name: "Abonament: monitoring sygnałów",
    category: "abonament",
    manufacturer: null,
    description: "Wariant tańszy: same sygnały alarmowe, bez interwencji i analityki.",
    mode: "fixed",
    items: [
      { match: "Abonament: monitoring sygnałów alarmowych", kind: "subscription", billing: "monthly", qtyBase: 1 },
    ],
  },
];

/* ------------------------------------------------------------------ */
/* 3. Oferty                                                            */
/* ------------------------------------------------------------------ */

/** Scenariusz oferty — po to, żeby lista pokazywała każdy stan dokumentu. */
interface OfferScenario {
  status: "draft" | "sent" | "accepted" | "rejected";
  kind: "rozbudowa" | "montaz" | "serwis";
  /** Nazwy pakietów do złożenia dokumentu. */
  packages: string[];
  /** Wartości parametrów per pakiet (klucz = nazwa pakietu). */
  params?: Record<string, Record<string, number>>;
  /** Procent ROCZNY; firmowa domyślna to 117% (company.lease_annual_rate). */
  lease?: { mode: "y1" | "y2" | "custom"; months?: number; rate: number; withLabour: boolean };
  discountPct?: number;
  /** Dni wstecz od TODAY — data wystawienia. */
  daysAgo: number;
  /** Ile dni ważna (od daty oferty). */
  validDays?: number;
  /** Drugi pakiet CCTV jako ALTERNATYWA, nie dodatek. */
  variantOfCctv?: boolean;
  /** Ostatnia sekcja jako opcja dodatkowa poza kwotą. */
  lastSectionOptional?: boolean;
  note: string;
}

const SCENARIOS: OfferScenario[] = [
  {
    status: "draft",
    kind: "montaz",
    packages: ["CCTV Dahua — instalacja podstawowa", "Abonament: dozór wideo z interwencją"],
    params: { "CCTV Dahua — instalacja podstawowa": { cameras: 12 } },
    daysAgo: 3,
    validDays: 30,
    note: "Szkic w trakcie ustalania zakresu z klientem.",
  },
  {
    status: "draft",
    kind: "montaz",
    packages: [
      "CCTV Dahua — instalacja podstawowa",
      "CCTV Hikvision — instalacja podstawowa",
      "Abonament: monitoring sygnałów",
    ],
    params: {
      "CCTV Dahua — instalacja podstawowa": { cameras: 8 },
      "CCTV Hikvision — instalacja podstawowa": { cameras: 8 },
    },
    variantOfCctv: true,
    daysAgo: 6,
    validDays: 30,
    note: "Dwa warianty sprzętowe do wyboru przez klienta — liczy się tylko wybrany.",
  },
  {
    status: "sent",
    kind: "montaz",
    packages: ["CCTV Dahua — obiekt zewnętrzny (słupy)", "Abonament: dozór wideo z interwencją"],
    params: { "CCTV Dahua — obiekt zewnętrzny (słupy)": { cameras: 6 } },
    lease: { mode: "y2", rate: 117, withLabour: false },
    daysAgo: 12,
    validDays: 30,
    note: "Sprzęt w dzierżawie 24 mies., montaż płatny jednorazowo.",
  },
  {
    status: "sent",
    kind: "montaz",
    packages: ["SSWiN Satel — system alarmowy", "Abonament: dozór wideo z interwencją"],
    params: { "SSWiN Satel — system alarmowy": { detectors: 14 } },
    lease: { mode: "y1", rate: 130, withLabour: true },
    daysAgo: 20,
    // Ważność z zapasem: seed ma zamrożone `TODAY`, a aplikacja liczy wygaśnięcie
    // wg PRAWDZIWEGO zegara. Przy krótkim terminie oferta „wysłana" wpadałaby
    // w „wygasła" po kilku dniach od zasiania i zestaw danych by się wyjałowił.
    validDays: 60,
    note: "Dzierżawa roczna razem z robocizną — klient nie płaci nic z góry.",
  },
  {
    // Marża zjedzona rabatem — jedyna oferta, która ma zapalić czerwone
    // ostrzeżenie o zejściu poniżej progu `company.min_margin_pct`.
    status: "sent",
    kind: "montaz",
    packages: ["CCTV Hikvision — instalacja podstawowa"],
    params: { "CCTV Hikvision — instalacja podstawowa": { cameras: 10 } },
    discountPct: 25,
    daysAgo: 15,
    validDays: 60,
    note: "Rabat 25% wycięty na negocjacjach — marża poniżej progu, do decyzji szefa.",
  },
  {
    status: "sent",
    kind: "rozbudowa",
    packages: ["SSWiN Satel — rozszerzenie o strefy", "Kontrola dostępu — jedno przejście"],
    lastSectionOptional: true,
    daysAgo: 9,
    validDays: 30,
    note: "Rozbudowa istniejącego systemu; kontrola dostępu jako opcja dodatkowa.",
  },
  {
    status: "accepted",
    kind: "montaz",
    packages: ["CCTV Dahua — instalacja podstawowa", "Abonament: dozór wideo z interwencją"],
    params: { "CCTV Dahua — instalacja podstawowa": { cameras: 16 } },
    lease: { mode: "y2", rate: 110, withLabour: false },
    discountPct: 5,
    daysAgo: 45,
    validDays: 30,
    note: "Przyjęta przez klienta; rabat 5% wynegocjowany na spotkaniu.",
  },
  {
    status: "accepted",
    kind: "rozbudowa",
    packages: ["CCTV Hikvision — instalacja podstawowa"],
    params: { "CCTV Hikvision — instalacja podstawowa": { cameras: 4 } },
    daysAgo: 70,
    validDays: 30,
    note: "Dołożenie czterech kamer na magazynie wysokiego składowania.",
  },
  {
    status: "rejected",
    kind: "montaz",
    packages: ["CCTV Dahua — obiekt zewnętrzny (słupy)"],
    params: { "CCTV Dahua — obiekt zewnętrzny (słupy)": { cameras: 10 } },
    daysAgo: 55,
    validDays: 30,
    note: "Klient wybrał tańszą ofertę konkurencji.",
  },
  {
    // Ważność minęła — status „expired" NIE jest zapisywany w bazie, tylko
    // wyliczany przy odczycie z `valid_until`. Ten wiersz to test tej reguły.
    status: "sent",
    kind: "serwis",
    packages: ["Kontrola dostępu — jedno przejście"],
    daysAgo: 120,
    validDays: 14,
    note: "Oferta po terminie ważności — na liście powinna pokazać się jako wygasła.",
  },
];

/* ------------------------------------------------------------------ */
/* Pomocnicze                                                           */
/* ------------------------------------------------------------------ */

type WarehouseRow = typeof schema.warehouseItems.$inferSelect;
type ServiceRow = typeof schema.services.$inferSelect;

/** Cena sprzedaży towaru: własna albo z narzutu (to samo, co robi API). */
function salePriceOf(item: WarehouseRow, markupPct: number): number {
  if (item.salePrice !== null && item.salePrice !== undefined) return item.salePrice;
  if (item.purchasePrice === null || item.purchasePrice === undefined) return 0;
  return Math.round(item.purchasePrice * (1 + markupPct / 100) * 100) / 100;
}

/** Ilość pozycji pakietu po przeskalowaniu — lustro `qtyFor` z offer-packages.ts. */
function qtyFor(def: PkgItemDef, paramValue: number): number {
  const raw = (def.qtyBase ?? 0) + (def.qtyPerParam ?? 0) * paramValue;
  if (def.round === "up") return Math.ceil(raw - 1e-9);
  return Math.round(raw * 1000) / 1000;
}

/* ------------------------------------------------------------------ */
/* SEED                                                                 */
/* ------------------------------------------------------------------ */

export function seedOffers(outerTx?: Tx): OffersCounts {
  return runInTx(outerTx, (tx) => {
    const counts: OffersCounts = {
      services: 0,
      packages: 0,
      packageItems: 0,
      offers: 0,
      sections: 0,
      items: 0,
    };

    const already = tx
      .select({ id: schema.offerPackages.id })
      .from(schema.offerPackages)
      .where(like(schema.offerPackages.description, `%${MARKER}%`))
      .all();
    assertNotSeeded("offers", already.length > 0);

    /* --- 0. Ustawienia firmowe (przez rejestr, żeby reset je cofnął) --- */
    const prevMarkup =
      tx
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.key, "company.warehouse_markup"))
        .get()?.value ?? null;
    const prevMinMargin =
      tx
        .select()
        .from(schema.appSettings)
        .where(eq(schema.appSettings.key, "company.min_margin_pct"))
        .get()?.value ?? null;

    writeRegistry(REGISTRY_KEY, {
      warehouseMarkup: prevMarkup,
      minMarginPct: prevMinMargin,
      applied: true,
    } satisfies SettingsRegistry);

    for (const [key, value] of [
      ["company.warehouse_markup", WAREHOUSE_MARKUP],
      ["company.min_margin_pct", MIN_MARGIN_PCT],
    ] as const) {
      tx.insert(schema.appSettings)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema.appSettings.key, set: { value } })
        .run();
    }
    const markupPct = Number(WAREHOUSE_MARKUP);

    /* --- 1. Katalog usług --------------------------------------------- */
    const serviceByName = new Map<string, ServiceRow>();
    SERVICE_DEFS.forEach((def, i) => {
      const row = tx
        .insert(schema.services)
        .values({
          name: def.name,
          category: def.category,
          system: def.system,
          unit: def.unit,
          cost: def.cost,
          price: def.price,
          // Opis niesie MARKER — po nim `--reset` znajduje usługi seeda.
          description: mark(`${def.category} · koszt własny ${def.cost} zł netto`),
          position: i + 1,
        })
        .returning()
        .get();
      serviceByName.set(def.name, row);
      counts.services++;
    });

    /* --- 2. Pakiety ---------------------------------------------------- */
    // Towary bierzemy z kartoteki (mogą, ale nie muszą pochodzić z seeda
    // magazynu) — pakiet ma wskazywać na to, co firma faktycznie ma.
    const warehouseItems = tx
      .select()
      .from(schema.warehouseItems)
      .where(eq(schema.warehouseItems.isArchived, false))
      .all();

    const findItem = (match: string, brand?: string): WarehouseRow | null => {
      const byName = warehouseItems.filter((i) => i.name === match);
      if (byName.length === 0) return null;
      if (!brand) return byName[0];
      return byName.find((i) => i.manufacturer === brand) ?? byName[0];
    };

    interface BuiltPackage {
      id: number;
      def: PkgDef;
    }
    const packageByName = new Map<string, BuiltPackage>();

    for (const [pi, def] of PACKAGE_DEFS.entries()) {
      const pkg = tx
        .insert(schema.offerPackages)
        .values({
          name: def.name,
          category: def.category,
          manufacturer: def.manufacturer,
          description: mark(def.description),
          mode: def.mode,
          params: def.param ? JSON.stringify([def.param]) : "[]",
          position: pi + 1,
        })
        .returning()
        .get();
      counts.packages++;
      packageByName.set(def.name, { id: pkg.id, def });

      def.items.forEach((it, ii) => {
        const service = it.kind === "labour" || it.kind === "subscription"
          ? serviceByName.get(it.match) ?? null
          : null;
        const item = service ? null : findItem(it.match, it.brand);

        // Brak trafienia znaczy, że przepis wskazuje na coś, czego w bazie nie
        // ma — milczące pominięcie dałoby pakiet uboższy, niż wygląda w kodzie.
        if (!service && !item) {
          throw new Error(
            `Pakiet „${def.name}": nie znaleziono pozycji „${it.match}"` +
              (it.brand ? ` (marka ${it.brand})` : "") +
              ". Zasiej najpierw magazyn (--only=warehouse) albo popraw nazwę w PACKAGE_DEFS.",
          );
        }

        tx.insert(schema.offerPackageItems)
          .values({
            packageId: pkg.id,
            position: ii + 1,
            source: service ? "service" : "warehouse",
            warehouseItemId: item?.id ?? null,
            serviceId: service?.id ?? null,
            name: service?.name ?? item?.name ?? it.match,
            unit: service?.unit ?? item?.unit ?? "szt",
            kind: it.kind,
            billing: it.billing ?? "one_time",
            qtyBase: it.qtyBase ?? 0,
            qtyPerParam: def.mode === "fixed" ? 0 : it.qtyPerParam ?? 0,
            paramKey: def.mode === "fixed" ? null : def.param?.key ?? null,
            qtyRound: it.round ?? "none",
          })
          .run();
        counts.packageItems++;
      });
    }

    /* --- 3. Oferty ------------------------------------------------------ */
    // Klienci i obiekty z kartoteki: oferta bez kontrahenta jest sierotą,
    // a przez `object_id` wchodzi potem do historii obiektu.
    const contractors = tx
      .select()
      .from(schema.contractors)
      .where(eq(schema.contractors.active, true))
      .all();
    const objects = tx.select().from(schema.objects).all();
    const salespeople = tx
      .select()
      .from(schema.salespeople)
      .where(eq(schema.salespeople.active, true))
      .all();
    const companies = tx
      .select()
      .from(schema.companies)
      .where(eq(schema.companies.active, true))
      .all();

    if (contractors.length === 0) {
      throw new Error(
        "Brak kontrahentów w bazie — oferty nie mają dla kogo powstać. " +
          "Zasiej najpierw: npx tsx scripts/seed-dev-year.ts --only=commercial",
      );
    }

    /** Kolejny numer w miesiącu — ta sama reguła co `nextOfferNumberSync`. */
    const nextNumber = (date: string): string => {
      const prefix = `OF/${date.slice(0, 4)}/${date.slice(5, 7)}/`;
      const rows = tx
        .select({ number: schema.offers.number })
        .from(schema.offers)
        .where(like(schema.offers.number, `${prefix}%`))
        .all();
      const max = rows.reduce((m, r) => {
        const n = parseInt(r.number.slice(prefix.length).split("-")[0]);
        return Number.isFinite(n) && n > m ? n : m;
      }, 0);
      return `${prefix}${String(max + 1).padStart(3, "0")}`;
    };

    for (const sc of SCENARIOS) {
      const date = addDays(TODAY, -sc.daysAgo);
      const contractor = pick(contractors);
      // Obiekt tego samego kontrahenta, gdy jakiś ma — inaczej oferta bez obiektu.
      const own = objects.filter((o) => o.contractorId === contractor.id);
      const object = own.length ? pick(own) : null;

      const offer = tx
        .insert(schema.offers)
        .values({
          number: nextNumber(date),
          date,
          validUntil: sc.validDays ? addDays(date, sc.validDays) : null,
          sentAt: sc.status === "draft" ? null : date,
          kind: sc.kind,
          status: sc.status,
          contractorId: contractor.id,
          clientName: contractor.name,
          clientNip: contractor.nip ?? "",
          objectId: object?.id ?? null,
          site: object?.name ?? "",
          address: [object?.address, object?.city].filter(Boolean).join(", "),
          salespersonId: salespeople.length ? pick(salespeople).id : null,
          companyId: companies.length ? pick(companies).id : null,
          discountPct: sc.discountPct ?? 0,
          leaseMode: sc.lease?.mode ?? "none",
          leaseMonths: sc.lease?.mode === "custom" ? sc.lease.months ?? null : null,
          leaseAnnualRate: sc.lease?.rate ?? null,
          leaseIncludeLabour: sc.lease?.withLabour ?? false,
          notes: mark(sc.note),
          createdBy: "msajdak",
        })
        .returning()
        .get();
      counts.offers++;

      const cctvNames = sc.packages.filter((n) => packageByName.get(n)?.def.category === "cctv");

      sc.packages.forEach((pkgName, si) => {
        const built = packageByName.get(pkgName);
        if (!built) throw new Error(`Scenariusz oferty wskazuje nieznany pakiet „${pkgName}"`);
        const params = sc.params?.[pkgName] ?? {};
        const paramValue = built.def.param ? params[built.def.param.key] ?? built.def.param.default : 0;

        // Warianty: dwa pakiety CCTV w jednej grupie, wybrany tylko pierwszy.
        const isVariant = !!sc.variantOfCctv && cctvNames.includes(pkgName);
        const isLast = si === sc.packages.length - 1;

        const section = tx
          .insert(schema.offerSections)
          .values({
            offerId: offer.id,
            position: si + 1,
            category: built.def.category,
            title: built.def.name,
            packageId: built.id,
            params: JSON.stringify(built.def.param ? { [built.def.param.key]: paramValue } : {}),
            isOptional: !!sc.lastSectionOptional && isLast,
            variantGroup: isVariant ? "system CCTV" : null,
            variantSelected: isVariant ? cctvNames.indexOf(pkgName) === 0 : true,
          })
          .returning()
          .get();
        counts.sections++;

        const pkgItems = tx
          .select()
          .from(schema.offerPackageItems)
          .where(eq(schema.offerPackageItems.packageId, built.id))
          .orderBy(schema.offerPackageItems.position)
          .all();

        let position = 0;
        for (const pi of pkgItems) {
          const qty =
            built.def.mode === "fixed"
              ? pi.qtyBase
              : qtyFor(
                  {
                    match: pi.name,
                    kind: pi.kind as PkgItemDef["kind"],
                    qtyBase: pi.qtyBase,
                    qtyPerParam: pi.qtyPerParam,
                    round: pi.qtyRound,
                  },
                  paramValue,
                );
          if (qty <= 0) continue;

          // Ceny to MIGAWKA liczona tak samo jak w API — inaczej „Przelicz ceny"
          // od razu po zasianiu zgłaszałby rozjazd na każdej pozycji.
          let unitCost: number | null = null;
          let unitPrice = 0;
          if (pi.source === "warehouse" && pi.warehouseItemId !== null) {
            const item = warehouseItems.find((w) => w.id === pi.warehouseItemId);
            unitCost = item?.purchasePrice ?? null;
            unitPrice = item ? salePriceOf(item, markupPct) : 0;
          } else if (pi.source === "service" && pi.serviceId !== null) {
            const svc = SERVICE_DEFS.find(
              (s) => serviceByName.get(s.name)?.id === pi.serviceId,
            );
            unitCost = svc?.cost ?? null;
            unitPrice = svc?.price ?? 0;
          }

          position += 1;
          tx.insert(schema.offerItems)
            .values({
              offerId: offer.id,
              sectionId: section.id,
              position,
              source: pi.source,
              warehouseItemId: pi.warehouseItemId,
              serviceId: pi.serviceId,
              name: pi.name,
              unit: pi.unit,
              qty,
              kind: pi.kind,
              billing: pi.billing,
              unitCost,
              unitPrice,
              discountPct: 0,
              isOptional: false,
            })
            .run();
          counts.items++;
        }
      });
    }

    return counts;
  });
}

/* ------------------------------------------------------------------ */
/* RESET                                                                */
/* ------------------------------------------------------------------ */

export function resetOffers(outerTx?: Tx): OffersResetCounts {
  return runInTx(outerTx, (tx) => {
    const counts: OffersResetCounts = { offers: 0, packages: 0, services: 0, settings: 0 };

    /* --- Oferty (sekcje i pozycje lecą kaskadą) ------------------------ */
    const offers = tx
      .select({ id: schema.offers.id })
      .from(schema.offers)
      .where(like(schema.offers.notes, `%${MARKER}%`))
      .all();
    if (offers.length) {
      const ids = offers.map((o) => o.id);
      tx.delete(schema.offerItems).where(inArray(schema.offerItems.offerId, ids)).run();
      tx.delete(schema.offerSections).where(inArray(schema.offerSections.offerId, ids)).run();
      tx.delete(schema.offers).where(inArray(schema.offers.id, ids)).run();
      // Dziennik aktywności zostawiłby sieroty (`activity_log` celowo nie ma
      // klucza obcego do encji), więc kasujemy go po ID TYCH ofert. Zamiatanie
      // całego `entity_type = 'offer'` zabrałoby historię dokumentów, które
      // ktoś założył z ekranu — a tych seed nigdy nie widział.
      tx.delete(schema.activityLog)
        .where(
          and(
            eq(schema.activityLog.entityType, "offer"),
            inArray(schema.activityLog.entityId, ids)
          )
        )
        .run();
      counts.offers = ids.length;
    }

    /* --- Pakiety PRZED usługami --------------------------------------- */
    // `offer_package_items.service_id` ma ON DELETE CASCADE, więc kasowanie
    // usług najpierw wyrwałoby pozycje z pakietów, których nie ruszamy.
    const packages = tx
      .select({ id: schema.offerPackages.id })
      .from(schema.offerPackages)
      .where(like(schema.offerPackages.description, `%${MARKER}%`))
      .all();
    if (packages.length) {
      const ids = packages.map((p) => p.id);
      tx.delete(schema.offerPackageItems)
        .where(inArray(schema.offerPackageItems.packageId, ids))
        .run();
      tx.delete(schema.offerPackages).where(inArray(schema.offerPackages.id, ids)).run();
      tx.delete(schema.activityLog)
        .where(
          and(
            eq(schema.activityLog.entityType, "offer_package"),
            inArray(schema.activityLog.entityId, ids)
          )
        )
        .run();
      counts.packages = ids.length;
    }

    /* --- Usługi -------------------------------------------------------- */
    const services = tx
      .select({ id: schema.services.id })
      .from(schema.services)
      .where(like(schema.services.description, `%${MARKER}%`))
      .all();
    if (services.length) {
      const ids = services.map((s) => s.id);
      tx.delete(schema.services).where(inArray(schema.services.id, ids)).run();
      counts.services = ids.length;
    }

    /* --- Ustawienia firmowe — tylko to, co seed sam wpisał ------------- */
    const reg = readRegistry<SettingsRegistry>(REGISTRY_KEY, EMPTY_REGISTRY);
    if (reg.applied) {
      const restore = (key: string, previous: string | null, seeded: string) => {
        const current = tx
          .select()
          .from(schema.appSettings)
          .where(eq(schema.appSettings.key, key))
          .get()?.value;
        // Ktoś zmienił wartość po seedzie — to już jego decyzja, nie ruszamy.
        if (current !== seeded) return;
        if (previous === null) {
          tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
        } else {
          tx.update(schema.appSettings)
            .set({ value: previous })
            .where(eq(schema.appSettings.key, key))
            .run();
        }
        counts.settings++;
      };
      restore("company.warehouse_markup", reg.warehouseMarkup, WAREHOUSE_MARKUP);
      restore("company.min_margin_pct", reg.minMarginPct, MIN_MARGIN_PCT);
      dropRegistry(REGISTRY_KEY);
    }

    return counts;
  });
}
