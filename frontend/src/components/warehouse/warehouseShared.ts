import type {
  StockEntry,
  WarehouseDef,
  WarehouseDocStatus,
  WarehouseDocType,
  WarehouseType,
} from "@/lib/api";
import type { PillTone } from "@/lib/calendar-labels";

/**
 * Etykiety i tony pigułek magazynu. Ton trafia do `pillClass()` z
 * calendar-labels — ten sam kształt i ta sama paleta (jasna + ciemna) co
 * badge'e kalendarza i realizacji.
 */
export const DOC_TYPE_META: Record<
  WarehouseDocType,
  { label: string; tone: PillTone }
> = {
  PZ: { label: "PZ — przyjęcie", tone: "emerald" },
  WZ: { label: "WZ — wydanie zewn.", tone: "orange" },
  RW: { label: "RW — zużycie wewn.", tone: "sky" },
  MM: { label: "MM — przesunięcie", tone: "violet" },
};

export const DOC_STATUS_META: Record<
  WarehouseDocStatus,
  { label: string; tone: PillTone }
> = {
  // Szkic szary jak „Wykonane”/„Protokół (szkic)” w kalendarzu — bursztyn
  // rezerwujemy na to, co wymaga reakcji.
  draft: { label: "Szkic", tone: "neutral" },
  confirmed: { label: "Zatwierdzony", tone: "emerald" },
  cancelled: { label: "Anulowany", tone: "red" },
};

export const WAREHOUSE_TYPE_META: Record<
  WarehouseType,
  { label: string; tone: PillTone }
> = {
  main: { label: "Główny", tone: "emerald" },
  vehicle: { label: "Pojazd", tone: "sky" },
  employee: { label: "Pracownik", tone: "violet" },
  site: { label: "Obiekt", tone: "orange" },
  other: { label: "Inny", tone: "muted" },
};

/** Standardowe jednostki podpowiadane w formularzach. */
export const COMMON_UNITS = ["szt", "m", "kpl", "op", "kg"];

const qtyFormat = new Intl.NumberFormat("pl-PL", {
  maximumFractionDigits: 3,
});

/** Ilość magazynowa po polsku (bez śmieciowych miejsc po przecinku). */
export function fmtQty(v: number | null | undefined): string {
  return qtyFormat.format(Number(v || 0));
}

const plnFormat = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});

export function fmtPln(v: number | null | undefined): string {
  return plnFormat.format(Number(v || 0));
}

/**
 * Kwota, której może nie być. W odróżnieniu od `fmtPln` NIE udaje, że brak
 * danych to 0 zł — towar bez wpisanej ceny zakupu ma pokazać kreskę, a nie
 * „0,00 zł", bo z zera policzyłoby się 100% marży.
 */
export function fmtPlnOrDash(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : plnFormat.format(v);
}

/** Procent z jednym miejscem po przecinku; brak danych = kreska. */
export function fmtPct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return `${v.toLocaleString("pl-PL", { maximumFractionDigits: 1 })}%`;
}

/**
 * Lustro `marginOf` z src/lib/margin.ts — do liczenia na żywo w formularzu,
 * zanim cokolwiek poleci na backend. Zwraca null, gdy liczby nie da się podać
 * uczciwie (brak kosztu, brak ceny, wartość niedodatnia).
 */
export function marginOf(
  cost: number | null | undefined,
  price: number | null | undefined
): { amount: number; marginPct: number; markupPct: number } | null {
  if (cost === null || cost === undefined || price === null || price === undefined)
    return null;
  if (!Number.isFinite(cost) || !Number.isFinite(price)) return null;
  if (cost <= 0 || price <= 0) return null;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return {
    amount: r2(price - cost),
    marginPct: r2(((price - cost) / price) * 100),
    markupPct: r2(((price - cost) / cost) * 100),
  };
}

/** Lustro `effectiveSalePrice` — cena własna, a bez niej koszt + narzut firmowy. */
export function effectiveSalePrice(
  purchasePrice: number | null | undefined,
  salePrice: number | null | undefined,
  markupPct: number
): number | null {
  if (salePrice !== null && salePrice !== undefined) return salePrice;
  if (purchasePrice === null || purchasePrice === undefined) return null;
  if (!Number.isFinite(purchasePrice)) return null;
  return Math.round(purchasePrice * (1 + markupPct / 100) * 100) / 100;
}

/** Format SQLite "YYYY-MM-DD HH:MM:SS" — UTC bez znacznika strefy. */
const SQLITE_UTC_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Parsuje datę z API odpornie na format SQLite: string bez "T" i "Z"
 * traktujemy jako UTC (inaczej new Date() zinterpretuje go jako czas lokalny
 * i historia wyświetli się przesunięta o strefę).
 */
function parseApiDate(v: string): Date {
  return new Date(SQLITE_UTC_RE.test(v) ? `${v.replace(" ", "T")}Z` : v);
}

export function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = parseApiDate(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("pl-PL");
}

export function fmtDateTime(v: string | null | undefined): string {
  if (!v) return "—";
  const d = parseApiDate(v);
  return Number.isNaN(d.getTime())
    ? v
    : d.toLocaleString("pl-PL", { dateStyle: "short", timeStyle: "short" });
}

/** Ilość towaru w konkretnym magazynie wg wpisów stock. */
export function stockFor(
  stock: StockEntry[],
  itemId: number,
  warehouseId: number | null | undefined
): number {
  if (!warehouseId) return 0;
  const entry = stock.find(
    (s) => s.itemId === itemId && s.warehouseId === warehouseId
  );
  return entry ? entry.quantity : 0;
}

/** Suma stanu towaru po wszystkich magazynach. */
export function totalStockFor(stock: StockEntry[], itemId: number): number {
  return stock
    .filter((s) => s.itemId === itemId)
    .reduce((sum, s) => sum + s.quantity, 0);
}

export function warehouseLabel(
  warehouses: WarehouseDef[],
  id: number | null | undefined,
  fallback?: string | null
): string {
  if (fallback) return fallback;
  if (!id) return "—";
  const w = warehouses.find((x) => x.id === id);
  return w ? w.name : `#${id}`;
}

/** Czyta plik jako data-URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () =>
      reject(new Error("Nie udało się wczytać pliku"));
    reader.readAsDataURL(file);
  });
}

/** Przeskalowuje obraz w przeglądarce do max `maxSize` px (JPEG ~0.8). */
export async function resizeImageToDataUrl(
  file: File,
  maxSize = 800
): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Nieprawidłowy plik graficzny"));
    el.src = dataUrl;
  });
  const scale = Math.min(1, maxSize / Math.max(img.width, img.height, 1));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas jest niedostępny w tej przeglądarce");
  ctx.drawImage(img, 0, 0, w, h);
  return canvas.toDataURL("image/jpeg", 0.8);
}

/** Dzisiejsza data w formacie YYYY-MM-DD (dla input[type=date]). */
export function todayIso(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
