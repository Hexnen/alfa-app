/**
 * Numeracja draftów umów: `seq/KOD/rok` (np. `12/ZDW/2026`).
 *
 * Licznik jest PER SPÓŁKA I ROK, bo kod w numerze (`ZDW`) należy do spółki
 * wystawiającej dokument — dwie spółki grupy prowadzą dwie niezależne serie.
 *
 * Wyścig dwóch równoczesnych POST-ów rozstrzyga UNIKALNY INDEKS
 * `(company_id, year, seq)`, a nie to zapytanie: `max(seq)+1` policzone
 * w transakcji zawęża okno, ale gwarancją jest baza. Ta sama konstrukcja co
 * `nextOfferNumberSync` w src/routes/offers.ts.
 *
 * FORMAT NUMERU MIESZKA WYŁĄCZNIE TUTAJ. Oryginalny wzór ma w przykładzie
 * segment miesiąca (`07/01/S.C./2026`); gdyby klient go zażądał, zmiana idzie
 * w jednym miejscu, a nie po całym module.
 */
import { and, eq, sql } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";

export interface ContractNumberParts {
  seq: number;
  companyCode: string;
  year: number;
}

/** Jedyne miejsce, w którym powstaje napis numeru umowy. */
export function formatContractNumber({ seq, companyCode, year }: ContractNumberParts): string {
  return `${seq}/${companyCode}/${year}`;
}

/**
 * Kolejny wolny numer dla spółki w danym roku. Wołać WEWNĄTRZ transakcji,
 * w której wstawiany jest wiersz draftu.
 */
export function nextContractNumberSync(
  dbx: DbOrTx,
  companyId: number,
  companyCode: string,
  year: number
): { seq: number; contractNumber: string } {
  const row = dbx
    .select({ maxSeq: sql<number | null>`max(${schema.contractDrafts.seq})` })
    .from(schema.contractDrafts)
    .where(and(eq(schema.contractDrafts.companyId, companyId), eq(schema.contractDrafts.year, year)))
    .get();
  const seq = (row?.maxSeq ?? 0) + 1;
  return { seq, contractNumber: formatContractNumber({ seq, companyCode, year }) };
}
