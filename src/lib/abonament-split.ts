import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * ROZBICIE ABONAMENTU NA LINIE USŁUGOWE (wrzesień 2026).
 *
 * Obiekt płaci co miesiąc trzy różne rzeczy i do tej pory dwie z nich siedziały
 * w jednej kolumnie `objects.monthly_value`:
 *
 *   monthly_zdw    — zdalny dozór wizyjny: kamery, SSWiN, wideorecepcja (CMA),
 *   monthly_ofi    — ochrona fizyczna: ludzie stojący na obiekcie,
 *   monthly_rental — dzierżawa sprzętu (osobna kolumna od sierpnia 2026).
 *
 * DLACZEGO TO BOLAŁO: Analityka ma przekrój usługowy (`?service=zdv|ofi|all`),
 * a przy jednej kwocie obiekt z kamerami I wartownikiem wchodził CAŁYM
 * abonamentem do obu przekrojów. „ZDV + OFI" wychodziło więcej niż „wszystko" —
 * i nie dało się tego naprawić inaczej niż rozbiciem danych, bo klucza podziału
 * jednej faktury na dwie linie w bazie po prostu nie było.
 *
 * NULL ≠ 0, tak jak wszędzie w tym schemacie: brak kwoty znaczy „nikt nie
 * uzupełnił", zero znaczyłoby „robimy to za darmo".
 *
 * DZIERŻAWA LICZY SIĘ DO ZDV: dzierżawiony sprzęt to sprzęt monitoringu
 * (rejestratory, kamery), nie mundur wartownika.
 *
 * FLAGI USŁUG = USŁUGI AKTYWNE DZIŚ. Od wprowadzenia okresów usług (tabela
 * `object_services`, migracja 0084) `objects.has_*` jest CACHE'em przeliczanym
 * z okresów: flaga zapala się, gdy obiekt ma choć jeden NIEZAKOŃCZONY okres tej
 * usługi (src/lib/object-services.ts → `flagsFromServices`). Rozbicie
 * abonamentu i `SERVICE_SQL` czytają więc stan NA DZIŚ — i tak ma zostać:
 * abonament jest kwotą bieżącą, a nie szeregiem czasowym, więc dzielenie go po
 * usługach sprzed roku dałoby rozbicie faktury, której nikt dziś nie wystawia.
 * Historię usług czyta wyłącznie seria czasowa analityki i mianownik kosztu CMA
 * per miesiąc.
 */

/** Marker dopisywany do notatek obiektu, którego rozbicia nie dało się ustalić. */
export const SPLIT_TODO_NOTE = "Rozbicie abonamentu do potwierdzenia";

/** Fraza z scripts/uzupelnij-kartoteke.ts — cena z majowego wyciągu wspólnoty. */
const BANK_NOTE = "Abonament z wpływu bankowego";
/** Fraza z scripts/uzupelnij-kartoteke.ts — kwota rozdzielona z faktury zbiorczej. */
const SPLIT_INVOICE_NOTE = "Abonament rozdzielony z faktury zbiorczej";

export type SplitSource =
  | "brak-kwoty"
  | "brak-ofi"
  | "sama-ofi"
  | "wplyw-bankowy"
  | "faktura-ofi"
  | "faktura-zdv"
  | "cena-cma"
  | "niepewne";

export interface SplitInput {
  /** Kwota do rozbicia (dotychczasowy `monthly_value`). NULL = nie ma czego dzielić. */
  monthlyValue: number | null | undefined;
  hasOfi: boolean;
  hasCameras: boolean;
  hasSswin: boolean;
  hasVideoreception: boolean;
  /** Notatki obiektu — niosą pochodzenie ceny (patrz stałe wyżej). */
  notes?: string | null;
  /** Czy cena pochodzi z rejestru CMA (`monitored_objects.extra_data1`). */
  priceFromCma?: boolean;
}

export interface SplitResult {
  monthlyZdw: number | null;
  monthlyOfi: number | null;
  /** Którą regułą to wyszło — do raportu migracji i do tłumaczenia się z liczby. */
  source: SplitSource;
  /** Czy trzeba dopisać `SPLIT_TODO_NOTE` do notatek (rozstrzygnięcie zgadywane). */
  uncertain: boolean;
}

/** Czy obiekt ma cokolwiek, co obsługuje centrum monitorowania. */
export function hasZdwService(o: {
  hasCameras: boolean;
  hasSswin: boolean;
  hasVideoreception: boolean;
}): boolean {
  return o.hasCameras || o.hasSswin || o.hasVideoreception;
}

/** Flagi usługowe z notatki o fakturze zbiorczej: „… Pozycje: … [ZDV] 3875 zł". */
function invoiceFlags(notes: string): { ofi: boolean; zdv: boolean } {
  const line = notes
    .split("\n")
    .filter((l) => l.includes(SPLIT_INVOICE_NOTE))
    .join(" ");
  const flags = [...line.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1].toUpperCase());
  // Etykieta klienta w cudzysłowie też niesie flagę („ASILI SP.Z O.O. ZDV”),
  // więc jeśli nawiasów nie ma, patrzymy na całą linię.
  const haystack = flags.length > 0 ? flags.join(" ") : line.toUpperCase();
  return { ofi: /\bOFI\b/.test(haystack), zdv: /\bZDV\b/.test(haystack) };
}

/**
 * Rozdziela jedną kwotę abonamentu na ZDW i OFI po tym, co o obiekcie wiadomo.
 * Kolejność reguł jest istotna — pierwsza pasująca wygrywa:
 *
 *  1. brak kwoty → nic (NULL, NULL),
 *  2. obiekt bez OFI → całość na ZDW,
 *  3. obiekt z samą OFI (bez kamer/SSWiN/wideorecepcji) → całość na OFI,
 *  4. MIESZANY — rozstrzyga POCHODZENIE CENY, nie usługi:
 *     a. „Abonament z wpływu bankowego" (wspólnoty płacące za wartownika) → OFI,
 *     b. „Abonament rozdzielony z faktury zbiorczej" z flagą OFI → OFI, z ZDV → ZDW,
 *     c. cena z raportu CMA (`extra_data1`) → ZDW, bo raport wycenia monitoring,
 *     d. nie da się ustalić → ZDW i dopisek `SPLIT_TODO_NOTE` w notatkach.
 *
 * Reguła 4d celowo NIE dzieli kwoty po połowie: wymyślona proporcja wygląda jak
 * dana i nikt by jej już nie zweryfikował, a jawny dopisek prosi o decyzję człowieka.
 */
export function splitAbonament(input: SplitInput): SplitResult {
  const value = input.monthlyValue ?? null;
  if (value === null) {
    return { monthlyZdw: null, monthlyOfi: null, source: "brak-kwoty", uncertain: false };
  }
  const zdw: SplitResult = { monthlyZdw: value, monthlyOfi: null, source: "brak-ofi", uncertain: false };
  if (!input.hasOfi) return zdw;
  if (!hasZdwService(input)) {
    return { monthlyZdw: null, monthlyOfi: value, source: "sama-ofi", uncertain: false };
  }

  const notes = input.notes ?? "";
  if (notes.includes(BANK_NOTE)) {
    return { monthlyZdw: null, monthlyOfi: value, source: "wplyw-bankowy", uncertain: false };
  }
  if (notes.includes(SPLIT_INVOICE_NOTE)) {
    const flags = invoiceFlags(notes);
    if (flags.ofi && !flags.zdv) {
      return { monthlyZdw: null, monthlyOfi: value, source: "faktura-ofi", uncertain: false };
    }
    if (flags.zdv && !flags.ofi) {
      return { monthlyZdw: value, monthlyOfi: null, source: "faktura-zdv", uncertain: false };
    }
    // Obie flagi (albo żadna) — faktura nie mówi, za co konkretnie; niżej.
  }
  if (input.priceFromCma) {
    return { monthlyZdw: value, monthlyOfi: null, source: "cena-cma", uncertain: false };
  }
  return { monthlyZdw: value, monthlyOfi: null, source: "niepewne", uncertain: true };
}

/**
 * Wartość abonamentu wystawiana na zewnątrz jako `monthlyValue` — SUMA obu linii.
 * NULL tylko wtedy, gdy nie uzupełniono ŻADNEJ: inaczej obiekt z samym OFI
 * pokazywałby „brak abonamentu”. To pole jest wyliczane; źródłem prawdy są
 * `monthly_zdw` i `monthly_ofi`.
 */
export function monthlyValueOf(
  monthlyZdw: number | null | undefined,
  monthlyOfi: number | null | undefined
): number | null {
  if ((monthlyZdw ?? null) === null && (monthlyOfi ?? null) === null) return null;
  return (monthlyZdw ?? 0) + (monthlyOfi ?? 0);
}

/**
 * Te same wyrażenia w SQL — do filtrów, sortowania i agregatów. Nazwy kolumn
 * piszemy DOSŁOWNIE (`objects.monthly_zdw`), bo drizzle 0.36 renderuje
 * interpolowaną kolumnę bez kwalifikatora tabeli, a w podzapytaniu skorelowanym
 * trafiłaby wtedy w kolumnę zapytania nadrzędnego (patrz src/routes/salespeople.ts).
 */
export const MONTHLY_VALUE_SQL: SQL = sql`(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0))`;
/** Przychód miesięczny obiektu: oba abonamenty + dzierżawa sprzętu. */
export const MONTHLY_REVENUE_SQL: SQL = sql`(coalesce(objects.monthly_zdw, 0) + coalesce(objects.monthly_ofi, 0) + coalesce(objects.monthly_rental, 0))`;
/** Czy KTÓRAKOLWIEK kwota przychodu jest uzupełniona (brak ≠ zero). */
export const HAS_ANY_REVENUE_SQL: SQL = sql`(objects.monthly_zdw is not null or objects.monthly_ofi is not null or objects.monthly_rental is not null)`;

/** Wariant z prefiksem aliasu tabeli — dla podzapytań z własnym aliasem obiektów. */
export function monthlyRevenueSqlFor(alias: string): SQL {
  return sql.raw(
    `(coalesce(${alias}.monthly_zdw, 0) + coalesce(${alias}.monthly_ofi, 0) + coalesce(${alias}.monthly_rental, 0))`
  );
}

/** Wariant z prefiksem aliasu tabeli — „ma jakikolwiek przychód”. */
export function hasAnyRevenueSqlFor(alias: string): SQL {
  return sql.raw(
    `(${alias}.monthly_zdw is not null or ${alias}.monthly_ofi is not null or ${alias}.monthly_rental is not null)`
  );
}
