// Etykiety bytów współdzielone między ekranami.
//
// Reguła „jak nazwać obiekt na liście wyboru" powstała dwa razy — w mapowaniu
// kadrowym i w mapowaniu rejestru monitoringu — z identycznym ciałem. Dwie
// kopie znaczą, że pierwsza zmiana formatu rozjedzie ekrany, więc reguła
// mieszka tu raz.
import type { ObjectCatalogEntry } from "./api";

/**
 * Etykieta obiektu z kartoteki w liście wyboru. Sama nazwa nie wystarcza —
 * kartoteka ma obiekty o bliźniaczych nazwach u różnych klientów, więc miasto
 * i kontrahent są tu częścią identyfikacji, a nie ozdobą.
 */
export const catalogLabel = (o: ObjectCatalogEntry) =>
  [o.name, o.city, o.contractorName].filter(Boolean).join(" · ");
