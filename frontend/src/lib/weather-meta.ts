/**
 * Pogoda — warstwa BEZ JSX: mapa kodów WMO, formatowanie liczb i teksty opisów.
 *
 * Moduł istnieje osobno od `components/CalendarWeather.tsx` z jednego powodu: plik, który
 * eksportuje komponenty ORAZ zwykłe funkcje, wywala Fast Refresh Vite'a
 * (`react-refresh/only-export-components`) — przy każdym HMR kalendarz zostawał w półstanie
 * (m.in. martwe drag&drop FullCalendara). W `CalendarWeather.tsx` zostają wyłącznie komponenty,
 * cała reszta mieszka tutaj. Ikony Lucide są tu wartościami (referencje do komponentów),
 * nie JSX — element buduje dopiero warstwa widoku.
 */
import {
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudHail,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  CloudSunRain,
  Cloudy,
  Sun,
} from "lucide-react";
import type { WeatherBrief } from "@/lib/api";
import { parseLocal, splitTip, toDateStr } from "@/lib/calendar-labels";
import { tipAttrs } from "@/components/ui/tooltip";

// ---------------------------------------------------------------------------
// Kody WMO → ikona + polska etykieta
// ---------------------------------------------------------------------------

export type WeatherIcon = typeof Sun;

export interface WmoMeta {
  icon: WeatherIcon;
  label: string;
  /** Kolor ikony (light + dark) — JEDYNE miejsce, gdzie się go ustala. */
  className: string;
}

/** Palety zjawisk: słońce bursztynowe, opady niebieskie, śnieg cyjanowy, burza fioletowa. */
const SUN = "text-amber-500 dark:text-amber-400";
const SUN_SOFT = "text-amber-500/80 dark:text-amber-400/80";
const GREY = "text-slate-500 dark:text-slate-300";
const FOG = "text-slate-400 dark:text-slate-400";
const DRIZZLE = "text-sky-500 dark:text-sky-400";
const RAIN = "text-blue-500 dark:text-blue-400";
const RAIN_HEAVY = "text-blue-600 dark:text-blue-400";
const SNOW = "text-cyan-500 dark:text-cyan-300";
const STORM = "text-violet-600 dark:text-violet-400";

/**
 * Mapa kodów WMO (Open-Meteo `weather_code`). Klucze to konkretne kody —
 * nieznany kod dostaje neutralne „Zachmurzenie” (patrz `weatherMeta`).
 *
 * Dobór ikon jest dosłowny, bo ikona to jedyne, co widać na kafelku: 1 i 2 MUSZĄ się różnić
 * (słońce vs. słońce zza chmury), 3 to pełne zachmurzenie (`Cloudy`, nie pojedyncza chmurka),
 * a 80/81 to opady PRZELOTNE — słońce w ikonie jest tu informacją, nie ozdobą.
 */
const WMO: Record<number, WmoMeta> = {
  0: { icon: Sun, label: "Bezchmurnie", className: SUN },
  1: { icon: Sun, label: "Prawie bezchmurnie", className: SUN_SOFT },
  2: { icon: CloudSun, label: "Częściowe zachmurzenie", className: SUN },
  3: { icon: Cloudy, label: "Pochmurno", className: GREY },
  45: { icon: CloudFog, label: "Mgła", className: FOG },
  48: { icon: CloudFog, label: "Mgła osadzająca szadź", className: FOG },
  51: { icon: CloudDrizzle, label: "Słaba mżawka", className: DRIZZLE },
  53: { icon: CloudDrizzle, label: "Mżawka", className: DRIZZLE },
  55: { icon: CloudDrizzle, label: "Silna mżawka", className: DRIZZLE },
  56: { icon: CloudDrizzle, label: "Marznąca mżawka", className: DRIZZLE },
  57: { icon: CloudDrizzle, label: "Silna marznąca mżawka", className: DRIZZLE },
  61: { icon: CloudRain, label: "Słaby deszcz", className: RAIN },
  63: { icon: CloudRain, label: "Umiarkowany deszcz", className: RAIN },
  65: { icon: CloudRain, label: "Silny deszcz", className: RAIN_HEAVY },
  66: { icon: CloudRain, label: "Marznący deszcz", className: RAIN },
  67: { icon: CloudRain, label: "Silny marznący deszcz", className: RAIN_HEAVY },
  71: { icon: CloudSnow, label: "Słabe opady śniegu", className: SNOW },
  73: { icon: CloudSnow, label: "Opady śniegu", className: SNOW },
  75: { icon: CloudSnow, label: "Silne opady śniegu", className: SNOW },
  77: { icon: CloudSnow, label: "Śnieg ziarnisty", className: SNOW },
  80: { icon: CloudSunRain, label: "Przelotne opady", className: DRIZZLE },
  81: { icon: CloudSunRain, label: "Przelotne opady", className: DRIZZLE },
  82: { icon: CloudRain, label: "Ulewa", className: RAIN_HEAVY },
  85: { icon: CloudSnow, label: "Przelotny śnieg", className: SNOW },
  86: { icon: CloudSnow, label: "Silne przelotne opady śniegu", className: SNOW },
  95: { icon: CloudLightning, label: "Burza", className: STORM },
  96: { icon: CloudHail, label: "Burza z gradem", className: STORM },
  99: { icon: CloudHail, label: "Silna burza z gradem", className: STORM },
};

const WMO_FALLBACK: WmoMeta = { icon: Cloud, label: "Zachmurzenie", className: GREY };

/**
 * Ikona + etykieta + kolor dla kodu WMO (nieznany kod → neutralna chmura).
 * Zwraca obiekt, bo w JSX ikonę podajemy jako `meta.icon` — lokalna zmienna
 * z komponentem tworzonym w trakcie renderu łamie reguły React Compilera.
 */
export const weatherMeta = (code: number): WmoMeta => WMO[code] ?? WMO_FALLBACK;

/** Ikona Lucide dla kodu WMO. */
export const weatherIcon = (code: number): WeatherIcon => weatherMeta(code).icon;

/** Polska etykieta zjawiska dla kodu WMO. */
export const weatherLabel = (code: number): string => weatherMeta(code).label;

// ---------------------------------------------------------------------------
// Formatowanie
// ---------------------------------------------------------------------------

export const round = (n: number): number => Math.round(n);
/** Temperatura bez jednostki: „14°”. */
export const temp = (n: number): string => `${round(n)}°`;
/** Opady: bez zbędnego zera po przecinku („4 mm”, „0,4 mm”). */
export const mm = (n: number): string => (n >= 1 || n === 0 ? String(round(n)) : n.toFixed(1).replace(".", ","));

const dayFmt = new Intl.DateTimeFormat("pl-PL", { weekday: "short", day: "numeric", month: "short" });
export const fmtDay = (date: string): string => {
  const d = parseLocal(date);
  return Number.isNaN(d.getTime()) ? date : dayFmt.format(d);
};
/** „14:00” z ISO godziny (bez zależności od strefy — backend liczy w Europe/Warsaw). */
export const fmtHour = (iso: string): string => (iso.length >= 16 ? iso.slice(11, 16) : iso);
export const hourNum = (iso: string): number => Number(iso.slice(11, 13));

/** Kolory stopni ostrzeżeń IMGW: 1 żółty, 2 pomarańczowy, 3 czerwony. */
export const WARNING_TONE: Record<1 | 2 | 3, string> = {
  1: "text-yellow-600 dark:text-yellow-400",
  2: "text-orange-600 dark:text-orange-400",
  3: "text-red-600 dark:text-red-400",
};
export const WARNING_BOX: Record<1 | 2 | 3, string> = {
  1: "border-yellow-400/60 bg-yellow-50 dark:border-yellow-500/40 dark:bg-yellow-500/10",
  2: "border-orange-400/60 bg-orange-50 dark:border-orange-500/40 dark:bg-orange-500/10",
  3: "border-red-400/70 bg-red-50 dark:border-red-500/40 dark:bg-red-500/10",
};
export const WARNING_LABEL: Record<1 | 2 | 3, string> = {
  1: "żółty",
  2: "pomarańczowy",
  3: "czerwony",
};

/** „10:00”–„14:00” → „10–14”; niepełne godziny zostają z minutami. */
const shortHour = (hm: string): string => (hm.endsWith(":00") ? hm.slice(0, 2) : hm);

/** „w godz. 10–14” — okno, z którego backend policzył kod i liczby (null dla całodniowych). */
export function windowLabel(b: WeatherBrief): string {
  return b.window ? ` w godz. ${shortHour(b.window.from)}–${shortHour(b.window.to)}` : "";
}

/** Jednolinijkowy opis pogody: „Deszcz w godz. 10–14, 12–17°C”. */
export function weatherHeadline(b: WeatherBrief): string {
  return `${weatherLabel(b.code)}${windowLabel(b)}, ${round(b.tempMinC)}–${round(b.tempMaxC)}°C`;
}

/** Szczegóły: „opady 4 mm (70%), wiatr 35 km/h”. */
export function weatherFacts(b: WeatherBrief): string {
  const prob = b.precipProb != null ? ` (${round(b.precipProb)}%)` : "";
  return `opady ${mm(b.precipMm)} mm${prob}, wiatr ${round(b.windKmh)} km/h`;
}

/** Zakres temperatur okna: „14–17” albo „16”, gdy po zaokrągleniu to jedna liczba. */
function tempRange(b: WeatherBrief): string {
  const lo = round(b.tempMinC);
  const hi = round(b.tempMaxC);
  return lo === hi ? String(lo) : `${lo}–${hi}`;
}

/** „Przelotne opady, 14–17°C, wiatr 21 km/h” — jedna linia dla podglądu wydarzenia. */
export function weatherLineText(b: WeatherBrief): string {
  return `${weatherLabel(b.code)}, ${tempRange(b)}°C, wiatr ${round(b.windKmh)} km/h`;
}

/**
 * Tekst dymka znacznika — „Nagłówek — wyjaśnienie” (jak billingTip/protocolTip),
 * kolejne linie: ostrzeżenie IMGW i źródło punktu prognozy.
 */
export function weatherTip(b: WeatherBrief): string {
  const lines = [`${weatherHeadline(b)} — ${weatherFacts(b)}`];
  if (b.warningLevel > 0) {
    lines.push(`Ostrzeżenie IMGW ${b.warningLevel}° (${WARNING_LABEL[b.warningLevel as 1 | 2 | 3]})`);
  }
  if (b.point.label) lines.push(`Prognoza dla: ${b.point.label}`);
  return lines.join("\n");
}

export const markTip = (text: string) => {
  const spec = splitTip(text);
  return spec ? tipAttrs(spec) : {};
};

export const flat = (s: string): string => s.replace(/\n/g, " · ");

const stampFmt = new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" });
export const fmtFetched = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : stampFmt.format(d);
};

/** „od pt 12 wrz, 10:00 do so 13 wrz, 08:00” — z pominięciem dnia, gdy ten sam. */
export function fmtWarningRange(from: string, to: string): string {
  const a = new Date(from);
  const b = new Date(to);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return `${from} — ${to}`;
  const sameDay = toDateStr(a) === toDateStr(b);
  const timeFmt = new Intl.DateTimeFormat("pl-PL", { hour: "2-digit", minute: "2-digit" });
  const head = `${dayFmt.format(a)}, ${timeFmt.format(a)}`;
  const tail = sameDay ? timeFmt.format(b) : `${dayFmt.format(b)}, ${timeFmt.format(b)}`;
  return `od ${head} do ${tail}`;
}
