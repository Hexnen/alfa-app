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
