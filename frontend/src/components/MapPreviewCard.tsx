/**
 * Karta z MINI-MAPĄ dla wklejonego linku do Google Maps.
 *
 * Zwykły podgląd linku (`LinkPreviewCard`) pokazywał dla map to, co Google daje
 * w metadanych: tytuł „Google Maps" i logo. Z notatki „spotkanie tutaj: <link>"
 * nie dawało się więc odczytać NIC o miejscu. Tutaj rysujemy sam punkt —
 * Leafletem na kafelkach OpenStreetMap, więc bez klucza Google i bez wysyłania
 * czegokolwiek do Google z poziomu naszej strony.
 *
 * Mapa jest CELOWO nieinteraktywna (bez przeciągania, zoomu i klawiatury): to
 * ilustracja w tekście, a nie widget — przechwytywanie scrolla w środku notatki
 * byłoby wrogie. Kliknięcie otwiera oryginalny link w Mapach. Atrybucja OSM
 * zostaje włączona, bo wymaga jej licencja kafelków.
 *
 * Punkt bierze się albo z gotowego `point` (kartoteka obiektu ma współrzędne),
 * albo z podglądu linku z backendu (`preview.map`) — wtedy współrzędne mogą
 * pochodzić z adresu, z rozwinięcia krótkiego linku albo z geokodera.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet z CDN (jak w LocationPicker), globalne `L` nie ma typów */
import { useEffect, useRef, useState } from "react";
import { Building2, ExternalLink, MapPin, Navigation } from "lucide-react";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";
import { loadLeaflet, OSM_ATTRIBUTION, OSM_TILE_URL } from "@/lib/leaflet-loader";
import { loadDistances, loadPreview, readSessionPreview } from "@/lib/link-preview-client";
import { useInView } from "@/lib/use-in-view";
import { useRichTextContext } from "@/lib/richtext-context";
import { fmtKm } from "@/lib/travel";
import { fmtMinutes } from "@/lib/calendar-labels";
import type { LinkDistance, LinkDistances, LinkPreview } from "@/lib/api";

declare const L: any;

/** Zoom z linku bywa skrajny (cały kraj albo wnętrze budynku) — trzymamy go w sensownym zakresie. */
const MIN_ZOOM = 12;
const MAX_ZOOM = 17;
const DEFAULT_ZOOM = 15;

export interface MapPoint {
  lat: number;
  lng: number;
  zoom?: number | null;
  label?: string | null;
}

export interface MapPreviewCardProps {
  /** Oryginalny link — otwiera się z kliknięcia w mapę i z przycisku. */
  href: string;
  /** Gotowy punkt (np. współrzędne obiektu) — wtedy nic nie pobieramy. */
  point?: MapPoint | null;
  /** Adres do pobrania podglądu, gdy punktu nie znamy z góry. */
  url?: string;
  /** Wariant jednoliniowy: miniatura 64×64 zamiast paska mapy. */
  compact?: boolean;
  className?: string;
}

function clampZoom(zoom: number | null | undefined): number {
  const z = Math.round(Number(zoom));
  if (!Number.isFinite(z)) return DEFAULT_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** Pinezka jako SVG (Lucide nie działa wewnątrz `divIcon`, więc rysujemy ją wprost). */
const PIN_SVG = (size: number) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">` +
  `<path d="M12 23s7.5-7.1 7.5-13A7.5 7.5 0 0 0 4.5 10c0 5.9 7.5 13 7.5 13z" fill="#dc2626" stroke="#fff" stroke-width="1.5"/>` +
  `<circle cx="12" cy="10" r="2.6" fill="#fff"/></svg>`;

/**
 * „12,4 km (18 min)”, a dla przybliżenia linią prostą „~12,4 km (18 min)”.
 * Tylda nie jest ozdobnikiem: bez niej liczba z linii prostej ×1,3 wyglądałaby
 * jak zmierzony przejazd (tooltip mówi resztę).
 */
function fmtDistance(d: LinkDistance): string {
  const approx = d.method === "straight" ? "~" : "";
  const time = fmtMinutes(d.minutes);
  return `${approx}${fmtKm(d.km)}${time ? ` (${time})` : ""}`;
}

const STRAIGHT_TIP = "Dystans w linii prostej ×1,3 — trasa drogowa dolicza się w tle";

/**
 * Pinezka bywa postawiona w lesie albo na środku osiedla. Trasa liczy się wtedy
 * do najbliższej sensownej drogi, a resztę trzeba przejść — i lepiej to napisać,
 * niż udawać, że samochód dojedzie pod sam punkt.
 */
function fmtSnap(snapKm: number | undefined): string | null {
  if (!snapKm || snapKm < 0.1) return null;
  const meters = Math.round(snapKm * 1000);
  return meters >= 1000
    ? `+ ok. ${fmtKm(Math.round(snapKm * 10) / 10)} pieszo od drogi`
    : `+ ok. ${Math.round(meters / 10) * 10} m pieszo od drogi`;
}

/** Nawigacja w Mapach Google — działa i w przeglądarce, i w aplikacji na telefonie. */
function directionsHref(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
}

export function MapPreviewCard({ href, point, url, compact = false, className }: MapPreviewCardProps) {
  const { ref: rootRef, inView } = useInView<HTMLDivElement>();
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  // Adres w ref, żeby handler kliknięcia w mapę nie wymuszał jej przebudowy przy
  // każdej zmianie propsa (mapa powstaje raz, klik ma otwierać AKTUALNY link).
  const hrefRef = useRef(href);
  useEffect(() => {
    hrefRef.current = href;
  }, [href]);

  // Podgląd pobieramy tylko wtedy, gdy punktu nie podano wprost.
  const [preview, setPreview] = useState<LinkPreview | null>(() => (url ? readSessionPreview(url) : null));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (point || !url || preview || !inView) return;
    let alive = true;
    loadPreview(url).then((data) => {
      if (alive) setPreview(data);
    });
    return () => {
      alive = false;
    };
  }, [point, url, preview, inView]);

  // Podgląd wrócił, ale to nie był link do map (albo punktu nie dało się ustalić)
  // — wtedy karta mapy nie ma czego pokazać i znika; zostaje sam link w tekście.
  const noMap = !point && !!preview && !preview.map;

  // Obiekt, którego dotyczy notatka — stąd bierze się „Od obiektu". Karta pod
  // pinezką w kartotece obiektu nie ma providera, więc pokaże tylko biuro
  // (dystans obiektu do samego siebie byłby zerem i szumem).
  const { objectId } = useRichTextContext();
  const [distances, setDistances] = useState<LinkDistances | null>(null);
  const [distancesDone, setDistancesDone] = useState(false);

  const resolved: MapPoint | null = point ?? preview?.map ?? null;
  const lat = resolved?.lat;
  const lng = resolved?.lng;
  const zoom = clampZoom(resolved?.zoom);

  // Dystanse lecą razem z kaflami — tak samo leniwie, żeby lista notatek nie
  // odpalała kilkunastu zapytań o trasy, zanim ktokolwiek na nie spojrzy.
  // W wariancie `compact` je pomijamy: w jednej linii nie ma na nie miejsca.
  useEffect(() => {
    if (compact || !inView || lat === undefined || lng === undefined) return;
    let alive = true;
    loadDistances(lat, lng, objectId).then((data) => {
      if (!alive) return;
      setDistances(data);
      setDistancesDone(true);
    });
    return () => {
      alive = false;
    };
  }, [compact, inView, lat, lng, objectId]);

  // Mapa powstaje dopiero, gdy karta jest w widoku i znamy punkt.
  useEffect(() => {
    if (!inView || lat === undefined || lng === undefined) return;
    let cancelled = false;
    void loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current || mapRef.current) return;
      if (typeof L === "undefined") return; // CDN nie odpowiedział — zostaje szkielet
      const map = L.map(mapElRef.current, {
        center: [lat, lng],
        zoom,
        zoomControl: false,
        attributionControl: true,
        dragging: false,
        scrollWheelZoom: false,
        touchZoom: false,
        doubleClickZoom: false,
        boxZoom: false,
        keyboard: false,
        inertia: false,
        tap: false,
      });
      L.tileLayer(OSM_TILE_URL, { maxZoom: 19, attribution: OSM_ATTRIBUTION }).addTo(map);
      const pin = compact ? 20 : 28;
      L.marker([lat, lng], {
        icon: L.divIcon({
          className: "",
          // Pinezka rysowana SVG, a nie emotką: emotka zależy od fontu systemowego
          // i na części maszyn (oraz w zrzutach z headless) wychodzi pustym kwadratem.
          html: PIN_SVG(pin),
          iconSize: [pin, pin],
          iconAnchor: [pin / 2, pin],
        }),
        interactive: false,
        keyboard: false,
      }).addTo(map);

      // Atrybucja musi zostać (licencja OSM), ale w karcie ma być przypisem.
      const attribution = map.attributionControl?.getContainer?.();
      if (attribution) {
        attribution.style.fontSize = "9px";
        attribution.style.padding = "0 3px";
        attribution.style.background = "rgba(255,255,255,.7)";
      }

      const container = map.getContainer();
      container.style.cursor = "pointer";
      container.style.background = "transparent";
      map.on("click", () => window.open(hrefRef.current, "_blank", "noopener,noreferrer"));

      mapRef.current = map;
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
      setReady(false);
    };
  }, [inView, lat, lng, zoom, compact]);

  const label = resolved?.label?.trim() || "Lokalizacja";
  const coords = lat !== undefined && lng !== undefined ? `${lat.toFixed(4)}, ${lng.toFixed(4)}` : null;

  if (noMap) return null;

  return (
    <div
      ref={rootRef}
      data-testid="map-preview"
      // Notatka bywa w karcie, którą klik otwiera — mapa ma otwierać tylko siebie.
      onClick={(e) => e.stopPropagation()}
      className={cn(
        "overflow-hidden rounded-md border border-border bg-muted/40 text-left",
        compact ? "flex items-stretch gap-2" : "block",
        className
      )}
    >
      {/* Kadr mapy: w pełnej karcie pasek nad opisem, w wąskiej — miniatura z lewej. */}
      <div className={cn("relative shrink-0 bg-muted", compact ? "h-16 w-16" : "h-[140px] w-full")}>
        <div ref={mapElRef} className="absolute inset-0 h-full w-full" />
        {!ready && (
          // Szkielet dokładnie tej samej wysokości — nic nie podskakuje po wczytaniu Leafleta.
          <div className="absolute inset-0 animate-pulse bg-muted-foreground/10" aria-hidden />
        )}
      </div>

      <div className={cn("min-w-0 flex-1", compact ? "self-center py-1 pr-2" : "px-2 py-1.5")}>
        <div className="truncate text-sm font-semibold text-foreground" title={label}>
          {label}
        </div>
        {coords && <div className="text-xs tabular-nums text-muted-foreground">{coords}</div>}

        {/*
          Dystanse: „ile stąd do biura" i „ile stąd do obiektu z notatki".
          Dopóki backend liczy, stoi szkielet JEDNEJ linii — bez niego karta
          podskakiwałaby po każdym doliczeniu trasy.
        */}
        {!compact &&
          (!distancesDone ? (
            <div className="mt-0.5 h-3.5 w-2/3 animate-pulse rounded bg-muted-foreground/10" aria-hidden />
          ) : (
            (distances?.office || distances?.object) && (
              <div
                data-testid="map-distances"
                className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
              >
                {distances.office && (
                  <span
                    className="inline-flex items-center gap-1"
                    {...(distances.office.method === "straight" ? tip(STRAIGHT_TIP) : {})}
                  >
                    <Building2 className="h-3 w-3 shrink-0" aria-hidden />
                    Od biura: <span className="tabular-nums">{fmtDistance(distances.office)}</span>
                  </span>
                )}
                {distances.object && (
                  <span
                    className="inline-flex items-center gap-1"
                    {...(distances.object.method === "straight"
                      ? tip(STRAIGHT_TIP)
                      : distances.object.objectName
                        ? tip(distances.object.objectName)
                        : {})}
                  >
                    <MapPin className="h-3 w-3 shrink-0" aria-hidden />
                    Od obiektu: <span className="tabular-nums">{fmtDistance(distances.object)}</span>
                  </span>
                )}
                {fmtSnap(distances.snapKm) && (
                  <span
                    className="text-muted-foreground/80"
                    {...tip("Pinezka stoi poza siecią dróg — trasa liczona do najbliższej ulicy")}
                  >
                    {fmtSnap(distances.snapKm)}
                  </span>
                )}
              </div>
            )
          ))}

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> Otwórz w Google Maps
          </a>
          {lat !== undefined && lng !== undefined && (
            <a
              href={directionsHref(lat, lng)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Navigation className="h-3 w-3" /> Nawiguj
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default MapPreviewCard;
