import { db, schema } from "../db/index.js";
import { asc, eq } from "drizzle-orm";

/**
 * Obiekt z kartoteki w formie pozycji listy wyboru. Kontrahent i miasto są
 * częścią identyfikacji, a nie ozdobą: kartoteka ma obiekty o bliźniaczych
 * nazwach u różnych klientów i po samej nazwie nie da się ich rozróżnić.
 */
export interface ObjectCatalogEntry {
  id: number;
  name: string;
  city: string | null;
  contractorName: string;
}

/**
 * Wspólne zapytanie o kartotekę obiektów do list wyboru przy ręcznym
 * mapowaniu rejestrów. Wystawiają je DWA moduły — Kadry (`/hr/object-catalog`)
 * i CMA (`/monitored-objects/object-catalog`) — bo mapowanie robią różne
 * osoby, które nie muszą mieć dostępu do modułu Kontrahenci/Obiekty.
 * Zapytanie siedzi tutaj, żeby oba endpointy zwracały dokładnie ten sam
 * kształt i tę samą kolejność.
 */
export function fetchObjectCatalog(): Promise<ObjectCatalogEntry[]> {
  return db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      city: schema.objects.city,
      contractorName: schema.contractors.name,
    })
    .from(schema.objects)
    .innerJoin(
      schema.contractors,
      eq(schema.objects.contractorId, schema.contractors.id),
    )
    .orderBy(asc(schema.objects.name));
}

/**
 * Pozycja wąskiego słownika obiektów `GET /objects/catalog` — do pickerów
 * w modułach, które NIE mają klucza `objects` (kalendarze, umowy, zlecenia,
 * realizacje, rozwinięcie kontrahentów). Wyłącznie identyfikacja: nazwa, adres,
 * kontrahent i status. ŻADNYCH kwot (abonamenty, koszty, wartości umów, usługi
 * z cenami) — po to ten endpoint istnieje zamiast dopisywania kluczy do `/objects`
 * (docs/AUDYT-UPRAWNIEN-A.md #1, #4, #10, #12).
 *
 * `contractor` ma kształt `{ id, name }` celowo — taki sam jak w pełnej liście
 * obiektów, więc pickery czytają `o.contractor?.name` bez względu na źródło.
 */
export interface ObjectPickEntry {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  status: string;
  contractorId: number;
  contractor: { id: number; name: string };
}

export function fetchObjectPickCatalog(opts: { contractorId?: number } = {}): ObjectPickEntry[] {
  const rows = db
    .select({
      id: schema.objects.id,
      name: schema.objects.name,
      address: schema.objects.address,
      city: schema.objects.city,
      status: schema.objects.status,
      contractorId: schema.objects.contractorId,
      contractorName: schema.contractors.name,
    })
    .from(schema.objects)
    .innerJoin(schema.contractors, eq(schema.objects.contractorId, schema.contractors.id))
    .where(opts.contractorId != null ? eq(schema.objects.contractorId, opts.contractorId) : undefined)
    .orderBy(asc(schema.objects.name))
    .all();
  return rows.map(({ contractorName, ...r }) => ({
    ...r,
    contractor: { id: r.contractorId, name: contractorName },
  }));
}
