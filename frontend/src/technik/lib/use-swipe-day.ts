/**
 * PRZERZUCANIE DNI GESTEM na ekranie „Dziś”.
 *
 * Dwa warunki wzięte z Medici i z bólu z tabletu:
 *  - próg 70 px w poziomie i wyraźna przewaga nad ruchem w pionie, żeby
 *    zwykłe przewijanie listy zleceń nie zmieniało dnia;
 *  - gest zaczęty BLIŻEJ NIŻ 24 px od lewej krawędzi jest ignorowany — tam
 *    Safari łapie własny „wstecz” i walka o ten sam ruch kończy się tym, że
 *    technik wypada z aplikacji.
 *
 * Nasłuch jest na `touch*`, nie na Pointer Events: mysz i rysik mają swoje
 * przyciski, a `touchend` daje `changedTouches` bez pilnowania capture.
 */
import { useEffect, useRef } from "react";

const THRESHOLD_PX = 70;
const EDGE_GUARD_PX = 24;

export function useSwipeDay<T extends HTMLElement>(onPrev: () => void, onNext: () => void) {
  const ref = useRef<T>(null);
  // Handlery w refie: gest trwa między renderami, a nie chcemy przepinać
  // nasłuchu przy każdej zmianie dnia.
  const handlers = useRef({ onPrev, onNext });
  useEffect(() => {
    handlers.current = { onPrev, onNext };
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    let startX = 0;
    let startY = 0;
    let active = false;

    const onTouchStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (e.touches.length !== 1 || !t || t.clientX < EDGE_GUARD_PX) {
        active = false;
        return;
      }
      startX = t.clientX;
      startY = t.clientY;
      active = true;
    };

    const onTouchEnd = (e: TouchEvent) => {
      if (!active) return;
      active = false;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - startX;
      const dy = t.clientY - startY;
      if (Math.abs(dx) < THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dx < 0) handlers.current.onNext();
      else handlers.current.onPrev();
    };

    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchend", onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchend", onTouchEnd);
    };
  }, []);

  return ref;
}
