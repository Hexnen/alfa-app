/**
 * Wstępne wypełnianie wyceny dla PŁATNEJ realizacji z kalendarza.
 *
 * Wycena jest trzecim (obok realizacji i protokołu) dokumentem, który powstaje
 * automatycznie z wydarzenia — ale tylko dla `billing = paid`. Łańcuch danych jest
 * dokładnie ten sam co w protokole (wydarzenie → obiekt → kontrahent → cennik),
 * dlatego zamiast go powielać, korzystamy z `buildProtocolPrefill`: bierzemy z niego
 * gotowy adres montażu i rozstrzygnięty cennik (technika wydarzenia → „Wykonawca 1”
 * → cennik główny). Pozycje wyceny to AKTYWNE pozycje tego cennika z ilością pustą —
 * tak samo, jak przy ręcznym „Nowa wycena” w module Wyceny (POST /quotes).
 *
 * Funkcja jest czysta względem zapisu (tylko odczyt). Zapis robi
 * `createQuoteForRealizationSync` w src/routes/quotes.ts.
 */
import { and, asc, eq } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { CalendarEvent, Realization } from "../db/schema.js";
import type { DbOrTx } from "./activity-log.js";
import { buildProtocolPrefill } from "./protocol-prefill.js";

/** Pozycja wyceny — ten sam kształt, co `QuoteItem` w src/routes/quotes.ts. */
export interface QuotePrefillItem {
  name: string;
  qty: string;
  unit: string;
  price: string;
}

export interface QuotePrefillValues {
  date: string;
  site: string;
  address: string;
  items: QuotePrefillItem[];
}

export interface QuotePrefill {
  values: QuotePrefillValues;
  /** Cennik, z którego wzięto pozycje (null = brak cennika w bazie). */
  priceList: { id: number; name: string; via: "technik" | "domyślny"; technician: string | null } | null;
}

/** Aktywne pozycje cennika po `position` — ilość zostaje pusta (uzupełnia ją człowiek). */
function priceListItems(dbx: DbOrTx, priceListId: number): QuotePrefillItem[] {
  return dbx
    .select({ name: schema.priceList.name, unit: schema.priceList.unit, price: schema.priceList.price })
    .from(schema.priceList)
    .where(and(eq(schema.priceList.priceListId, priceListId), eq(schema.priceList.active, true)))
    .orderBy(asc(schema.priceList.position), asc(schema.priceList.id))
    .all()
    .map((p) => ({ name: p.name, qty: "", unit: p.unit, price: String(p.price) }));
}

export interface BuildQuotePrefillOptions {
  /**
   * Wydarzenie, z którego powstaje realizacja. Potrzebne przy TWORZENIU wyceny:
   * `calendar_events.realization_id` jest wtedy jeszcze puste, więc wydarzenia nie
   * dałoby się odszukać po realizacji (tak samo jak przy protokole).
   */
  event?: CalendarEvent | null;
}

/** Komplet pól wyceny wyliczony z realizacji (i jej wydarzenia). Nic nie zapisuje. */
export function buildQuotePrefill(
  dbx: DbOrTx,
  r: Realization,
  opts: BuildQuotePrefillOptions = {}
): QuotePrefill {
  const { values, context } = buildProtocolPrefill(dbx, r, { event: opts.event });
  return {
    values: {
      date: values.workDate,
      site: r.site,
      // `installationAddress` to adres obiektu (a gdy go nie ma — nazwa obiektu z realizacji).
      address: values.installationAddress,
      items: context.priceList ? priceListItems(dbx, context.priceList.id) : [],
    },
    priceList: context.priceList,
  };
}
