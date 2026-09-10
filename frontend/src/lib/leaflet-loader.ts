/**
 * Leaflet z CDN — jedno ładowanie na całą aplikację.
 *
 * DLACZEGO Z CDN: mapy są w kilku miejscach (formularz lokalizacji, mapa
 * realizacji, planer trasy, mini-mapa w podglądzie linku), ale żadne z nich nie
 * jest na ścieżce startowej — trzymanie Leafleta w bundlu obciążałoby każdą
 * stronę. Dodatkowo publiczny formularz zlecenia ma działać samodzielnie, bez
 * npm-owej zależności.
 *
 * DLACZEGO TUTAJ: ten sam loader był skopiowany w trzech komponentach
 * (`LocationPicker`, `realization/RealizationsMap`, `calendar/RoutePlannerMap`)
 * i kopie zdążyły się rozjechać — jedna nie obsługiwała błędu ładowania i przy
 * braku sieci wisiała na zawsze. Jedno źródło = jedna poprawka.
 *
 * Funkcja jest idempotentna (znaczniki `<link>`/`<script>` mają stałe id) i
 * NIGDY nie odrzuca obietnicy: przy błędzie sieci też resolwuje, a wołający ma
 * sprawdzić, czy globalne `L` faktycznie istnieje — inaczej panel zostawałby
 * pusty bez żadnego sygnału.
 */
export const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
export const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
export const LEAFLET_CSS_ID = "leaflet-cdn-css";
export const LEAFLET_JS_ID = "leaflet-cdn-js";

/** Kafelki OSM — te same we wszystkich mapach; atrybucja jest wymagana licencyjnie. */
export const OSM_TILE_URL = "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png";
export const OSM_ATTRIBUTION = "© OpenStreetMap";

/** Wstrzykuje CSS + JS Leafleta (raz), kończy, gdy `window.L` jest dostępne albo padło. */
export function loadLeaflet(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || typeof document === "undefined") {
      resolve();
      return;
    }
    if ((window as unknown as { L?: unknown }).L) {
      resolve();
      return;
    }
    if (!document.getElementById(LEAFLET_CSS_ID)) {
      const link = document.createElement("link");
      link.id = LEAFLET_CSS_ID;
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    const existing = document.getElementById(LEAFLET_JS_ID) as HTMLScriptElement | null;
    if (existing) {
      if ((window as unknown as { L?: unknown }).L) resolve();
      else {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => resolve());
      }
      return;
    }
    const script = document.createElement("script");
    script.id = LEAFLET_JS_ID;
    script.src = LEAFLET_JS;
    script.async = true;
    script.addEventListener("load", () => resolve());
    // Brak sieci → nie wieszamy widoku; efekt sprawdzi, czy `L` faktycznie jest.
    script.addEventListener("error", () => resolve());
    document.head.appendChild(script);
  });
}
