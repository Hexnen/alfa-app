/**
 * Synchronizacja flag usług obiektów z okresami (`object_services`) — przy
 * starcie backendu i co 24 h. Wzorzec: src/lib/ai/retention.ts.
 *
 * DLACZEGO HARMONOGRAM, A NIE SAM ZAPIS. Flaga `objects.has_*` jest cache'em
 * odpowiedzi na pytanie „czy DZIŚ": okres z `end_date = wczoraj` przestaje się
 * liczyć bez żadnego zapisu, sam z upływem czasu. Bez tego przebiegu obiekt
 * z wygasłą usługą siedziałby w filtrze „Kamery" i w podziale kosztu centrum
 * monitorowania aż do następnej ręcznej edycji.
 *
 * Dotyka WYŁĄCZNIE obiektów mających co najmniej jeden wiersz okresu
 * (`syncAllObjectServiceFlags`, decyzja D3) — obiekty wstawiane wprost przez
 * skrypty i seedy zostają nietknięte.
 */
import { syncAllObjectServiceFlags } from "./object-services.js";

export const SERVICES_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

/** Sync przy starcie + co 24 h. Nigdy nie rzuca (błąd tylko w logu). */
export function startObjectServicesSync(): void {
  const run = () => {
    try {
      const changed = syncAllObjectServiceFlags();
      if (changed > 0) {
        console.log(`[uslugi] przeliczono flagi usług na ${changed} obiektach`);
      }
    } catch (e) {
      console.error("[uslugi] synchronizacja flag: błąd", e);
    }
  };
  run();
  if (timer) clearInterval(timer);
  timer = setInterval(run, SERVICES_SYNC_INTERVAL_MS);
  timer.unref?.();
}
