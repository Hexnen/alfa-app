/**
 * Mapa planera trasy (kalendarz → widok „Trasa").
 *
 * Wzorzec zgodny z `@/components/realization/RealizationsMap`: Leaflet ładowany z CDN
 * (bez zależności npm), maska „wyszarzonej zagranicy" z lokalnego konturu Polski,
 * `maxBounds`, `scrollWheelZoom` włączany kliknięciem, kafelki OSM jasne także w motywie
 * ciemnym (filtr CSS przekłamałby kolory tras).
 *
 * Czego ta mapa NIE pokazuje: rzeczywistego przebiegu dróg. Odcinki są liniami prostymi
 * i jest to jawnie napisane na mapie, bo inaczej wyglądałyby na trasę przejazdu.
 * Kilometry i czasy są prawdziwe — pochodzą z OSRM, nie z rysunku.
 *
 * Kolory: wypełnienie pinezki = TYP wydarzenia (zasada całego kalendarza), obrys i linia
 * trasy = POJAZD. Dzięki temu kolor pojazdu nigdy nie koduje niczego sam — zawsze towarzyszy
 * mu litera (A/B/C) na pinezce.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet ładowany z CDN (jak w LocationPicker/RealizationsMap), globalne `L` nie ma typów */
import { useCallback, useEffect, useRef } from "react";
import { Crosshair } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { POLAND_RING } from "@/assets/poland-outline";
import type { DayRoutePoint } from "@/lib/api";
import { vehicleLetter, type Vehicle, type VehiclePlan } from "@/lib/route-plan";

declare const L: any;

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS_ID = "leaflet-cdn-css";
const LEAFLET_JS_ID = "leaflet-cdn-js";

const DEFAULT_CENTER: [number, number] = [52.07, 19.48];
const DEFAULT_ZOOM = 6;
const SINGLE_POINT_ZOOM = 12;

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

function themeColor(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  } catch {
    return fallback;
  }
}

/** Kolor pojazdu z palety `--cal-veh-*` (Calendar.css). */
function vehicleColor(colorIndex: number): string {
  return themeColor(`--cal-veh-${(colorIndex % 6) + 1}`, "#2563eb");
}

/** Kolor typu wydarzenia z palety `--cal-<typ>` (Calendar.css). */
function typeColor(type: string): string {
  return themeColor(`--cal-${type}`, "#64748b");
}

function loadLeaflet(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && (window as any).L) {
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
      if ((window as any).L) resolve();
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
    script.addEventListener("error", () => resolve());
    document.head.appendChild(script);
  });
}

/** Mała kłódka SVG — Lucide nie działa wewnątrz `divIcon`, więc rysujemy ją wprost. */
const LOCK_SVG = `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

export interface RoutePlannerMapProps {
  office: DayRoutePoint | null;
  plans: { vehicle: Vehicle; plan: VehiclePlan }[];
  points: Map<string, DayRoutePoint>;
  /** Podświetlony przystanek (hover/fokus na osi czasu w panelu). */
  highlightEventId: number | null;
  onSelectStop: (eventId: number) => void;
  /** Etykieta wydarzenia do dymka na pinezce. */
  labelOf: (eventId: number) => string;
  /** Typ wydarzenia — decyduje o kolorze WYPEŁNIENIA pinezki (zasada „kolor = typ”). */
  typeOf: (eventId: number) => string;
  className?: string;
}

export function RoutePlannerMap({
  office,
  plans,
  points,
  highlightEventId,
  onSelectStop,
  labelOf,
  typeOf,
  className,
}: RoutePlannerMapProps) {
  const mapElRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const readyRef = useRef(false);
  // Handlery w ref — inaczej każda zmiana propsów przerysowywałaby całą mapę.
  const selectRef = useRef(onSelectStop);
  const labelRef = useRef(labelOf);
  const typeRef = useRef(typeOf);
  useEffect(() => {
    selectRef.current = onSelectStop;
    labelRef.current = labelOf;
    typeRef.current = typeOf;
  }, [onSelectStop, labelOf, typeOf]);

  const fit = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const coords: [number, number][] = [];
    if (office) coords.push([office.lat, office.lng]);
    for (const { plan } of plans) {
      for (const stop of plan.stops) {
        const pt = points.get(stop.pointKey);
        if (pt) coords.push([pt.lat, pt.lng]);
      }
    }
    if (coords.length === 0) {
      map.fitBounds(POLAND_BOUNDS, { padding: [10, 10], animate: false });
      return;
    }
    if (coords.length === 1) {
      map.setView(coords[0], SINGLE_POINT_ZOOM, { animate: false });
      return;
    }
    map.fitBounds(L.latLngBounds(coords), { padding: [32, 32], animate: false });
  }, [office, plans, points]);

  // --- Inicjalizacja mapy (raz) ---
  useEffect(() => {
    let cancelled = false;
    void loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current || mapRef.current) return;
      if (typeof L === "undefined") return; // brak sieci — panel po prostu zostaje pusty

      const map = L.map(mapElRef.current, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: true,
        scrollWheelZoom: false,
        maxBounds: MAX_BOUNDS,
        maxBoundsViscosity: 0.8,
        minZoom: 5,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap · trasowanie: OSRM",
      }).addTo(map);

      L.geoJSON(
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [WORLD_RING, POLAND_RING] } },
        {
          interactive: false,
          style: {
            stroke: false,
            fillColor: themeColor("--muted", "#e2e8f0"),
            fillOpacity: 0.93,
            fillRule: "evenodd",
          },
        }
      ).addTo(map);
      L.geoJSON(
        { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [POLAND_RING] } },
        {
          interactive: false,
          style: { color: themeColor("--muted-foreground", "#64748b"), weight: 1.2, fill: false, opacity: 0.85 },
        }
      ).addTo(map);

      map.on("click", () => map.scrollWheelZoom.enable());
      map.on("mouseout", () => map.scrollWheelZoom.disable());

      mapRef.current = map;
      layerRef.current = L.layerGroup().addTo(map);
      readyRef.current = true;
      map.fitBounds(POLAND_BOUNDS, { padding: [10, 10], animate: false });
      setTimeout(() => map.invalidateSize(), 60);

      // W trybie „fit do viewportu" kontener zmienia wysokość przy otwieraniu paneli —
      // bez tego Leaflet rysuje kafelki na starym rozmiarze.
      if (typeof ResizeObserver !== "undefined" && mapElRef.current) {
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(mapElRef.current);
        (map as any).__ro = ro;
      }
    });

    return () => {
      cancelled = true;
      const map = mapRef.current;
      if (map) {
        (map as any).__ro?.disconnect();
        map.remove();
        mapRef.current = null;
        layerRef.current = null;
        readyRef.current = false;
      }
    };
  }, []);

  // --- Przerysowanie warstwy tras ---
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (office) {
      const icon = L.divIcon({
        className: "cal-route-pin-wrap",
        html: `<div class="cal-route-pin cal-route-pin-office" title="Biuro">⌂</div>`,
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([office.lat, office.lng], { icon, zIndexOffset: 600, title: `Biuro: ${office.label}`, keyboard: true }).addTo(layer);
    }

    plans.forEach(({ vehicle, plan }) => {
      const color = vehicleColor(vehicle.colorIndex);
      const letter = vehicleLetter(vehicle.colorIndex);

      // Odcinki: biuro → 1 → 2 → … → biuro. Przerywane = dystans z linii prostej.
      let prev: [number, number] | null = office ? [office.lat, office.lng] : null;
      plan.stops.forEach((stop) => {
        const pt = points.get(stop.pointKey);
        if (!pt) return;
        const here: [number, number] = [pt.lat, pt.lng];
        if (prev) {
          L.polyline([prev, here], {
            color,
            weight: highlightEventId === stop.eventId ? 6 : 3,
            opacity: 0.75,
            dashArray: stop.leg.estimated ? "6 6" : undefined,
            interactive: false,
          }).addTo(layer);
        }
        prev = here;
      });
      if (prev && office && plan.returnLeg) {
        L.polyline([prev, [office.lat, office.lng]], {
          color,
          weight: 3,
          opacity: 0.55,
          dashArray: plan.returnLeg.estimated ? "6 6" : "2 5",
          interactive: false,
        }).addTo(layer);
      }

      // Pinezki: numer + litera pojazdu, obrys w kolorze pojazdu, wypełnienie w kolorze typu.
      plan.stops.forEach((stop, i) => {
        const pt = points.get(stop.pointKey);
        if (!pt) return;
        const label = labelRef.current(stop.eventId);
        const fillColor = typeColor(typeRef.current(stop.eventId));
        const locked = stop.lock === "locked";
        const html = `<div class="cal-route-pin${locked ? " is-locked" : ""}${
          highlightEventId === stop.eventId ? " is-active" : ""
        }" style="--pin-ring:${color};--pin-fill:${fillColor}">
            <span class="cal-route-pin-no">${i + 1}${letter}</span>
            ${locked ? `<span class="cal-route-pin-lock">${LOCK_SVG}</span>` : ""}
          </div>`;
        const icon = L.divIcon({ className: "cal-route-pin-wrap", html, iconSize: [30, 30], iconAnchor: [15, 15] });
        const title = `Przystanek ${i + 1}, ${vehicle.name}, ${pt.label}, przyjazd ${stop.arriveAt}${
          locked ? ", termin zablokowany kłódką" : ""
        }`;
        L.marker([pt.lat, pt.lng], { icon, title, alt: title, keyboard: true, zIndexOffset: 400 })
          .addTo(layer)
          .bindTooltip(`${i + 1}${letter} · ${label}`, { direction: "top", offset: [0, -14] })
          .on("click", () => selectRef.current(stop.eventId));
      });
    });
  }, [plans, points, office, highlightEventId]);

  // Kadr przelicza się przy zmianie zestawu punktów, nie przy każdym podświetleniu.
  useEffect(() => {
    if (readyRef.current) fit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [office, points, plans.length]);

  return (
    <div className={cn("cal-route-map relative", className)}>
      <div ref={mapElRef} className="h-full w-full rounded-md" role="img" aria-label="Mapa trasy dnia — pełny opis znajduje się na osi czasu obok" />
      <div className="cal-route-map-note" aria-hidden="true">
        Schemat — linie proste. Kilometry i czasy z OSRM.
      </div>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="absolute right-2 top-2 z-[500] gap-1"
        onClick={fit}
      >
        <Crosshair className="h-3.5 w-3.5" />
        Wyśrodkuj
      </Button>
    </div>
  );
}
