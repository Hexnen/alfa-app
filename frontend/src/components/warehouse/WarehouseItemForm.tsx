import { useMemo, useState } from "react";
import { fmtRelative, fmtTimestamp } from "@/lib/calendar-labels";
import { tip } from "@/components/ui/tooltip";
import { isPriceStale, priceAgeLabel } from "@/lib/price-age";
import { ImageOff, RotateCcw, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { warehouseApi, type WarehouseItem, type WarehouseItemInput } from "@/lib/api";
import {
  COMMON_UNITS,
  effectiveSalePrice,
  fmtPct,
  fmtPln,
  fmtPlnOrDash,
  marginOf,
  resizeImageToDataUrl,
} from "./warehouseShared";

interface WarehouseItemFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: WarehouseItemInput) => Promise<void>;
  item?: WarehouseItem | null;
  /** Istniejące kategorie do podpowiedzi (datalist). */
  categories: string[];
  /** Istniejący producenci do podpowiedzi (datalist). */
  manufacturers: string[];
  /** Narzut firmowy (%) — z niego liczy się cena sprzedaży bez własnej ceny. */
  warehouseMarkup: number;
}

const CUSTOM_UNIT = "__custom__";

/** Liczba z pola tekstowego; pusty string = brak wartości, nie zero. */
const parseMoney = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

export function WarehouseItemForm({
  open,
  onClose,
  onSubmit,
  item,
  categories,
  manufacturers,
  warehouseMarkup,
}: WarehouseItemFormProps) {
  const [loading, setLoading] = useState(false);
  const initialUnit = item?.unit || "szt";
  const isKnownUnit = COMMON_UNITS.includes(initialUnit);
  const [unitChoice, setUnitChoice] = useState(
    isKnownUnit ? initialUnit : CUSTOM_UNIT
  );
  const [customUnit, setCustomUnit] = useState(isKnownUnit ? "" : initialUnit);
  const [form, setForm] = useState({
    name: item?.name || "",
    sku: item?.sku || "",
    category: item?.category || "",
    manufacturer: item?.manufacturer || "",
    barcode: item?.barcode || "",
    minStock: item?.minStock != null ? String(item.minStock) : "",
    isAsset: item?.isAsset ?? false,
    description: item?.description || "",
    purchasePrice: item?.purchasePrice != null ? String(item.purchasePrice) : "",
    salePrice: item?.salePrice != null ? String(item.salePrice) : "",
  });
  const [photoData, setPhotoData] = useState<string | null>(
    item?.photoData || null
  );
  const [photoBusy, setPhotoBusy] = useState(false);
  const [lastPurchase, setLastPurchase] = useState<string | null>(null);
  const [lastPurchaseBusy, setLastPurchaseBusy] = useState(false);

  const unit = unitChoice === CUSTOM_UNIT ? customUnit.trim() : unitChoice;

  // Podgląd ceny i marży liczony tą samą arytmetyką co backend (warehouseShared),
  // żeby to, co widać przy wpisywaniu, zgadzało się z tym, co potem pokaże lista.
  const preview = useMemo(() => {
    const cost = parseMoney(form.purchasePrice);
    const own = parseMoney(form.salePrice);
    const price = effectiveSalePrice(cost, own, warehouseMarkup);
    return { cost, price, auto: own === null, margin: marginOf(cost, price) };
  }, [form.purchasePrice, form.salePrice, warehouseMarkup]);

  const fillFromLastPz = async () => {
    if (!item) return;
    setLastPurchaseBusy(true);
    try {
      const r = await warehouseApi.getLastPurchase(item.id);
      const price = r.data?.unitPrice;
      if (price == null) {
        setLastPurchase("Brak zatwierdzonego PZ z ceną dla tego towaru.");
        return;
      }
      setForm((p) => ({ ...p, purchasePrice: String(price) }));
      setLastPurchase(
        `Przepisano ${fmtPln(price)} z ${r.data?.docNumber || "ostatniego PZ"}.`
      );
    } catch (err) {
      setLastPurchase(
        err instanceof Error ? err.message : "Nie udało się pobrać ceny z PZ"
      );
    } finally {
      setLastPurchaseBusy(false);
    }
  };

  const handlePhoto = async (file: File | undefined) => {
    if (!file) return;
    setPhotoBusy(true);
    try {
      setPhotoData(await resizeImageToDataUrl(file, 800));
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd wczytywania zdjęcia"
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim() || !unit) {
      window.alert("Podaj nazwę i jednostkę towaru.");
      return;
    }
    setLoading(true);
    try {
      await onSubmit({
        name: form.name.trim(),
        unit,
        sku: form.sku.trim() || undefined,
        category: form.category.trim() || undefined,
        manufacturer: form.manufacturer.trim() || undefined,
        barcode: form.barcode.trim() || undefined,
        // Pusty string leci jako null: „wyczyść cenę zakupu" i „wróć do ceny
        // z narzutu" to świadome decyzje, a nie brak zmiany.
        purchasePrice: form.purchasePrice.trim() || null,
        salePrice: form.salePrice.trim() || null,
        minStock: form.minStock.trim() ? Number(form.minStock) : null,
        isAsset: form.isAsset,
        description: form.description.trim() || undefined,
        photoData,
      });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu towaru");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{item ? "Edytuj towar" : "Nowy towar"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="wi-name">Nazwa *</Label>
            <Input
              id="wi-name"
              value={form.name}
              onChange={(e) =>
                setForm((p) => ({ ...p, name: e.target.value }))
              }
              placeholder="np. Kamera IP 4 Mpx"
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-unit">Jednostka *</Label>
              <select
                id="wi-unit"
                value={unitChoice}
                onChange={(e) => setUnitChoice(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                {COMMON_UNITS.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
                <option value={CUSTOM_UNIT}>inna…</option>
              </select>
              {unitChoice === CUSTOM_UNIT && (
                <Input
                  value={customUnit}
                  onChange={(e) => setCustomUnit(e.target.value)}
                  placeholder="np. rolka"
                  required
                />
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="wi-sku">SKU</Label>
              <Input
                id="wi-sku"
                value={form.sku}
                onChange={(e) =>
                  setForm((p) => ({ ...p, sku: e.target.value }))
                }
                placeholder="np. KAM-4MP-01"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-category">Kategoria</Label>
              <Input
                id="wi-category"
                list="wi-category-list"
                value={form.category}
                onChange={(e) =>
                  setForm((p) => ({ ...p, category: e.target.value }))
                }
                placeholder="np. Kamery"
              />
              <datalist id="wi-category-list">
                {categories.map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </div>
            <div className="space-y-2">
              <Label htmlFor="wi-manufacturer">Producent</Label>
              <Input
                id="wi-manufacturer"
                list="wi-manufacturer-list"
                value={form.manufacturer}
                onChange={(e) =>
                  setForm((p) => ({ ...p, manufacturer: e.target.value }))
                }
                placeholder="np. Dahua"
              />
              <datalist id="wi-manufacturer-list">
                {manufacturers.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-barcode">Kod kreskowy</Label>
              <Input
                id="wi-barcode"
                value={form.barcode}
                onChange={(e) =>
                  setForm((p) => ({ ...p, barcode: e.target.value }))
                }
                placeholder="np. 5901234567890"
              />
            </div>
          </div>

          {/* Ceny i marża — wszystkie kwoty NETTO, jak w całej aplikacji. */}
          <div className="space-y-3 rounded-md border bg-muted/30 p-3">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="wi-purchase-price">Cena zakupu netto</Label>
                <Input
                  id="wi-purchase-price"
                  data-testid="wi-purchase-price"
                  type="number"
                  min="0"
                  step="0.01"
                  className="tabular-nums"
                  value={form.purchasePrice}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, purchasePrice: e.target.value }))
                  }
                  placeholder="np. 420"
                />
                {item && (
                  <button
                    type="button"
                    onClick={fillFromLastPz}
                    disabled={lastPurchaseBusy}
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50"
                  >
                    {lastPurchaseBusy
                      ? "Sprawdzanie…"
                      : "Przepisz z ostatniego PZ"}
                  </button>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="wi-sale-price">Cena sprzedaży netto</Label>
                <Input
                  id="wi-sale-price"
                  data-testid="wi-sale-price"
                  type="number"
                  min="0"
                  step="0.01"
                  className="tabular-nums"
                  value={form.salePrice}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, salePrice: e.target.value }))
                  }
                  placeholder={
                    preview.auto && preview.price !== null
                      ? `auto: ${fmtPln(preview.price)}`
                      : `auto: zakup + ${warehouseMarkup}%`
                  }
                />
                {!preview.auto && (
                  <button
                    type="button"
                    onClick={() => setForm((p) => ({ ...p, salePrice: "" }))}
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    <RotateCcw className="h-3 w-3" /> Wróć do ceny z narzutu
                  </button>
                )}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
              <span className="text-muted-foreground">
                Cena sprzedaży:{" "}
                <strong className="text-foreground tabular-nums">
                  {fmtPlnOrDash(preview.price)}
                </strong>
                {preview.auto && preview.price !== null && (
                  <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide">
                    auto
                  </span>
                )}
              </span>
              <span className="text-muted-foreground">
                Marża:{" "}
                <strong className="text-foreground tabular-nums">
                  {fmtPct(preview.margin?.marginPct)}
                </strong>
              </span>
              <span className="text-muted-foreground">
                Narzut:{" "}
                <strong className="text-foreground tabular-nums">
                  {fmtPct(preview.margin?.markupPct)}
                </strong>
              </span>
              {preview.margin && (
                <span className="text-muted-foreground">
                  Zysk:{" "}
                  <strong className="text-foreground tabular-nums">
                    {fmtPln(preview.margin.amount)}
                  </strong>
                </span>
              )}
            </div>
            {preview.cost === null && (
              <p className="text-xs text-muted-foreground">
                Bez ceny zakupu marży nie da się policzyć — pozycja w ofercie
                pokaże „brak danych" zamiast pełnego zysku.
              </p>
            )}
            {lastPurchase && (
              <p className="text-xs text-muted-foreground">{lastPurchase}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="wi-min-stock">Stan minimalny</Label>
              <Input
                id="wi-min-stock"
                type="number"
                min="0"
                step="any"
                value={form.minStock}
                onChange={(e) =>
                  setForm((p) => ({ ...p, minStock: e.target.value }))
                }
                placeholder="np. 5"
              />
            </div>
            <label className="flex items-center gap-2 pt-7 text-sm font-medium">
              <input
                type="checkbox"
                checked={form.isAsset}
                onChange={(e) =>
                  setForm((p) => ({ ...p, isAsset: e.target.checked }))
                }
                className="h-4 w-4 accent-primary"
              />
              Sprzęt zwrotny (do zwrotu)
            </label>
          </div>

          <div className="space-y-2">
            <Label htmlFor="wi-description">Opis</Label>
            <Textarea
              id="wi-description"
              value={form.description}
              onChange={(e) =>
                setForm((p) => ({ ...p, description: e.target.value }))
              }
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label>Zdjęcie</Label>
            <div className="flex items-center gap-3">
              {photoData ? (
                <img
                  src={photoData}
                  alt="Zdjęcie towaru"
                  className="h-16 w-16 rounded-md border object-cover"
                />
              ) : (
                <div className="flex h-16 w-16 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                  <ImageOff className="h-6 w-6" />
                </div>
              )}
              <div className="flex flex-col gap-1">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                  <Upload className="h-4 w-4" />
                  {photoBusy ? "Przetwarzanie…" : "Wybierz zdjęcie"}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      handlePhoto(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {photoData && (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"
                    onClick={() => setPhotoData(null)}
                  >
                    <X className="h-3 w-3" /> Usuń zdjęcie
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Ślad edycji i wiek ceny przy przyciskach: przy sporze o cenę
              pierwsze pytanie brzmi „kto to zmienił i kiedy", a nie „ile
              wynosi" — i ma być pod ręką bez wchodzenia do dziennika. */}
          {item && (
            <p className="text-[11px] text-muted-foreground">
              Utworzył {item.createdByLabel || "—"},{" "}
              <span {...tip(fmtTimestamp(item.createdAt))}>{fmtRelative(item.createdAt)}</span>
              {item.updatedAt !== item.createdAt && (
                <>
                  {" · "}Zmienił {item.updatedByLabel || "—"},{" "}
                  <span {...tip(fmtTimestamp(item.updatedAt))}>{fmtRelative(item.updatedAt)}</span>
                </>
              )}
              {(item.purchasePrice !== null || item.salePrice !== null) && (
                <>
                  {" · "}
                  <span
                    className={
                      isPriceStale(item.priceUpdatedAt, "warehouse")
                        ? "font-medium text-red-600"
                        : undefined
                    }
                  >
                    {priceAgeLabel(item.priceUpdatedAt, "warehouse")}
                  </span>
                </>
              )}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Anuluj
            </Button>
            <Button type="submit" disabled={loading || photoBusy}>
              {loading ? "Zapisywanie…" : item ? "Zapisz zmiany" : "Dodaj"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
