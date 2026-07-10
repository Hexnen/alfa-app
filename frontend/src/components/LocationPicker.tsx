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

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
}

export interface LocationPickerProps {
  /** Controlled value — the objectLocationUrl (canonical Google Maps URL). */
  value: string;
  onChange: (url: string) => void;
  /** "light" fits the slate/indigo internal card, "dark" the blue public form. */
  variant?: "light" | "dark";
  label?: string;
}

export function LocationPicker({
  value,
  onChange,
  variant = "light",
  label = "Lokalizacja obiektu na mapie",
}: LocationPickerProps) {
  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const [ready, setReady] = useState(false);

  // Address search state
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<NominatimResult[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const searchSeq = useRef(0);
  const debounceRef = useRef<number | null>(null);

  // Paste-coords state
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);

  const dark = variant === "dark";

  /** Place / move the pin, recenter, and emit the canonical URL. */
  const setPin = (lat: number, lng: number, opts?: { center?: boolean }) => {
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
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(map);

      // Click anywhere to place / move the pin.
      map.on("click", (e: any) => {
        setPin(e.latlng.lat, e.latlng.lng, { center: false });
      });

      mapRef.current = map;
      if (start) setPin(start.lat, start.lng, { center: true });

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
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    if (q.trim().length < 3) {
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
      else if (search.trim().length >= 3) runSearch(search.trim());
    } else if (e.key === "Escape") {
      setSearchOpen(false);
    }
  };

  const applyPaste = () => {
    const coords = parseCoords(pasteValue);
    if (!coords) {
      setPasteError(
        "Nie rozpoznano współrzędnych. Wklej link Google Maps lub „szer, dł”."
      );
      return;
    }
    setPasteError(null);
    setPin(coords.lat, coords.lng, { center: true });
  };

  // --- Theming --------------------------------------------------------------
  const labelStyle: React.CSSProperties = dark
    ? { display: "block", marginBottom: 6, fontWeight: 600, fontSize: 14, color: "#ffffff" }
    : { display: "block", marginBottom: 6, fontWeight: 500, fontSize: 14, color: "#334155" };

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

  const hintColor = dark ? "#cbd5e1" : "#64748b";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <label style={labelStyle}>{label}</label>

      {/* Address search */}
      <div style={{ position: "relative" }}>
        <input
          style={inputStyle}
          placeholder="🔎 Szukaj adresu (ulica, miasto)…"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={onSearchKeyDown}
          onFocus={() => {
            if (results.length) setSearchOpen(true);
          }}
          onBlur={() => setTimeout(() => setSearchOpen(false), 150)}
        />
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

      {/* Paste coords / Google Maps link */}
      <div
        style={{
          display: "flex",
          gap: 8,
          alignItems: "flex-start",
          flexWrap: "wrap",
        }}
      >
        <input
          style={{ ...inputStyle, flex: "1 1 200px", width: "auto" }}
          placeholder="Wklej pinezkę / współrzędne (link Google Maps lub „52.23, 21.01”)"
          value={pasteValue}
          onChange={(e) => {
            setPasteValue(e.target.value);
            if (pasteError) setPasteError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              applyPaste();
            }
          }}
        />
        <button type="button" style={btnStyle} onClick={applyPaste}>
          Ustaw
        </button>
      </div>
      {pasteError && (
        <div style={{ fontSize: 13, color: dark ? "#fca5a5" : "#dc2626" }}>
          {pasteError}
        </div>
      )}

      {/* Map */}
      <div
        ref={mapElRef}
        style={{
          width: "100%",
          height: 300,
          borderRadius: 8,
          overflow: "hidden",
          border: dark ? "1px solid rgba(255,255,255,0.25)" : "1px solid #cbd5e1",
          zIndex: 0,
        }}
      />
      <div style={{ fontSize: 12, color: hintColor }}>
        Kliknij na mapie, aby ustawić pinezkę obiektu.
      </div>
    </div>
  );
}
