import { useEffect, useRef, useState } from "react";

// Leaflet is loaded from the unpkg CDN at runtime (no npm dependency — keeps the
// standalone public form working), so the global `L` has no bundled types.
declare const L: any;

const LEAFLET_CSS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
const LEAFLET_JS = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
const LEAFLET_CSS_ID = "leaflet-cdn-css";
const LEAFLET_JS_ID = "leaflet-cdn-js";

const DEFAULT_CENTER: [number, number] = [52.07, 19.48]; // środek Polski
const DEFAULT_ZOOM = 6;

/** Remembers the user's base-layer choice (streets ⇄ satellite) across sessions. */
const MAP_LAYER_KEY = "mapLayerPref";

interface LatLng {
  lat: number;
  lng: number;
}

/** Injects Leaflet CSS + JS from the CDN once, resolving when `window.L` exists. */
function loadLeaflet(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window !== "undefined" && (window as any).L) {
      resolve();
      return;
    }
    // CSS (idempotent via guard id)
    if (!document.getElementById(LEAFLET_CSS_ID)) {
      const link = document.createElement("link");
      link.id = LEAFLET_CSS_ID;
      link.rel = "stylesheet";
      link.href = LEAFLET_CSS;
      document.head.appendChild(link);
    }
    // JS (idempotent via guard id)
    const existing = document.getElementById(LEAFLET_JS_ID) as
      | HTMLScriptElement
      | null;
    if (existing) {
      if ((window as any).L) resolve();
      else existing.addEventListener("load", () => resolve());
      return;
    }
    const script = document.createElement("script");
    script.id = LEAFLET_JS_ID;
    script.src = LEAFLET_JS;
    script.async = true;
    script.addEventListener("load", () => resolve());
    document.head.appendChild(script);
  });
}

/** Build the canonical Google Maps URL we persist in objectLocationUrl. */
function toMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`;
}

/**
 * Parse coordinates from either a Google Maps URL or a bare "lat, lng" string.
 * Handles @lat,lng · ?q=lat,lng / q=lat,lng · !3dlat!4dlng · /place/.../@lat,lng.
 */
function parseCoords(raw: string): LatLng | null {
  if (!raw) return null;
  const value = raw.trim();

  const inRange = (lat: number, lng: number) =>
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180;

  // !3d<lat>!4d<lng>
  const bang = value.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/);
  if (bang) {
    const lat = parseFloat(bang[1]);
    const lng = parseFloat(bang[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // @<lat>,<lng>  (covers /place/.../@lat,lng too)
  const at = value.match(/@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (at) {
    const lat = parseFloat(at[1]);
    const lng = parseFloat(at[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // /maps/search/<lat>,+<lng>  ·  /place/<lat>,<lng>  ·  /dir/<lat>,<lng>
  const path = value.match(
    /\/(?:search|place|dir)\/(-?\d+(?:\.\d+)?),\+?\s*(-?\d+(?:\.\d+)?)/
  );
  if (path) {
    const lat = parseFloat(path[1]);
    const lng = parseFloat(path[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // q=<lat>,<lng>  (?q= or &q=)
  const q = value.match(/[?&]q=(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/);
  if (q) {
    const lat = parseFloat(q[1]);
    const lng = parseFloat(q[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  // Bare "lat, lng"
  const bare = value.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (bare) {
    const lat = parseFloat(bare[1]);
    const lng = parseFloat(bare[2]);
    if (inRange(lat, lng)) return { lat, lng };
  }

  return null;
}

/**
 * True when the raw text is something we can place directly — coordinates or an
 * http(s) link (Google Maps) — rather than a free-text address to geocode.
 */
function isDirectInput(raw: string): boolean {
  return parseCoords(raw) != null || /^https?:\/\//i.test(raw.trim());
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

/** Format a Polish street line: prepend „ul." unless a type word is present. */
function polishStreet(road: string, house: string): string {
  const name = road.trim();
  if (!name) return "";
  const hasType =
    /^(ul\.|ulica|al\.|aleja|aleje|pl\.|plac|rondo|os\.|osiedle|bulwar|skwer|park|droga|szosa|trakt|wybrzeże)\b/i.test(
      name
    );
  const withType = hasType ? name : "ul. " + name;
  return house ? `${withType} ${house}` : withType;
}

/**
 * Reverse-geocode a pin into a normal Polish address via Nominatim.
 * `address` is the full „ul. nazwa numer, miasto, województwo" form;
 * `city` is kept separately for the CRM's city column.
 */
async function reverseGeocode(
  lat: number,
  lng: number
): Promise<{ address: string; city: string } | null> {
  const url =
    "https://nominatim.openstreetmap.org/reverse?format=json&zoom=18&accept-language=pl&lat=" +
    lat +
    "&lon=" +
    lng;
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const a = data?.address ?? {};
    const road =
      a.road || a.pedestrian || a.footway || a.path || a.cycleway || "";
    const house = a.house_number || "";
    const city =
      a.city ||
      a.town ||
      a.village ||
      a.municipality ||
      a.hamlet ||
      a.county ||
      "";
    // Nominatim returns e.g. „województwo mazowieckie" — keep just „mazowieckie".
    const voivodeship = (a.state || "").replace(/^województwo\s+/i, "");

    const street =
      polishStreet(road, house) ||
      (typeof data?.display_name === "string"
        ? data.display_name.split(",")[0].trim()
        : "");

    const address = [street, city, voivodeship].filter(Boolean).join(", ");
    return { address, city };
  } catch {
    return null;
  }
}

export interface LocationPickerProps {
  /** Controlled value — the objectLocationUrl (canonical Google Maps URL). */
  value: string;
  onChange: (url: string) => void;
  /** Called with the address + city reverse-geocoded from the dropped pin. */
  onAddress?: (address: string, city: string) => void;
  /** Address to show on mount for an already-placed pin (skips re-geocoding). */
  initialAddress?: string;
  /** "light" fits the slate/indigo internal card, "dark" the blue public form. */
  variant?: "light" | "dark";
}

export function LocationPicker({
  value,
  onChange,
  onAddress,
  initialAddress,
  variant = "light",
}: LocationPickerProps) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onAddressRef = useRef(onAddress);
  onAddressRef.current = onAddress;

  const [ready, setReady] = useState(false);

  // Address search state
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const searchSeq = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // Direct-input (coords / Google Maps link) state — shares the same field as
  // the address search; the field auto-detects which kind of input it is.
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  // Address reverse-geocoded from the current pin (address + city are derived
  // from the pin — there are no manual address inputs).
  const [resolvedAddr, setResolvedAddr] = useState<{
    address: string;
    city: string;
  } | null>(null);
  const [addrLoading, setAddrLoading] = useState(false);
  const reverseSeq = useRef(0);

  const dark = variant === "dark";

  /** Reverse-geocode the pin and report the address/city upward. */
  const runReverse = (lat: number, lng: number) => {
    const my = ++reverseSeq.current;
    setAddrLoading(true);
    reverseGeocode(lat, lng).then((res) => {
      if (my !== reverseSeq.current) return;
      setAddrLoading(false);
      if (!res) return;
      setResolvedAddr(res);
      onAddressRef.current?.(res.address, res.city);
    });
  };

  /** Place / move the pin, recenter, emit the URL, and resolve its address. */
  const setPin = (
    lat: number,
    lng: number,
    opts?: { center?: boolean; reverse?: boolean }
  ) => {
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      markerRef.current = L.marker([lat, lng], {
        icon: L.divIcon({
          className: "",
          html:
            '<div style="font-size:30px;line-height:1;filter:drop-shadow(0 1px 3px rgba(0,0,0,.7))">📍</div>',
          iconSize: [30, 30],
          iconAnchor: [15, 28],
        }),
        interactive: true,
        zIndexOffset: 900,
      }).addTo(map);
    }
    if (opts?.center !== false) {
      map.setView([lat, lng], Math.max(map.getZoom(), 17));
    }
    onChangeRef.current(toMapsUrl(lat, lng));
    if (opts?.reverse !== false) runReverse(lat, lng);
  };

  // Load Leaflet + init the map once.
  useEffect(() => {
    let cancelled = false;
    loadLeaflet().then(() => {
      if (cancelled || !mapElRef.current || mapRef.current) return;

      const start = parseCoords(value);
      const map = L.map(mapElRef.current, {
        center: start ? [start.lat, start.lng] : DEFAULT_CENTER,
        zoom: start ? 17 : DEFAULT_ZOOM,
        zoomControl: true,
      });
      // Two base layers with a switcher: street map + satellite imagery.
      const streets = L.tileLayer(
        "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        { maxZoom: 19, attribution: "© OpenStreetMap" }
      );
      const satellite = L.tileLayer(
        "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        { maxZoom: 19, attribution: "© Esri, Maxar, Earthstar Geographics" }
      );
      // Base layer choice (streets ⇄ satellite) is remembered across sessions.
      let satOn = false;
      try {
        satOn = localStorage.getItem(MAP_LAYER_KEY) === "satellite";
      } catch {
        /* ignore unavailable storage */
      }
      (satOn ? satellite : streets).addTo(map);

      // A single compact icon button toggles the base layer (takes far less
      // room than the expanded layer switcher).
      const ToggleControl = L.Control.extend({
        options: { position: "topright" },
        onAdd() {
          const btn = L.DomUtil.create("button");
          btn.type = "button";
          btn.title = "Przełącz: mapa / satelita";
          btn.innerHTML = satOn ? "🗺️" : "🛰️";
          btn.style.cssText =
            "width:34px;height:34px;padding:0;border:none;border-radius:6px;" +
            "background:#fff;cursor:pointer;font-size:18px;line-height:34px;" +
            "box-shadow:0 1px 4px rgba(0,0,0,.35);";
          L.DomEvent.disableClickPropagation(btn);
          L.DomEvent.on(btn, "click", (e: any) => {
            L.DomEvent.stop(e);
            satOn = !satOn;
            if (satOn) {
              map.removeLayer(streets);
              satellite.addTo(map);
              btn.innerHTML = "🗺️";
            } else {
              map.removeLayer(satellite);
              streets.addTo(map);
              btn.innerHTML = "🛰️";
            }
            try {
              localStorage.setItem(
                MAP_LAYER_KEY,
                satOn ? "satellite" : "streets"
              );
            } catch {
              /* ignore unavailable storage */
            }
          });
          return btn;
        },
      });
      map.addControl(new ToggleControl());

      // Click anywhere to place / move the pin.
      map.on("click", (e: any) => {
        setPin(e.latlng.lat, e.latlng.lng, { center: false });
      });

      mapRef.current = map;
      // Restore an existing pin + its stored address without re-geocoding.
      if (start) {
        setPin(start.lat, start.lng, { center: true, reverse: false });
        if (initialAddress) setResolvedAddr({ address: initialAddress, city: "" });
      }

      // The map mounts inside a conditionally-rendered step, so tiles need a
      // size recalculation once the container is actually laid out.
      setTimeout(() => map.invalidateSize(), 60);
      setReady(true);
    });

    return () => {
      cancelled = true;
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
        markerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fix tiles shortly after becoming ready (step just became visible).
  useEffect(() => {
    if (ready && mapRef.current) {
      const t = setTimeout(() => mapRef.current?.invalidateSize(), 120);
      return () => clearTimeout(t);
    }
  }, [ready]);

  // Debounced Nominatim search.
  const runSearch = (q: string) => {
    const my = ++searchSeq.current;
    setSearching(true);
    setSearchOpen(true);
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&limit=6&accept-language=pl&countrycodes=pl&q=" +
      encodeURIComponent(q);
    fetch(url, { headers: { Accept: "application/json" } })
      .then((r) => r.json())
      .then((data) => {
        if (my !== searchSeq.current) return;
        setResults(Array.isArray(data) ? data : []);
        setActiveIdx(-1);
        setSearching(false);
      })
      .catch(() => {
        if (my === searchSeq.current) {
          setResults([]);
          setSearching(false);
        }
      });
  };

  const onSearchChange = (q: string) => {
    setSearch(q);
    if (pasteError) setPasteError(null);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    // Coordinates or a link → no address lookup; the „Ustaw" action places it.
    if (isDirectInput(q) || q.trim().length < 3) {
      setResults([]);
      setSearchOpen(false);
      return;
    }
    debounceRef.current = window.setTimeout(() => runSearch(q.trim()), 350);
  };

  const pickResult = (it: NominatimResult) => {
    const lat = parseFloat(it.lat);
    const lng = parseFloat(it.lon);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;
    setPin(lat, lng, { center: true });
    setSearch(it.display_name.split(",").slice(0, 2).join(",").trim());
    setResults([]);
    setSearchOpen(false);
    setActiveIdx(-1);
  };

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      setActiveIdx((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      setActiveIdx((i) => (i - 1 + results.length) % results.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIdx >= 0 && results[activeIdx]) pickResult(results[activeIdx]);
      else if (isDirectInput(search)) applyPaste();
      else if (search.trim().length >= 3) runSearch(search.trim());
    } else if (e.key === "Escape") {
      setSearchOpen(false);
    }
  };

  const applyPaste = async () => {
    // Fast path: the value already carries coordinates (@lat,lng, q=, bare…).
    const coords = parseCoords(search);
    if (coords) {
      setPasteError(null);
      setPin(coords.lat, coords.lng, { center: true });
      setSearch(`${coords.lat}, ${coords.lng}`);
      setSearchOpen(false);
      return;
    }

    // Short links (maps.app.goo.gl / goo.gl / g.co) carry no coordinates — they
    // must be expanded server-side (the browser can't follow them cross-origin).
    const value = search.trim();
    if (/^https?:\/\//i.test(value)) {
      setResolving(true);
      setPasteError(null);
      try {
        const res = await fetch(
          `/api/public/resolve-location?url=${encodeURIComponent(value)}`
        );
        const json = await res.json();
        if (res.ok && json?.success && json.data) {
          setPin(json.data.lat, json.data.lng, { center: true });
          setSearch(`${json.data.lat}, ${json.data.lng}`);
          setSearchOpen(false);
          return;
        }
        setPasteError(
          json?.error ?? "Nie udało się odczytać pinezki z tego linku."
        );
      } catch {
        setPasteError("Nie udało się połączyć, aby rozpoznać link.");
      } finally {
        setResolving(false);
      }
      return;
    }

    setPasteError(
      "Nie rozpoznano współrzędnych. Wklej link Google Maps lub „szer, dł”."
    );
  };

  // --- Theming --------------------------------------------------------------
  const inputStyle: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    padding: dark ? "10px 12px" : "8px 12px",
    borderRadius: 6,
    border: "1px solid #cbd5e1",
    backgroundColor: "#ffffff",
    color: "#0f172a",
    fontSize: dark ? 15 : 14,
  };

  const btnStyle: React.CSSProperties = {
    padding: dark ? "10px 16px" : "8px 14px",
    borderRadius: 6,
    border: "none",
    backgroundColor: dark ? "#3b82f6" : "#4f46e5",
    color: "#ffffff",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };

  // Coordinates / link pasted → show the „Ustaw" action instead of geocoding.
  const directMode = isDirectInput(search);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {/* One field: address search, coordinates, or a Google Maps link.
          We auto-detect which was entered — coords/link show the „Ustaw"
          button, free text runs the address geocoder with a dropdown. */}
      <div style={{ position: "relative" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "stretch" }}>
          <input
            style={{ ...inputStyle, flex: 1, width: "auto" }}
            placeholder="Adres, link lub współrzędne"
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            onKeyDown={onSearchKeyDown}
            onFocus={() => {
              if (results.length) setSearchOpen(true);
            }}
            onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
          />
          {directMode && (
            <button
              type="button"
              style={{ ...btnStyle, opacity: resolving ? 0.7 : 1 }}
              onClick={applyPaste}
              disabled={resolving}
            >
              {resolving ? "Ustawiam…" : "Ustaw"}
            </button>
          )}
        </div>
        {searchOpen && (searching || results.length > 0) && (
          <div
            style={{
              position: "absolute",
              zIndex: 1000,
              top: "calc(100% + 4px)",
              left: 0,
              right: 0,
              maxHeight: 240,
              overflowY: "auto",
              backgroundColor: "#ffffff",
              color: "#0f172a",
              border: "1px solid #cbd5e1",
              borderRadius: 6,
              boxShadow: "0 6px 20px rgba(0,0,0,0.18)",
            }}
          >
            {searching && (
              <div style={{ padding: "10px 12px", fontSize: 13, color: "#64748b" }}>
                Szukam…
              </div>
            )}
            {!searching &&
              results.map((it, i) => {
                const parts = it.display_name.split(",");
                const head = parts.slice(0, 2).join(",").trim();
                const rest = parts.slice(2).join(",").trim();
                return (
                  <div
                    key={i}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      pickResult(it);
                    }}
                    style={{
                      padding: "8px 12px",
                      cursor: "pointer",
                      fontSize: 14,
                      backgroundColor: i === activeIdx ? "#eef2ff" : "transparent",
                      borderBottom:
                        i < results.length - 1 ? "1px solid #f1f5f9" : "none",
                    }}
                  >
                    <div>{head}</div>
                    {rest && (
                      <small style={{ color: "#64748b" }}>{rest}</small>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
      {pasteError && (
        <div style={{ fontSize: 13, color: dark ? "#fca5a5" : "#dc2626" }}>
          {pasteError}
        </div>
      )}

      {/* Map — square (height follows width) so it scales up on both mobile
          and desktop and shows as much map as the card is wide. */}
      <div
        ref={mapElRef}
        style={{
          width: "100%",
          aspectRatio: "1 / 1",
          borderRadius: 8,
          overflow: "hidden",
          border: dark ? "1px solid rgba(255,255,255,0.25)" : "1px solid #cbd5e1",
          zIndex: 0,
        }}
      />
      {/* Address derived from the pin (no manual address fields). */}
      {(addrLoading || resolvedAddr) && (
        <div
          style={{
            fontSize: 13,
            color: dark ? "#e2e8f0" : "#334155",
            fontWeight: 500,
          }}
        >
          {addrLoading
            ? "Rozpoznaję adres z pinezki…"
            : resolvedAddr?.address || "Nie rozpoznano adresu — dopnij pinezkę"}
        </div>
      )}
    </div>
  );
}
