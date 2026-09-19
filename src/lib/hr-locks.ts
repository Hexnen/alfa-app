/**
 * Rezerwacja listy Kadr do edycji — kto teraz pisze w wypłatach, godzinach
 * i biurze danego miesiąca (tabela `hr_edit_locks`, migracja 0109).
 *
 * PO CO. Konflikt wersji jednego wiersza pilnuje `expectedUpdatedAt` (409
 * „ktoś zmienił, odśwież”). Ale wypełnianie miesiąca to nie jeden wiersz, tylko
 * pół godziny wpisywania w te same kolumny z kartki od księgowości — dwie
 * osoby robiące to naraz zamazują się nawzajem seriami, a każdy zapis z osobna
 * wygląda poprawnie. Dlatego przełącznik „Podgląd → Edycja” BIERZE listę na
 * 15 minut, a pozostali widzą właściciela i mogą poprosić o zwolnienie.
 *
 * REZERWACJA JEST CZĘŚCIOWA. Kadry to nie jedna kolejka do jednego arkusza:
 * OFI wpisuje swoje godziny obiektowe, CMA swoje, a księgowość domyka całość.
 * Blokada ma więc trzy współrzędne: (lista, miesiąc, PORTAL DZIAŁU).
 *  - portal (`hr_departments.portal`, np. `ofi`) rezerwuje WYŁĄCZNIE wiersze
 *    swoich działów — reszta listy zostaje wolna,
 *  - pełne Kadry (portal `null`) rezerwują CAŁOŚĆ, ale z wyłączeniem działów,
 *    które ktoś już trzyma: te wiersze są dla nich zablokowane (i o nie można
 *    poprosić z osobna), a cała reszta jest do pisania od razu,
 *  - 409 „lista zajęta” zostaje tylko wtedy, gdy nie da się edytować NICZEGO:
 *    całość trzyma ktoś inny albo trzyma ktoś inny dokładnie ten portal.
 *
 * TRZY REGUŁY, KTÓRE TRZYMAJĄ TO W RYZACH:
 *  1. Rezerwacja należy do UŻYTKOWNIKA, nie do karty — ta sama osoba zapisze
 *     z drugiego okna i z telefonu, bo to wciąż jedna seria zmian.
 *  2. Rezerwacja WYGASA (`expires_at`). Zamknięty laptop niczego nie zwolni,
 *     więc brak heartbeatu przez 15 minut = lista wraca do puli. Wiersz po
 *     terminie jest martwy nawet zanim ktoś go skasuje.
 *  3. Sprzątanie jest LENIWE: martwe wiersze kasuje pierwsze `acquire` albo
 *     odczyt stanu. Cron do kilku wierszy na miesiąc byłby przerostem formy.
 *
 * Trasy HTTP siedzą w `src/routes/hr-locks.ts`, a egzekwowanie przy zapisie —
 * w `writeGuard` w `src/routes/hr.ts` (obok blokady zamkniętego miesiąca).
 */
import { db, schema } from "../db/index.js";
import { and, eq, inArray } from "drizzle-orm";
import type { User } from "../db/schema.js";
import { userLabelOf, type DbOrTx } from "./activity-log.js";

/** Listy, które da się zarezerwować. Słowniki celowo nie mają rezerwacji. */
export const HR_LOCK_SCOPES = ["payroll", "hours", "office"] as const;
export type HrLockScope = (typeof HR_LOCK_SCOPES)[number];

export const isHrLockScope = (v: unknown): v is HrLockScope =>
  typeof v === "string" && (HR_LOCK_SCOPES as readonly string[]).includes(v);

/**
 * Portal w API: `null` = CAŁA lista (pełne Kadry), tekst = jeden portal działowy.
 *
 * W bazie `null` jest zapisany jako `""`, bo w SQLite dwa NULL-e są w indeksie
 * UNIQUE RÓŻNE — z NULL-em unikat (scope, rok, miesiąc, portal) przepuściłby
 * dowolnie wiele rezerwacji całości, czyli dokładnie to, przed czym broni.
 */
export type HrPortal = string | null;

/** Wartość kolumny `portal` dla rezerwacji całej listy. */
const WHOLE = "";

/** API → baza (`null` i puste zdania to jedno i to samo). */
const toDbPortal = (p: HrPortal | undefined): string =>
  typeof p === "string" ? p.trim().slice(0, 40) : WHOLE;

/** Baza → API. */
const toApiPortal = (v: string): HrPortal => (v === WHOLE ? null : v);

/**
 * Ile trwa rezerwacja. 15 minut to kompromis: dość, żeby przejść się po biurze
 * z pytaniem do księgowej, i na tyle mało, że po zamkniętym laptopie nikt nie
 * czeka do jutra. Klient przedłuża ją heartbeatem co 60 s, a każdy zapis
 * odnawia ją samoczynnie (`touchLock`).
 */
export const HR_LOCK_TTL_MS = 15 * 60_000;

/** Odstęp, przed upływem którego kolejna prośba o zwolnienie odbija się 429. */
export const HR_LOCK_REQUEST_COOLDOWN_MS = 2 * 60_000;

/** Nazwy list w zdaniach: „Listę wypłat edytuje Jan Kowalski”. */
const SCOPE_LABEL: Record<HrLockScope, string> = {
  payroll: "Listę wypłat",
  hours: "Listę godzin",
  office: "Rozliczenie biura",
};

/** Dopełniacz do prośby: „poprosiła o zwolnienie listy wypłat”. */
export const scopeLabelGen: Record<HrLockScope, string> = {
  payroll: "listy wypłat",
  hours: "listy godzin",
  office: "rozliczenia biura",
};

/** Biernik do zdania „Jan Kowalski edytuje listę wypłat”. */
export const scopeLabelAcc: Record<HrLockScope, string> = {
  payroll: "listę wypłat",
  hours: "listę godzin",
  office: "rozliczenie biura",
};

type LockRow = typeof schema.hrEditLocks.$inferSelect;

/** Godzina z ISO w strefie serwera — „do 14:32” w komunikacie. */
export function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Czy rezerwacja wciąż żyje (termin w przyszłości). */
export const isLockLive = (row: LockRow, now = Date.now()): boolean =>
  Date.parse(row.expiresAt) > now;

// ---------------------------------------------------------------------------
// Portale działów
// ---------------------------------------------------------------------------

/**
 * Portal działu (`hr_departments.portal`). `null` = dział bez portalu, czyli
 * wiersze należące wyłącznie do pełnych Kadr.
 *
 * Czytamy przy każdym pytaniu, bez cache'u: to jedno zapytanie po kluczu
 * głównym w słowniku, który ma kilka wierszy, a nieświeży cache po zmianie
 * przypisania działu dawałby blokadę „nie tego” portalu.
 */
export function portalOfDepartment(
  departmentId: number | null | undefined,
  dbx: DbOrTx = db,
): HrPortal {
  if (departmentId == null) return null;
  const row = dbx
    .select({ portal: schema.hrDepartments.portal })
    .from(schema.hrDepartments)
    .where(eq(schema.hrDepartments.id, departmentId))
    .get();
  return row?.portal ?? null;
}

/** Portal pracownika — z jego działu w kartotece (wypłaty i biuro). */
export function portalOfEmployee(
  employeeId: number | null | undefined,
  dbx: DbOrTx = db,
): HrPortal {
  if (employeeId == null) return null;
  const row = dbx
    .select({ departmentId: schema.hrEmployees.departmentId })
    .from(schema.hrEmployees)
    .where(eq(schema.hrEmployees.id, employeeId))
    .get();
  return portalOfDepartment(row?.departmentId ?? null, dbx);
}

/** Portal umowy — przez pracownika, do którego należy. */
export function portalOfContract(
  contractId: number | null | undefined,
  dbx: DbOrTx = db,
): HrPortal {
  if (contractId == null) return null;
  const row = dbx
    .select({ employeeId: schema.hrContracts.employeeId })
    .from(schema.hrContracts)
    .where(eq(schema.hrContracts.id, contractId))
    .get();
  return portalOfEmployee(row?.employeeId ?? null, dbx);
}

/** Portale wpisów godzin (operacje zbiorcze) — bez powtarzania zapytań. */
export function portalsOfHoursIds(ids: readonly number[], dbx: DbOrTx = db): HrPortal[] {
  if (ids.length === 0) return [];
  const rows = dbx
    .select({ departmentId: schema.hrHours.departmentId })
    .from(schema.hrHours)
    .where(inArray(schema.hrHours.id, [...ids]))
    .all();
  const cache = new Map<number | null, HrPortal>();
  const out = new Set<HrPortal>();
  for (const r of rows) {
    const key = r.departmentId ?? null;
    if (!cache.has(key)) cache.set(key, portalOfDepartment(key, dbx));
    out.add(cache.get(key) ?? null);
  }
  return [...out];
}

/** Etykiety portali do komunikatów („OFI”, a nie „ofi”). */
export function portalLabels(dbx: DbOrTx = db): Map<string, string> {
  const rows = dbx
    .select({ name: schema.hrDepartments.name, portal: schema.hrDepartments.portal })
    .from(schema.hrDepartments)
    .all();
  const out = new Map<string, string>();
  for (const r of rows) {
    if (!r.portal) continue;
    if (!out.has(r.portal)) out.set(r.portal, r.name);
  }
  return out;
}

/** Etykieta jednego portalu (fallback: sam klucz). */
export const portalLabel = (portal: HrPortal, dbx: DbOrTx = db): string =>
  portal == null ? "całość" : (portalLabels(dbx).get(portal) ?? portal);

// ---------------------------------------------------------------------------
// Kształt widziany przez front
// ---------------------------------------------------------------------------

export interface HrLockDto {
  scope: HrLockScope;
  year: number;
  month: number;
  /** `null` = rezerwacja CAŁEJ listy; tekst = portal działowy. */
  portal: HrPortal;
  /** Nazwa działu portalu („OFI”) — do zdań w interfejsie. */
  portalLabel: string | null;
  userId: number;
  /** Podpis właściciela („Jan Kowalski”) — do paska i komunikatów. */
  userLabel: string;
  acquiredAt: string;
  expiresAt: string;
  /** Czy trzyma ją użytkownik, który pyta (wtedy front wchodzi w edycję). */
  mine: boolean;
  /** Prośba o zwolnienie — właściciel widzi po niej baner nad tabelą. */
  request: { userId: number | null; label: string; at: string; message: string | null } | null;
}

export function lockDto(row: LockRow, viewerId: number | null, dbx: DbOrTx = db): HrLockDto {
  const portal = toApiPortal(row.portal);
  return {
    scope: row.scope as HrLockScope,
    year: row.year,
    month: row.month,
    portal,
    portalLabel: portal == null ? null : (portalLabels(dbx).get(portal) ?? portal),
    userId: row.userId,
    userLabel: row.userLabel || "Ktoś inny",
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    mine: viewerId != null && row.userId === viewerId,
    request: row.requestedAt
      ? {
          userId: row.requestedByUserId ?? null,
          label: row.requestedByLabel || "Ktoś inny",
          at: row.requestedAt,
          message: row.requestMessage ?? null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Odczyt
// ---------------------------------------------------------------------------

/**
 * Wszystkie ŻYWE rezerwacje jednej listy w miesiącu; martwe kasuje po drodze
 * (leniwe sprzątanie — po wiersze po terminie nie przychodzi żaden cron).
 */
export function liveLocks(
  scope: HrLockScope,
  year: number,
  month: number,
  dbx: DbOrTx = db,
): LockRow[] {
  return pruneLocks(scope, year, month, dbx).live;
}

/**
 * Rezerwacje listy z podziałem na żywe i właśnie skasowane (po terminie).
 * Martwe wracają z funkcji, bo kto przejmuje wygasłą rezerwację, ten ma prawo
 * wiedzieć (i zapisać w dzienniku), po kim ją przejął.
 */
function pruneLocks(
  scope: HrLockScope,
  year: number,
  month: number,
  dbx: DbOrTx = db,
): { live: LockRow[]; dead: LockRow[] } {
  const rows = dbx
    .select()
    .from(schema.hrEditLocks)
    .where(
      and(
        eq(schema.hrEditLocks.scope, scope),
        eq(schema.hrEditLocks.year, year),
        eq(schema.hrEditLocks.month, month),
      ),
    )
    .all();
  const now = Date.now();
  const live: LockRow[] = [];
  const dead: LockRow[] = [];
  for (const row of rows) {
    if (isLockLive(row, now)) {
      live.push(row);
      continue;
    }
    dead.push(row);
    dbx.delete(schema.hrEditLocks).where(eq(schema.hrEditLocks.id, row.id)).run();
  }
  return { live, dead };
}

/** Jedna rezerwacja (lista + portal) albo `null`, gdy jej nie ma lub wygasła. */
export function liveLockRow(
  scope: HrLockScope,
  year: number,
  month: number,
  portal: HrPortal,
  dbx: DbOrTx = db,
): LockRow | null {
  const want = toDbPortal(portal);
  return liveLocks(scope, year, month, dbx).find((r) => r.portal === want) ?? null;
}

/** Stan rezerwacji trzech list miesiąca — wszystkie żywe, z moją włącznie. */
export function monthLocks(
  year: number,
  month: number,
  viewerId: number | null,
): Record<HrLockScope, HrLockDto[]> {
  const out = {} as Record<HrLockScope, HrLockDto[]>;
  for (const scope of HR_LOCK_SCOPES) {
    out[scope] = liveLocks(scope, year, month).map((r) => lockDto(r, viewerId));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Zapis
// ---------------------------------------------------------------------------

export interface AcquireResult {
  ok: boolean;
  lock: HrLockDto;
  /**
   * Działy WYŁĄCZONE z tej rezerwacji: portale, które w tej chwili trzyma ktoś
   * inny. Pełne Kadry dostają listę i tak — ich wiersze są wyszarzone, a o
   * każdy dział wolno poprosić osobno. Dla rezerwacji portalowej lista jest
   * zawsze pusta (portal i tak sięga tylko swoich wierszy).
   */
  excluded: HrLockDto[];
  /**
   * Podpis osoby, po której przejęto WYGASŁĄ rezerwację (`null`, gdy lista była
   * wolna albo już nasza). Trasa zapisuje to w dzienniku — „lista sama się
   * zwolniła i ktoś inny ją wziął” to zdarzenie, o które ludzie pytają.
   */
  takenOverFrom: string | null;
}

/**
 * Bierze listę (albo jej portal) na `HR_LOCK_TTL_MS`. Wynik:
 *  - `ok: true` — mamy co edytować; `excluded` mówi, których działów NIE
 *    (bo trzyma je ktoś inny),
 *  - `ok: false` — nie da się edytować nic: całość trzyma ktoś inny albo
 *    trzyma ktoś inny dokładnie ten portal. `lock` opisuje właściciela.
 *
 * CAŁOŚĆ W JEDNEJ TRANSAKCJI: odczyt i wstawienie muszą być atomowe, bo dwa
 * równoległe „Edycja” z dwóch przeglądarek inaczej zobaczyłyby obie „wolne”.
 * Ostatnią linią obrony jest unikat (scope, rok, miesiąc, portal) z 0109.
 */
export function acquireLock(input: {
  user: User;
  scope: HrLockScope;
  year: number;
  month: number;
  /** Portal wołającego; `null`/brak = pełne Kadry (całość listy). */
  portal?: HrPortal;
  clientId: string | null;
}): AcquireResult {
  const { user, scope, year, month, clientId } = input;
  const portal = toDbPortal(input.portal);
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresAt = new Date(now.getTime() + HR_LOCK_TTL_MS).toISOString();

  return db.transaction((tx): AcquireResult => {
    const { live: rows, dead } = pruneLocks(scope, year, month, tx);
    const whole = rows.find((r) => r.portal === WHOLE) ?? null;
    const existing = rows.find((r) => r.portal === portal) ?? null;
    /** Po kim przejmujemy WYGASŁĄ rezerwację tej samej listy (do dziennika). */
    const expiredHere = dead.find((r) => r.portal === portal && r.userId !== user.id) ?? null;

    // Całość w cudzych rękach blokuje wszystko — także portal, bo jego wiersze
    // są częścią tej całości.
    if (whole && whole.userId !== user.id) {
      return {
        ok: false,
        lock: lockDto(whole, user.id, tx),
        excluded: [],
        takenOverFrom: null,
      };
    }
    // Ten sam portal u kogoś innego = nie ma czego brać.
    if (existing && existing.userId !== user.id) {
      return {
        ok: false,
        lock: lockDto(existing, user.id, tx),
        excluded: [],
        takenOverFrom: null,
      };
    }

    const takenOverFrom = expiredHere ? expiredHere.userLabel || "ktoś inny" : null;

    const values = {
      scope,
      year,
      month,
      portal,
      userId: user.id,
      userLabel: userLabelOf(user),
      clientId,
      acquiredAt: existing ? existing.acquiredAt : nowIso,
      expiresAt,
      lastSeenAt: nowIso,
      // Prośba dotyczyła POPRZEDNIEJ rezerwacji — nowy właściciel nie ma jej
      // po kim dziedziczyć (a baner „proszą o zwolnienie” wisiałby bez powodu).
      requestedByUserId: null,
      requestedByLabel: null,
      requestedAt: null,
      requestMessage: null,
    };

    const row = existing
      ? tx
          .update(schema.hrEditLocks)
          .set(values)
          .where(eq(schema.hrEditLocks.id, existing.id))
          .returning()
          .get()
      : tx.insert(schema.hrEditLocks).values(values).returning().get();

    // Działy zajęte przez kogoś innego: dla całości to lista wyłączeń,
    // dla portalu — zawsze pusta (nie sięga cudzych wierszy).
    const excluded =
      portal === WHOLE
        ? rows
            .filter((r) => r.portal !== WHOLE && r.userId !== user.id)
            .map((r) => lockDto(r, user.id, tx))
        : [];

    return { ok: true, lock: lockDto(row, user.id, tx), excluded, takenOverFrom };
  });
}

/** Przedłuża WŁASNĄ rezerwację. `null` = nie ma czego przedłużać (wygasła/cudza). */
export function heartbeatLock(input: {
  user: User;
  scope: HrLockScope;
  year: number;
  month: number;
  portal?: HrPortal;
}): HrLockDto | null {
  const { user, scope, year, month } = input;
  const row = liveLockRow(scope, year, month, input.portal ?? null);
  if (!row || row.userId !== user.id) return null;
  return lockDto(touchLock(row), user.id);
}

/**
 * Odnawia termin rezerwacji. Wołane heartbeatem co 60 s ORAZ przy każdym
 * zapisie (`writeGuard`) — kto pisze, ten nie może stracić listy tylko dlatego,
 * że karta akurat nie zdążyła z pingiem.
 */
export function touchLock(row: LockRow): LockRow {
  const now = new Date();
  return (
    db
      .update(schema.hrEditLocks)
      .set({
        lastSeenAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + HR_LOCK_TTL_MS).toISOString(),
      })
      .where(eq(schema.hrEditLocks.id, row.id))
      .returning()
      .get() ?? row
  );
}

/**
 * Zwalnia WŁASNĄ rezerwację. Zwraca `true`, gdy faktycznie coś zwolniono —
 * `false` znaczy „nie było czego” (wygasła, cudza), co dla klienta jest równie
 * dobrym końcem i NIE jest błędem: `release` leci też z `sendBeacon` przy
 * zamykaniu karty, gdzie nikt nie przeczyta kodu odpowiedzi.
 */
export function releaseLock(input: {
  user: User;
  scope: HrLockScope;
  year: number;
  month: number;
  portal?: HrPortal;
  /** Admin może zdjąć cudzą rezerwację (awaryjnie — zwykły user nie). */
  force?: boolean;
}): { released: boolean; previousOwner: string | null } {
  const { user, scope, year, month } = input;
  const row = liveLockRow(scope, year, month, input.portal ?? null);
  if (!row) return { released: false, previousOwner: null };
  if (row.userId !== user.id && !input.force) {
    return { released: false, previousOwner: row.userLabel || null };
  }
  db.delete(schema.hrEditLocks).where(eq(schema.hrEditLocks.id, row.id)).run();
  return { released: true, previousOwner: row.userLabel || null };
}

export type RequestReleaseResult =
  | { status: "ok"; lock: HrLockDto; ownerLabel: string }
  | { status: "no-lock" }
  | { status: "mine" }
  | { status: "cooldown"; lock: HrLockDto; retryAfterMs: number };

/**
 * Prośba o zwolnienie listy albo jednego jej portalu. Zapis idzie w wiersz
 * rezerwacji (jedna prośba na rezerwację), a sygnał SSE budzi właściciela
 * banerem.
 *
 * Powtórka w ciągu 2 minut odbija się `cooldown`: „poproś” to przycisk, w który
 * człowiek czekający na listę wciśnie dziesięć razy, a właściciel ma zobaczyć
 * jedną prośbę, nie dziesięć banerów.
 */
export function requestRelease(input: {
  user: User;
  scope: HrLockScope;
  year: number;
  month: number;
  portal?: HrPortal;
  message?: string | null;
}): RequestReleaseResult {
  const { user, scope, year, month } = input;
  const row = liveLockRow(scope, year, month, input.portal ?? null);
  if (!row) return { status: "no-lock" };
  if (row.userId === user.id) return { status: "mine" };
  const now = Date.now();
  if (row.requestedAt) {
    const age = now - Date.parse(row.requestedAt);
    if (Number.isFinite(age) && age < HR_LOCK_REQUEST_COOLDOWN_MS) {
      return {
        status: "cooldown",
        lock: lockDto(row, user.id),
        retryAfterMs: HR_LOCK_REQUEST_COOLDOWN_MS - age,
      };
    }
  }
  const message = (input.message ?? "").trim().slice(0, 200) || null;
  const updated =
    db
      .update(schema.hrEditLocks)
      .set({
        requestedByUserId: user.id,
        requestedByLabel: userLabelOf(user),
        requestedAt: new Date(now).toISOString(),
        requestMessage: message,
      })
      .where(eq(schema.hrEditLocks.id, row.id))
      .returning()
      .get() ?? row;
  return {
    status: "ok",
    lock: lockDto(updated, user.id),
    ownerLabel: row.userLabel || "właściciela listy",
  };
}

// ---------------------------------------------------------------------------
// Egzekwowanie przy zapisie
// ---------------------------------------------------------------------------

/**
 * Czego dotyczy zapis: lista portali wierszy (`null` w tablicy = wiersz bez
 * działu/portalu, czyli należący wyłącznie do pełnych Kadr) albo `"all"` —
 * operacja zbiorcza dotykająca całej listy (przeniesienie z poprzedniego
 * miesiąca, wklejka kwot).
 */
export type WritePortals = readonly HrPortal[] | "all";

export interface EditLockDenial {
  error: string;
  /** Rezerwacja, która zablokowała zapis (gdy trzyma ją ktoś inny). */
  lock: HrLockDto | null;
  /** Portal, o który trzeba poprosić (front proponuje prośbę o TEN dział). */
  portal: HrPortal;
}

/**
 * Strażnik zapisu: `null`, gdy wołający ma rezerwację POKRYWAJĄCĄ zapisywane
 * wiersze, albo gotowy komunikat do odpowiedzi 423 (Locked).
 *
 * Reguła: wiersz wolno zapisać, gdy piszący trzyma całość ALBO portal tego
 * wiersza — i gdy nikt inny nie trzyma portalu tego wiersza (rezerwacja
 * całości nie przebija portalu, bo to portal wypełnia swoje godziny).
 *
 * Zwraca komunikat, a nie wyjątek — tak samo jak `assertMonthOpen`, bo handlery
 * Kadr zwracają błędy przez `c.json({ success: false, error }, kod)`.
 *
 * TRZY RÓŻNE 423, które front rozróżnia po `lock`/`portal`:
 *  - „trzyma ktoś inny” (mówi kto, do kiedy i który dział) → prośba o zwolnienie,
 *  - „rezerwacja wygasła” (`lock: null`) → ciche wzięcie listy i powtórka zapisu,
 *  - „operacja zbiorcza wymaga całej listy” → przełącz się na pełną edycję.
 */
export function assertEditLock(
  user: User,
  scope: HrLockScope,
  year: number,
  month: number,
  portals: WritePortals = "all",
): EditLockDenial | null {
  const rows = liveLocks(scope, year, month);
  const whole = rows.find((r) => r.portal === WHOLE) ?? null;
  const mineWhole = whole && whole.userId === user.id ? whole : null;
  const otherWhole = whole && whole.userId !== user.id ? whole : null;

  const deniedByOther = (row: LockRow): EditLockDenial => ({
    error:
      row.portal === WHOLE
        ? `${SCOPE_LABEL[scope]} edytuje ${row.userLabel || "ktoś inny"} (do ${hhmm(row.expiresAt)}) — poproś o zwolnienie`
        : `Wiersze działu ${portalLabel(toApiPortal(row.portal))} edytuje ${row.userLabel || "ktoś inny"} (do ${hhmm(row.expiresAt)}) — poproś o zwolnienie`,
    lock: lockDto(row, user.id),
    portal: toApiPortal(row.portal),
  });

  const expired = (portal: HrPortal): EditLockDenial => ({
    error: `Rezerwacja ${scopeLabelGen[scope]} wygasła — kliknij „Edycja”, aby ją odnowić`,
    lock: null,
    portal,
  });

  // Operacja zbiorcza dotyka wszystkiego, więc wymaga całej listy i braku
  // cudzych rezerwacji działowych — inaczej po cichu wpisałaby się w wiersze,
  // które ktoś właśnie wypełnia.
  if (portals === "all") {
    if (otherWhole) return deniedByOther(otherWhole);
    const foreign = rows.find((r) => r.portal !== WHOLE && r.userId !== user.id);
    if (foreign) return deniedByOther(foreign);
    if (!mineWhole) return expired(null);
    touchLock(mineWhole);
    return null;
  }

  const used: LockRow[] = [];
  for (const p of new Set(portals)) {
    const want = toDbPortal(p);
    const mineHere = rows.find((r) => r.portal === want && r.userId === user.id) ?? null;
    const otherHere = rows.find((r) => r.portal === want && r.userId !== user.id) ?? null;
    // Dokładnie ten portal (albo całość) w cudzych rękach — koniec rozmowy.
    if (otherHere) return deniedByOther(otherHere);
    if (mineHere) {
      // Mam rezerwację TEGO portalu. Cudza rezerwacja całości mnie nie dotyczy:
      // powstała już Z WYŁĄCZENIEM mojego działu (patrz `acquireLock`), więc
      // sekcja pisze swoje wiersze, choć Kadry trzymają resztę listy.
      used.push(mineHere);
      continue;
    }
    // Nie mam tego portalu — zostaje moja rezerwacja CAŁOŚCI (wiersz bez działu
    // pokrywa zresztą wyłącznie ona).
    if (otherWhole) return deniedByOther(otherWhole);
    if (!mineWhole) return expired(p);
    used.push(mineWhole);
  }
  // Kto pisze, ten trzyma: każdy zapis odnawia termin, więc wpisywanie kwot
  // przez pół godziny nie gubi listy przy zgubionym heartbeacie.
  for (const row of new Set(used)) touchLock(row);
  return null;
}
