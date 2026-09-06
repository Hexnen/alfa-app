/**
 * Tożsamość obiektu — JEDYNE miejsce, przez które przechodzi pytanie
 * „jakiego obiektu z kartoteki dotyczy ta realizacja (a przez nią protokół i wycena)?".
 *
 * DLACZEGO NAZWA NIE MOŻE BYĆ KLUCZEM. Do niedawna realizacja wskazywała obiekt
 * tekstem (`realizations.site`), a dwie niezależne kopie funkcji `resolveObject`
 * (protocol-prefill.ts i realization-autofill.ts) dopasowywały ten tekst do
 * `objects.name`. W kartotece dwanaście obiektów ma zduplikowane nazwy
 * („Stacja paliw Bochnia" ×2), więc na żywych danych **29 z 289 realizacji (10%)**
 * dopasowywało się po nazwie do INNEGO obiektu, niż wskazywał kalendarz. To nie
 * było ryzyko teoretyczne, tylko policzony błąd: adres montażu, kontrahent i NIP
 * w protokole potrafiły należeć do cudzego obiektu, a nikt tego nie widział, bo
 * nazwa się zgadzała.
 *
 * Dlatego kolejność jest sztywna i KRÓTKA:
 *   1. `realizations.object_id` — klucz obcy, źródło prawdy (dziś wypełniony w 100%),
 *   2. `calendar_events.object_id` z wpiętego wydarzenia — dla realizacji wpisanej
 *      ręcznie, zanim obiekt dostał FK (migracja 0057 zrobiła backfill właśnie stąd),
 *   3. koniec. Braku FK NIE ratujemy nazwą — zwracamy `null` i pozwalamy wołającemu
 *      pokazać brak. Cicha zła odpowiedź jest gorsza niż jawny brak: pusty adres widać
 *      od razu, cudzy adres w podpisanym protokole zostaje na zawsze.
 *
 * `realizations.site` zostaje w bazie, ale jest MIGAWKĄ na dokument (nazwa obiektu
 * w chwili prac), nie kluczem — protokół ma drukować to, co uzgodniono wtedy, nawet
 * gdy obiekt później przemianowano. Nigdy nie wraca tu jako kryterium wyszukiwania.
 */
import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { schema } from "../db/index.js";
import type { DbOrTx } from "./activity-log.js";

/** Skąd wzięliśmy FK — trafia do opisów „skąd to wyszło" w prefillu i automacie. */
export type ObjectIdentitySource = "realizacja" | "kalendarz";

/**
 * Obiekt rozstrzygnięty przez FK. Zestaw kolumn jest sumą tego, czego potrzebują
 * oba miejsca wołające (adres montażu i kontrahent w protokole, sama nazwa
 * w automacie realizacji) — jeden odczyt zamiast dwóch różnych.
 */
export interface ResolvedObject {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  contractorId: number;
  via: ObjectIdentitySource;
}

/** Minimum, jakiego potrzebujemy z realizacji — żeby dało się wołać także z fikstur testowych. */
export interface RealizationRef {
  id: number;
  objectId?: number | null;
}

/** Minimum, jakiego potrzebujemy z wydarzenia kalendarza. */
export interface EventObjectRef {
  objectId: number | null;
}

export interface ResolveObjectOptions {
  /**
   * Wydarzenia realizacji, jeśli wołający już je wczytał. Pusta tablica znaczy
   * „sprawdziłem, nie ma żadnego" — wtedy nie pytamy bazy drugi raz. Pominięcie
   * pola (`undefined`) znaczy „dociągnij sam".
   */
  events?: readonly EventObjectRef[];
}

/** Pierwsze niezanulowane wydarzenie realizacji — jedyne dopuszczalne źródło zastępcze. */
function loadEventObjectId(dbx: DbOrTx, realizationId: number): number | null {
  const row = dbx
    .select({ objectId: schema.calendarEvents.objectId })
    .from(schema.calendarEvents)
    .where(
      and(
        eq(schema.calendarEvents.realizationId, realizationId),
        isNull(schema.calendarEvents.deletedAt),
        ne(schema.calendarEvents.status, "cancelled")
      )
    )
    .orderBy(asc(schema.calendarEvents.startAt))
    .get();
  return row?.objectId ?? null;
}

/**
 * ID obiektu realizacji wyłącznie z kluczy obcych: `realizations.object_id`,
 * a gdy go nie ma — `calendar_events.object_id` wpiętego wydarzenia.
 * `null` = nie wiadomo; wołający MUSI to obsłużyć jako brak, nie zgadywać.
 */
export function resolveObjectId(
  dbx: DbOrTx,
  r: RealizationRef,
  opts: ResolveObjectOptions = {}
): { id: number; via: ObjectIdentitySource } | null {
  if (r.objectId != null) return { id: r.objectId, via: "realizacja" };

  const fromEvent =
    opts.events !== undefined
      ? opts.events.find((e) => e.objectId != null)?.objectId ?? null
      : loadEventObjectId(dbx, r.id);
  return fromEvent != null ? { id: fromEvent, via: "kalendarz" } : null;
}

/**
 * Obiekt realizacji z kartoteki — kanoniczne rozwiązanie tożsamości.
 * Zwraca `null`, gdy nie ma FK ALBO gdy FK wskazuje obiekt, którego już nie ma
 * (kartoteka jest po `ON DELETE SET NULL`, ale ręczne migracje potrafią ominąć ORM).
 */
export function resolveRealizationObject(
  dbx: DbOrTx,
  r: RealizationRef,
  opts: ResolveObjectOptions = {}
): ResolvedObject | null {
  const ref = resolveObjectId(dbx, r, opts);
  if (!ref) return null;

  const row = dbx
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      contractorId: schema.objects.contractorId,
    })
    .from(schema.objects)
    .where(eq(schema.objects.id, ref.id))
    .get();
  return row ? { ...row, via: ref.via } : null;
}
