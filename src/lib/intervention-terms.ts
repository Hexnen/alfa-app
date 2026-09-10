/**
 * Warunki grupy interwencyjnej: rozwiązywanie okresu obowiązującego w danym dniu,
 * kontrola nakładania się okresów i ROZLICZENIE podjazdów.
 *
 * DLACZEGO ROZLICZENIE LICZY SIĘ PRZY ODCZYCIE, a nie zapisuje w wierszu interwencji:
 * warunki bywają uzupełniane po fakcie („dopiero teraz mamy podpisaną umowę, stawka
 * za podjazd to 180 zł”). Zamrożona kwota w wierszu znaczyłaby, że korekta warunków
 * nie rusza historii i rejestr rozjeżdża się z fakturą podwykonawcy. Tutaj korekta
 * przelicza wszystko przy następnym otwarciu listy.
 *
 * Konsument: src/routes/intervention-groups.ts.
 */
import { and, eq, ne, sql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import type { Intervention, InterventionTerm } from "../db/schema.js";
import type { DbOrTx } from "./activity-log.js";

/** Data „na zawsze” — `end_date IS NULL` znaczy „umowa trwa”, a nie „skończyła się”. */
export const OPEN_END = "9999-12-31";

/**
 * Wiersz warunków obowiązujący dla obiektu w danym dniu (YYYY-MM-DD) albo null.
 * Okresy tego samego obiektu nie mogą się nakładać (patrz `overlappingTerm`),
 * więc dopasowanie jest co najwyżej jedno — `limit(1)` to wyłącznie asekuracja
 * na dane sprzed wprowadzenia kontroli.
 */
export function resolveTermFor(
  objectId: number,
  date: string,
  dbx: DbOrTx = db
): InterventionTerm | undefined {
  return dbx
    .select()
    .from(schema.interventionTerms)
    .where(
      and(
        eq(schema.interventionTerms.objectId, objectId),
        sql`${schema.interventionTerms.startDate} <= ${date}`,
        sql`coalesce(${schema.interventionTerms.endDate}, ${OPEN_END}) >= ${date}`
      )
    )
    .orderBy(sql`${schema.interventionTerms.startDate} desc`)
    .limit(1)
    .all()[0];
}

/**
 * Wiersz warunków TEGO SAMEGO obiektu, którego okres zachodzi na [startDate, endDate]
 * (endDate null = otwarty). `excludeId` pomija edytowany wiersz.
 *
 * Dwa okresy zachodzą, gdy każdy zaczyna się nie później, niż kończy drugi.
 */
export function overlappingTerm(
  objectId: number,
  startDate: string,
  endDate: string | null,
  excludeId?: number,
  dbx: DbOrTx = db
): InterventionTerm | undefined {
  const conds = [
    eq(schema.interventionTerms.objectId, objectId),
    sql`${schema.interventionTerms.startDate} <= ${endDate ?? OPEN_END}`,
    sql`coalesce(${schema.interventionTerms.endDate}, ${OPEN_END}) >= ${startDate}`,
  ];
  if (excludeId !== undefined) conds.push(ne(schema.interventionTerms.id, excludeId));
  return dbx
    .select()
    .from(schema.interventionTerms)
    .where(and(...conds))
    .orderBy(schema.interventionTerms.startDate)
    .limit(1)
    .all()[0];
}

// ---------------------------------------------------------------------------
// Rozliczenie
// ---------------------------------------------------------------------------

/** Minimum z wiersza warunków potrzebne do policzenia kwot. */
export type SettlementTerm = Pick<
  InterventionTerm,
  "id" | "calloutFee" | "freeCallouts" | "hourlyStandbyFee"
>;

/** Minimum z wiersza interwencji potrzebne do policzenia kwot. */
export type SettlementRow = Pick<
  Intervention,
  "id" | "objectId" | "termId" | "happenedAt" | "standbyHours"
>;

export interface Settlement {
  /** Numer podjazdu w miesiącu kalendarzowym, w ramach pary (obiekt, warunki). Od 1. */
  seqInMonth: number;
  /** Czy mieści się w puli darmowych podjazdów z abonamentu. */
  isFree: boolean;
  /** Koszt podjazdu: 0 dla darmowego, stawka dla płatnego, null gdy stawki nie ma. */
  calloutCost: number | null;
  /** Godziny postoju × stawka; null, gdy brakuje którejkolwiek składowej. */
  standbyCost: number | null;
  /** Suma niepustych składowych; null, gdy obie są puste. */
  totalCost: number | null;
}

/** Miesiąc kalendarzowy z `happened_at` (`2026-03-14T21:05` → `2026-03`). */
function monthOf(happenedAt: string): string {
  return happenedAt.slice(0, 7);
}

/**
 * Rozlicza podjazdy. Zwraca mapę `id interwencji → Settlement`.
 *
 * WAŻNE: numerację trzeba liczyć z PEŁNEGO zbioru miesiąca dla obiektu, a filtry
 * (firma, szukajka) nakładać dopiero na wynik. Inaczej wyszukanie „awaria czujki”
 * przesuwałoby numery i pierwszy znaleziony podjazd wychodziłby na darmowy.
 *
 * Grupujemy po (object_id, term_id, miesiąc), bo pula darmowych podjazdów należy
 * do konkretnej umowy: przy zmianie firmy w połowie miesiąca każda ze stron liczy
 * swoje podjazdy od nowa.
 */
export function settleInterventions(
  rows: SettlementRow[],
  termById: Map<number, SettlementTerm>
): Map<number, Settlement> {
  const groups = new Map<string, SettlementRow[]>();
  for (const r of rows) {
    const key = `${r.objectId}|${r.termId}|${monthOf(r.happenedAt)}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const out = new Map<number, Settlement>();
  for (const list of groups.values()) {
    list.sort((a, b) => a.happenedAt.localeCompare(b.happenedAt) || a.id - b.id);
    list.forEach((row, i) => {
      const seqInMonth = i + 1;
      const term = termById.get(row.termId);
      const free = term?.freeCallouts ?? 0;
      const isFree = seqInMonth <= free;
      const calloutCost = isFree ? 0 : (term?.calloutFee ?? null);
      const rate = term?.hourlyStandbyFee ?? null;
      const standbyCost =
        row.standbyHours !== null && row.standbyHours !== undefined && rate !== null
          ? round2(row.standbyHours * rate)
          : null;
      const totalCost =
        calloutCost === null && standbyCost === null
          ? null
          : round2((calloutCost ?? 0) + (standbyCost ?? 0));
      out.set(row.id, { seqInMonth, isFree, calloutCost, standbyCost, totalCost });
    });
  }
  return out;
}

/** Grosze, nie ogony binarne: 1.5 × 33.33 ma dać 50, a nie 49.994999999999997. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export interface SettlementSummary {
  count: number;
  freeCount: number;
  calloutCost: number;
  standbyCost: number;
  totalCost: number;
}

/** Podsumowanie listy — sumuje wyłącznie NIEPUSTE kwoty (null ≠ 0 zł). */
export function summarize(items: Settlement[]): SettlementSummary {
  const sum = (pick: (s: Settlement) => number | null) =>
    round2(items.reduce((acc, s) => acc + (pick(s) ?? 0), 0));
  return {
    count: items.length,
    freeCount: items.filter((s) => s.isFree).length,
    calloutCost: sum((s) => s.calloutCost),
    standbyCost: sum((s) => s.standbyCost),
    totalCost: sum((s) => s.totalCost),
  };
}
