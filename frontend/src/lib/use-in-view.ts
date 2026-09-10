/**
 * „Czy element wjechał w widok" — jeden IntersectionObserver dla wszystkiego, co
 * ma się ładować leniwie (karty podglądu linków, mini-mapy Leafleta).
 *
 * Lista dwudziestu notatek nie ma odpalać dwudziestu zapytań ani dwudziestu map,
 * dopóki nie zjedziesz na nie wzrokiem. Obserwacja kończy się po pierwszym
 * wejściu w widok — karta raz pokazana zostaje pokazana.
 *
 * Bez `IntersectionObserver` (starsza przeglądarka, jsdom w testach) zwracamy od
 * razu `true` — brak leniwego ładowania jest lepszy niż pusta karta.
 */
import { useEffect, useRef, useState } from "react";

export function useInView<T extends HTMLElement>(rootMargin = "200px") {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    if (inView) return;
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView, rootMargin]);

  return { ref, inView };
}
