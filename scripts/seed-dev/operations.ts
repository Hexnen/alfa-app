/**
 * Warstwa OPERACYJNA danych deweloperskich: kalendarz → realizacje → protokoły → wyceny.
 *
 * Moduł uruchamia się PO `commercial.ts` i wiesza się na jego obiektach: bez nich
 * wydarzenie nie ma gdzie się odbyć, a realizacja nie ma z czego wziąć nazwy obiektu
 * ani danych klienta do protokołu.
 *
 * NAJWAŻNIEJSZA ZASADA — przepływ dokumentów. W aplikacji to nie seed decyduje,
 * co z czego powstaje: `src/lib/calendar-realizations.ts` robi z wydarzenia realizację,
 * a z realizacji protokół i (dla prac płatnych) wycenę. Dane deweloperskie mają ten
 * przepływ ODWZOROWAĆ, a nie wymyślić własny, więc pola realizacji liczy tu wprost
 * `mapEventToRealization()` — ta sama funkcja, którą wywoła automat przy najbliższej
 * edycji wydarzenia. Gdyby seed policzył je po swojemu, pierwsza edycja wydarzenia
 * w UI „poprawiłaby” połowę bazy i wyglądałoby to na błąd aplikacji.
 *
 * Czego automat NIE dotyka i co dlatego wypełnia seed: kwoty (`amount*`, `discount`),
 * `hourlyCost`, `actualKm`, `caretaker`, fakturowanie — to domena księgowości.
 *
 * Trzy zasady z `shared.ts` obowiązują bez wyjątku: losowość wyłącznie przez `rng()`,
 * każdy wiersz niesie MARKER w polu tekstowym, daty siedzą w PERIOD.
 */
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "../../src/db/index.js";
import type { CalendarEvent, CalendarEventStatus, CalendarEventType } from "../../src/db/schema.js";
import { mapEventToRealization } from "../../src/lib/calendar-realizations.js";
import { expandOccurrences } from "../../src/lib/calendar-recurrence.js";
import { workTypeFromEventType } from "../../src/lib/protocol-prefill.js";
import { getCompanyConfig } from "../../src/lib/company-config.js";
import {
  MARKER,
  PERIOD,
  TODAY,
  addDays,
  chance,
  int,
  isSeeded,
  isWorkday,
  mark,
  money,
  num,
  parseDate,
  personName,
  pick,
  rng,
  seed,
  weighted,
} from "./shared.js";

/** Uchwyt transakcyjny drizzle — ten sam interfejs co `db`, ale w otwartej transakcji. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Ziarno modułu. Seedujemy TUTAJ (jak `commercial.ts`), żeby `seedOperations()` dawało
 * ten sam wynik niezależnie od tego, co uruchomiło się przed nim. Wartość inna niż
 * w handlu — dwa moduły na tym samym ziarnie ciągnęłyby bliźniaczy strumień liczb.
 */
const SEED = 20260830;

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

/**
 * Format `calendar_events.start_at` z daty i minut od północy: "YYYY-MM-DDTHH:MM".
 * Minuty normalizujemy sami, bo składanie „godzina + pół godziny trwania” potrafi
 * dać 60 minut, a `HH:60` przeszłoby przez INSERT i wywróciło dopiero parser dat.
 */
const at = (iso: string, minutesOfDay: number): string =>
  `${iso}T${pad2(Math.floor(minutesOfDay / 60))}:${pad2(minutesOfDay % 60)}`;

/** Dzieli listę na paczki — jeden INSERT na paczkę zamiast jednego na wiersz. */
function chunks<T>(rows: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Kopie `clean`/`clip` z `src/lib/protocol-prefill.ts` — patrz `protocolActivities()`. */
const clean = (v: string | null | undefined): string => (v ?? "").replace(/\s+/g, " ").trim();
const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Znacznik „przechodni”: MARKER jest już w `description` wydarzenia, więc pola, które
 * aplikacja SKŁADA z tytułu i opisu (adnotacja realizacji, czynności protokołu),
 * niosą go same z siebie. Doklejanie drugiego znacznika przez `mark()` dałoby tekst
 * RÓŻNY od tego, co policzy automat — a wtedy pierwsza edycja wydarzenia w UI
 * przepisałaby połowę realizacji przez `syncRealizationFromEvent()` i po drodze
 * zgubiła znacznik, którego szuka `--reset`. `mark()` zostaje jako siatka
 * bezpieczeństwa na wypadek, gdyby przycinanie długości zjadło znacznik.
 */
const keepMarked = (text: string): string => (isSeeded(text) ? text : mark(text));

/** Wszystkie dni okna PERIOD, po kolei. */
function daysInPeriod(): string[] {
  const out: string[] = [];
  for (let d: string = PERIOD.from; d <= PERIOD.to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Data nie później niż TODAY — dla pól, które opisują coś już wykonanego. */
const notAfterToday = (iso: string): string => (iso > TODAY ? TODAY : iso);

/**
 * Alokator numerów dokumentów w konwencji z `src/routes/*.ts`:
 * `P/RRRR/MM/NNN` (protokoły) i `W/RRRR/MM/NNN` (wyceny).
 *
 * Liczniki startują od NAJWYŻSZEGO numeru, jaki jest już w bazie w danym miesiącu —
 * tak samo, jak robi to `nextProtocolNumberSync`. Trzymamy je w pamięci, zamiast wołać
 * tamtą funkcję: przy ~250 dokumentach byłoby to ~250 zapytań `LIKE` po całej tabeli,
 * a wynik jest identyczny, bo w transakcji seeda nikt inny nie alokuje numerów.
 */
function numberAllocator(
  prefixLetter: "P" | "W",
  existing: readonly string[],
): (dateIso: string) => string {
  const maxSeq = new Map<string, number>();
  for (const number of existing) {
    const m = new RegExp(`^${prefixLetter}/(\\d{4})/(\\d{2})/(\\d+)$`).exec(number);
    if (!m) continue;
    const key = `${m[1]}/${m[2]}`;
    const n = Number(m[3]);
    if (Number.isFinite(n) && n > (maxSeq.get(key) ?? 0)) maxSeq.set(key, n);
  }
  return (dateIso: string) => {
    const key = `${dateIso.slice(0, 4)}/${dateIso.slice(5, 7)}`;
    const next = (maxSeq.get(key) ?? 0) + 1;
    maxSeq.set(key, next);
    return `${prefixLetter}/${key}/${String(next).padStart(3, "0")}`;
  };
}

/* ------------------------------------------------------------------ */
/* Wynik                                                               */
/* ------------------------------------------------------------------ */

export interface OperationsCounts {
  series: number;
  events: number;
  assignees: number;
  notes: number;
  realizations: number;
  protocols: number;
  quotes: number;
  activity: number;
}

const emptyCounts = (): OperationsCounts => ({
  series: 0,
  events: 0,
  assignees: 0,
  notes: 0,
  realizations: 0,
  protocols: 0,
  quotes: 0,
  activity: 0,
});

/* ------------------------------------------------------------------ */
/* Słowniki — polskie, fikcyjne, ale z branży                          */
/* ------------------------------------------------------------------ */

/** Tytuły i opisy per typ wydarzenia. Pierwszy człon idzie do tytułu, drugi do opisu. */
const WORK: Record<CalendarEventType, ReadonlyArray<readonly [string, string]>> = {
  serwis: [
    ["Brak obrazu z kamery", "Kamera nie wysyła strumienia — diagnostyka toru wizyjnego i zasilania PoE."],
    ["Rejestrator się zawiesza", "Restarty rejestratora co kilka godzin; kontrola dysków i temperatury szafy."],
    ["Wymiana dysku w rejestratorze", "Dysk zgłasza błędy SMART, wymiana i odbudowa macierzy."],
    ["Awaria zasilania toru kamerowego", "Zadziałało zabezpieczenie w skrzynce; pomiar obciążenia i wymiana zasilacza."],
    ["Regulacja pól widzenia", "Klient zgłasza martwą strefę przy bramie — korekta ustawienia kamer."],
    ["Naprawa łącza światłowodowego", "Uszkodzenie kabla po pracach ziemnych; spawanie i pomiar reflektometrem."],
    ["Serwis kontroli dostępu", "Czytnik przy wejściu głównym nie odczytuje kart."],
    ["Usunięcie usterki po burzy", "Przepięcie w instalacji — przegląd ochronników i wymiana uszkodzonego switcha."],
  ],
  montaz: [
    ["Montaż kamer zewnętrznych", "Montaż kamer na słupach, trasa kablowa w peszlu, konfiguracja rejestratora."],
    ["Rozbudowa monitoringu o kolejne kamery", "Dołożenie kamer w nowej hali, przełączenie na istniejący rejestrator."],
    ["Montaż systemu alarmowego", "Centrala, czujki ruchu, sygnalizator zewnętrzny i moduł GSM."],
    ["Montaż kontroli dostępu", "Czytniki, elektrozaczepy i przyciski wyjścia przy wejściach do biura."],
    ["Uruchomienie rejestratora i macierzy", "Konfiguracja nagrywania, kont użytkowników i zdalnego podglądu."],
    ["Montaż szafy teletechnicznej", "Szafa 12U, listwa zasilająca, patchpanel i opis okablowania."],
  ],
  wizja: [
    ["Wizja lokalna przed ofertą", "Pomiar tras kablowych, ustalenie punktów montażowych i zasilania."],
    ["Wizja lokalna — rozbudowa systemu", "Inwentaryzacja istniejącej instalacji pod kątem dołożenia kamer."],
    ["Wizja lokalna z klientem", "Omówienie zakresu prac i ustalenie harmonogramu montażu."],
  ],
  demontaz: [
    ["Demontaż instalacji po zakończeniu umowy", "Zdjęcie kamer i osprzętu, zabezpieczenie przejść kablowych."],
    ["Demontaż sprzętu dzierżawionego", "Odbiór rejestratora i kamer, protokolarne przekazanie sprzętu."],
  ],
  konserwacja: [
    ["Przegląd okresowy systemu CCTV", "Czyszczenie kloszy, kontrola mocowań, test nagrań i zapisu na dysku."],
    ["Konserwacja systemu alarmowego", "Test czujek, kontrola akumulatorów i łączności z centrum monitorowania."],
    ["Przegląd kontroli dostępu", "Kontrola elektrozaczepów, czytników i zasilania awaryjnego."],
    ["Konserwacja instalacji na obiekcie", "Przegląd szafy teletechnicznej, aktualizacja firmware i kopia konfiguracji."],
  ],
  biuro: [
    ["Dokumentacja powykonawcza", "Opis instalacji, schematy i przekazanie kompletu klientowi."],
    ["Przygotowanie ofert", "Wyceny na podstawie wizji lokalnych z ostatniego tygodnia."],
    ["Rozliczenie miesiąca", "Uzgodnienie realizacji i protokołów przed fakturowaniem."],
  ],
  przygotowanie: [
    ["Przygotowanie sprzętu do montażu", "Kompletacja kamer, kabli i osprzętu z magazynu, wstępna konfiguracja."],
    ["Prekonfiguracja rejestratora", "Adresacja, konta i harmonogram nagrywania przed wyjazdem na obiekt."],
  ],
  urlop: [
    ["Urlop wypoczynkowy", "Nieobecność planowana."],
    ["Urlop na żądanie", "Nieobecność zgłoszona z dnia na dzień."],
  ],
};

/** Sprzęt do pozycji protokołu — w odróżnieniu od kabli ma numer seryjny. */
const HARDWARE = [
  ["KAMERA TUBOWA 4MPX", "szt."],
  ["KAMERA KOPUŁOWA 4MPX", "szt."],
  ["KAMERA OBROTOWA PTZ", "szt."],
  ["REJESTRATOR NVR 16CH", "szt."],
  ["SWITCH POE 8 PORTÓW", "szt."],
  ["ZASILACZ BUFOROWY 12V", "szt."],
  ["DYSK TWARDY 4TB", "szt."],
  ["UCHWYT NAROŻNY DO KAMERY", "szt."],
] as const;

/** Treści notatek do wydarzeń wykonanych — dziennik z obiektu. */
const NOTE_TEXTS = [
  "Klient potwierdził zakres prac na miejscu.",
  "Brak dostępu do jednego pomieszczenia — dokończenie w kolejnym terminie.",
  "Przekazano zalecenia dotyczące czyszczenia kloszy co kwartał.",
  "Sprzęt pobrany z magazynu, reszta materiału zwrócona.",
  "Uzgodniono z ochroną wejście po godzinie 16:00.",
  "Do wymiany zasilacz przy bramie — ujęte w wycenie.",
  "Podpis odebrany od kierownika obiektu.",
] as const;

/* ------------------------------------------------------------------ */
/* Kontekst z bazy — wszystko czytane w czasie działania               */
/* ------------------------------------------------------------------ */

interface LoadedObject {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  department: string;
  status: string;
  contractorId: number;
}

interface LoadedContractor {
  id: number;
  name: string;
  nip: string;
  city: string | null;
  phone: string | null;
  contactPerson: string | null;
  salespersonId: number | null;
}

interface LoadedTechnician {
  id: number;
  name: string;
  active: boolean;
}

interface PriceItem {
  name: string;
  unit: string;
  price: number;
  kind: string;
}

interface Context {
  objects: LoadedObject[];
  /** Pula do losowania obiektu — z powtórzeniami, patrz `buildObjectPool`. */
  objectPool: LoadedObject[];
  contractorById: Map<number, LoadedContractor>;
  salespersonById: Map<number, string>;
  technicians: LoadedTechnician[];
  materials: PriceItem[];
  services: PriceItem[];
  userId: number | null;
  userLabel: string | null;
  rates: { hour: number; km: number; hourlyCost: number; markup: number; roundTrip: boolean };
}

/**
 * Rozkład wydarzeń po obiektach jest CELOWO nierówny: co piąty obiekt dostaje
 * czterokrotnie większą szansę. Na płaskim rozkładzie ranking „obiekty z największą
 * liczbą serwisów” i wykrywanie obiektów awaryjnych pokazują szum, a nie sygnał.
 */
function buildObjectPool(objects: readonly LoadedObject[]): LoadedObject[] {
  const heavy = new Set(shuffle([...objects.keys()]).slice(0, Math.ceil(objects.length / 5)));
  const pool: LoadedObject[] = [];
  objects.forEach((o, i) => {
    const times = heavy.has(i) ? 4 : 1;
    for (let k = 0; k < times; k++) pool.push(o);
  });
  return pool;
}

function loadContext(tx: Tx): Context {
  // Wydarzenia planujemy tylko na obiektach, które są w obsłudze — na obiekcie
  // archiwalnym („inactive”) serwis w tym roku byłby sprzecznością.
  const objects = tx
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      department: schema.objects.department,
      status: schema.objects.status,
      contractorId: schema.objects.contractorId,
      salespersonId: schema.objects.salespersonId,
    })
    .from(schema.objects)
    .all();

  const usable = objects.filter((o) => o.status !== "inactive" && o.status !== "pending");
  if (usable.length === 0) throw new Error("Brak obiektów w bazie — uruchom najpierw seed handlowy.");

  const contractorById = new Map<number, LoadedContractor>();
  for (const c of tx
    .select({
      id: schema.contractors.id,
      name: schema.contractors.name,
      nip: schema.contractors.nip,
      city: schema.contractors.city,
      phone: schema.contractors.phone,
      contactPerson: schema.contractors.contactPerson,
      salespersonId: schema.contractors.salespersonId,
    })
    .from(schema.contractors)
    .all()) {
    contractorById.set(c.id, c);
  }

  const salespersonById = new Map<number, string>();
  for (const s of tx
    .select({ id: schema.salespeople.id, firstName: schema.salespeople.firstName, lastName: schema.salespeople.lastName })
    .from(schema.salespeople)
    .all()) {
    salespersonById.set(s.id, `${s.firstName} ${s.lastName}`.trim());
  }

  const technicians = tx
    .select({
      id: schema.technicians.id,
      firstName: schema.technicians.firstName,
      lastName: schema.technicians.lastName,
      active: schema.technicians.active,
    })
    .from(schema.technicians)
    .all()
    .map((t) => ({ id: t.id, name: `${t.firstName} ${t.lastName}`.trim(), active: t.active }));
  if (technicians.length === 0) throw new Error("Brak techników w bazie — uruchom najpierw seed techników.");

  const price = tx
    .select({
      name: schema.priceList.name,
      unit: schema.priceList.unit,
      price: schema.priceList.price,
      kind: schema.priceList.kind,
      active: schema.priceList.active,
    })
    .from(schema.priceList)
    .all()
    .filter((p) => p.active);

  // Autor wpisów: konto administratora, a gdyby go nie było — pierwszy użytkownik.
  // NULL jest dopuszczalny (kolumny mają ON DELETE SET NULL), więc brak kont nie blokuje seeda.
  const user =
    tx.select({ id: schema.users.id, email: schema.users.email, displayName: schema.users.displayName }).from(schema.users).all()[0] ??
    null;

  const cfg = getCompanyConfig().values;
  return {
    objects: usable,
    objectPool: buildObjectPool(usable),
    contractorById,
    salespersonById,
    technicians,
    materials: price.filter((p) => p.kind === "material"),
    services: price.filter((p) => p.kind === "service"),
    userId: user?.id ?? null,
    userLabel: user ? (user.displayName || user.email) : null,
    // Stawki bierzemy z ustawień firmy (`app_settings`), a nie z własnych stałych —
    // inaczej kwoty w seedzie rozjechałyby się z tym, co przy najbliższym
    // „Uzupełnij z danych” policzy `src/lib/realization-autofill.ts`.
    // Zera w ustawieniach traktujemy jak „nieustawione” i podstawiamy sensowny rynkowy fallback.
    rates: {
      hour: cfg.rateHour || 80,
      km: cfg.rateKm || 1.2,
      hourlyCost: cfg.hourlyCost || 55,
      markup: cfg.materialMarkup,
      roundTrip: cfg.kmRoundTrip,
    },
  };
}

/** Opiekun obiektu: własny handlowiec obiektu, a gdy go nie ma — handlowiec kontrahenta. */
function caretakerOf(ctx: Context, obj: LoadedObject | null, ownSalespersonId: number | null): string | null {
  if (!obj) return null;
  const id = ownSalespersonId ?? ctx.contractorById.get(obj.contractorId)?.salespersonId ?? null;
  return id != null ? (ctx.salespersonById.get(id) ?? null) : null;
}

/* ------------------------------------------------------------------ */
/* 1. PLAN WYDARZEŃ                                                    */
/* ------------------------------------------------------------------ */

/** Docelowa liczba wydarzeń w oknie — łącznie z wystąpieniami serii. */
const TARGET_EVENTS = 600;

/** Ile dni roboczych jest „ciche” (święta, przestoje) — bez nich rok wygląda jak automat. */
const QUIET_WORKDAY_SHARE = 0.12;

interface PlannedEvent {
  row: typeof schema.calendarEvents.$inferInsert;
  obj: LoadedObject | null;
  /** Technicy przypisani do wydarzenia (kolejność = kolejność wstawiania, patrz niżej). */
  technicianIds: number[];
  /** Opiekun handlowy — trafia do realizacji i dalej do protokołu jako „handlowiec”. */
  caretaker: string | null;
}

/**
 * Rozkład typów wydarzeń. Najwięcej serwisów i konserwacji — tak wygląda rok firmy,
 * która ma portfel obiektów w obsłudze, a nie ciągły montaż nowych instalacji.
 * `urlop`, `biuro` i `przygotowanie` są celowo w puli: nie tworzą realizacji
 * (`REALIZATION_FORBIDDEN_TYPES` / typy spoza `DEFAULT_REALIZATION_TYPES`), więc
 * dopiero one sprawdzają, czy automat naprawdę je omija.
 */
const TYPE_MIX = [
  ["serwis", 34],
  ["konserwacja", 17],
  ["montaz", 15],
  ["wizja", 9],
  ["demontaz", 4],
  ["przygotowanie", 7],
  ["biuro", 7],
  ["urlop", 7],
] as const;

/** Rozliczenie zależy od rodzaju prac: konserwacja jest zwykle w ryczałcie, serwis płatny. */
function billingFor(type: CalendarEventType): "warranty" | "free" | "paid" | null {
  switch (type) {
    case "serwis":
      return weighted([["paid", 62], ["warranty", 30], ["free", 8]] as const);
    case "konserwacja":
      return weighted([["warranty", 68], ["paid", 27], ["free", 5]] as const);
    case "montaz":
      return weighted([["paid", 84], ["warranty", 8], ["free", 8]] as const);
    case "wizja":
      return weighted([["free", 62], ["paid", 33], ["warranty", 5]] as const);
    case "demontaz":
      return weighted([["paid", 68], ["free", 32]] as const);
    default:
      // Biuro, przygotowanie i urlop nie mają rozliczenia — front chowa dla nich to pole.
      return null;
  }
}

/**
 * Status wobec TODAY. Granica jest twarda: wydarzenie z jutrzejszą datą NIE MOŻE być
 * wykonane. W przeszłości zostawiamy trochę „planned” — to zapomniane wpisy, na których
 * dopiero widać sens panelu „Uzupełnij zaległe realizacje”.
 */
function statusFor(dayIso: string): CalendarEventStatus {
  if (dayIso < TODAY) {
    return weighted([["done", 84], ["cancelled", 9], ["planned", 4], ["confirmed", 3]] as const);
  }
  if (dayIso === TODAY) return weighted([["done", 40], ["confirmed", 40], ["planned", 20]] as const);
  return weighted([["planned", 64], ["confirmed", 36]] as const);
}

/**
 * Technicy na wydarzenie. Nieaktywni to byli pracownicy — dostają wyłącznie wydarzenia
 * sprzed pół roku, żeby w bieżącym grafiku nie pracował ktoś, kogo nie ma już w firmie.
 */
function assignTechnicians(ctx: Context, dayIso: string, type: CalendarEventType): number[] {
  const cutoff = addDays(TODAY, -180);
  const pool = dayIso < cutoff ? ctx.technicians : ctx.technicians.filter((t) => t.active);
  const usable = pool.length ? pool : ctx.technicians;
  // Urlop dotyczy jednej osoby; przy pracach na obiekcie jeździ 1–3 techników.
  const n = type === "urlop" ? 1 : weighted([[1, 45], [2, 40], [3, 15]] as const);
  return shuffle(usable).slice(0, Math.min(n, usable.length)).map((t) => t.id);
}

/** Buduje jedno wydarzenie na wskazany dzień (bez serii — te mają własną ścieżkę). */
function planEvent(ctx: Context, dayIso: string): PlannedEvent {
  const type: CalendarEventType = weighted(TYPE_MIX);
  const [titleBase, description] = pick(WORK[type]);

  // Urlop i praca biurowa nie dzieją się na obiekcie klienta.
  const onSite = type !== "urlop" && type !== "biuro";
  const obj = onSite ? pick(ctx.objectPool) : null;

  const status = statusFor(dayIso);
  const technicianIds = assignTechnicians(ctx, dayIso, type);

  // Godziny pracy 7:00–17:00; wydarzenie kończy się najpóźniej o 18:00, więc trwanie
  // docinamy do godziny startu zamiast losować je niezależnie i przenosić przez północ.
  const startHour = weighted([[7, 25], [8, 30], [9, 15], [10, 10], [11, 6], [12, 6], [13, 5], [14, 3]] as const);
  const startMinutes = startHour * 60 + (chance(0.3) ? 30 : 0);
  const durationMinutes = Math.min(
    18 * 60 - startMinutes,
    weighted([[60, 15], [90, 12], [120, 20], [180, 18], [240, 15], [300, 10], [360, 10]] as const),
  );

  // Kilka procent wydarzeń jest całodniowych (wielodniowe montaże, urlopy). `end_at`
  // jest EXCLUSIVE — dokładnie jak w FullCalendar i jak zapisuje to `calendar-mutations.ts`.
  const allDay = type === "urlop" ? chance(0.85) : chance(0.03);
  const spanDays = allDay ? int(1, type === "urlop" ? 5 : 2) : 1;

  const startAt = allDay ? dayIso : at(dayIso, startMinutes);
  const endAt = allDay ? addDays(dayIso, spanDays) : at(dayIso, startMinutes + durationMinutes);

  const title = obj ? `${titleBase} — ${obj.name}` : titleBase;
  const location = obj ? [obj.address, obj.city].filter(Boolean).join(", ") : type === "biuro" ? "Biuro" : null;

  // Wydarzenie powstaje w kalendarzu z wyprzedzeniem — data utworzenia przed terminem,
  // ale nigdy przed początkiem okna (widoki miesięczne liczą po `created_at`).
  const createdIso = (() => {
    const c = addDays(dayIso, -int(1, 21));
    return c < PERIOD.from ? PERIOD.from : c;
  })();

  return {
    obj,
    technicianIds,
    caretaker: caretakerOf(ctx, obj, null),
    row: {
      type,
      title,
      description: mark(description),
      location,
      startAt,
      endAt,
      allDay,
      status,
      // Kalendarz jest narzędziem działu technicznego; wizja lokalna bywa prowadzona
      // przez handlowca, więc część z nich siedzi w dziale sprzedaży.
      department: type === "wizja" ? weighted([["technical", 6], ["sales", 4]] as const) : "technical",
      objectId: obj?.id ?? null,
      billing: billingFor(type),
      createdBy: ctx.userId,
      updatedBy: ctx.userId,
      createdAt: stamp(createdIso),
      updatedAt: stamp(createdIso),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 2. SERIE CYKLICZNE                                                  */
/* ------------------------------------------------------------------ */

const SERIES_COUNT = 12;

/**
 * Cykliczne konserwacje — dwanaście umów z przeglądem miesięcznym albo kwartalnym.
 *
 * Materializacja jest DOKŁADNIE taka, jak w `createEvent()` z `calendar-mutations.ts`:
 * wiersz w `calendar_series` to sama reguła, a każde wystąpienie to zwykłe
 * `calendar_events` ze wspólnym `series_id`. Listę wystąpień liczy `expandOccurrences()`
 * z `calendar-recurrence.ts` — ta sama funkcja, co w aplikacji, więc daty wypadają
 * identycznie (z zachowaniem dnia miesiąca i clampem 31 → koniec lutego).
 *
 * Wystąpienia mogą wypaść w sobotę i tego NIE poprawiamy: aplikacja też nie przesuwa
 * serii na dzień roboczy, a seed ma pokazywać stan, który potrafi powstać w UI.
 *
 * `calendar_series` nie ma ŻADNEJ kolumny tekstowej, więc nie da się w niej zostawić
 * MARKER-a. Znacznik niosą wystąpienia (`description`), a reset kasuje serie osierocone
 * po skasowaniu tych wystąpień — patrz `resetOperations()`.
 */
function planSeries(ctx: Context): { series: (typeof schema.calendarSeries.$inferInsert)[]; occurrences: PlannedEvent[][] } {
  const series: (typeof schema.calendarSeries.$inferInsert)[] = [];
  const occurrences: PlannedEvent[][] = [];

  const sites = shuffle(ctx.objects).slice(0, SERIES_COUNT);

  for (let i = 0; i < SERIES_COUNT && i < sites.length; i++) {
    const obj = sites[i];
    const freq = i % 2 === 0 ? ("monthly" as const) : ("quarterly" as const);

    // Start w pierwszym miesiącu okna, dzień 1–28 (dzień 29–31 wypadałby z lutego,
    // a clamp `addMonthsKeepDay` przesuwałby wtedy cały cykl na koniec miesiąca).
    const baseDay = int(1, 28);
    const baseDate = `${PERIOD.from.slice(0, 7)}-${pad2(baseDay)}`;
    const startHour = int(7, 12);
    const hours = weighted([[2, 40], [3, 35], [4, 25]] as const);

    series.push({
      freq,
      interval: 1,
      until: PERIOD.to,
      count: null,
      createdBy: ctx.userId,
      createdAt: stamp(PERIOD.from),
      updatedAt: stamp(PERIOD.from),
    });

    const expanded = expandOccurrences(
      at(baseDate, startHour * 60),
      at(baseDate, (startHour + hours) * 60),
      false,
      { freq, interval: 1, until: PERIOD.to },
    );

    const [titleBase, description] = pick(WORK.konserwacja);
    const caretaker = caretakerOf(ctx, obj, null);
    const label = freq === "monthly" ? "co miesiąc" : "co kwartał";
    const title = `${titleBase} — ${obj.name}`;

    occurrences.push(
      expanded.map((occ) => {
        const dayIso = occ.startAt.slice(0, 10);
        const createdIso = PERIOD.from;
        return {
          obj,
          technicianIds: assignTechnicians(ctx, dayIso, "konserwacja"),
          caretaker,
          row: {
            type: "konserwacja" as const,
            title,
            description: mark(`${description} Przegląd ${label}.`),
            location: [obj.address, obj.city].filter(Boolean).join(", "),
            startAt: occ.startAt,
            endAt: occ.endAt,
            allDay: false,
            status: statusFor(dayIso),
            department: "technical",
            objectId: obj.id,
            // Przegląd z umowy jest w ryczałcie — dla klienta gwarancyjny, nie płatny.
            billing: weighted([["warranty", 80], ["paid", 20]] as const),
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
            createdAt: stamp(createdIso),
            updatedAt: stamp(createdIso),
          },
        };
      }),
    );
  }

  return { series, occurrences };
}

/* ------------------------------------------------------------------ */
/* 3. GĘSTOŚĆ DNI                                                      */
/* ------------------------------------------------------------------ */

/**
 * Ile wydarzeń wypada danego dnia. Dzień roboczy to 2–5 wpisów, sobota sporadycznie,
 * niedziela prawie nigdy (awaria, po której ktoś musi wyjechać). Wystąpienia serii są
 * już policzone i wchodzą do tego samego budżetu — inaczej miesiące z przeglądem
 * puchłyby ponad realną przepustowość ekipy.
 */
function eventsForDay(dayIso: string, fromSeries: number): number {
  if (!isWorkday(dayIso)) {
    const saturday = parseDate(dayIso).getUTCDay() === 6;
    const extra = saturday ? (chance(0.16) ? 1 : 0) : chance(0.02) ? 1 : 0;
    return Math.max(0, extra - fromSeries);
  }
  // Dzień „cichy” — święto, inwentaryzacja, urlop całej ekipy.
  if (chance(QUIET_WORKDAY_SHARE)) return Math.max(0, (chance(0.5) ? 1 : 0) - fromSeries);
  const target = weighted([[2, 60], [3, 28], [4, 9], [5, 3]] as const);
  return Math.max(0, target - fromSeries);
}

/* ------------------------------------------------------------------ */
/* 4. REALIZACJE, PROTOKOŁY, WYCENY                                    */
/* ------------------------------------------------------------------ */

/** Dla ilu wykonanych wydarzeń powstaje realizacja. */
const REALIZATION_SHARE = 0.7;
/** Dla ilu realizacji powstaje protokół. */
const PROTOCOL_SHARE = 0.6;
/** Ile protokołów jest podpisanych (reszta to szkice do domknięcia). */
const PROTOCOL_SIGNED_SHARE = 0.55;
/** Ile wycen łącznie (część przy realizacjach, część wolnostojących). */
const TARGET_QUOTES = 40;
/** Ile wycen jest wolnostojących — utworzonych ręcznie w module Wyceny. */
const STANDALONE_QUOTES = 10;

/** Pozycje materiałowe protokołu: kable z cennika + sprzęt z numerem seryjnym. */
function protocolItems(ctx: Context, type: CalendarEventType): Array<{ name: string; serial: string; unit: string; qty: string }> {
  const items: Array<{ name: string; serial: string; unit: string; qty: string }> = [];

  for (const m of ctx.materials) {
    // Nie każdy materiał z cennika idzie na każdą robotę — pusta ilość zostaje
    // w dokumencie jako pozycja do ewentualnego dopisania (tak działa prefill).
    const used = type === "montaz" ? chance(0.85) : chance(0.4);
    items.push({ name: m.name, serial: "", unit: m.unit, qty: used ? String(int(10, 420)) : "" });
  }

  // Sprzęt pojawia się przy montażu i przy serwisie z wymianą — z numerem seryjnym,
  // bo to on jest dowodem, co konkretnie zostało zamontowane u klienta.
  const hwCount = type === "montaz" ? int(2, 5) : chance(0.45) ? int(1, 2) : 0;
  for (const [name, unit] of shuffle(HARDWARE).slice(0, hwCount)) {
    items.push({ name, serial: `SN${int(100000, 999999)}`, unit, qty: String(int(1, 8)) });
  }

  return items;
}

/** Pozycje wyceny: usługi (dojazd, RBH) + materiały, w kształcie `[{name,qty,unit,price}]`. */
function quoteItems(ctx: Context, filled: boolean, hours: number, km: number): Array<{ name: string; qty: string; unit: string; price: string }> {
  const rows: Array<{ name: string; qty: string; unit: string; price: string }> = [];
  const qty = (v: number) => (filled ? String(round2(v)) : "");

  for (const s of ctx.services) {
    if (s.unit === "KM") rows.push({ name: s.name, qty: qty(km), unit: s.unit, price: String(s.price) });
    else if (s.unit === "RBH") rows.push({ name: s.name, qty: qty(Math.max(1, Math.round(hours))), unit: s.unit, price: String(s.price) });
    else if (chance(0.35)) rows.push({ name: s.name, qty: qty(int(5, 60)), unit: s.unit, price: String(s.price) });
  }
  for (const m of ctx.materials) {
    rows.push({ name: m.name, qty: chance(0.6) ? qty(int(10, 300)) : "", unit: m.unit, price: String(m.price) });
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* 5. WSTAWIANIE — kolejność wynika z zależności, nie z upodobania      */
/* ------------------------------------------------------------------ */

interface PlannedRealization {
  ev: CalendarEvent;
  plan: PlannedEvent;
  row: typeof schema.realizations.$inferInsert;
}

/** Serie cykliczne + ich wystąpienia (jeszcze bez `series_id` — ten znamy po insercie). */
function insertSeries(tx: Tx, ctx: Context): { ids: number[]; occurrences: PlannedEvent[][] } {
  const { series, occurrences } = planSeries(ctx);
  const ids: number[] = [];
  for (const batch of chunks(series, 20)) {
    ids.push(...tx.insert(schema.calendarSeries).values(batch).returning({ id: schema.calendarSeries.id }).all().map((r) => r.id));
  }
  occurrences.forEach((list, i) => {
    for (const occ of list) occ.row.seriesId = ids[i];
  });
  return { ids, occurrences };
}

/** Roczny plan wydarzeń: wystąpienia serii + swobodne wpisy dzień po dniu. */
function planCalendar(ctx: Context, occurrences: readonly PlannedEvent[][]): PlannedEvent[] {
  const planned: PlannedEvent[] = [];
  const seriesPerDay = new Map<string, number>();
  for (const list of occurrences) {
    for (const occ of list) {
      planned.push(occ);
      const day = occ.row.startAt.slice(0, 10);
      seriesPerDay.set(day, (seriesPerDay.get(day) ?? 0) + 1);
    }
  }

  const freeform: PlannedEvent[] = [];
  for (const day of daysInPeriod()) {
    const n = eventsForDay(day, seriesPerDay.get(day) ?? 0);
    for (let k = 0; k < n; k++) freeform.push(planEvent(ctx, day));
  }

  // Nadmiar ponad TARGET_EVENTS ścinamy LOSOWO z całego roku, a nie przerywając pętlę
  // po dacie. Urwanie ogona zostawiłoby pusty sierpień — czyli bieżący miesiąc, który
  // kalendarz otwiera domyślnie — i cała baza wyglądałaby na martwą.
  const keep = Math.max(0, TARGET_EVENTS - planned.length);
  planned.push(...(freeform.length > keep ? shuffle(freeform).slice(0, keep) : freeform));

  // Kolejność wstawiania = kolejność chronologiczna, żeby identyfikatory rosły razem
  // z datami (tak wygląda baza, która narastała przez rok).
  planned.sort((a, b) => (a.row.startAt < b.row.startAt ? -1 : a.row.startAt > b.row.startAt ? 1 : 0));
  return planned;
}

function insertEvents(tx: Tx, planned: readonly PlannedEvent[]): CalendarEvent[] {
  const rows: CalendarEvent[] = [];
  for (const batch of chunks(planned.map((p) => p.row), 40)) {
    rows.push(...tx.insert(schema.calendarEvents).values(batch).returning().all());
  }
  return rows;
}

/**
 * Przypisania techników. Wstawiane PRZED realizacjami, bo `mapEventToRealization()`
 * czyta wykonawców właśnie z tej tabeli — bez nich realizacja miałaby puste
 * `contractor_1/2`, a protokół pustego wykonawcę.
 */
function insertAssignees(tx: Tx, eventRows: readonly CalendarEvent[], planned: readonly PlannedEvent[]): number {
  const rows: (typeof schema.calendarEventAssignees.$inferInsert)[] = [];
  eventRows.forEach((ev, i) => {
    for (const technicianId of planned[i].technicianIds) rows.push({ eventId: ev.id, technicianId });
  });
  let inserted = 0;
  for (const batch of chunks(rows, 200)) {
    tx.insert(schema.calendarEventAssignees).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Realizacje dla części wykonanych wydarzeń.
 *
 * Bramka wyboru jest TA SAMA, co w `ensureBlockedReason()`: tylko status „wykonane”
 * i tylko typ objęty automatem (`DEFAULT_REALIZATION_TYPES`). Urlop, biuro
 * i przygotowanie realizacji nie dostają — tak jak w aplikacji.
 *
 * Nie każde pasujące wydarzenie ją dostaje (~70%): reszta to wpisy, przy których nikt
 * nie domknął dokumentów. Bez nich panel „Uzupełnij zaległe realizacje” nie ma czego
 * uzupełniać, a tryb `auto_realization = "off"` nie ma jak się objawić.
 */
function planRealizations(
  tx: Tx,
  ctx: Context,
  eventRows: readonly CalendarEvent[],
  planned: readonly PlannedEvent[],
): PlannedRealization[] {
  const REALIZATION_TYPES: readonly CalendarEventType[] = ["serwis", "montaz", "wizja", "demontaz", "konserwacja"];
  const candidates = eventRows
    .map((ev, i) => ({ ev, plan: planned[i] }))
    .filter(({ ev }) => ev.status === "done" && REALIZATION_TYPES.includes(ev.type));

  const chosen = shuffle(candidates).slice(0, Math.round(candidates.length * REALIZATION_SHARE));
  chosen.sort((a, b) => (a.ev.startAt < b.ev.startAt ? -1 : 1));

  return chosen.map(({ ev, plan }) => {
    // SEDNO MODUŁU: pola „dokumentowe” realizacji liczy funkcja aplikacji, nie seed.
    // Dzięki temu `syncRealizationFromEvent()` przy pierwszej edycji wydarzenia nie ma
    // czego poprawiać — dane są już w stanie, do którego automat i tak by je doprowadził.
    const mapped = mapEventToRealization(tx, ev);

    const paid = mapped.billing === "paid";
    const hours = mapped.actualHours;
    // Dojazd liczony w obie strony, gdy tak mówią ustawienia firmy (`company.km_round_trip`).
    const km = round2(num(4, 120, 1) * (ctx.rates.roundTrip ? 2 : 1));

    // Prace gwarancyjne i darmowe nie generują przychodu — kwoty zostają zerowe, ale
    // koszt roboczogodziny i tak jest poniesiony. To jedyny sposób, żeby w Analityce
    // dało się w ogóle zobaczyć, ile firmę kosztuje gwarancja.
    const amountHours = paid ? round2(hours * ctx.rates.hour) : 0;
    const amountKm = paid ? round2(km * ctx.rates.km) : 0;
    const materialBase = !paid
      ? 0
      : ev.type === "montaz"
        ? money(400, 6500, 10)
        : chance(0.45)
          ? money(60, 900, 10)
          : 0;
    const amountMaterial = round2(materialBase * (1 + ctx.rates.markup / 100));
    const subtotal = amountHours + amountKm + amountMaterial;
    const discount = paid && subtotal > 0 && chance(0.18) ? money(subtotal * 0.02, subtotal * 0.1, 10) : 0;

    // Faktura wychodzi po zamknięciu miesiąca — starsze prace płatne są rozliczone,
    // świeższe jeszcze czekają, więc lista „do zafakturowania” nie jest pusta.
    const invoiced = paid && mapped.date <= addDays(TODAY, -40) && chance(0.85);

    return {
      ev,
      plan,
      row: {
        date: mapped.date,
        site: mapped.site,
        workType: mapped.workType,
        billing: mapped.billing,
        kind: mapped.kind,
        contractor1: mapped.contractor1,
        contractor2: mapped.contractor2,
        actualHours: hours,
        actualKm: km,
        amountHours,
        amountMaterial,
        amountKm,
        discount,
        // Koszt roboczogodziny z ustawień firmy; przy podwykonawcy jest wyższy.
        hourlyCost: chance(0.2) ? round2(ctx.rates.hourlyCost * 1.4) : ctx.rates.hourlyCost,
        invoiced,
        invoicedAt: invoiced ? notAfterToday(addDays(mapped.date, int(7, 30))) : null,
        caretaker: plan.caretaker,
        // Adnotacja DOKŁADNIE taka, jaką liczy `realizationNote()` — znacznik wchodzi do
        // niej razem z opisem wydarzenia (patrz `keepMarked`), więc nie doklejamy drugiego.
        // Człowiek odczyta z niej numer wydarzenia, z którego realizacja powstała.
        note: keepMarked(mapped.note),
        createdAt: stamp(mapped.date),
        updatedAt: stamp(mapped.date),
      },
    };
  });
}

/** Wstawia realizacje i spina je z wydarzeniami w OBIE strony. */
function insertRealizations(tx: Tx, plans: readonly PlannedRealization[]): number[] {
  const ids: number[] = [];
  for (const batch of chunks(plans.map((p) => p.row), 40)) {
    ids.push(...tx.insert(schema.realizations).values(batch).returning({ id: schema.realizations.id }).all().map((r) => r.id));
  }
  // Spięcie zwrotne osobnymi UPDATE-ami: `calendar_events.realization_id` ma częściowy
  // indeks UNIQUE, więc jedna realizacja to dokładnie jedno wydarzenie i nie da się
  // tego zapisać jednym poleceniem bez ryzyka kolizji.
  plans.forEach((p, i) => {
    tx.update(schema.calendarEvents).set({ realizationId: ids[i] }).where(eq(schema.calendarEvents.id, p.ev.id)).run();
  });
  return ids;
}

interface InsertedProtocols {
  ids: number[];
  numbers: string[];
  /** Wydarzenie, do którego należy protokół o tym samym indeksie. */
  eventIds: number[];
}

/**
 * Protokoły dla części realizacji. Protokół jest ŹRÓDŁEM PRAWDY o wykonanej pracy,
 * ale nie każda realizacja go ma: wiersze zaimportowane z arkusza (sprzed automatu)
 * go nie dostały. Ten brak jest celowy — bez niego przycisk „Wygeneruj brakujące
 * protokoły” (POST /protocols/sync) nie ma czego generować.
 */
function insertProtocols(
  tx: Tx,
  ctx: Context,
  plans: readonly PlannedRealization[],
  realizationIds: readonly number[],
): InsertedProtocols {
  const nextNumber = numberAllocator(
    "P",
    tx.select({ number: schema.protocols.number }).from(schema.protocols).all().map((r) => r.number),
  );

  const withProtocol = shuffle([...plans.keys()])
    .slice(0, Math.round(plans.length * PROTOCOL_SHARE))
    .sort((a, b) => a - b);

  const rows: (typeof schema.protocols.$inferInsert)[] = [];
  const eventIds: number[] = [];
  for (const i of withProtocol) {
    const { ev, plan, row } = plans[i];
    const contractor = plan.obj ? ctx.contractorById.get(plan.obj.contractorId) : undefined;
    const signed = chance(PROTOCOL_SIGNED_SHARE);
    // Podpis odbierany na obiekcie tego samego dnia albo parę dni później.
    const signedAt = signed
      ? `${notAfterToday(addDays(row.date, int(0, 3)))}T${pad2(int(9, 17))}:${pad2(int(0, 59))}:00.000Z`
      : null;

    rows.push({
      realizationId: realizationIds[i],
      number: nextNumber(row.date),
      workDate: row.date,
      // To samo mapowanie, co w `syncRealizationFromEvent()`: konserwacja i serwis
      // trafiają do protokołu jako „serwis”, demontaż jako „inne”.
      workType: workTypeFromEventType(ev.type) ?? "serwis",
      actualHours: row.actualHours ?? 0,
      actualKm: row.actualKm ?? 0,
      contractor: [row.contractor1, row.contractor2].filter(Boolean).join(", "),
      // Handlowiec protokołu = opiekun realizacji (tak czyta to `buildProtocolPrefill`).
      salesperson: row.caretaker ?? null,
      clientName: contractor?.name ?? null,
      clientNip: contractor?.nip ?? null,
      clientCity: contractor?.city ?? plan.obj?.city ?? null,
      installationAddress: plan.obj?.address ?? row.site,
      contact: [contractor?.contactPerson, contractor?.phone].filter(Boolean).join(", ") || null,
      // „Wykonane czynności” w formacie `buildProtocolPrefill()`: tytuł — opis, przycięte
      // do 400 znaków. Znacznik przychodzi z opisu wydarzenia, więc nie dokładamy drugiego.
      activities: keepMarked(clip([clean(ev.title), clean(ev.description)].filter(Boolean).join(" — "), 400)),
      items: JSON.stringify(protocolItems(ctx, ev.type)),
      // Podpis BEZ `signature_png` i bez `content_hash`: dataURL z podpisem to kilkadziesiąt
      // kilobajtów base64 na dokument, czyli kilkanaście megabajtów bazy deweloperskiej za
      // obrazek, którego nikt nie ogląda. Status i data podpisu wystarczą, żeby zadziałały
      // wszystkie reguły „protokół podpisany jest nietykalny”.
      signerName: signed ? personName() : null,
      signedAt,
      status: signed ? "final" : "draft",
      createdAt: stamp(row.date),
      updatedAt: signedAt ?? stamp(row.date),
    });
    eventIds.push(ev.id);
  }

  const ids: number[] = [];
  for (const batch of chunks(rows, 40)) {
    ids.push(...tx.insert(schema.protocols).values(batch).returning({ id: schema.protocols.id }).all().map((r) => r.id));
  }

  // `calendar_events.protocol_id` to JAWNE przypięcie; aplikacja odnajduje protokół także
  // przez realizację, gdy kolumna jest pusta. Wypełniamy ją, bo obie drogi prowadzą tu do
  // tego samego dokumentu, a jawne powiązanie widać wprost w API kalendarza.
  eventIds.forEach((eventId, i) => {
    tx.update(schema.calendarEvents).set({ protocolId: ids[i] }).where(eq(schema.calendarEvents.id, eventId)).run();
  });

  return { ids, numbers: rows.map((r) => r.number), eventIds };
}

/**
 * Wyceny. Powiązana wycena istnieje TYLKO dla prac PŁATNYCH — to reguła automatu
 * (`syncQuoteForEvent`), a nie ozdobnik: wycena przy pracy gwarancyjnej byłaby
 * dokumentem, który aplikacja przy najbliższej edycji wydarzenia sama by skasowała.
 */
function insertQuotes(
  tx: Tx,
  ctx: Context,
  plans: readonly PlannedRealization[],
  realizationIds: readonly number[],
): number {
  const nextNumber = numberAllocator(
    "W",
    tx.select({ number: schema.quotes.number }).from(schema.quotes).all().map((r) => r.number),
  );

  const paidIdx = shuffle(plans.map((_, i) => i).filter((i) => plans[i].row.billing === "paid"));
  const linked = paidIdx.slice(0, Math.max(0, TARGET_QUOTES - STANDALONE_QUOTES)).sort((a, b) => a - b);

  const rows: (typeof schema.quotes.$inferInsert)[] = [];
  for (const i of linked) {
    const { plan, row } = plans[i];
    // ~25% wycen to nietknięte szkice (bez ilości) — dokładnie te, które automat ma
    // prawo skasować przy zmianie rozliczenia (`isQuoteUntouched`). Reszta ma ilości.
    const filled = chance(0.75);
    rows.push({
      number: nextNumber(row.date),
      date: row.date,
      site: row.site,
      // `quotes` nie ma kolumny na notatkę, więc MARKER idzie do adresu — jedynego pola
      // tekstowego bez znaczenia dla wyliczeń (numer, data, obiekt i pozycje muszą zostać
      // czyste, bo liczy z nich sumy front i eksport PDF).
      address: mark([plan.obj?.address, plan.obj?.city].filter(Boolean).join(", ")),
      items: JSON.stringify(quoteItems(ctx, filled, row.actualHours ?? 0, row.actualKm ?? 0)),
      realizationId: realizationIds[i],
      createdAt: stamp(row.date),
      updatedAt: stamp(row.date),
    });
  }

  // Wyceny wolnostojące — utworzone ręcznie w module Wyceny, jeszcze bez realizacji.
  // Schemat wprost je dopuszcza (`realization_id` NULL), a bez nich lista wycen sugeruje,
  // że wycena może powstać wyłącznie z kalendarza.
  for (let k = 0; k < STANDALONE_QUOTES; k++) {
    const obj = pick(ctx.objectPool);
    const date = notAfterToday(addDays(TODAY, -int(1, 300)));
    rows.push({
      number: nextNumber(date),
      date,
      site: obj.name,
      address: mark([obj.address, obj.city].filter(Boolean).join(", ")),
      items: JSON.stringify(quoteItems(ctx, chance(0.6), num(2, 10, 1), num(20, 200, 1))),
      realizationId: null,
      createdAt: stamp(date),
      updatedAt: stamp(date),
    });
  }

  let inserted = 0;
  for (const batch of chunks(rows, 40)) {
    tx.insert(schema.quotes).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/** Notatki z obiektu — dziennik przy wydarzeniach wykonanych. */
function insertNotes(tx: Tx, ctx: Context, eventRows: readonly CalendarEvent[]): number {
  const rows: (typeof schema.calendarEventNotes.$inferInsert)[] = [];
  for (const ev of eventRows) {
    if (ev.status !== "done" || !chance(0.16)) continue;
    const howMany = chance(0.25) ? 2 : 1;
    const day = ev.startAt.slice(0, 10);
    for (let k = 0; k < howMany; k++) {
      rows.push({
        eventId: ev.id,
        userId: ctx.userId,
        userLabel: ctx.userLabel,
        source: "user",
        text: mark(pick(NOTE_TEXTS)),
        createdAt: stamp(day),
        updatedAt: stamp(day),
      });
    }
  }
  let inserted = 0;
  for (const batch of chunks(rows, 100)) {
    tx.insert(schema.calendarEventNotes).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/**
 * Dziennik aktywności. `activity_log` jest generyczny dla całej aplikacji, ale pierwszym
 * konsumentem jest kalendarz — wpisy powtarzają treść, jaką zapisuje `logActivity()`
 * z `calendar-realizations.ts`, żeby feed „Aktywność” czytało się spójnie z resztą historii.
 */
function insertActivity(
  tx: Tx,
  ctx: Context,
  plans: readonly PlannedRealization[],
  realizationIds: readonly number[],
  protocols: InsertedProtocols,
  eventRows: readonly CalendarEvent[],
): number {
  const rows: (typeof schema.activityLog.$inferInsert)[] = [];

  plans.forEach((p, i) => {
    const protocolAt = protocols.eventIds.indexOf(p.ev.id);
    const docs = protocolAt >= 0 ? ` i protokół ${protocols.numbers[protocolAt]}` : "";
    rows.push({
      entityType: "calendar_event",
      entityId: p.ev.id,
      objectId: p.ev.objectId,
      userId: ctx.userId,
      userLabel: ctx.userLabel,
      action: "linked",
      field: "realization",
      newValue: String(realizationIds[i]),
      summary: mark(`Utworzono realizację #${realizationIds[i]}${docs} (${p.row.site}, ${p.row.date})`),
      createdAt: stamp(p.row.date),
    });
  });

  // Do tego próbka zmian statusu — bez nich dziennik pokazuje wyłącznie pracę automatu,
  // a nie człowieka, który zamyka wydarzenie po powrocie z obiektu.
  for (const ev of eventRows) {
    if (ev.status !== "done" || !chance(0.12)) continue;
    rows.push({
      entityType: "calendar_event",
      entityId: ev.id,
      objectId: ev.objectId,
      userId: ctx.userId,
      userLabel: ctx.userLabel,
      action: "status_changed",
      field: "status",
      oldValue: "confirmed",
      newValue: "done",
      summary: mark(`Status: Potwierdzone → Wykonane (${ev.title})`),
      createdAt: stamp(ev.startAt.slice(0, 10)),
    });
  }

  let inserted = 0;
  for (const batch of chunks(rows, 150)) {
    tx.insert(schema.activityLog).values(batch).run();
    inserted += batch.length;
  }
  return inserted;
}

/* ------------------------------------------------------------------ */
/* Wejście publiczne                                                   */
/* ------------------------------------------------------------------ */

export async function seedOperations(): Promise<OperationsCounts> {
  seed(SEED);

  // Cały moduł w jednej transakcji: ~1700 wierszy to jeden fsync zamiast 1700.
  return db.transaction((tx) => {
    const ctx = loadContext(tx);

    // Kolejność jest wymuszona przepływem dokumentów, nie wygodą: seria daje `series_id`
    // wydarzeniom, wydarzenia i przypisani technicy dają realizację, realizacja daje
    // protokół i wycenę. Odwrócenie któregokolwiek kroku zostawia puste pole w dokumencie.
    const series = insertSeries(tx, ctx);
    const planned = planCalendar(ctx, series.occurrences);
    const eventRows = insertEvents(tx, planned);
    const assignees = insertAssignees(tx, eventRows, planned);

    const realizationPlans = planRealizations(tx, ctx, eventRows, planned);
    const realizationIds = insertRealizations(tx, realizationPlans);
    const protocols = insertProtocols(tx, ctx, realizationPlans, realizationIds);
    const quotes = insertQuotes(tx, ctx, realizationPlans, realizationIds);

    const notes = insertNotes(tx, ctx, eventRows);
    const activity = insertActivity(tx, ctx, realizationPlans, realizationIds, protocols, eventRows);

    return {
      series: series.ids.length,
      events: eventRows.length,
      assignees,
      notes,
      realizations: realizationIds.length,
      protocols: protocols.ids.length,
      quotes,
      activity,
    };
  });
}

/**
 * Kasuje WYŁĄCZNIE to, co zasiał `seedOperations()` — rozpoznanie po MARKER-ze
 * w polu tekstowym, nigdy po zakresie identyfikatorów. Pięć pierwotnych wydarzeń,
 * dwie realizacje, dwa protokoły i jedna wycena zostają nietknięte.
 *
 * Kolejność jest odwrotna do zależności FK, ale ważniejszy jest tu inny szczegół:
 * `calendar_events` wskazuje NA realizację, protokół i wycenę, a jednocześnie
 * realizacja i wycena mają zwrotne kaskady. Dlatego najpierw znikają wydarzenia
 * (razem z nimi kaskadowo przypisania i notatki), a dopiero potem dokumenty — przy
 * odwrotnej kolejności bazy sprzed migracji 0043, w których FK dodane przez
 * ALTER TABLE nie mają ON DELETE, wywróciłyby się na „FOREIGN KEY constraint failed”.
 */
export async function resetOperations(): Promise<OperationsCounts> {
  return db.transaction((tx) => {
    const counts = emptyCounts();

    const seededEvents = tx
      .select({ id: schema.calendarEvents.id, description: schema.calendarEvents.description, seriesId: schema.calendarEvents.seriesId })
      .from(schema.calendarEvents)
      .all()
      .filter((r) => isSeeded(r.description));
    const eventIds = seededEvents.map((r) => r.id);
    // Serie zapamiętujemy PRZED skasowaniem wystąpień — po nim nie da się już ustalić,
    // która reguła należała do seeda (`calendar_series` nie ma pola tekstowego).
    const seriesIds = [...new Set(seededEvents.map((r) => r.seriesId).filter((id): id is number => id != null))];

    // Notatki: po znaczniku ORAZ po wydarzeniu — notatka mogła powstać na wygenerowanym
    // wydarzeniu już po seedzie i nie może zostać sierotą.
    const noteIds = new Set(
      tx
        .select({ id: schema.calendarEventNotes.id, eventId: schema.calendarEventNotes.eventId, text: schema.calendarEventNotes.text })
        .from(schema.calendarEventNotes)
        .all()
        .filter((r) => isSeeded(r.text) || eventIds.includes(r.eventId))
        .map((r) => r.id),
    );
    for (const batch of chunks([...noteIds], 200)) {
      tx.delete(schema.calendarEventNotes).where(inArray(schema.calendarEventNotes.id, batch)).run();
      counts.notes += batch.length;
    }

    // Przypisania techników nie mają kolumny tekstowej — idą po identyfikatorze wydarzenia.
    for (const batch of chunks(eventIds, 200)) {
      const removed = tx
        .select({ eventId: schema.calendarEventAssignees.eventId })
        .from(schema.calendarEventAssignees)
        .where(inArray(schema.calendarEventAssignees.eventId, batch))
        .all().length;
      tx.delete(schema.calendarEventAssignees).where(inArray(schema.calendarEventAssignees.eventId, batch)).run();
      counts.assignees += removed;
    }

    for (const batch of chunks(eventIds, 200)) {
      tx.delete(schema.calendarEvents).where(inArray(schema.calendarEvents.id, batch)).run();
      counts.events += batch.length;
    }

    const protocolIds = tx
      .select({ id: schema.protocols.id, activities: schema.protocols.activities })
      .from(schema.protocols)
      .all()
      .filter((r) => isSeeded(r.activities))
      .map((r) => r.id);
    for (const batch of chunks(protocolIds, 200)) {
      // Wydarzenia sprzed seeda mogły przypiąć protokół jawnie — zdejmujemy to
      // powiązanie sami, bo FK z ALTER TABLE nie wszędzie ma ON DELETE SET NULL.
      tx.update(schema.calendarEvents).set({ protocolId: null }).where(inArray(schema.calendarEvents.protocolId, batch)).run();
      tx.delete(schema.protocols).where(inArray(schema.protocols.id, batch)).run();
      counts.protocols += batch.length;
    }

    const quoteIds = tx
      .select({ id: schema.quotes.id, address: schema.quotes.address })
      .from(schema.quotes)
      .all()
      .filter((r) => isSeeded(r.address))
      .map((r) => r.id);
    for (const batch of chunks(quoteIds, 200)) {
      tx.update(schema.calendarEvents).set({ quoteId: null }).where(inArray(schema.calendarEvents.quoteId, batch)).run();
      tx.delete(schema.quotes).where(inArray(schema.quotes.id, batch)).run();
      counts.quotes += batch.length;
    }

    const realizationIds = tx
      .select({ id: schema.realizations.id, note: schema.realizations.note })
      .from(schema.realizations)
      .all()
      .filter((r) => isSeeded(r.note))
      .map((r) => r.id);
    for (const batch of chunks(realizationIds, 200)) {
      tx.update(schema.calendarEvents).set({ realizationId: null }).where(inArray(schema.calendarEvents.realizationId, batch)).run();
      tx.delete(schema.realizations).where(inArray(schema.realizations.id, batch)).run();
      counts.realizations += batch.length;
    }

    // Serie kasujemy dopiero, gdy nie zostało po nich ANI JEDNO wydarzenie: gdyby ktoś
    // dopisał do wygenerowanej serii własny termin, reguła musi przeżyć reset.
    for (const seriesId of seriesIds) {
      const left = tx
        .select({ id: schema.calendarEvents.id })
        .from(schema.calendarEvents)
        .where(eq(schema.calendarEvents.seriesId, seriesId))
        .all().length;
      if (left > 0) continue;
      tx.delete(schema.calendarSeries).where(eq(schema.calendarSeries.id, seriesId)).run();
      counts.series += 1;
    }

    const activityIds = tx
      .select({ id: schema.activityLog.id, summary: schema.activityLog.summary })
      .from(schema.activityLog)
      .all()
      .filter((r) => isSeeded(r.summary))
      .map((r) => r.id);
    for (const batch of chunks(activityIds, 200)) {
      tx.delete(schema.activityLog).where(inArray(schema.activityLog.id, batch)).run();
      counts.activity += batch.length;
    }

    return counts;
  });
}

/** Nazwa modułu w logach orkiestratora. */
export const OPERATIONS_MODULE = `operacje (${MARKER})`;
