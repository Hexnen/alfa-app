/**
 * Numeracja draftów umów: `seq/KOD/rok` (np. `12/ZDW/2026`, `3/RODO/2026`).
 *
 * Licznik jest PER SPÓŁKA, ROK I KOD. Kod należy albo do spółki wystawiającej
 * dokument (umowa ZDW bierze `companies.contract_code`), albo do samego wzoru
 * (umowa RODO ma stały `RODO` — patrz `ContractTemplateDef.numberCode`). Dzięki
 * trzeciemu członowi klucza dwie spółki grupy prowadzą dwie niezależne serie,
 * a umowa towarzysząca nie zjada numeru umowie głównej.
 *
 * Wyścig dwóch równoczesnych POST-ów rozstrzyga UNIKALNY INDEKS
 * `(company_id, year, number_code, seq)`, a nie to zapytanie: `max(seq)+1`
 * policzone w transakcji zawęża okno, ale gwarancją jest baza. Ta sama
 * konstrukcja co `nextOfferNumberSync` w src/routes/offers.ts.
 *
 * SKASOWANIE OSTATNIEGO DRAFTU ZWALNIA NUMER — i tylko w swojej serii, bo
 * `max(seq)` liczymy z tym samym filtrem, z którym nadajemy.
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
  /** Kod serii: spółki (`ZDW`) albo szablonu (`RODO`). */
  numberCode: string;
  year: number;
}

/** Jedyne miejsce, w którym powstaje napis numeru umowy. */
export function formatContractNumber({ seq, numberCode, year }: ContractNumberParts): string {
  return `${seq}/${numberCode}/${year}`;
}

/**
 * Kolejny wolny numer w serii (spółka + rok + kod). Wołać WEWNĄTRZ transakcji,
 * w której wstawiany jest wiersz draftu.
 */
export function nextContractNumberSync(
  dbx: DbOrTx,
  companyId: number,
  numberCode: string,
  year: number
): { seq: number; contractNumber: string } {
  const row = dbx
    .select({ maxSeq: sql<number | null>`max(${schema.contractDrafts.seq})` })
    .from(schema.contractDrafts)
    .where(
      and(
        eq(schema.contractDrafts.companyId, companyId),
        eq(schema.contractDrafts.year, year),
        eq(schema.contractDrafts.numberCode, numberCode)
      )
    )
    .get();
  const seq = (row?.maxSeq ?? 0) + 1;
  return { seq, contractNumber: formatContractNumber({ seq, numberCode, year }) };
}
