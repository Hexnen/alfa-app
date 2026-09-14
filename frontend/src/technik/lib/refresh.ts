import { useEffect, useRef } from "react";

/**
 * ODŚWIEŻENIE PO POWROCIE DO KARTY.
 *
 * Technik wraca do panelu po rozmowie, po Mapach, po zdjęciu — i musi zobaczyć
 * stan sprzed sekundy, a nie sprzed godziny. Bez React Query robi to jeden
 * nasłuch: `visibilitychange` (powrót z tła na tablecie) plus `focus` (powrót
 * z innego okna na desktopie).
 *
 * Callback trzymamy w refie, żeby nie przepinać nasłuchu przy każdym renderze.
 */

/** Ile ms po zadziałaniu nasłuchu ignorujemy drugie zdarzenie tego samego powrotu. */
const DEDUPE_MS = 1000;

export function useRefreshOnFocus(reload: () => void, enabled = true): void {
  const cb = useRef(reload);
  useEffect(() => {
    cb.current = reload;
  });

  const lastRun = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      // Powrót z tła na tablecie odpala OBA zdarzenia w tej samej chwili
      // (`visibilitychange` i zaraz po nim `focus`), więc każde odświeżenie
      // szło na serwer dwa razy. Sekunda odstępu sprząta duplikat i niczego
      // nie kosztuje — ręczne odświeżenie idzie inną drogą (`reload`).
      const now = Date.now();
      if (now - lastRun.current < DEDUPE_MS) return;
      lastRun.current = now;
      cb.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);
}
