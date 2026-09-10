import { asc, eq, inArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { zonedToday } from "./tz.js";
import { ValidationError } from "./validate.js";
import type {
  ObjectServiceInput,
  ObjectServiceKind,
  ObjectType,
} from "../types/index.js";

/** Usługi obiektu w kształcie, w jakim przychodzą z formularzy. */
export interface ObjectServiceFlags {
  hasCameras?: boolean | null;
  hasSswin?: boolean | null;
  hasVideoreception?: boolean | null;
  hasOfi?: boolean | null;
}

/**
 * Dawny „typ ochrony” wyliczony z usług.
 *
 * Kolumna `objects.type` jest @deprecated, ale wciąż NOT NULL i wciąż czyta ją
 * kilka miejsc (m.in. analityka), więc każdy zapis musi ją czymś wypełnić.
 * Odwzorowanie jest odwrotnością migracji 0055 (monitoring → kamery, alarm →
 * SSWiN, physical → OFI, mixed → kamery + SSWiN), żeby dane zapisane po zmianie
 * wyglądały tak samo jak przemigrowane. Znika razem z kolumną.
 */
export function legacyObjectType(s: ObjectServiceFlags): ObjectType {
  const cameras = !!s.hasCameras || !!s.hasVideoreception;
  const sswin = !!s.hasSswin;
  if (cameras && sswin) return "mixed";
  if (cameras) return "monitoring";
  if (sswin) return "alarm";
  if (s.hasOfi) return "physical";
  // Obiekt bez ani jednej usługi: kolumna musi mieć wartość, a „monitoring” było
  // dotąd domyślnym wyborem formularzy. Prawda o usługach siedzi w has_*.
  return "monitoring";
}

// ---------------------------------------------------------------------------
// OKRESY USŁUG (tabela `object_services`) — źródło prawdy dla flag `objects.has_*`
// ---------------------------------------------------------------------------

/**
 * Kolejność = kolejność w UI (formularz, karta obiektu, mail). Jeden słownik dla
 * walidacji, etykiet i pętli po usługach — rozjazd oznaczałby trzy miejsca do
 * poprawienia przy dodaniu piątej usługi.
 */
export const OBJECT_SERVICE_KINDS = ["kamery", "sswin", "wideorecepcja", "ofi"] as const;

/** Polskie nazwy do komunikatów walidacji i do maila zlecenia. */
export const OBJECT_SERVICE_LABELS: Record<ObjectServiceKind, string> = {
  kamery: "Kamery",
  sswin: "SSWiN",
  wideorecepcja: "Wideorecepcja",
  ofi: "Ochrona fizyczna",
};

/** Wiersz okresu w kształcie, w jakim wraca z bazy (albo w jakim go liczymy). */
export interface ServicePeriodLike {
  service: ObjectServiceKind;
  startDate: string;
  /** `undefined` traktujemy jak `null` — okresy z body nie muszą podawać końca. */
  endDate?: string | null;
  cameraCount?: number | null;
}

/** Flagi obiektu wyliczone z okresów — dokładnie te kolumny, co cache w `objects`. */
export interface ComputedObjectFlags {
  hasCameras: boolean;
  hasSswin: boolean;
  hasVideoreception: boolean;
  hasOfi: boolean;
  cameraCount: number | null;
}

/** „Dziś" w strefie aplikacji (Europe/Warsaw) — porównywalne ze `start_date`/`end_date`. */
export function todayIso(): string {
  return zonedToday();
}

/**
 * Okres ZAKOŃCZONY = ma datę końca i ta data już minęła. Koniec „dziś" jeszcze
 * się liczy: usługa świadczona do końca dzisiejszego dnia nadal jest świadczona.
 */
export function isServiceEnded(
  row: { endDate?: string | null },
  today = todayIso()
): boolean {
  return row.endDate !== null && row.endDate !== undefined && row.endDate !== "" && row.endDate < today;
}

/**
 * Okres ZAPLANOWANY = start jeszcze przed nami. To NIE wyłącza usługi z flag
 * (patrz `flagsFromServices`) — literówka w roku nie może wyrzucić obiektu
 * z analityki; UI odróżnia „trwa" od „zaplanowana" badge'em.
 */
export function isServicePlanned(row: { startDate: string }, today = todayIso()): boolean {
  return row.startDate > today;
}

/**
 * Data poza jakimkolwiek sensownym horyzontem umowy — górna granica przedziału
 * „od dziś w nieskończoność". Dzięki niej `flagsFromServices` jest szczególnym
 * przypadkiem `flagsFromServicesInRange` i definicja aktywności istnieje RAZ.
 */
const FAR_FUTURE_DATE = "9999-12-31";

/**
 * Czy okres NACHODZI na przedział `[from, to]` (obie daty włącznie)?
 *
 * To uogólnienie „aktywny": okres zachodzi na przedział, gdy zaczął się nie
 * później niż jego koniec i nie skończył się przed jego początkiem. Dla
 * `[dziś, ∞)` daje dokładnie to samo, co `!isServiceEnded` — z regułą D2
 * włącznie: okres jeszcze nierozpoczęty NADAL liczy się do flag.
 *
 * Do liczenia stanu usług w KONKRETNYM MIESIĄCU (mianownik CMA per miesiąc,
 * seria czasowa analityki): `from` = pierwszy dzień miesiąca, `to` = ostatni.
 */
export function isServiceActiveInRange(
  row: { startDate: string; endDate?: string | null },
  from: string,
  to: string
): boolean {
  if (row.startDate > to) return false;
  return (
    row.endDate === null || row.endDate === undefined || row.endDate === "" || row.endDate >= from
  );
}

/**
 * Flagi obiektu policzone dla PRZEDZIAŁU dat — ta sama arytmetyka, co
 * `flagsFromServices`, tylko zamiast „na dziś" pyta „w tym oknie".
 */
export function flagsFromServicesInRange(
  rows: readonly ServicePeriodLike[],
  from: string,
  to: string
): ComputedObjectFlags {
  return computeFlags(rows.filter((r) => isServiceActiveInRange(r, from, to)));
}

/**
 * Flagi obiektu z listy okresów. AKTYWNY = niezakończony (patrz `isServiceEnded`).
 *
 * `cameraCount` to SUMA po aktywnych okresach kamer, ale `null`, gdy któryś
 * z nich nie ma liczby: „usługa jest, ilości nikt nie policzył" nie może
 * zamienić się w sumę częściową, bo obiekt wszedłby do podziału kosztu centrum
 * monitorowania z zaniżoną wagą, zamiast zostać zgłoszony jako brak danych.
 */
export function flagsFromServices(
  rows: readonly ServicePeriodLike[],
  today = todayIso()
): ComputedObjectFlags {
  // „Aktywny na dziś" to przedział [dziś, +∞) — jedna definicja aktywności dla
  // listy, analityki i mianownika CMA.
  return flagsFromServicesInRange(rows, today, FAR_FUTURE_DATE);
}

/** Flagi z GOTOWEJ listy okresów aktywnych — wspólny rdzeń obu funkcji wyżej. */
function computeFlags(active: readonly ServicePeriodLike[]): ComputedObjectFlags {
  const cameras = active.filter((r) => r.service === "kamery");
  let cameraCount: number | null = null;
  if (cameras.length > 0) {
    cameraCount = cameras.some((r) => r.cameraCount === null || r.cameraCount === undefined)
      ? null
      : cameras.reduce((sum, r) => sum + (r.cameraCount ?? 0), 0);
  }
  return {
    hasCameras: cameras.length > 0,
    hasSswin: active.some((r) => r.service === "sswin"),
    hasVideoreception: active.some((r) => r.service === "wideorecepcja"),
    hasOfi: active.some((r) => r.service === "ofi"),
    cameraCount,
  };
}

// ---------------------------------------------------------------------------
// „KOŃCZY SIĘ WKRÓTCE" — JEDNA definicja dla listy obiektów i dla analityki
// ---------------------------------------------------------------------------

/** Domyślny horyzont „kończy się wkrótce": filtr listy i kafelek Analityki. */
export const ENDING_SOON_DEFAULT_DAYS = 90;

/** Data przesunięta o N dni, w formacie kolumn dat (`YYYY-MM-DD`). */
export function isoPlusDays(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Granica horyzontu — ostatni dzień, który jeszcze wpada do zestawienia. */
export function endingSoonLimitDate(today: string, horizonDays: number): string {
  return isoPlusDays(today, horizonDays);
}

/**
 * Pierwszy i ostatni dzień miesiąca `YYYY-MM` — granice okna do
 * `isServiceActiveInRange`. Ostatni dzień liczymy jako „dzień przed pierwszym
 * dniem następnego miesiąca", żeby nie mieć w kodzie tabelki długości miesięcy
 * ani wyjątku na luty.
 */
export function monthBounds(year: number, month: number): { from: string; to: string } {
  const mm = String(month).padStart(2, "0");
  const from = `${year}-${mm}-01`;
  const nextY = month === 12 ? year + 1 : year;
  const nextM = month === 12 ? 1 : month + 1;
  return { from, to: isoPlusDays(`${nextY}-${String(nextM).padStart(2, "0")}-01`, -1) };
}

/**
 * PREDYKAT „obiekt kończy się w ciągu N dni" — wersja SQL. Dwa niezależne powody:
 *
 *  1. wpisane wprost `expected_end_date` w horyzoncie (plan biznesowy obiektu),
 *  2. obiekt ma co najmniej jeden NIEZAKOŃCZONY okres usługi i KAŻDY z nich
 *     kończy się w horyzoncie — czyli po tej dacie nie zostaje ani jedna usługa.
 *
 * Warunek „≥1 niezakończony okres" jest tu istotny, a nie kosmetyczny: bez niego
 * obiekt, któremu WSZYSTKIE okresy już się skończyły, spełniał warunek pusto
 * („nie ma okresu wystającego poza horyzont") i wpadał do zestawienia jako
 * „kończący się". Obiekt, który już się skończył, dopiero się nie kończy —
 * zestawienie ma pokazywać UMOWY DO PRZEDŁUŻENIA, a nie archiwum.
 *
 * Obiekt bez ANI JEDNEGO wiersza okresów (skrypty, dane sprzed migracji 0084)
 * nie ma z czego wyliczyć końca i wchodzi tu wyłącznie przez `expected_end_date`.
 *
 * Nazwy tabel piszemy DOSŁOWNIE (`objects.id`, nie `${schema.objects.id}`) —
 * drizzle 0.36 renderuje interpolowaną kolumnę bez kwalifikatora tabeli, co
 * w podzapytaniu skorelowanym trafiłoby w kolumnę zapytania nadrzędnego.
 */
export function endingSoonSql(today: string, horizonDays: number): SQL {
  const limitDate = endingSoonLimitDate(today, horizonDays);
  return sql`(
    (objects.expected_end_date is not null and objects.expected_end_date <= ${limitDate})
    or (
      exists (
        select 1 from object_services s
        where s.object_id = objects.id
          and (s.end_date is null or s.end_date >= ${today})
      )
      and not exists (
        select 1 from object_services s
        where s.object_id = objects.id
          and (s.end_date is null or s.end_date > ${limitDate})
      )
    )
  )`;
}

/**
 * Ten sam predykat w JS — dla analityki, która liczy agregaty w pamięci
 * (patrz nagłówek src/routes/analytics.ts: koszt osobowy przychodzi z Kadr jako
 * mapa, więc do SQL-a nie ma jak go wstrzyknąć).
 *
 * Musi zwracać DOKŁADNIE to samo, co `endingSoonSql` — kafelek Analityki linkuje
 * do listy z tym samym horyzontem i obie liczby użytkownik porównuje wprost.
 */
export function isEndingSoon(
  row: { expectedEndDate?: string | null },
  periods: readonly ServicePeriodLike[],
  today: string,
  horizonDays: number
): boolean {
  const limitDate = endingSoonLimitDate(today, horizonDays);
  if (row.expectedEndDate && row.expectedEndDate <= limitDate) return true;
  const notEnded = periods.filter((p) => !isServiceEnded(p, today));
  if (notEnded.length === 0) return false;
  return notEnded.every((p) => !!p.endDate && p.endDate <= limitDate);
}

/** `db` albo transakcja drizzle — helpery działają w obu kontekstach. */
export type ObjectServicesTx = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Okresy obiektu w kolejności prezentacji (usługa, potem data startu). */
export function readObjectServices(tx: ObjectServicesTx, objectId: number) {
  return tx
    .select()
    .from(schema.objectServices)
    .where(eq(schema.objectServices.objectId, objectId))
    .orderBy(asc(schema.objectServices.service), asc(schema.objectServices.startDate))
    .all();
}

/**
 * Przelicza cache obiektu (`has_*`, `camera_count`, @deprecated `type`) z jego
 * okresów. BEZWARUNKOWY — pusta lista okresów gasi wszystkie flagi, bo tak
 * wygląda obiekt, z którego usunięto ostatnią usługę.
 *
 * Wołać po KAŻDEJ zmianie wierszy okresów, w tej samej transakcji, co zmiana —
 * inaczej między zapisem a syncem lista i analityka pokazują stan sprzed edycji.
 */
export function syncObjectServiceFlags(
  tx: ObjectServicesTx,
  objectId: number,
  today = todayIso()
): ComputedObjectFlags {
  const rows = readObjectServices(tx, objectId);
  const flags = flagsFromServices(rows, today);
  tx.update(schema.objects)
    .set({
      hasCameras: flags.hasCameras,
      hasSswin: flags.hasSswin,
      hasVideoreception: flags.hasVideoreception,
      hasOfi: flags.hasOfi,
      cameraCount: flags.cameraCount,
      type: legacyObjectType(flags),
    })
    .where(eq(schema.objects.id, objectId))
    .run();
  return flags;
}

/**
 * Bulk-sync: przelicza flagi WYŁĄCZNIE obiektom, które mają co najmniej jeden
 * wiersz okresu.
 *
 * Obiekty bez wierszy zostają nietknięte ŚWIADOMIE: skrypty testowe i seedy
 * wstawiają obiekty wprost do `objects` z samymi flagami (test-geo, test-autofill,
 * test-analytics, seed-demo-data…). Globalny sync wyzerowałby im usługi i testy
 * zaczęłyby padać na danych, których nikt nie zmieniał. Sync po zapisie z trasy
 * jest osobny i bezwarunkowy dla edytowanego obiektu.
 *
 * @returns liczba obiektów, którym cache faktycznie się zmienił
 */
export function syncAllObjectServiceFlags(today = todayIso()): number {
  const rows = db
    .select({
      objectId: schema.objectServices.objectId,
      service: schema.objectServices.service,
      startDate: schema.objectServices.startDate,
      endDate: schema.objectServices.endDate,
      cameraCount: schema.objectServices.cameraCount,
    })
    .from(schema.objectServices)
    .all();
  if (rows.length === 0) return 0;

  const byObject = new Map<number, ServicePeriodLike[]>();
  for (const r of rows) {
    const list = byObject.get(r.objectId);
    if (list) list.push(r);
    else byObject.set(r.objectId, [r]);
  }

  const current = db
    .select({
      id: schema.objects.id,
      hasCameras: schema.objects.hasCameras,
      hasSswin: schema.objects.hasSswin,
      hasVideoreception: schema.objects.hasVideoreception,
      hasOfi: schema.objects.hasOfi,
      cameraCount: schema.objects.cameraCount,
      type: schema.objects.type,
    })
    .from(schema.objects)
    .where(inArray(schema.objects.id, [...byObject.keys()]))
    .all();

  let changed = 0;
  db.transaction((tx) => {
    for (const o of current) {
      const flags = flagsFromServices(byObject.get(o.id) ?? [], today);
      const type = legacyObjectType(flags);
      // Zapisujemy tylko realne różnice — bulk po całej kartotece nie ma
      // powodu dotykać `updated_at` obiektów, na których nic się nie zmieniło.
      if (
        o.hasCameras === flags.hasCameras &&
        o.hasSswin === flags.hasSswin &&
        o.hasVideoreception === flags.hasVideoreception &&
        o.hasOfi === flags.hasOfi &&
        o.cameraCount === flags.cameraCount &&
        o.type === type
      ) {
        continue;
      }
      tx.update(schema.objects)
        .set({
          hasCameras: flags.hasCameras,
          hasSswin: flags.hasSswin,
          hasVideoreception: flags.hasVideoreception,
          hasOfi: flags.hasOfi,
          cameraCount: flags.cameraCount,
          type,
        })
        .where(eq(schema.objects.id, o.id))
        .run();
      changed++;
    }
  });
  return changed;
}

/**
 * PEŁNA PODMIANA listy okresów obiektu (diff po `id`: update / insert / delete).
 *
 * Podmiana, a nie „dołóż": bez tego usunięcie wiersza w formularzu nie miałoby
 * jak dojechać do backendu. Wiersz z `id` spoza tego obiektu to próba edycji
 * cudzych danych → `ValidationError` (400), nie ciche pominięcie.
 *
 * NIE woła synca — robi to wołający, razem z resztą swojego zapisu.
 *
 * @returns czy cokolwiek się zmieniło (do decyzji o wpisie w historii obiektu)
 */
export function applyServiceRows(
  tx: ObjectServicesTx,
  objectId: number,
  inputs: readonly ObjectServiceInput[]
): boolean {
  const existing = readObjectServices(tx, objectId);
  const byId = new Map(existing.map((r) => [r.id, r]));
  const keep = new Set<number>();
  const stamp = new Date().toISOString();
  let changed = false;

  for (const input of inputs) {
    const cameraCount = input.service === "kamery" ? input.cameraCount ?? null : null;
    if (input.id !== undefined && input.id !== null) {
      const row = byId.get(input.id);
      if (!row) {
        throw new ValidationError(`Okres usługi #${input.id} nie należy do tego obiektu`);
      }
      keep.add(input.id);
      /*
       * „Data szacowana" gaśnie dokładnie wtedy, gdy użytkownik WPISAŁ inną datę
       * startu — wtedy datę zna i zgadywanka z backfillu 0084 przestaje
       * obowiązywać. Przy niezmienionej dacie zostaje wartość Z BAZY, a nie ta
       * z body: formularz odsyła całą listę przy każdej edycji (liczba kamer,
       * uwagi), więc czytanie flagi z body kasowałoby ją każdemu klientowi,
       * który jej nie zna, albo pozwalało zamalować znaną datę „szacowaną”.
       */
      const startEstimated = row.startDate === input.startDate ? row.startEstimated : false;
      if (
        row.service === input.service &&
        row.startDate === input.startDate &&
        row.endDate === (input.endDate ?? null) &&
        row.startEstimated === startEstimated &&
        row.cameraCount === cameraCount &&
        row.notes === (input.notes ?? null)
      ) {
        continue;
      }
      tx.update(schema.objectServices)
        .set({
          service: input.service,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          startEstimated,
          cameraCount,
          notes: input.notes ?? null,
          updatedAt: stamp,
        })
        .where(eq(schema.objectServices.id, input.id))
        .run();
      changed = true;
    } else {
      tx.insert(schema.objectServices)
        .values({
          objectId,
          service: input.service,
          startDate: input.startDate,
          endDate: input.endDate ?? null,
          // Nowy wiersz z formularza ma datę wpisaną przez człowieka — chyba że
          // klient jawnie powie, że tylko ją oszacował (import, kopia okresu).
          startEstimated: input.startEstimated ?? false,
          cameraCount,
          notes: input.notes ?? null,
        })
        .run();
      changed = true;
    }
  }

  const removed = existing.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (removed.length > 0) {
    tx.delete(schema.objectServices).where(inArray(schema.objectServices.id, removed)).run();
    changed = true;
  }
  return changed;
}

/**
 * Okresy z flag — dla SKRYPTÓW (import kartoteki, seedy), które budują obiekty
 * ze źródeł znających tylko „ma / nie ma".
 *
 * IDEMPOTENTNY: usługa, która ma już jakikolwiek wiersz, jest pomijana, więc
 * powtórzony przebieg importu nie zdubluje okresów. Flag NIE przelicza — skrypt
 * ustawia je sam przy wstawianiu obiektu, a to zostawia jego dane nietknięte.
 *
 * @returns liczba wstawionych wierszy
 */
export function upsertServiceRowsFromFlags(
  tx: ObjectServicesTx,
  objectId: number,
  flags: {
    hasCameras?: boolean | null;
    hasSswin?: boolean | null;
    hasVideoreception?: boolean | null;
    hasOfi?: boolean | null;
    cameraCount?: number | null;
  },
  startDate: string,
  opts: {
    endDate?: string | null;
    notes?: string | null;
    /**
     * `true`, gdy `startDate` NIE pochodzi ze źródła, tylko z fallbacku („dziś",
     * data importu). Wiersz wtedy nie liczy się jako „rozpoczęcie" w analityce —
     * inaczej dzień uruchomienia importu wygląda na miesiąc rekordowej sprzedaży.
     */
    startEstimated?: boolean;
  } = {}
): number {
  const wanted: ObjectServiceKind[] = [];
  if (flags.hasCameras) wanted.push("kamery");
  if (flags.hasSswin) wanted.push("sswin");
  if (flags.hasVideoreception) wanted.push("wideorecepcja");
  if (flags.hasOfi) wanted.push("ofi");
  if (wanted.length === 0) return 0;

  const existing = new Set(
    tx
      .select({ service: schema.objectServices.service })
      .from(schema.objectServices)
      .where(eq(schema.objectServices.objectId, objectId))
      .all()
      .map((r) => r.service)
  );

  let inserted = 0;
  for (const service of wanted) {
    if (existing.has(service)) continue;
    tx.insert(schema.objectServices)
      .values({
        objectId,
        service,
        startDate,
        endDate: opts.endDate ?? null,
        startEstimated: opts.startEstimated ?? false,
        cameraCount: service === "kamery" ? flags.cameraCount ?? null : null,
        notes: opts.notes ?? null,
      })
      .run();
    inserted++;
  }
  return inserted;
}
