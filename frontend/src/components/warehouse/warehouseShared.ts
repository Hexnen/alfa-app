import type {
  StockEntry,
  WarehouseDef,
  WarehouseDocStatus,
  WarehouseDocType,
  WarehouseType,
} from "@/lib/api";

/** Etykiety i kolory badge'y typów dokumentów magazynowych. */
export const DOC_TYPE_META: Record<
  WarehouseDocType,
  { label: string; badge: string }
> = {
  PZ: { label: "PZ — przyjęcie", badge: "bg-emerald-100 text-emerald-700" },
  WZ: { label: "WZ — wydanie zewn.", badge: "bg-orange-100 text-orange-700" },
  RW: { label: "RW — zużycie wewn.", badge: "bg-sky-100 text-sky-700" },
  MM: { label: "MM — przesunięcie", badge: "bg-violet-100 text-violet-700" },
};

export const DOC_STATUS_META: Record<
  WarehouseDocStatus,
  { label: string; badge: string }
> = {
  draft: { label: "Szkic", badge: "bg-amber-100 text-amber-700" },
  confirmed: { label: "Zatwierdzony", badge: "bg-emerald-100 text-emerald-700" },
  cancelled: { label: "Anulowany", badge: "bg-red-100 text-red-700" },
};

export const WAREHOUSE_TYPE_META: Record<
  WarehouseType,
  { label: string; badge: string }
> = {
  main: { label: "Główny", badge: "bg-emerald-100 text-emerald-700" },
  vehicle: { label: "Pojazd", badge: "bg-sky-100 text-sky-700" },
  employee: { label: "Pracownik", badge: "bg-violet-100 text-violet-700" },
  site: { label: "Obiekt", badge: "bg-orange-100 text-orange-700" },
  other: { label: "Inny", badge: "bg-muted text-muted-foreground" },
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
