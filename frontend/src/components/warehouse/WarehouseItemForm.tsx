import { useEffect, useMemo, useRef, useState } from "react";
import { fmtRelative, fmtTimestamp, pillClass } from "@/lib/calendar-labels";
import { tip } from "@/components/ui/tooltip";
import { isPriceStale, priceAgeLabel } from "@/lib/price-age";
import {
  ExternalLink,
  ImageOff,
  Lock,
  RefreshCw,
  RotateCcw,
  ShoppingCart,
  Upload,
  X,
} from "lucide-react";
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
import {
  warehouseApi,
  type ShopImportParseResult,
  type WarehouseItem,
  type WarehouseItemInput,
  type WarehouseItemSource,
  type WarehouseItemSourceInput,
} from "@/lib/api";
import {
  ShopImportPanel,
  type ShopImportApplied,
  type ShopImportSnapshot,
} from "./ShopImportPanel";
import {
  COMMON_UNITS,
  effectiveSalePrice,
  fmtPct,
  fmtPln,
  fmtPlnOrDash,
  fmtQty,
  MARGIN_HELP,
  MARKUP_HELP,
  marginOf,
  resizeImageToDataUrl,
  shopFromUrl,
} from "./warehouseShared";
import { cn } from "@/lib/utils";

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
  /** Źródła towaru doczytane przez stronę (GET /items/:id/sources). */
  sources?: WarehouseItemSource[];
  /** true = od razu po otwarciu poproś o plik zapisanej strony sklepu. */
  initialImportOpen?: boolean;
  /**
   * Gotowa propozycja importu (z kolejki wtyczki) — formularz otwiera się od
   * razu na panelu przeglądu, bez pytania o plik. Parsowanie zrobił już serwer
   * przy przyjęciu wpisu z wtyczki, więc pliku nie ma i nie będzie.
   */
  initialImport?: ShopImportParseResult | null;
  /** „Otwórz istniejący” z listy dopasowań importu. */
  onOpenExisting?: (id: number) => void;
}

const CUSTOM_UNIT = "__custom__";

/** Liczba z pola tekstowego; pusty string = brak wartości, nie zero. */
const parseMoney = (raw: string): number | null => {
  const t = raw.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const HTML_FILE_RE = /\.(html?|htm)$/i;

const isHtmlFile = (f: File) =>
  HTML_FILE_RE.test(f.name) || (f.type || "").toLowerCase().startsWith("text/html");

const NOT_A_PRODUCT_PAGE =
  "Nie rozpoznano strony produktu. Upewnij się, że to zapisana strona towaru " +
  "(nie lista) i że wybrano „Strona sieci Web, kompletna”.";

/**
 * Wiersz źródła w formularzu. `id` mają tylko wiersze już zapisane w bazie —
 * import dokłada wiersze bez id, a zapis kartoteki (POST/PUT z `sources`)
 * podmienia CAŁY zbiór, więc dopisanie i usunięcie dzieje się w tej samej
 * transakcji co reszta towaru.
 */
interface SourceRow {
  id?: number;
  input: WarehouseItemSourceInput;
}

const rowFrom = (s: WarehouseItemSource): SourceRow => ({
  id: s.id,
  input: {
    shop: s.shop,
    shopLabel: s.shopLabel,
    productUrl: s.productUrl,
    supplierCode: s.supplierCode,
    supplierProductId: s.supplierProductId,
    lastPriceNet: s.lastPriceNet,
    lastPriceGross: s.lastPriceGross,
    vatRate: s.vatRate,
    currency: s.currency,
    lastStock: s.lastStock,
    loggedIn: s.loggedIn,
    fetchedAt: s.fetchedAt ?? undefined,
  },
});

export function WarehouseItemForm({
  open,
  onClose,
  onSubmit,
  item,
  categories,
  manufacturers,
  warehouseMarkup,
  sources: initialSources,
  initialImportOpen = false,
  initialImport = null,
  onOpenExisting,
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
    manufacturerCode: item?.manufacturerCode || "",
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
  /**
   * Czy zdjęcie ruszaliśmy w tym oknie. Lista towarów NIE niesie `photoData`
   * (ważyłaby megabajty), więc bez tej flagi zapis edycji wysyłałby
   * `photoData: null` i po cichu kasował zdjęcie z kartoteki.
   */
  const [photoDirty, setPhotoDirty] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [lastPurchase, setLastPurchase] = useState<string | null>(null);
  const [lastPurchaseBusy, setLastPurchaseBusy] = useState(false);

  // --- Import ze sklepu ---
  const [rows, setRows] = useState<SourceRow[]>(
    (initialSources ?? []).map(rowFrom)
  );
  const [sourcesDirty, setSourcesDirty] = useState(false);
  /**
   * Propozycja importu w przeglądzie. Startuje z `initialImport`, gdy dane
   * przyszły z wtyczki — formularz montuje się wtedy od razu na panelu
   * przeglądu (strona ustawia `key`, więc przemontowanie przy zmianie wpisu
   * kolejki jest gwarantowane i stan startowy nie zdąży się zestarzeć).
   */
  const [imported, setImported] = useState<ShopImportParseResult | null>(
    initialImport
  );
  const [importBusy, setImportBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  /** Sklep, którego źródło odświeżamy plikiem (null = zwykły import). */
  const [refreshShop, setRefreshShop] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const refreshInputRef = useRef<HTMLInputElement>(null);
  const askedForFile = useRef(false);

  const unit = unitChoice === CUSTOM_UNIT ? customUnit.trim() : unitChoice;

  /**
   * Zdjęcie doczytujemy osobnym żądaniem, bo lista go nie niesie (patrz
   * `photoDirty`). Bez tego edycja towaru pokazywałaby „brak zdjęcia”
   * przy towarze, który zdjęcie ma.
   */
  useEffect(() => {
    if (!item || item.photoData || !item.hasPhoto) return;
    let alive = true;
    warehouseApi
      .getItemPhoto(item.id)
      .then((r) => {
        if (alive && r.data?.photoData) setPhotoData(r.data.photoData);
      })
      .catch(() => {
        /* brak zdjęcia to nie błąd formularza — zostaje placeholder */
      });
    return () => {
      alive = false;
    };
  }, [item]);

  /**
   * „Aktualizuj ze sklepu” z listy: od razu pytamy o plik. Import z wtyczki
   * (`initialImport`) tę ścieżkę POMIJA — dane są już sparsowane, a okno
   * wyboru pliku wyskoczyłoby na wierzchu gotowego przeglądu.
   */
  useEffect(() => {
    if (initialImport || !initialImportOpen || askedForFile.current) return;
    askedForFile.current = true;
    setRefreshShop(null);
    importInputRef.current?.click();
  }, [initialImportOpen, initialImport]);

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
      setPhotoDirty(true);
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd wczytywania zdjęcia"
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  /* ------------------------------ import ------------------------------ */

  /** Wspólne wczytanie pliku: pełny import albo odświeżenie jednego źródła. */
  const parseFile = async (file: File): Promise<ShopImportParseResult | null> => {
    if (!isHtmlFile(file)) {
      window.alert(
        "To nie jest zapisana strona internetowa. Wybierz plik .html " +
          "(Ctrl+S w przeglądarce → „Strona sieci Web, kompletna”)."
      );
      return null;
    }
    setImportBusy(true);
    try {
      const res = await warehouseApi.parseShopPage(file);
      const data = res.data ?? null;
      if (!data) return null;
      if (data.parsed.name === null) {
        window.alert(NOT_A_PRODUCT_PAGE);
        return null;
      }
      return data;
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Nie udało się odczytać strony sklepu"
      );
      return null;
    } finally {
      setImportBusy(false);
    }
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    const data = await parseFile(file);
    if (data) setImported(data);
  };

  /**
   * Odświeżenie jednego źródła nowym zrzutem strony. Świadomie NIE otwiera
   * panelu przeglądu: tu chodzi o cenę i stan tego samego produktu, a nie
   * o ponowne wypełnianie kartoteki.
   */
  const handleRefreshFile = async (shop: string, file: File | undefined) => {
    if (!file) return;
    const data = await parseFile(file);
    if (!data) return;
    const parsedShop = data.parsed.shop || shopFromUrl(data.parsed.url ?? "");
    if (parsedShop !== shop) {
      window.alert(
        `Ten plik pochodzi ze sklepu „${parsedShop || "nierozpoznanego"}”, ` +
          `a odświeżasz źródło „${shop}”. Wczytaj stronę z właściwego sklepu ` +
          "albo dodaj drugie źródło przyciskiem „Wczytaj ze sklepu”."
      );
      return;
    }
    const s = data.suggestedSource;
    setRows((prev) =>
      prev.map((r) =>
        r.input.shop === shop
          ? {
              ...r,
              input: {
                ...r.input,
                shopLabel: s.shopLabel ?? r.input.shopLabel,
                productUrl: s.productUrl ?? r.input.productUrl,
                supplierCode: s.supplierCode ?? r.input.supplierCode,
                supplierProductId: s.supplierProductId ?? r.input.supplierProductId,
                lastPriceNet: s.lastPriceNet,
                lastPriceGross: s.lastPriceGross,
                vatRate: s.vatRate,
                currency: s.currency ?? r.input.currency,
                lastStock: s.lastStock,
                loggedIn: s.loggedIn,
                raw: s.raw,
                // Brak `fetchedAt` = backend stempluje „teraz”, czyli dokładnie
                // moment odczytu strony, którą właśnie wczytaliśmy.
                fetchedAt: undefined,
              },
            }
          : r
      )
    );
    setSourcesDirty(true);
    const net = data.suggestedItem.purchasePrice;
    if (
      net !== null &&
      String(net) !== form.purchasePrice.trim() &&
      window.confirm(
        `Cena w sklepie to ${fmtPln(net)} netto. Przepisać ją też do ceny zakupu towaru?`
      )
    ) {
      setForm((p) => ({ ...p, purchasePrice: String(net) }));
    }
  };

  /** Zatwierdzenie panelu importu — wpisujemy zaznaczone pola do formularza. */
  const applyImport = (applied: ShopImportApplied) => {
    const v = applied.values;
    setForm((p) => {
      const next = { ...p };
      if (v.name !== undefined) next.name = v.name;
      if (v.category !== undefined) next.category = v.category;
      if (v.manufacturer !== undefined) next.manufacturer = v.manufacturer;
      if (v.manufacturerCode !== undefined) next.manufacturerCode = v.manufacturerCode;
      if (v.barcode !== undefined) next.barcode = v.barcode;
      if (v.purchasePrice !== undefined) next.purchasePrice = v.purchasePrice;
      if (v.description !== undefined) next.description = v.description;
      if (applied.descriptionAppend) {
        next.description = [next.description.trim(), applied.descriptionAppend]
          .filter(Boolean)
          .join("\n\n");
      }
      return next;
    });
    if (v.unit) {
      if (COMMON_UNITS.includes(v.unit)) {
        setUnitChoice(v.unit);
        setCustomUnit("");
      } else {
        setUnitChoice(CUSTOM_UNIT);
        setCustomUnit(v.unit);
      }
    }
    if (applied.photoData !== undefined) {
      setPhotoData(applied.photoData);
      setPhotoDirty(true);
    }
    // Źródło wchodzi po kluczu `shop` — ten sam sklep dwa razy to odświeżenie
    // wiersza, nie drugi wiersz (tak samo jak UNIQUE (item_id, shop) w bazie).
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.input.shop === applied.source.shop);
      if (idx === -1) return [...prev, { input: applied.source }];
      const next = [...prev];
      next[idx] = { ...next[idx], input: applied.source };
      return next;
    });
    setSourcesDirty(true);
    setImported(null);
  };

  const removeSource = (shop: string) => {
    if (
      !window.confirm(
        `Usunąć źródło „${shop}”? Zniknie po zapisaniu towaru — historii ruchów to nie dotyka.`
      )
    )
      return;
    setRows((prev) => prev.filter((r) => r.input.shop !== shop));
    setSourcesDirty(true);
  };

  /* ------------------------------ zapis ------------------------------ */

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
        manufacturerCode: form.manufacturerCode.trim() || undefined,
        barcode: form.barcode.trim() || undefined,
        // Pusty string leci jako null: „wyczyść cenę zakupu" i „wróć do ceny
        // z narzutu" to świadome decyzje, a nie brak zmiany.
        purchasePrice: form.purchasePrice.trim() || null,
        salePrice: form.salePrice.trim() || null,
        minStock: form.minStock.trim() ? Number(form.minStock) : null,
        isAsset: form.isAsset,
        description: form.description.trim() || undefined,
        // `undefined` = zostaw zdjęcie/źródła w bazie w spokoju. Wysyłamy je
        // TYLKO wtedy, gdy ktoś ich w tym oknie dotknął (albo zakładamy towar).
        photoData: photoDirty || !item ? photoData : undefined,
        sources:
          sourcesDirty || !item ? rows.map((r) => r.input) : undefined,
      });
      onClose();
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu towaru");
    } finally {
      setLoading(false);
    }
  };

  /** Migawka pól do kolumny „Obecnie” w panelu importu. */
  const snapshot: ShopImportSnapshot = {
    name: form.name,
    category: form.category,
    manufacturer: form.manufacturer,
    manufacturerCode: form.manufacturerCode,
    barcode: form.barcode,
    unit,
    purchasePrice: form.purchasePrice,
    description: form.description,
  };

  /* --- Drag & drop zapisanej strony na całe okno dialogu --- */
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      setRefreshShop(null);
      handleImportFile(file);
    }
  };

  const importButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={importBusy}
      onClick={() => {
        setRefreshShop(null);
        importInputRef.current?.click();
      }}
      data-testid="wi-import-shop"
    >
      <ShoppingCart className="mr-1 h-4 w-4" />
      {importBusy ? "Czytanie strony…" : "Wczytaj ze sklepu"}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className={cn(
          "sm:max-w-lg max-h-[90vh] overflow-y-auto",
          imported && "sm:max-w-3xl",
          dragActive && "ring-2 ring-primary ring-offset-2"
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={() => setDragActive(false)}
        onDrop={onDrop}
      >
        {/* Ukryte inputy plików — jeden dla importu, drugi dla „Odśwież z pliku”,
            żeby wybór pliku nie mieszał się między dwoma znaczeniami. */}
        <input
          ref={importInputRef}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(e) => {
            handleImportFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
        <input
          ref={refreshInputRef}
          type="file"
          accept=".html,.htm,text/html"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (refreshShop) handleRefreshFile(refreshShop, file);
          }}
        />

        <DialogHeader>
          <div className="flex flex-wrap items-center justify-between gap-2 pr-6">
            <DialogTitle>
              {imported
                ? "Import ze sklepu"
                : item
                  ? "Edytuj towar"
                  : "Nowy towar"}
            </DialogTitle>
            {!imported && importButton}
          </div>
        </DialogHeader>

        {imported ? (
          <ShopImportPanel
            result={imported}
            mode={item ? "edit" : "new"}
            current={snapshot}
            hasPhoto={photoData !== null || item?.hasPhoto === true}
            onApply={applyImport}
            onCancel={() => setImported(null)}
            onOpenExisting={onOpenExisting}
          />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {dragActive && (
              <p className="rounded-md border border-dashed border-primary bg-primary/5 p-2 text-center text-xs text-muted-foreground">
                Upuść zapisaną stronę produktu (.html), żeby wypełnić formularz
              </p>
            )}
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
              {/* Symbol producenta obok kodu kreskowego, bo to dwa kody tego
                  samego towaru — a MPN jest kluczem dopasowania przy imporcie
                  ze sklepu (jeden towar, kilka sklepów, jeden symbol). */}
              <div className="space-y-2">
                <Label htmlFor="wi-manufacturer-code">Symbol producenta</Label>
                <Input
                  id="wi-manufacturer-code"
                  data-testid="wi-manufacturer-code"
                  value={form.manufacturerCode}
                  onChange={(e) =>
                    setForm((p) => ({ ...p, manufacturerCode: e.target.value }))
                  }
                  placeholder="np. TC-C320N"
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
                  <span
                    className="cursor-help underline decoration-dotted"
                    {...tip(MARGIN_HELP)}
                  >
                    Marża:
                  </span>{" "}
                  <strong className="text-foreground tabular-nums">
                    {fmtPct(preview.margin?.marginPct)}
                  </strong>
                </span>
                <span className="text-muted-foreground">
                  <span
                    className="cursor-help underline decoration-dotted"
                    {...tip(MARKUP_HELP)}
                  >
                    Narzut:
                  </span>{" "}
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

            {/* --- Źródła: sklepy, w których ten towar kupujemy --- */}
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <Label>Źródła (sklepy dostawców)</Label>
                {rows.length > 0 && importButton}
              </div>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Brak źródeł. „Wczytaj ze sklepu” przyjmuje zapisaną stronę
                  produktu (Ctrl+S → „Strona sieci Web, kompletna”) i zapamiętuje
                  sklep, kod u dostawcy oraz cenę — dzięki temu następnym razem
                  wystarczy odświeżyć.
                </p>
              ) : (
                <ul className="divide-y rounded-md border" data-testid="wi-sources">
                  {rows.map((r) => {
                    const s = r.input;
                    const net =
                      typeof s.lastPriceNet === "string"
                        ? parseMoney(s.lastPriceNet)
                        : (s.lastPriceNet ?? null);
                    const gross =
                      typeof s.lastPriceGross === "string"
                        ? parseMoney(s.lastPriceGross)
                        : (s.lastPriceGross ?? null);
                    return (
                      <li key={s.shop} className="space-y-1 p-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">
                            {s.shopLabel || s.shop}
                          </span>
                          {s.productUrl && (
                            <a
                              href={s.productUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
                            >
                              <ExternalLink className="h-3 w-3" /> strona produktu
                            </a>
                          )}
                          {!s.loggedIn && (
                            <span
                              className={pillClass("amber", { compact: true })}
                              {...tip(
                                "Strona zapisana bez logowania — cena może być detaliczna albo w ogóle niewidoczna."
                              )}
                            >
                              <Lock className="h-3 w-3" /> bez logowania
                            </span>
                          )}
                          <span className="ml-auto flex items-center gap-1">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                              onClick={() => {
                                setRefreshShop(s.shop);
                                refreshInputRef.current?.click();
                              }}
                            >
                              <RefreshCw className="h-3 w-3" /> Odśwież z pliku
                            </button>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 text-muted-foreground hover:text-destructive"
                              onClick={() => removeSource(s.shop)}
                            >
                              <X className="h-3 w-3" /> Usuń
                            </button>
                          </span>
                        </div>
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-muted-foreground">
                          {s.supplierCode && <span>kod: {s.supplierCode}</span>}
                          <span className="tabular-nums">
                            netto {fmtPlnOrDash(net)} / brutto {fmtPlnOrDash(gross)}
                          </span>
                          {s.lastStock != null && (
                            <span>stan: {fmtQty(s.lastStock)}</span>
                          )}
                          <span {...tip(fmtTimestamp(s.fetchedAt))}>
                            odczyt: {fmtRelative(s.fetchedAt)}
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
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
                      onClick={() => {
                        setPhotoData(null);
                        setPhotoDirty(true);
                      }}
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
                <span {...tip(fmtTimestamp(item.createdAt))}>
                  {fmtRelative(item.createdAt)}
                </span>
                {item.updatedAt !== item.createdAt && (
                  <>
                    {" · "}Zmienił {item.updatedByLabel || "—"},{" "}
                    <span {...tip(fmtTimestamp(item.updatedAt))}>
                      {fmtRelative(item.updatedAt)}
                    </span>
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
              <Button type="submit" disabled={loading || photoBusy || importBusy}>
                {loading ? "Zapisywanie…" : item ? "Zapisz zmiany" : "Dodaj"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
