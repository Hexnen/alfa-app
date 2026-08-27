/**
 * Mapa realizacji miesiąca (zakładka Techniczny → Realizacje).
 *
 * Panel obok kafla „Rok … — przychód / strata" (na lg+ prawa kolumna, niżej pod
 * kaflem): pinezki realizacji, które mają obiekt ze współrzędnymi
 * (`realization.location`, dokładany przez backend przy GET /realizations),
 * oraz osobny znacznik biura (GET /company/office).
 *
 * Uwagi projektowe:
 *  - Leaflet ładujemy z CDN dokładnie tak jak `LocationPicker` (bez zależności npm),
 *    dopiero gdy panel jest rozwinięty. Panel jest rozwinięty domyślnie, ale można
 *    go zwinąć — stan trzymamy w localStorage `alfa.realizations.map` ("0" = zwinięty).
 *  - Kadr liczy się sam: `fitBounds` po wszystkich pinezkach RAZEM ze znacznikiem
 *    biura, bez `maxZoom` (jeden punkt → zoom 12, zero punktów → cała Polska).
 *    „Wyśrodkuj" powtarza to dopasowanie.
 *  - Zagranica jest wyszarzona maską (prostokąt świata z dziurą w kształcie Polski);
 *    kontur granicy leży w repo (`@/assets/poland-outline`), bez odpytywania API.
 *    `maxBounds` + `maxBoundsViscosity` trzymają kadr przy Polsce.
 *  - Kolor pinezki = rodzaj realizacji (serwis / gwarancja / montaż) — te same barwy,
 *    co badge w tabeli. Rozmiar = wartość netto w trzech progach.
 *  - Kafelki OSM zostają jasne także w motywie ciemnym (filtr CSS przekłamałby
 *    kolory pinezek); ciemny jest tylko chrome panelu, legendy i maski. Kolor maski
 *    czytamy ze zmiennych motywu przy tworzeniu mapy (zmiana motywu w locie
 *    przemaluje ją dopiero po ponownym zamontowaniu panelu).
 *  - `scrollWheelZoom` wyłączony, żeby mapa nie przechwytywała scrolla strony —
 *    włącza się kliknięciem w mapę (i wyłącza po zjechaniu kursorem).
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- Leaflet ładowany z CDN (jak w LocationPicker), globalne `L` nie ma typów */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Building2, ChevronDown, Crosshair, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  calendarEventHref,
  realizationHref,
  REALIZATION_KIND_LABEL,
} from "@/lib/calendar-labels";
import { getCompanyOffice, type CompanyOffice, type Realization, type RealizationKind } from "@/lib/api";
import { POLAND_RING } from "@/assets/poland-outline";

// Leaflet z CDN (jak w LocationPicker) — globalne `L` nie ma typów.
declare const L: any;

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS_ID = "leaflet-cdn-css";
const LEAFLET_JS_ID = "leaflet-cdn-js";

/** Stan rozwinięcia panelu ("0" = zwinięty; brak wpisu = rozwinięty). */
const OPEN_KEY = "alfa.realizations.map";

const DEFAULT_CENTER: [number, number] = [52.07, 19.48]; // środek Polski
const DEFAULT_ZOOM = 6;

/** Widok bazowy: cała Polska (gdy nie ma ani pinezek, ani biura). */
const POLAND_BOUNDS: [[number, number], [number, number]] = [
  [49.0, 14.07],
  [55.04, 24.15],
];

/** Zakres, poza który nie da się „uciec" mapą (Polska + margines). */
const MAX_BOUNDS: [[number, number], [number, number]] = [
  [47.6, 12.2],
  [56.4, 26.2],
];

/** Pojedynczy punkt: fitBounds nie ma czego dopasować — bierzemy sensowny zoom. */
const SINGLE_POINT_ZOOM = 12;

/** Odczyt zmiennej motywu (`--muted` itd.) jako gotowego koloru hsl(). */
function themeColor(name: string, fallback: string): string {
  try {
    const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return raw ? `hsl(${raw})` : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Maska „wyszarzonej zagranicy": prostokąt obejmujący cały świat z dziurą
 * w kształcie Polski (reguła even-odd w SVG Leafleta wycina wnętrze).
 */
const WORLD_RING: [number, number][] = [
  [-180, -90],
  [180, -90],
  [180, 90],
  [-180, 90],
  [-180, -90],
];

/** Injects Leaflet CSS + JS from the CDN once, resolving when `window.L` exists. */
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
    // Brak sieci → nie wieszamy panelu; efekt sprawdzi, czy `L` faktycznie jest.
    script.addEventListener("error", () => resolve());
    document.head.appendChild(script);
  });
}

// --- Skala pinezek ---------------------------------------------------------

/** Kolory pinezek = rodzaje realizacji (spójne z badge'ami w tabeli). */
const KIND_COLOR: Record<RealizationKind, string> = {
  service: "#059669", // emerald-600
  warranty: "#d97706", // amber-600
  installation: "#7c3aed", // violet-600
};

/** Trzy progi wartości netto — promień pinezki. */
const SIZE_STEPS = [
  { max: 500, radius: 6, label: "do 500 zł" },
  { max: 2000, radius: 9, label: "500–2000 zł" },
  { max: Infinity, radius: 13, label: "powyżej 2000 zł" },
] as const;

const radiusFor = (total: number) =>
  (SIZE_STEPS.find((s) => Math.abs(total) < s.max) ?? SIZE_STEPS[SIZE_STEPS.length - 1]).radius;

const pln = new Intl.NumberFormat("pl-PL", { style: "currency", currency: "PLN" });
const money = (v: number | null | undefined) => pln.format(Number(v || 0));

const fmtDate = (d: string) => {
  const [y, m, day] = d.split("-");
  return day ? `${day}.${m}.${y}` : d;
};

/** Realizacja z lokalizacją, która ma komplet współrzędnych. */
interface MapPoint {
  row: Realization;
  lat: number;
  lng: number;
}

export interface RealizationsMapProps {
  rows: Realization[];
  className?: string;
}

export function RealizationsMap({ rows, className }: RealizationsMapProps) {
  const navigate = useNavigate();

  // Domyślnie rozwinięta (mapa stoi obok podsumowania rocznego); zwinięcie
  // pamiętamy w localStorage — tylko jawne "0" zamyka panel.
  const [open, setOpen] = useState(() => {
    try {
      return localStorage.getItem(OPEN_KEY) !== "0";
    } catch {
      return true;
    }
  });
  const [office, setOffice] = useState<CompanyOffice | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [wheel, setWheel] = useState(false);

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const layerRef = useRef<any>(null);
  const boundsRef = useRef<any>(null);
  const resizeObsRef = useRef<ResizeObserver | null>(null);
  /** Ile znaczników jest na mapie (pinezki + biuro) — patrz `recenter`. */
  const locCountRef = useRef(0);

  const points = useMemo<MapPoint[]>(
    () =>
      rows
        .filter((r) => r.location && r.location.lat != null && r.location.lng != null)
        .map((r) => ({ row: r, lat: r.location!.lat as number, lng: r.location!.lng as number })),
    [rows]
  );
  const missing = rows.length - points.length;
  const hasPoints = points.length > 0;
  /** Mapę pokazujemy też bez pinezek, gdy znamy adres biura (sam znacznik firmy). */
  const showMap = hasPoints || (office != null && office.lat != null && office.lng != null);

  const toggle = () => {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OPEN_KEY, next ? "1" : "0");
      } catch {
        /* ignore unavailable storage */
      }
      return next;
    });
  };

  // Adres biura — dociągany raz, przy pierwszym rozwinięciu panelu.
  useEffect(() => {
    if (!open || office) return;
    let cancelled = false;
    getCompanyOffice()
      .then((res) => {
        if (!cancelled) setOffice(res.data ?? null);
      })
      .catch(() => {
        /* brak ustawień biura = mapa bez znacznika biura */
      });
    return () => {
      cancelled = true;
    };
  }, [open, office]);

  // Inicjalizacja mapy — po rozwinięciu panelu, gdy jest co pokazać (pinezki
  // albo samo biuro). Zależy od `showMap`, a nie od samej listy: zmiana miesiąca
  // przestawia markery (osobny efekt), a nie przebudowuje całej mapy.
  useEffect(() => {
    if (!open || !showMap) return;
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current || mapRef.current) return;
      if (typeof (window as any).L === "undefined") {
        setFailed(true);
        return;
      }
      const map = L.map(mapElRef.current, {
        center: DEFAULT_CENTER,
        zoom: DEFAULT_ZOOM,
        zoomControl: true,
        // Mapa nie może przechwytywać scrolla strony — zoom kółkiem po kliknięciu.
        scrollWheelZoom: false,
        // Mapa pilnuje kadru na Polskę — nie da się nią „uciec" w świat.
        maxBounds: MAX_BOUNDS,
        maxBoundsViscosity: 0.8,
        minZoom: 5,
      });
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(map);

      // Maska: świat na szaro, Polska wycięta (kontur trzymany lokalnie w repo).
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
            // Prawie krycie — poza granicą ma zostać spokojne tło, nie druga mapa.
            fillOpacity: 0.93,
            fillRule: "evenodd",
          },
        }
      ).addTo(map);
      // Cienka obwódka samej granicy.
      L.geoJSON(
        {
          type: "Feature",
          properties: {},
          geometry: { type: "Polygon", coordinates: [POLAND_RING] },
        },
        {
          interactive: false,
          style: { color: themeColor("--muted-foreground", "#64748b"), weight: 1.2, fill: false, opacity: 0.85 },
        }
      ).addTo(map);

      // Widok startowy = cała Polska; kadr do punktów ustawia efekt markerów.
      map.fitBounds(POLAND_BOUNDS, { padding: [10, 10], animate: false });
      // Zoom kółkiem dopiero po kliknięciu w mapę (żeby nie łapała scrolla strony),
      // i z powrotem wyłączony, gdy kursor zjedzie z kontenera.
      map.on("click", () => {
        map.scrollWheelZoom.enable();
        setWheel(true);
      });
      layerRef.current = L.layerGroup().addTo(map);
      mapRef.current = map;
      setTimeout(() => map.invalidateSize(), 60);
      // Mapa stoi w kolumnie rozciąganej do wysokości kafla rocznego — po każdej
      // zmianie rozmiaru kontenera Leaflet musi przeliczyć kafelki.
      if (typeof ResizeObserver !== "undefined" && mapElRef.current) {
        const ro = new ResizeObserver(() => map.invalidateSize());
        ro.observe(mapElRef.current);
        resizeObsRef.current = ro;
      }
      setReady(true);
    });
    // Zwinięcie panelu / odmontowanie → mapa znika razem z listenerami.
    return () => {
      cancelled = true;
      resizeObsRef.current?.disconnect();
      resizeObsRef.current = null;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        layerRef.current = null;
        boundsRef.current = null;
        setReady(false);
        setWheel(false);
      }
    };
  }, [open, showMap]);

  /** Treść dymka — budowana jako DOM, żeby linki szły przez router (bez przeładowania). */
  const popupNode = useCallback((row: Realization) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "min-width:200px;font-size:13px;line-height:1.45;color:#0f172a";

    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;margin-bottom:2px";
    title.textContent = row.location?.name || row.site;
    wrap.appendChild(title);

    const meta = document.createElement("div");
    meta.style.cssText = "color:#475569";
    meta.textContent = `${fmtDate(row.date)} · ${REALIZATION_KIND_LABEL[row.kind] ?? row.kind}`;
    wrap.appendChild(meta);

    const amount = document.createElement("div");
    amount.style.cssText = "margin-top:2px;font-weight:600";
    amount.textContent = `${money(row.total)}${row.invoiced ? " · zafakturowana" : ""}`;
    wrap.appendChild(amount);

    const crew = [row.contractor1, row.contractor2].filter(Boolean).join(", ");
    if (crew) {
      const who = document.createElement("div");
      who.style.cssText = "color:#475569";
      who.textContent = crew;
      wrap.appendChild(who);
    }

    const addr = [row.location?.address, row.location?.city].filter(Boolean).join(", ");
    if (addr) {
      const a = document.createElement("div");
      a.style.cssText = "color:#64748b;font-size:12px;margin-top:2px";
      a.textContent = addr;
      wrap.appendChild(a);
    }

    const links = document.createElement("div");
    links.style.cssText = "margin-top:8px;display:flex;gap:10px;flex-wrap:wrap";
    const mkLink = (label: string, href: string) => {
      const a = document.createElement("a");
      a.href = href;
      a.textContent = label;
      a.style.cssText = "color:#4f46e5;font-weight:600;text-decoration:underline;cursor:pointer";
      a.addEventListener("click", (e) => {
        e.preventDefault();
        navigate(href);
      });
      links.appendChild(a);
    };
    mkLink("Otwórz realizację", realizationHref(row.id, row.date));
    if (row.calendarEventId) mkLink("W kalendarzu", calendarEventHref(row.calendarEventId, row.date));
    wrap.appendChild(links);

    return wrap;
  }, [navigate]);

  /**
   * Kadr: wszystkie pinezki miesiąca razem ze znacznikiem biura, bez `maxZoom`
   * (ma przybliżać maksymalnie). Jeden punkt → rozsądny zoom, zero punktów →
   * cała Polska.
   */
  const recenter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    map.invalidateSize();
    // Bez animacji: kadr ustawiamy tuż po utworzeniu mapy, a trwająca animacja
    // zoomu potrafi zjeść kolejne setView/fitBounds.
    const opts = { animate: false } as const;
    const bounds = boundsRef.current;
    if (locCountRef.current === 1 && bounds && bounds.isValid()) {
      map.setView(bounds.getCenter(), SINGLE_POINT_ZOOM, opts);
      return;
    }
    if (bounds && bounds.isValid()) {
      map.fitBounds(bounds, { padding: [24, 24], ...opts });
      return;
    }
    map.fitBounds(POLAND_BOUNDS, { padding: [10, 10], ...opts });
  }, []);

  // Pinezki: przebudowywane przy każdej zmianie danych miesiąca / biura.
  useEffect(() => {
    if (!ready || !mapRef.current || !layerRef.current) return;
    const group = layerRef.current;
    group.clearLayers();
    const bounds = L.latLngBounds([]);

    for (const p of points) {
      const marker = L.circleMarker([p.lat, p.lng], {
        radius: radiusFor(p.row.total),
        color: "#ffffff",
        weight: 2,
        fillColor: KIND_COLOR[p.row.kind] ?? "#0ea5e9",
        fillOpacity: 0.9,
      });
      marker.bindPopup(popupNode(p.row), { maxWidth: 280, autoPan: true });
      marker.bindTooltip(
        `${p.row.location?.name || p.row.site} · ${money(p.row.total)}`,
        { direction: "top" }
      );
      marker.addTo(group);
      bounds.extend([p.lat, p.lng]);
    }

    if (office && office.lat != null && office.lng != null) {
      const officeIcon = L.divIcon({
        className: "",
        html:
          '<div title="Biuro" style="width:26px;height:26px;border-radius:7px;background:#1e293b;color:#fff;' +
          'display:flex;align-items:center;justify-content:center;border:2px solid #fff;' +
          'box-shadow:0 1px 4px rgba(0,0,0,.45)">' +
          '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18Z"/><path d="M6 12H4a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2"/>' +
          '<path d="M18 9h2a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-2"/><path d="M10 6h4"/><path d="M10 10h4"/>' +
          '<path d="M10 14h4"/><path d="M10 18h4"/></svg></div>',
        iconSize: [26, 26],
        iconAnchor: [13, 13],
      });
      L.marker([office.lat, office.lng], { icon: officeIcon, zIndexOffset: 500 })
        .bindPopup(`<b>Biuro</b><br>${office.address || office.city || ""}`)
        .addTo(group);
      bounds.extend([office.lat, office.lng]);
    }

    boundsRef.current = bounds;
    // Liczba znaczników (pinezki + biuro) — decyduje, czy fitBounds ma sens.
    locCountRef.current = points.length + (office && office.lat != null && office.lng != null ? 1 : 0);
    // Kadr przeliczamy po każdej zmianie miesiąca/filtrów i po rozwinięciu panelu.
    recenter();
  }, [ready, points, office, popupNode, recenter]);

  const kindLegend: { kind: RealizationKind; label: string }[] = [
    { kind: "service", label: REALIZATION_KIND_LABEL.service },
    { kind: "warranty", label: REALIZATION_KIND_LABEL.warranty },
    { kind: "installation", label: REALIZATION_KIND_LABEL.installation },
  ];

  return (
    <div
      className={cn("flex flex-col rounded-lg border bg-card text-card-foreground", className)}
      data-testid="realizations-map"
    >
      {/* Nagłówek panelu — sam przycisk rozwijania + liczniki */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          data-testid="realizations-map-toggle"
          className="flex items-center gap-2 text-sm font-medium hover:text-primary"
        >
          <ChevronDown
            className={cn("h-4 w-4 transition-transform", open ? "" : "-rotate-90")}
            aria-hidden
          />
          <MapPin className="h-4 w-4 text-muted-foreground" aria-hidden />
          Mapa realizacji ({points.length})
        </button>
        {missing > 0 && (
          <span
            className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="realizations-map-missing"
            {...tip(
              "Realizacje bez współrzędnych obiektu nie trafiają na mapę.\nUzupełnij pinezkę w karcie obiektu (Techniczny → Obiekty)."
            )}
          >
            bez lokalizacji: {missing}
          </span>
        )}
        {open && ready && (
          <div className="ml-auto flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7"
              onClick={recenter}
              data-testid="realizations-map-recenter"
              {...tip("Dopasuj widok do wszystkich pinezek miesiąca")}
            >
              <Crosshair className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Wyśrodkuj
            </Button>
          </div>
        )}
      </div>

      {open && (
        <div className="flex min-h-0 flex-1 flex-col border-t p-3">
          {/* Brak pinezek: komunikat + (jeśli jest biuro) sama mapa Polski pod nim. */}
          {!hasPoints && (
            <div
              className="mb-3 rounded-md border border-dashed px-4 py-4 text-center text-sm text-muted-foreground"
              data-testid="realizations-map-empty"
            >
              Żadna realizacja w tym miesiącu nie ma współrzędnych obiektu — uzupełnij je w karcie
              obiektu.
              <div className="mt-2">
                <Button variant="outline" size="sm" onClick={() => navigate("/technical/obiekty")}>
                  <Building2 className="mr-1.5 h-3.5 w-3.5" aria-hidden />
                  Przejdź do Obiektów
                </Button>
              </div>
            </div>
          )}
          {!showMap ? null : failed ? (
            <div className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              Nie udało się załadować biblioteki mapy (brak połączenia z internetem).
            </div>
          ) : (
            <>
              {/* Mapa wypełnia wysokość kolumny (obok kafla rocznego), ale nigdy
                  nie schodzi poniżej 260 px — tyle ma na mobile pod kaflem. */}
              <div className="relative min-h-0 flex-1">
                <div
                  ref={mapElRef}
                  className="h-full min-h-[260px] w-full overflow-hidden rounded-md border"
                  style={{ zIndex: 0 }}
                  data-testid="realizations-map-canvas"
                  onMouseLeave={() => {
                    mapRef.current?.scrollWheelZoom?.disable();
                    setWheel(false);
                  }}
                />
                {!wheel && (
                  <div className="pointer-events-none absolute bottom-2 left-2 z-[400] rounded bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-sm">
                    Kliknij mapę, by włączyć zoom kółkiem
                  </div>
                )}
              </div>

              {/* Legenda: kolor = rodzaj, rozmiar = wartość netto */}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {kindLegend.map((l) => (
                  <span key={l.kind} className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2.5 w-2.5 rounded-full ring-1 ring-white"
                      style={{ backgroundColor: KIND_COLOR[l.kind] }}
                      aria-hidden
                    />
                    {l.label}
                  </span>
                ))}
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className="inline-flex h-3.5 w-3.5 items-center justify-center rounded-[4px] bg-slate-800 text-white"
                    aria-hidden
                  >
                    <Building2 className="h-2.5 w-2.5" />
                  </span>
                  Biuro
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-flex items-end gap-0.5" aria-hidden>
                    <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground/70" />
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/70" />
                    <span className="inline-block h-3.5 w-3.5 rounded-full bg-muted-foreground/70" />
                  </span>
                  wielkość = kwota ({SIZE_STEPS.map((s) => s.label).join(" · ")})
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
