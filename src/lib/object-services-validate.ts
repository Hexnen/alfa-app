/**
 * Walidacja OKRESÓW USŁUG z body — wspólna dla kartoteki obiektu
 * (`PUT/POST /api/objects`) i dla zlecenia (`orders.object_services`).
 *
 * Osobny moduł, a nie funkcja w trasie obiektów: te same okresy przychodzą
 * dwiema drogami (formularz obiektu i formularz zlecenia), a dublowanie
 * walidatora oznaczałoby dwa różne komplety komunikatów dla tego samego pola.
 *
 * Wzorzec jak `src/routes/contracts.ts` — każde pole przez walidator z
 * `src/lib/validate.ts`, błąd jako `ValidationError` (trasa → 400 po polsku).
 */
import type { ObjectServiceInput, ObjectServiceKind } from "../types/index.js";
import { OBJECT_SERVICE_KINDS, OBJECT_SERVICE_LABELS } from "./object-services.js";
import {
  asRecord,
  parseBool,
  parseDate,
  parseEnum,
  parseId,
  parseNumber,
  parseString,
  STR,
  ValidationError,
} from "./validate.js";

/**
 * Sufit liczby okresów w jednym zapisie. Realny obiekt ma ich kilka (cztery
 * usługi × kilka wznowień); sto to zapas z ogromnym marginesem, a bez sufitu
 * jeden PUT mógłby kazać wstawić dowolnie długą listę wierszy.
 */
const MAX_SERVICE_ROWS = 100;

/**
 * Lista okresów z body.
 *
 * `undefined` (także `null`) = klient pola NIE przysłał → stare zachowanie flag
 * (D5: skrypty i starsze klienty API dalej działają). Obecność listy oznacza
 * PEŁNĄ PODMIANĘ — patrz `applyServiceRows`.
 *
 * @param label nazwa pola do komunikatów („Usługi" w obiekcie, „Usługi obiektu"
 *   w zleceniu) — użytkownik ma wiedzieć, który formularz odrzucił dane.
 */
export function parseObjectServices(
  raw: unknown,
  label = "Usługi"
): ObjectServiceInput[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw)) {
    throw new ValidationError(`Pole „${label}” musi być listą okresów usług`);
  }
  if (raw.length > MAX_SERVICE_ROWS) {
    throw new ValidationError(
      `Pole „${label}” ma zbyt wiele pozycji (maks. ${MAX_SERVICE_ROWS})`
    );
  }

  const out: ObjectServiceInput[] = [];
  const seenIds = new Set<number>();

  for (let i = 0; i < raw.length; i++) {
    const row = asRecord(raw[i]);
    // Numer pozycji w komunikacie: formularz pokazuje kilka wierszy naraz
    // i „zła data" bez wskazania którego wiersza nie da się poprawić.
    const where = `${label} — pozycja ${i + 1}`;

    const service = parseEnum(row.service, OBJECT_SERVICE_KINDS, `${where}: usługa`, {
      required: true,
    }) as ObjectServiceKind;
    const name = OBJECT_SERVICE_LABELS[service];

    const startDate = parseDate(row.startDate, `${name}: data od`, { required: true }) as string;
    const endDate = parseDate(row.endDate, `${name}: data do`) ?? null;
    if (endDate !== null && endDate < startDate) {
      throw new ValidationError(
        `${name}: data zakończenia nie może być wcześniejsza niż data rozpoczęcia`
      );
    }

    // Liczba kamer ma sens WYŁĄCZNIE przy kamerach. Przy innych usługach
    // zerujemy ją po cichu (a nie 400): formularz może przysłać pole, którego
    // po zmianie rodzaju usługi nie zdążył wyczyścić.
    const cameraCount =
      service === "kamery"
        ? parseNumber(row.cameraCount, {
            label: `${name}: liczba kamer`,
            integer: true,
            min: 0,
            max: 10_000,
          }) ?? null
        : null;

    const id = parseId(row.id, `${where}: identyfikator`) ?? undefined;
    if (id !== undefined) {
      if (seenIds.has(id)) {
        throw new ValidationError(`Pole „${label}” zawiera dwa razy ten sam okres (#${id})`);
      }
      seenIds.add(id);
    }

    // „Data szacowana" (backfill 0084). Klient odsyła flagę taką, jaką dostał —
    // dzięki temu edycja liczby kamer nie udaje, że nagle znamy datę startu.
    // O zgaszeniu flagi decyduje ZMIANA daty, nie to pole (patrz applyServiceRows).
    const startEstimated = parseBool(row.startEstimated, `${name}: data szacowana`);

    out.push({
      ...(id !== undefined ? { id } : {}),
      service,
      startDate,
      endDate,
      ...(startEstimated !== undefined ? { startEstimated } : {}),
      cameraCount,
      notes: parseString(row.notes, { label: `${name}: uwagi`, max: STR.NOTES }) ?? null,
    });
  }

  return out;
}
