/**
 * Miesiąc rozliczeniowy Kadr — lista kontrolna i blokada zamkniętego okresu.
 *
 * Dwie rzeczy, które muszą mówić jednym głosem:
 *  1. CO ZOSTAŁO do zrobienia w miesiącu (`buildMonthChecklist`) — te same
 *     liczby widzi pasek „Postęp miesiąca" w Wynagrodzeniach, kafle miesiąca
 *     (`GET /hr/summary`) i okno „Zamknij miesiąc" (`GET /hr/month-status`).
 *     Gdyby każde z nich liczyło po swojemu, zamknięcie „bez braków" potrafiłoby
 *     zostawić brak widoczny w tabeli obok.
 *  2. CZY WOLNO PISAĆ w tym okresie (`assertMonthOpen`) — jedna funkcja wołana
 *     na wejściu każdego handlera zmieniającego dane MIESIĘCZNE (godziny,
 *     wypłaty, biuro, normy). Słowniki (pracownicy, umowy, obiekty, działy) nie
 *     należą do miesiąca i nie są blokowane.
 *
 * Stan miesiąca trzyma `hr_month_status` (migracja 0106): brak wiersza =
 * miesiąc otwarty. Czytamy synchronicznie (better-sqlite3), więc strażnik jest
 * zwykłym `if` na początku handlera, a nie kolejnym `await`.
 */
import { db, schema } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { periodLabel } from "./hr-activity.js";
import type { DbOrTx } from "./activity-log.js";

// ---------------------------------------------------------------------------
// Lista kontrolna miesiąca
// ---------------------------------------------------------------------------

/**
 * Co jest już zrobione, a czego brakuje. Liczby, nie oceny — decyzję „czy to
 * jeszcze braki" podejmuje `closingWarnings` (backend) i pasek (front).
 */
export interface HrMonthChecklist {
  /** Wszystkie wpisy godzin miesiąca. */
  hoursEntries: number;
  /** Z tego wpisy z jakąkolwiek godziną (praca / urlop / L4). */
  hoursFilled: number;
  /** Wpisy przeniesione z poprzedniego miesiąca, bez potwierdzenia przypisania. */
  uncertainAssignments: number;
  /** Umowy, którym godziny się policzyły (jest z czego liczyć wypłatę). */
  contractsWithHours: number;
  /** Z tego umowy z wpisaną kwotą główną od księgowości. */
  contractsWithAmount: number;
  /** Dodatki „do przeliczenia" — kwota nie jest jeszcze znana. */
  pendingBonus: number;
  /** Umowy z godzinami, ale BEZ kwoty głównej (to samo, co `contractsWithHours - contractsWithAmount`). */
  missingMain: number;
  /** Wpisy rozliczenia biura w miesiącu. */
  officeEntries: number;
  /**
   * Wpisy biura w miesiącu POPRZEDNIM — punkt odniesienia dla pustego biura.
   * Zero wpisów samo w sobie nie jest brakiem (biura mogło nie być), ale zero
   * po miesiącu z czternastoma wpisami to zapomniane rozliczenie.
   */
  prevOfficeEntries: number;
}

/** Wiersz godzin ma cokolwiek wpisane — ta sama reguła, co w zakładce Godziny. */
const hoursRowFilled = (r: HoursRowForChecklist): boolean =>
  (r.workedHours ?? 0) > 0 || (r.uwHours ?? 0) > 0 || (r.l4Hours ?? 0) > 0;

export interface HoursRowForChecklist {
  workedHours?: number | null;
  uwHours?: number | null;
  l4Hours?: number | null;
  objectUncertain?: boolean | null;
}

export interface PayrollRowForChecklist {
  faktGodziny?: number | null;
  kwotaGlowna?: number | null;
  bonusPending?: boolean;
}

/**
 * Lista kontrolna z już wczytanych danych miesiąca — czysta funkcja, bez
 * własnych zapytań, żeby `GET /hr/summary` (który i tak ma te wiersze) nie
 * czytał bazy drugi raz.
 */
export function buildMonthChecklist(input: {
  hours: HoursRowForChecklist[];
  payroll: PayrollRowForChecklist[];
  officeEntries: number;
  prevOfficeEntries: number;
}): HrMonthChecklist {
  const { hours, payroll, officeEntries, prevOfficeEntries } = input;
  const withHours = payroll.filter((r) => (r.faktGodziny ?? 0) > 0);
  const contractsWithAmount = withHours.filter((r) => r.kwotaGlowna != null).length;
  return {
    hoursEntries: hours.length,
    hoursFilled: hours.filter(hoursRowFilled).length,
    uncertainAssignments: hours.filter((r) => r.objectUncertain === true).length,
    contractsWithHours: withHours.length,
    contractsWithAmount,
    pendingBonus: payroll.filter((r) => r.bonusPending === true).length,
    missingMain: withHours.length - contractsWithAmount,
    officeEntries,
    prevOfficeEntries,
  };
}

/**
 * Powody, dla których zamknięcie wymaga świadomego „mimo to”: puste wpisy
 * godzin, niepotwierdzone przypisania, umowy z godzinami bez kwoty i zapomniane
 * rozliczenie biura. Każdy z nich zatrzymuje zamknięcie (`force: true`
 * przechodzi, ale zostawia ślad w dzienniku). Dodatki „do przeliczenia” są
 * tylko notką (`closingNotes`) — domykają się przy wypłacie, po zamknięciu.
 */
export function closingWarnings(checklist: HrMonthChecklist): string[] {
  const out: string[] = [];
  // Kolejność jak w rozliczaniu miesiąca: najpierw godziny, potem ich
  // przypisania, na końcu kwoty i biuro — dokładnie tak, jak czyta się pasek
  // stanu miesiąca nad tabelą.
  const emptyHours = checklist.hoursEntries - checklist.hoursFilled;
  if (emptyHours > 0) {
    out.push(`${emptyHours} wpisów godzin bez godzin`);
  }
  if (checklist.uncertainAssignments > 0) {
    out.push(`${checklist.uncertainAssignments} wpisów godzin z niepotwierdzonym przypisaniem`);
  }
  if (checklist.missingMain > 0) {
    out.push(`${checklist.missingMain} umów z godzinami bez kwoty głównej`);
  }
  // Puste biuro jest brakiem tylko wtedy, gdy poprzedni miesiąc pokazuje, że
  // biuro w ogóle się rozlicza — inaczej ostrzegalibyśmy każdą firmę bez biura.
  if (checklist.officeEntries === 0 && checklist.prevOfficeEntries > 0) {
    out.push(
      `brak rozliczenia biura — w poprzednim miesiącu było ${checklist.prevOfficeEntries} wpisów`,
    );
  }
  return out;
}

/**
 * Rzeczy do odnotowania przy zamknięciu, które go NIE blokują: dodatek „do
 * przeliczenia” z natury domyka się dopiero przy wypłacie, więc wymaganie na
 * niego „mimo to” zamieniłoby ostrzeżenie w formalność klikaną co miesiąc.
 * Okno zamknięcia pokazuje je osobno, pod listą braków.
 */
export function closingNotes(checklist: HrMonthChecklist): string[] {
  const out: string[] = [];
  if (checklist.pendingBonus > 0) {
    out.push(
      `${checklist.pendingBonus} dodatków „do przeliczenia” — kwota domknie się przy wypłacie`,
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Stan miesiąca i blokada zapisu
// ---------------------------------------------------------------------------

/** Wiersz stanu miesiąca albo `null` (brak wiersza = miesiąc nigdy nie zamykany). */
export function monthStatusRow(
  year: number,
  month: number,
  dbx: DbOrTx = db,
): typeof schema.hrMonthStatus.$inferSelect | null {
  return (
    dbx
      .select()
      .from(schema.hrMonthStatus)
      .where(
        and(eq(schema.hrMonthStatus.year, year), eq(schema.hrMonthStatus.month, month)),
      )
      .get() ?? null
  );
}

export const isMonthClosed = (year: number, month: number, dbx: DbOrTx = db): boolean =>
  monthStatusRow(year, month, dbx)?.status === "closed";

/** Komunikat blokady — jedno zdanie, które mówi też, co zrobić dalej. */
export const monthClosedMessage = (year: number, month: number): string =>
  `Miesiąc ${periodLabel({ year, month })} jest zamknięty — otwórz go ponownie, aby wprowadzać zmiany`;

/**
 * Strażnik zapisu danych miesięcznych: `null`, gdy miesiąc jest otwarty, albo
 * gotowy komunikat do odpowiedzi 423 (Locked), gdy zamknięty.
 *
 * Zwraca komunikat, a nie wyjątek — handlery Kadr zwracają błędy przez
 * `c.json({ success: false, error }, kod)` i rzucanie łamałoby ten wzorzec
 * (a w transakcji better-sqlite3 potrafiłoby też cofnąć zapis w połowie).
 */
export function assertMonthOpen(year: number, month: number): string | null {
  return isMonthClosed(year, month) ? monthClosedMessage(year, month) : null;
}
