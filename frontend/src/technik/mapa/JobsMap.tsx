/**
 * MAPA ZLECEŃ — Leaflet 1.9 z CDN, dokładnie ten sam loader i te same kafelki
 * co mapy CRM-a (`@/lib/leaflet-loader`, `RoutePlannerMap`). Panel technika NIE
 * dokłada własnej biblioteki map: jedna zależność, jedna licencja, jeden cache
 * przeglądarki.
 *
 * Czego tu nie ma: tras, kolejności przystanków i kilometrów — od tego jest
 * planer w kalendarzu biura. Ta mapa odpowiada na jedno pytanie: „gdzie dziś
 * jadę i co tam mam”.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet ładowany z CDN (jak w RoutePlannerMap), globalne `L` nie ma typów */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Crosshair, Maximize2, WifiOff } from "lucide-react";
import { POLAND_RING } from "@/assets/poland-outline";
import { LEAFLET_JS_ID, OSM_ATTRIBUTION, OSM_TILE_URL, loadLeaflet } from "@/lib/leaflet-loader";
import { cn } from "@/lib/utils";
import { EmptyState } from "../ui/empty-state";
import { Button } from "@/components/ui/button";
import { jobsLabel } from "../lib/jobs";
import {
  pinPlaceTitle,
  pinState,
  pinTimeLabel,
  typeColor,
  typeIconSvg,
  type JobPin,
  type MapRange,
} from "./pins";

declare const L: any;

const POLAND_BOUNDS: [[number, number], [number, number]] = [
  [49.0, 14.07],
  [55.04, 24.15],
];
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [47.6, 12.2],
  [56.4, 26.2],
];
const WORLD_RING: [number, number][] = [
  [-180, -90],
  [180, -90],
  [180, 90],
  [-180, 90],
  [-180, -90],
];

/**
 * Jedna pinezka nie ma prawa zbliżyć widoku do poziomu pojedynczego budynku:
 * technik traci wtedy pojęcie, w którym mieście stoi. 15 to skala dzielnicy.
 */
const MAX_FIT_ZOOM = 15;

/**
 * Padding kadru jest ASYMETRYCZNY, bo etykieta wisi po PRAWEJ stronie pinezki
 * (do 9 rem). Równe 48 px ucinałoby nazwę obiektu przy wschodniej krawędzi.
 */
const FIT_PAD_TL: [number, number] = [48, 48];
const FIT_PAD_BR: [number, number] = [120, 56];

function themeColor(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  } catch {
    return fallback;
  }
}

/** Escape do HTML-a pinezki: nazwy obiektów bywają z „&” i cudzysłowem. */
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

export interface JobsMapProps {
  pins: JobPin[];
  /** Znacznik biura — poza kadrowaniem, żeby nie rozciągał widoku na pół Polski. */
  office: { lat: number; lng: number } | null;
  range: MapRange;
  selectedKey: string | null;
  onSelect: (key: string | null) => void;
  /** Wysokość otwartej dolnej karty (px) — podnosi przyciski mapy nad nią. */
  sheetHeight: number;
  /**
   * Trwa PONOWNE wczytywanie listy (zmiana zakresu, powrót do karty). Mapa
   * zostaje na ekranie z delikatną plakietką zamiast znikać pod szkieletem —
   * odmontowanie budowało Leafleta od zera i kasowało kadr technika.
   */
  refreshing?: boolean;
  /** Błąd geolokalizacji trafia do toasta panelu, nie do konsoli. */
  onGeoError: (message: string) => void;
  className?: string;
}

export function JobsMap({
  pins,
  office,
  range,
  selectedKey,
  onSelect,
  sheetHeight,
  refreshing = false,
  onGeoError,
  className,
}: JobsMapProps) {
  const elRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  /** Timer `invalidateSize` po starcie — sprzątany przy odmontowaniu (patrz niżej). */
  const resizeTimer = useRef<number | null>(null);
  const meRef = useRef<any>(null);
  /**
   * Kadr, który USTAWILIŚMY SAMI (ostatnie `fitBounds`). Po każdym `moveend`
   * porównujemy z nim aktualny środek i zoom: zgadza się = to byliśmy my,
   * różni się = kadr należy do technika i „Dopasuj” ma sens. Wcześniej
   * decydowało `dragstart`, więc przycisk zapalał się także po dotknięciu
   * mapy, które niczego nie przesunęło.
   */
  const frameRef = useRef<{ lat: number; lng: number; zoom: number } | null>(null);
  const pinsRef = useRef(pins);
  pinsRef.current = pins;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;

  const [status, setStatus] = useState<"loading" | "ready" | "offline">("loading");
  const [moved, setMoved] = useState(false);
  /** `moved` do odczytu z domknięć, które żyją dłużej niż render (ResizeObserver). */
  const movedRef = useRef(moved);
  movedRef.current = moved;
  const [locating, setLocating] = useState(false);
  /** Zmieniamy, gdy technik chce spróbować wczytać Leafleta jeszcze raz. */
  const [attempt, setAttempt] = useState(0);

  /**
   * ETYKIETA PO STRONIE, PO KTÓREJ JEST MIEJSCE.
   *
   * Domyślnie wisi na prawo od pinezki, ale pinezka przy wschodniej krawędzi
   * ucinałaby nazwę obiektu w pół słowa — a to jedyna rzecz, po której technik
   * poznaje miejsce. Zamiast rozpychać kadr paddingiem na pół ekranu (na 390 px
   * nie ma z czego), etykieta przeskakuje na lewo. Liczone w pikselach
   * kontenera, więc przelicza się po każdym ruchu mapy.
   */
  const placeLabels = useCallback(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    const width = map.getSize().x;
    const taken: { l: number; r: number; t: number; b: number }[] = [];
    layer.eachLayer((marker: any) => {
      const el: HTMLElement | null = marker.getElement?.()?.querySelector?.(".tm-pin") ?? null;
      const label: HTMLElement | null = el?.querySelector(".tm-pin-label") ?? null;
      if (!el || !label || !marker.getLatLng) return;
      const { x, y } = map.latLngToContainerPoint(marker.getLatLng());
      // 36 px odstępu + 9 rem etykiety = 180 px; tyle musi zostać po prawej.
      const flip = width - x < 180 && x > 180;
      el.classList.toggle("is-left", flip);
      el.classList.remove("is-nolabel");
      const w = label.offsetWidth;
      const h = label.offsetHeight;
      const l = flip ? x - 36 - w : x + 36;
      const box = { l, r: l + w, t: y - h / 2, b: y + h / 2 };
      // Dwie etykiety jedna na drugiej to zero informacji zamiast jednej.
      // Wcześniejsze zlecenie (markery wchodzą chronologicznie) zatrzymuje
      // swoją; późniejsze zostaje samą kropką — nazwę pokaże dolna karta.
      if (taken.some((t) => box.l < t.r && box.r > t.l && box.t < t.b && box.b > t.t)) {
        el.classList.add("is-nolabel");
      } else {
        taken.push(box);
      }
    });
  }, []);

  /** Zapamiętanie kadru USTAWIONEGO PRZEZ NAS (patrz `frameRef`). */
  const markFrame = useCallback((map: any) => {
    const c = map.getCenter();
    frameRef.current = { lat: c.lat, lng: c.lng, zoom: map.getZoom() };
  }, []);

  const fit = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const coords = pinsRef.current.map((p) => [p.lat, p.lng] as [number, number]);
    if (coords.length === 0) {
      map.fitBounds(POLAND_BOUNDS, { padding: [12, 12], animate: false });
    } else {
      map.fitBounds(L.latLngBounds(coords), {
        paddingTopLeft: FIT_PAD_TL,
        paddingBottomRight: FIT_PAD_BR,
        maxZoom: MAX_FIT_ZOOM,
        animate: false,
      });
    }
    // `animate: false` ustawia widok synchronicznie, więc zapamiętany kadr jest
    // już tym docelowym — `moveend` porówna się z nim i nie weźmie naszego
    // dopasowania za ruch technika.
    markFrame(map);
    movedRef.current = false;
    setMoved(false);
  }, [markFrame]);

  // --- Inicjalizacja (raz na wejście w zakładkę) ---
  useEffect(() => {
    let cancelled = false;
    void loadLeaflet().then(() => {
      if (cancelled || !elRef.current) return;
      if (typeof L === "undefined") {
        setStatus("offline");
        return;
      }
      if (mapRef.current) return;

      const map = L.map(elRef.current, {
        center: [52.07, 19.48],
        zoom: 6,
        // Bez kwadracików +/−: mają 30 px, a w panelu obowiązuje 44 px. Zoom
        // robi się szczypaniem i dwuklikiem, tak jak w mapach systemowych.
        zoomControl: false,
        // Mapa zajmuje cały ekran i pod nią NIE MA czego przewijać, więc kółko
        // myszy może zoomować od razu (w CRM trzeba było najpierw kliknąć).
        scrollWheelZoom: true,
        maxBounds: MAX_BOUNDS,
        maxBoundsViscosity: 0.8,
        minZoom: 5,
        tap: true,
      });
      L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
      // Atrybucja w LEWY dolny róg — w prawym stoją „Dopasuj” i „Moja pozycja”.
      map.attributionControl.setPosition("bottomleft");

      // Kontur Polski jak w planerze trasy: zagranica wyszarzona, granica cienką kreską.
      L.geoJSON(
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [WORLD_RING, POLAND_RING] },
        },
        {
          interactive: false,
          style: {
            stroke: false,
            fillColor: themeColor("--muted", "#e2e8f0"),
            fillOpacity: 0.93,
            fillRule: "evenodd",
          },
        },
      ).addTo(map);
      L.geoJSON(
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [POLAND_RING] } },
        {
          interactive: false,
          style: {
            color: themeColor("--muted-foreground", "#64748b"),
            weight: 1.2,
            fill: false,
            opacity: 0.85,
          },
        },
      ).addTo(map);

      map.on("click", () => selectRef.current(null));
      map.on("moveend zoomend", () => {
        placeLabels();
        // „Dopasuj” zapala się po tym, CO SIĘ STAŁO z kadrem, a nie po samym
        // dotknięciu mapy: porównujemy środek i zoom z ostatnim naszym.
        const f = frameRef.current;
        const c = map.getCenter();
        const same =
          !!f &&
          Math.abs(c.lat - f.lat) < 1e-6 &&
          Math.abs(c.lng - f.lng) < 1e-6 &&
          map.getZoom() === f.zoom;
        movedRef.current = !same;
        setMoved(!same);
      });

      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      setStatus("ready");
      fit();
      // Timer MUSI być sprzątnięty: po odmontowaniu mapy (wyjście z zakładki
      // w trakcie ładowania) `invalidateSize` na usuniętej mapie rzucał
      // `TypeError: _leaflet_pos` prosto w konsolę technika.
      resizeTimer.current = window.setTimeout(() => {
        resizeTimer.current = null;
        map.invalidateSize();
      }, 60);

      // Obrót tabletu i zmiana wysokości kontenera: bez `invalidateSize`
      // Leaflet rysuje kafelki na starym rozmiarze, a kadr zostaje przycięty.
      if (typeof ResizeObserver !== "undefined") {
        const ro = new ResizeObserver(() => {
          map.invalidateSize();
          // `movedRef`, a nie `moved` z domknięcia pierwszego renderu: obrót
          // tabletu czytał wartość sprzed godziny i kasował kadr technika.
          if (!movedRef.current) fit();
        });
        ro.observe(elRef.current);
        (map as any).__ro = ro;
      }
    });

    return () => {
      cancelled = true;
      if (resizeTimer.current !== null) {
        window.clearTimeout(resizeTimer.current);
        resizeTimer.current = null;
      }
      const map = mapRef.current;
      if (map) {
        (map as any).__ro?.disconnect();
        map.remove();
        mapRef.current = null;
        layerRef.current = null;
        meRef.current = null;
      }
    };
    // Mapa powstaje RAZ na wejście w zakładkę; `fit` i `placeLabels` są stabilne,
    // a `moved` czytamy refem — ponowna inicjalizacja przy każdym przesunięciu
    // byłaby absurdem.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // --- Pinezki ---
  // `status` w zależnościach NIE jest ozdobą: mapa powstaje asynchronicznie
  // (loader z CDN), więc pierwszy przebieg tego efektu zastaje `mapRef` pusty
  // i bez niego pinezki nigdy by się nie narysowały.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (office) {
      const icon = L.divIcon({
        className: "tm-icon",
        html: `<div class="tm-office" title="Biuro">${typeIconSvg("biuro")}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
      });
      L.marker([office.lat, office.lng], { icon, title: "Biuro", alt: "Biuro", zIndexOffset: -200 }).addTo(
        layer,
      );
    }

    for (const pin of pins) {
      const first = pin.jobs[0];
      const color = typeColor(first.type);
      const state = pinState(pin);
      const count = pin.jobs.length;
      const name = pinPlaceTitle(pin);
      const when = pinTimeLabel(first, range);
      const html = `<div class="tm-pin${state === "done" ? " is-done" : ""}${
        state === "running" ? " is-running" : ""
      }${selectedKey === pin.key ? " is-active" : ""}" style="--pin:${color}">
          <span class="tm-pin-dot">${typeIconSvg(first.type)}</span>
          ${count > 1 ? `<span class="tm-pin-count">×${count}</span>` : ""}
          <span class="tm-pin-label"><span class="tm-pin-name">${esc(name)}</span><span class="tm-pin-time">${esc(
            when,
          )}${count > 1 ? ` · ${jobsLabel(count)}` : ""}</span></span>
        </div>`;
      const title =
        count > 1
          ? `${name} — ${jobsLabel(count)}, najbliższe ${when}`
          : `${name} — ${first.typeLabel}, ${when}`;
      const icon = L.divIcon({ className: "tm-icon", html, iconSize: [30, 30], iconAnchor: [15, 15] });
      L.marker([pin.lat, pin.lng], {
        icon,
        title,
        alt: title,
        keyboard: true,
        zIndexOffset: state === "running" ? 400 : selectedKey === pin.key ? 500 : 200,
      })
        .addTo(layer)
        .on("click", () => selectRef.current(pin.key));
    }
    placeLabels();
  }, [status, pins, office, range, selectedKey, placeLabels]);

  /**
   * Kadr przelicza się przy zmianie ZESTAWU MIEJSC (inny zakres, nowe zlecenie),
   * a nie przy każdym odświeżeniu listy: `pins` to nowa tablica po każdym
   * powrocie do karty, więc efekt na `[status, pins]` kasował technikowi zoom
   * i przesunięcie za każdym razem, gdy wrócił z Map Google. Kadru ustawionego
   * ręcznie nie ruszamy wcale — od tego jest przycisk „Dopasuj”.
   */
  const pinsKey = useMemo(() => [...pins.map((p) => p.key)].sort().join("|"), [pins]);
  const fittedKey = useRef<string | null>(null);
  useEffect(() => {
    if (status !== "ready") return;
    if (fittedKey.current === pinsKey) return;
    fittedKey.current = pinsKey;
    if (movedRef.current) return;
    fit();
  }, [status, pinsKey, fit]);

  const locate = useCallback(() => {
    const map = mapRef.current;
    if (!map || !navigator.geolocation) {
      onGeoError("Urządzenie nie udostępnia lokalizacji.");
      return;
    }
    setLocating(true);
    // Jednorazowo, BEZ śledzenia: ciągły `watchPosition` zjadałby baterię
    // przez cały dzień, a technik i tak patrzy na mapę raz na dojazd.
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        const here: [number, number] = [pos.coords.latitude, pos.coords.longitude];
        if (meRef.current) map.removeLayer(meRef.current);
        meRef.current = L.marker(here, {
          icon: L.divIcon({
            className: "tm-icon",
            html: `<div class="tm-me" title="Twoja pozycja"></div>`,
            iconSize: [18, 18],
            iconAnchor: [9, 9],
          }),
          title: "Twoja pozycja",
          alt: "Twoja pozycja",
          zIndexOffset: 600,
        }).addTo(map);
        // Skok na własną pozycję to kadr TECHNIKA — „Dopasuj” ma po nim zostać,
        // więc kadru nie zapamiętujemy jako naszego.
        map.setView(here, Math.max(map.getZoom(), 12), { animate: false });
        movedRef.current = true;
        setMoved(true);
      },
      (err) => {
        setLocating(false);
        onGeoError(
          err.code === err.PERMISSION_DENIED
            ? "Brak zgody na lokalizację — włącz ją w ustawieniach przeglądarki."
            : "Nie udało się ustalić pozycji.",
        );
      },
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 },
    );
  }, [onGeoError]);

  if (status === "offline") {
    return (
      <div className={cn("flex items-center justify-center rounded-xl border bg-card p-4", className)}>
        <EmptyState
          icon={WifiOff}
          title="Mapa wymaga połączenia z internetem"
          description="Kafelki mapy pobierają się z sieci. Lista zleceń działa dalej w zakładkach „Dziś” i „Nadchodzące”."
          className="border-0"
          action={
            <Button
              type="button"
              className="h-11"
              onClick={() => {
                // Loader jest idempotentny po `id` skryptu — ten, który padł,
                // musi zniknąć, inaczej ponowna próba czekałaby na zdarzenie,
                // które już się odbyło.
                document.getElementById(LEAFLET_JS_ID)?.remove();
                setStatus("loading");
                setAttempt((n) => n + 1);
              }}
            >
              Spróbuj ponownie
            </Button>
          }
        />
      </div>
    );
  }

  return (
    // `isolate` jest tu OBOWIĄZKOWE: warstwy Leafleta mają z-index 200–700,
    // a dolna karta panelu stoi na z-40. Bez własnego kontekstu układania mapa
    // malowałaby się NA karcie (kafelki prześwitujące przez treść).
    <div className={cn("relative isolate", className)}>
      <div
        ref={elRef}
        data-testid="technik-mapa-canvas"
        className="tm-canvas h-full w-full overflow-hidden rounded-xl border bg-muted"
        role="application"
        aria-label="Mapa zleceń — pełna lista jest w zakładkach „Dziś” i „Nadchodzące”"
      />
      {status === "loading" && (
        <div className="absolute inset-0 grid place-items-center rounded-xl bg-muted text-sm text-muted-foreground">
          Wczytuję mapę…
        </div>
      )}
      {/* Ponowne wczytanie listy NIE zabiera mapy z ekranu — sama plakietka
          mówi, że pinezki zaraz się przestawią. */}
      {status === "ready" && refreshing && (
        <p
          data-testid="technik-mapa-odswiezanie"
          className="pointer-events-none absolute left-1/2 top-3 z-[500] -translate-x-1/2 rounded-full border bg-card/90 px-3 py-1 text-xs text-muted-foreground shadow-sm"
        >
          Wczytuję zlecenia…
        </p>
      )}

      {/* Sterowanie w prawym dolnym rogu mapy; przy otwartej karcie unosi się nad nią. */}
      <div
        className="absolute right-3 z-[500] flex flex-col gap-2"
        style={{ bottom: `${12 + sheetHeight}px` }}
      >
        {moved && (
          <button
            type="button"
            data-testid="technik-mapa-dopasuj"
            onClick={fit}
            aria-label="Dopasuj widok do wszystkich zleceń"
            className="inline-flex h-11 w-11 items-center justify-center rounded-full border bg-card text-foreground shadow-md transition-transform active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Maximize2 className="h-5 w-5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          data-testid="technik-mapa-pozycja"
          onClick={locate}
          disabled={locating}
          aria-label="Pokaż moją pozycję"
          className="inline-flex h-11 w-11 items-center justify-center rounded-full border bg-card text-foreground shadow-md transition-transform active:scale-95 disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Crosshair className={cn("h-5 w-5", locating && "animate-pulse")} aria-hidden />
        </button>
      </div>

      {/* Biuro ma znaczenie także bez koloru — legenda mówi, co to za kropka. */}
      {office && (
        <p className="pointer-events-none absolute left-3 top-3 z-[500] inline-flex items-center gap-1 rounded-md border bg-card/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
          <Building2 className="h-3.5 w-3.5" aria-hidden />
          Biuro
        </p>
      )}
    </div>
  );
}
