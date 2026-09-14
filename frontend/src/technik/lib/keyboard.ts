import { useEffect } from "react";

/**
 * WYSOKOŚĆ KLAWIATURY EKRANOWEJ → CSS `--kb`.
 *
 * Safari nie zna `interactive-widget=resizes-content`, więc przy otwartej
 * klawiaturze `100dvh` dalej obejmuje obszar zasłonięty i sticky pasek akcji
 * chowa się pod klawiaturą. Jedyne wiarygodne źródło to `visualViewport`:
 * różnica między wysokością layoutu a widocznym oknem (minus przesunięcie
 * scrolla) to dokładnie tyle, ile zabrała klawiatura.
 *
 * Wynik trafia w `--kb` na `<html>`; korzystają z niego utilities `.bottom-kb`
 * i `.pb-kb` z `technik.css`. Layoutu przy tym NIE przebudowujemy.
 */
export function initKeyboardVar(): () => void {
  const vv = window.visualViewport;
  const root = document.documentElement;
  if (!vv) {
    root.style.setProperty("--kb", "0px");
    return () => {};
  }

  let frame = 0;
  const update = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      // `offsetTop` odejmujemy, bo przy przewinięciu strony pod klawiaturą
      // widoczny viewport jest przesunięty, a nie mniejszy.
      const hidden = window.innerHeight - vv.height - vv.offsetTop;
      // Poniżej ~80 px to pasek narzędzi Safari, nie klawiatura — ignorujemy,
      // żeby pasek akcji nie drgał przy zwykłym scrollu.
      root.style.setProperty("--kb", `${hidden > 80 ? Math.round(hidden) : 0}px`);
    });
  };

  update();
  vv.addEventListener("resize", update);
  vv.addEventListener("scroll", update);
  return () => {
    vv.removeEventListener("resize", update);
    vv.removeEventListener("scroll", update);
    if (frame) cancelAnimationFrame(frame);
    root.style.removeProperty("--kb");
  };
}

/** Wariant hookowy — wystarczy raz, w powłoce panelu. */
export function useKeyboardVar(): void {
  useEffect(() => initKeyboardVar(), []);
}

/**
 * Przewinięcie pola do środka ekranu po focusie. Wołane z `onFocus` pól w
 * długich formularzach; `block: "center"` zostawia miejsce na klawiaturę
 * i na sticky pasek akcji.
 */
export function scrollFieldIntoView(el: HTMLElement | null): void {
  if (!el) return;
  // Klawiatura wjeżdża animowanie — bez opóźnienia liczylibyśmy pozycję
  // sprzed zmiany viewportu.
  setTimeout(() => el.scrollIntoView({ block: "center", behavior: "smooth" }), 250);
}
