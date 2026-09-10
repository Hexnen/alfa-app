/**
 * Mostek między wtyczką przeglądarki „Dodaj do towarów Alfa” a aplikacją.
 *
 * Po co to w ogóle istnieje: wtyczka po zaimportowaniu produktu ma OBUDZIĆ już
 * otwartą kartę Magazynu, a nie otwierać kolejną. Service worker wtyczki umie
 * przełączyć kartę (`chrome.tabs.update`), ale nie umie „wejść” w reactowy
 * router — więc content script wtyczki na origin aplikacji robi
 * `window.postMessage({ type: "alfa-import-open", id })`, a ten komponent jako
 * jedyny w aplikacji tego słucha i zamienia sygnał na nawigację.
 *
 * Fallback (gdy karty ze skryptem nie ma) należy do wtyczki: przeładowuje
 * `/technical/magazyn?import=<id>`. Tutaj chodzi wyłącznie o przejście BEZ
 * przeładowania, żeby nie gubić niezapisanej pracy w innych zakładkach.
 *
 * Komponent nie renderuje nic i nie ma stanu — jeden nasłuch na całą sesję.
 */
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

/** Nazwa zdarzenia — musi być identyczna z `content-app.js` w paczce wtyczki. */
const MESSAGE_TYPE = "alfa-import-open";

export function PluginImportBridge() {
  const navigate = useNavigate();

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      /*
       * Trzy warunki, każdy z innego powodu:
       * - `origin` — `postMessage` przyjmuje wiadomości od dowolnej ramki, więc
       *   bez tego dowolna wstrzyknięta iframe mogłaby nas przestawiać;
       * - `source === window` — sygnał pochodzi z content scriptu wtyczki
       *   wstrzykniętego w TĘ stronę (ten sam obiekt window), nie z ramki
       *   potomnej;
       * - kształt danych — w konsoli i w bibliotekach chodzi mnóstwo obcych
       *   `postMessage` (HMR Vite'a, rozszerzenia), więc wszystko bez naszego
       *   `type` i liczbowego `id` ignorujemy w ciszy.
       */
      if (e.origin !== window.location.origin) return;
      if (e.source !== window) return;
      const data = e.data as { type?: unknown; id?: unknown } | null;
      if (!data || data.type !== MESSAGE_TYPE) return;
      const id = typeof data.id === "number" ? data.id : Number(data.id);
      if (!Number.isInteger(id) || id <= 0) return;
      navigate(`/technical/magazyn?import=${id}`);
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [navigate]);

  return null;
}
