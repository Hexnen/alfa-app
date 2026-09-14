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
export function useRefreshOnFocus(reload: () => void, enabled = true): void {
  const cb = useRef(reload);
  useEffect(() => {
    cb.current = reload;
  });

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") cb.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [enabled]);
}
