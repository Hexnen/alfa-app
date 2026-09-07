import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  ChevronsUpDown,
  History,
  ImageOff,
  PackageMinus,
  PackagePlus,
  Pencil,
  Plus,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  warehouseApi,
  type StockEntry,
  type WarehouseDef,
  type WarehouseDefInput,
  type WarehouseDocStatus,
  type WarehouseDocType,
  type WarehouseDocument,
  type WarehouseDocumentInput,
  type WarehouseItem,
  type WarehouseItemInput,
} from "@/lib/api";
import {
  WarehouseDocumentForm,
  type DocumentFormMode,
} from "@/components/warehouse/WarehouseDocumentForm";
import { WarehouseDocumentDetails } from "@/components/warehouse/WarehouseDocumentDetails";
import { WarehouseItemForm } from "@/components/warehouse/WarehouseItemForm";
import { WarehouseForm } from "@/components/warehouse/WarehouseForm";
import { WarehouseMovementsDialog } from "@/components/warehouse/WarehouseMovementsDialog";
import {
  DOC_STATUS_META,
  DOC_TYPE_META,
  WAREHOUSE_TYPE_META,
  fmtDate,
  fmtPct,
  fmtPln,
  fmtPlnOrDash,
  fmtQty,
  totalStockFor,
  warehouseLabel,
} from "@/components/warehouse/warehouseShared";
import { fmtRelative, fmtTimestamp, pillClass } from "@/lib/calendar-labels";
import { isPriceStale, priceAgeLabel } from "@/lib/price-age";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

/** Kolumny, po których da się sortować tabelę stanów magazynowych. */
type StockSortKey = "name" | "category" | "total" | "value" | "warehouses";

/** Kolumny, po których da się sortować listę dokumentów. */
type DocSortKey = "number" | "type" | "date" | "route" | "items" | "status";

/** Kolumny, po których da się sortować kartotekę towarów. */
type ItemSortKey =
  | "name"
  | "category"
  | "unit"
  | "purchase"
  | "sale"
  | "margin"
  | "minStock"
  | "created"
  | "updated";

/**
 * Domyślny kierunek sortowania kolumny — ilości, kwoty i daty ludzie czytają od
 * największej wartości (najwięcej / najdroższe / najnowsze u góry), teksty
 * alfabetycznie (jak w kartotece obiektów).
 */
const STOCK_DEFAULT_DIR: Record<StockSortKey, "asc" | "desc"> = {
  name: "asc",
  category: "asc",
  total: "desc",
  value: "desc",
  warehouses: "desc",
};

/**
 * Numer dokumentu koduje rok i miesiąc (PZ/2026/08/014), więc malejąco =
 * najnowsze u góry — tak samo jak przy sortowaniu po dacie wystawienia.
 */
const DOC_DEFAULT_DIR: Record<DocSortKey, "asc" | "desc"> = {
  number: "desc",
  type: "asc",
  date: "desc",
  route: "asc",
  items: "desc",
  status: "asc",
};

const ITEM_DEFAULT_DIR: Record<ItemSortKey, "asc" | "desc"> = {
  name: "asc",
  category: "asc",
  unit: "asc",
  purchase: "desc",
  sale: "desc",
  margin: "desc",
  minStock: "desc",
  created: "desc",
  updated: "desc",
};

/** Filtr stanu: wszystkie / tylko dostępne / tylko z zerowym stanem. */
type StockMode = "all" | "available" | "zero";

/** Filtr ceny sprzedaży: wszystkie / tylko wycenione / tylko bez ceny. */
type PriceMode = "all" | "with" | "without";

/** Filtr archiwum — zastępuje dawny przełącznik „Pokaż zarchiwizowane”. */
type StatusMode = "active" | "archived" | "all";

/** Świeżość daty dokumentu — jak filtr ostatniej zmiany w projektach monitoringu. */
type FreshMode = "all" | "7" | "30" | "90";

/** Wartość w selekcie oznaczająca „bez wpisanej wartości” (kategoria, producent). */
const NONE = "__none__";

/** Liczba z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data z bazy na liczbę do porównań; brak lub śmieć = wartość pusta (NULLS LAST). */
function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. Jeden
 * komponent obsługuje wszystkie tabele magazynu; `prefix` rozdziela
 * `data-testid` poszczególnych zakładek (stany / dokumenty / towary).
 */
function SortHeader<K extends string>({
  label,
  sortKey,
  sort,
  dir,
  onSort,
  prefix,
  align = "left",
  title,
}: {
  label: string;
  sortKey: K;
  sort: K;
  dir: "asc" | "desc";
  onSort: (key: K) => void;
  prefix: string;
  align?: "left" | "right";
  title?: string;
}) {
  const activeCol = sort === sortKey;
  const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      className={cn(
        "px-3 py-2 font-medium",
        align === "right" ? "text-right" : "text-left"
      )}
    >
      <button
        type="button"
        data-testid={`${prefix}-sort-${sortKey}`}
        onClick={() => onSort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        title={title}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          activeCol ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !activeCol && "opacity-40")} />
      </button>
    </th>
  );
}

export function Warehouse() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/magazyn");

  // --- Dane podstawowe (towary, magazyny, stany) ---
  const [items, setItems] = useState<WarehouseItem[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseDef[]>([]);
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [loading, setLoading] = useState(true);
  // Narzut firmowy — formularz liczy z niego cenę sprzedaży na żywo. Lista bierze
  // gotowe wartości z backendu, więc tutaj potrzebny jest tylko do podglądu.
  const [warehouseMarkup, setWarehouseMarkup] = useState(0);

  const loadCore = useCallback(async () => {
    try {
      const [itemsRes, whRes, stockRes, cfgRes] = await Promise.all([
        warehouseApi.getItems(true),
        warehouseApi.getWarehouses(),
        warehouseApi.getStock(),
        warehouseApi.getPricingConfig(),
      ]);
      setItems(itemsRes.data || []);
      setWarehouses(whRes.data || []);
      setStock(stockRes.data || []);
      setWarehouseMarkup(cfgRes.data?.warehouseMarkup ?? 0);
    } catch (err) {
      alertError(err, "Błąd wczytywania danych magazynu");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCore();
  }, [loadCore]);

  // --- Dokumenty ---
  const [documents, setDocuments] = useState<WarehouseDocument[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  /*
   * Typ i status zostają parametrami zapytania (backend tnie listę do 500
   * pozycji, więc filtrowanie ich po stronie serwera pokazuje pełną historię
   * wybranego typu). Reszta filtrów i całe sortowanie liczą się po stronie
   * klienta — bez debounce'u, bo nie ma żądania do odciążenia.
   */
  const [docTypeFilter, setDocTypeFilter] = useState("all");
  const [docStatusFilter, setDocStatusFilter] = useState("all");

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const res = await warehouseApi.getDocuments({
        type: docTypeFilter === "all" ? undefined : docTypeFilter,
        status: docStatusFilter === "all" ? undefined : docStatusFilter,
      });
      setDocuments(res.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania dokumentów");
    } finally {
      setDocsLoading(false);
    }
  }, [docTypeFilter, docStatusFilter]);

  useEffect(() => {
    loadDocuments();
  }, [loadDocuments]);

  const loadStock = useCallback(async () => {
    try {
      const res = await warehouseApi.getStock();
      setStock(res.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania stanów magazynowych");
    }
  }, []);

  /**
   * Po mutacjach dokumentów odświeżamy tylko stany i listę dokumentów —
   * items (ze zdjęciami base64) i warehouses nie zmieniają się przy
   * operacjach dokumentowych, więc nie ściągamy ich bez potrzeby.
   */
  const refreshDocsAndStock = useCallback(async () => {
    await Promise.all([loadStock(), loadDocuments()]);
  }, [loadStock, loadDocuments]);

  // --- Karty wewnętrzne ---
  const [tab, setTab] = useState("stany");

  // --- Zakładka Stany: filtry i sortowanie ---
  const [stockSearch, setStockSearch] = useState("");
  const [stockCategory, setStockCategory] = useState("all");
  const [stockWarehouse, setStockWarehouse] = useState("all");
  const [stockMode, setStockMode] = useState<StockMode>("all");
  const [stockQtyMin, setStockQtyMin] = useState("");
  const [stockQtyMax, setStockQtyMax] = useState("");
  const [stockValueMin, setStockValueMin] = useState("");
  const [stockValueMax, setStockValueMax] = useState("");
  const [stockSort, setStockSort] = useState<StockSortKey>("name");
  const [stockDir, setStockDir] = useState<"asc" | "desc">("asc");

  // --- Zakładka Dokumenty: filtry client-side i sortowanie ---
  const [docSearch, setDocSearch] = useState("");
  const [docWarehouseFilter, setDocWarehouseFilter] = useState("all");
  const [docFreshMode, setDocFreshMode] = useState<FreshMode>("all");
  const [docItemsMin, setDocItemsMin] = useState("");
  const [docItemsMax, setDocItemsMax] = useState("");
  // Domyślnie po dacie malejąco — dokładnie ta kolejność, w której listę
  // zwraca backend, więc wejście na zakładkę niczego nie przestawia.
  const [docSort, setDocSort] = useState<DocSortKey>("date");
  const [docDir, setDocDir] = useState<"asc" | "desc">("desc");

  // --- Zakładka Towary ---
  const [itemSearch, setItemSearch] = useState("");
  const [itemCategory, setItemCategory] = useState("all");
  const [itemManufacturer, setItemManufacturer] = useState("all");
  const [itemUnit, setItemUnit] = useState("all");
  const [itemStatus, setItemStatus] = useState<StatusMode>("active");
  const [itemPriceMode, setItemPriceMode] = useState<PriceMode>("all");
  const [itemMin, setItemMin] = useState("");
  const [itemMax, setItemMax] = useState("");
  const [itemSort, setItemSort] = useState<ItemSortKey>("name");
  const [itemDir, setItemDir] = useState<"asc" | "desc">("asc");
  const [itemFormOpen, setItemFormOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<WarehouseItem | null>(null);

  // --- Zakładka Magazyny ---
  const [showArchivedWh, setShowArchivedWh] = useState(false);
  const [whFormOpen, setWhFormOpen] = useState(false);
  const [editingWh, setEditingWh] = useState<WarehouseDef | null>(null);

  // --- Formularz dokumentu ---
  const [docFormMode, setDocFormMode] = useState<DocumentFormMode | null>(null);
  const [docFormPrefill, setDocFormPrefill] = useState<number | null>(null);
  /** Szkic edytowany w formularzu (null = tworzenie nowego dokumentu). */
  const [editingDoc, setEditingDoc] = useState<WarehouseDocument | null>(null);
  const [docFormNonce, setDocFormNonce] = useState(0);

  const openDocForm = (mode: DocumentFormMode, prefillItemId?: number) => {
    setDocFormMode(mode);
    setDocFormPrefill(prefillItemId ?? null);
    setEditingDoc(null);
    setDocFormNonce((n) => n + 1);
  };

  /** Otwiera formularz w trybie edycji szkicu (tryb wyprowadzony z docType). */
  const openDocEdit = (doc: WarehouseDocument) => {
    const mode: DocumentFormMode =
      doc.docType === "PZ" ? "PZ" : doc.docType === "MM" ? "MM" : "issue";
    setDetailsDoc(null);
    setDocFormMode(mode);
    setDocFormPrefill(null);
    setEditingDoc(doc);
    setDocFormNonce((n) => n + 1);
  };

  const closeDocForm = () => {
    setDocFormMode(null);
    setEditingDoc(null);
  };

  // --- Dialog szczegółów dokumentu + historia ruchów ---
  const [detailsDoc, setDetailsDoc] = useState<WarehouseDocument | null>(null);
  const [historyItem, setHistoryItem] = useState<WarehouseItem | null>(null);

  const openDocumentDetails = async (doc: WarehouseDocument) => {
    try {
      const res = await warehouseApi.getDocument(doc.id);
      setDetailsDoc(res.data || doc);
    } catch (err) {
      alertError(err, "Błąd wczytywania dokumentu");
    }
  };

  // --- Handlery mutacji ---
  // Uwaga: try/finally — po błędzie (np. 409 przy wyścigu edycji) też
  // odświeżamy listę dokumentów i stany, a komunikat z API leci dalej
  // do window.alert w komponencie wywołującym.
  const handleDocumentSubmit = async (data: WarehouseDocumentInput) => {
    if (!editable) return;
    try {
      if (editingDoc) {
        // Jeden PUT z `confirm: true` = atomowe zapisz-i-zatwierdź (błąd
        // stanu → backend nie zapisuje nic, szkic zostaje nietknięty).
        await warehouseApi.updateDocument(editingDoc.id, data);
      } else {
        await warehouseApi.createDocument(data);
      }
    } finally {
      await refreshDocsAndStock();
    }
  };

  const handleDocumentConfirm = async (doc: WarehouseDocument) => {
    if (!editable) return;
    try {
      await warehouseApi.confirmDocument(doc.id);
      setDetailsDoc(null);
    } finally {
      await refreshDocsAndStock();
    }
  };

  const handleDocumentCancel = async (doc: WarehouseDocument) => {
    if (!editable) return;
    try {
      await warehouseApi.cancelDocument(doc.id);
      setDetailsDoc(null);
    } finally {
      await refreshDocsAndStock();
    }
  };

  const handleDocumentDelete = async (doc: WarehouseDocument) => {
    if (!editable) return;
    try {
      await warehouseApi.deleteDocument(doc.id);
      setDetailsDoc(null);
    } finally {
      await refreshDocsAndStock();
    }
  };

  const handleItemSubmit = async (data: WarehouseItemInput) => {
    if (!editable) return;
    if (editingItem) {
      await warehouseApi.updateItem(editingItem.id, data);
    } else {
      await warehouseApi.createItem(data);
    }
    await loadCore();
  };

  /** Tworzy towar inline z formularza dokumentu i zwraca go do wstawienia. */
  const handleInlineItemCreate = async (
    data: WarehouseItemInput
  ): Promise<WarehouseItem> => {
    const res = await warehouseApi.createItem(data);
    if (!res.data) throw new Error("Nie udało się utworzyć towaru");
    await loadCore();
    return res.data;
  };

  const handleItemArchive = async (item: WarehouseItem) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Zarchiwizować towar "${item.name}"? Zniknie z list wyboru, historia zostanie zachowana.`
      )
    )
      return;
    try {
      await warehouseApi.archiveItem(item.id);
      await loadCore();
    } catch (err) {
      alertError(err, "Błąd archiwizacji towaru");
    }
  };

  const handleItemRestore = async (item: WarehouseItem) => {
    if (!editable) return;
    try {
      // PUT wymaga pełnego body (walidacja parseItemBody) — odsyłamy bieżące
      // pola towaru, zmieniając wyłącznie flagę archiwum.
      await warehouseApi.updateItem(item.id, {
        name: item.name,
        unit: item.unit,
        sku: item.sku ?? undefined,
        category: item.category ?? undefined,
        description: item.description ?? undefined,
        minStock: item.minStock,
        isAsset: item.isAsset,
        barcode: item.barcode ?? undefined,
        photoData: item.photoData,
        isArchived: false,
      });
      await loadCore();
    } catch (err) {
      alertError(err, "Błąd przywracania towaru");
    }
  };

  const handleWarehouseSubmit = async (data: WarehouseDefInput) => {
    if (!editable) return;
    if (editingWh) {
      await warehouseApi.updateWarehouse(editingWh.id, data);
    } else {
      await warehouseApi.createWarehouse(data);
    }
    await loadCore();
  };

  const handleWarehouseArchive = async (wh: WarehouseDef) => {
    if (!editable) return;
    if (
      !window.confirm(
        `Zarchiwizować magazyn "${wh.name}"? Operacja możliwa tylko przy zerowym stanie.`
      )
    )
      return;
    try {
      await warehouseApi.archiveWarehouse(wh.id);
      await loadCore();
    } catch (err) {
      alertError(err, "Błąd archiwizacji magazynu");
    }
  };

  const handleWarehouseRestore = async (wh: WarehouseDef) => {
    if (!editable) return;
    try {
      // PUT wymaga pełnego body (walidacja parseWarehouseBody) — odsyłamy
      // bieżące pola magazynu (w tym niezmieniony parentId), zmieniając
      // wyłącznie flagę archiwum. Backend odrzuca restore pod zarchiwizowanym
      // rodzicem — komunikat po polsku trafia do alertu poniżej.
      await warehouseApi.updateWarehouse(wh.id, {
        name: wh.name,
        code: wh.code ?? undefined,
        type: wh.type,
        parentId: wh.parentId,
        isArchived: false,
      });
    } catch (err) {
      alertError(err, "Błąd przywracania magazynu");
    } finally {
      await loadCore();
    }
  };

  // --- Dane pochodne ---
  const categories = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((i) => (i.category || "").trim())
            .filter((c): c is string => c.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [items]
  );

  const manufacturers = useMemo(
    () =>
      Array.from(
        new Set(
          items
            .map((i) => (i.manufacturer || "").trim())
            .filter((m): m is string => m.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [items]
  );

  const activeWarehouses = useMemo(
    () => warehouses.filter((w) => !w.isArchived),
    [warehouses]
  );

  const visibleWarehouses = useMemo(
    () => warehouses.filter((w) => showArchivedWh || !w.isArchived),
    [warehouses, showArchivedWh]
  );

  const warehouseChipLabel = (warehouseId: number) => {
    const w = warehouses.find((x) => x.id === warehouseId);
    return w ? w.code || w.name : `#${warehouseId}`;
  };

  /** Jednostki do selecta — wolne pole tekstowe, więc listę budujemy z danych. */
  const units = useMemo(
    () =>
      Array.from(
        new Set(items.map((i) => i.unit.trim()).filter((u) => u !== ""))
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [items]
  );

  /** Trasa dokumentu („z → do”) — ta sama treść w tabeli i w sortowaniu. */
  const docRoute = useCallback(
    (doc: WarehouseDocument) => {
      const from = doc.warehouseFromId
        ? warehouseLabel(warehouses, doc.warehouseFromId, doc.warehouseFromName)
        : null;
      const to = doc.warehouseToId
        ? warehouseLabel(warehouses, doc.warehouseToId, doc.warehouseToName)
        : null;
      return [from, to].filter(Boolean).join(" → ");
    },
    [warehouses]
  );

  // ---------------------------- STANY: dane ----------------------------
  /** Jeden przebieg: filtry + sortowanie stanów magazynowych. */
  const stockRows = useMemo(() => {
    const q = stockSearch.trim().toLowerCase();
    const whId = stockWarehouse === "all" ? null : Number(stockWarehouse);
    const qtyMin = parseAmount(stockQtyMin);
    const qtyMax = parseAmount(stockQtyMax);
    const valMin = parseAmount(stockValueMin);
    const valMax = parseAmount(stockValueMax);

    const list = items
      .filter((i) => !i.isArchived)
      .map((item) => {
        const entries = stock.filter(
          (s) => s.itemId === item.id && s.quantity !== 0
        );
        const total = totalStockFor(stock, item.id);
        return {
          item,
          entries,
          total,
          // Wartość liczymy z ceny zakupu; bez ceny tabela pokazuje kreskę,
          // więc traktujemy ją jak wartość pustą (NULLS LAST).
          value: item.purchasePrice != null ? total * item.purchasePrice : null,
        };
      })
      .filter((row) => {
        const i = row.item;
        if (
          q &&
          ![i.name, i.sku, i.barcode].some((v) =>
            (v ?? "").toLowerCase().includes(q)
          )
        ) {
          return false;
        }
        if (stockCategory !== "all") {
          const cat = (i.category || "").trim();
          if (stockCategory === NONE ? cat !== "" : cat !== stockCategory)
            return false;
        }
        if (whId !== null && !row.entries.some((e) => e.warehouseId === whId))
          return false;
        // „Dostępne” = cokolwiek leży na półce; „zerowy stan” to towar z
        // kartoteki, którego nie ma nigdzie (typowy sygnał do zamówienia).
        if (stockMode === "available" && row.total <= 0) return false;
        if (stockMode === "zero" && row.total !== 0) return false;
        if (qtyMin !== undefined && row.total < qtyMin) return false;
        if (qtyMax !== undefined && row.total > qtyMax) return false;
        const value = row.value ?? 0;
        if (valMin !== undefined && value < valMin) return false;
        if (valMax !== undefined && value > valMax) return false;
        return true;
      });

    type Row = (typeof list)[number];
    const mul = stockDir === "asc" ? 1 : -1;
    const text = (r: Row) =>
      stockSort === "name" ? r.item.name : (r.item.category ?? "");
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (r: Row): number | null => {
      switch (stockSort) {
        case "total":
          // Zero to informacja („nie ma tego na stanie”), a nie brak danych.
          return r.total;
        case "value":
          return r.value;
        default:
          return r.entries.length;
      }
    };
    const numeric =
      stockSort === "total" ||
      stockSort === "value" ||
      stockSort === "warehouses";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po kategorii” zaczynałoby
    // się od towarów bez kategorii. Remis rozstrzyga nazwa, żeby kolejność
    // była stabilna.
    const compare = (a: Row, b: Row): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort(
      (a, b) => compare(a, b) || a.item.name.localeCompare(b.item.name, "pl")
    );
  }, [
    items,
    stock,
    stockSearch,
    stockCategory,
    stockWarehouse,
    stockMode,
    stockQtyMin,
    stockQtyMax,
    stockValueMin,
    stockValueMax,
    stockSort,
    stockDir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleStockSort = (key: StockSortKey) => {
    if (stockSort === key) {
      setStockDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setStockSort(key);
    setStockDir(STOCK_DEFAULT_DIR[key]);
  };

  const stockFiltersActive =
    stockSearch !== "" ||
    stockCategory !== "all" ||
    stockWarehouse !== "all" ||
    stockMode !== "all" ||
    stockQtyMin !== "" ||
    stockQtyMax !== "" ||
    stockValueMin !== "" ||
    stockValueMax !== "";

  const clearStockFilters = () => {
    setStockSearch("");
    setStockCategory("all");
    setStockWarehouse("all");
    setStockMode("all");
    setStockQtyMin("");
    setStockQtyMax("");
    setStockValueMin("");
    setStockValueMax("");
  };

  // -------------------------- DOKUMENTY: dane --------------------------
  /** Jeden przebieg: filtry + sortowanie listy dokumentów. */
  const visibleDocuments = useMemo(() => {
    const q = docSearch.trim().toLowerCase();
    const whId = docWarehouseFilter === "all" ? null : Number(docWarehouseFilter);
    const min = parseAmount(docItemsMin);
    const max = parseAmount(docItemsMax);
    const cutoff =
      docFreshMode === "all"
        ? null
        : Date.now() - parseInt(docFreshMode, 10) * 24 * 3600_000;

    const list = documents.filter((d) => {
      if (
        q &&
        ![d.docNumber, d.contractorName, d.invoiceNumber, docRoute(d)].some((v) =>
          (v ?? "").toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      // Typ i status idą też na backend — powtórzenie tutaj pilnuje, żeby po
      // zmianie selecta lista nie migała starym zestawem przed odpowiedzią.
      if (docTypeFilter !== "all" && d.docType !== docTypeFilter) return false;
      if (docStatusFilter !== "all" && d.status !== docStatusFilter) return false;
      if (
        whId !== null &&
        d.warehouseFromId !== whId &&
        d.warehouseToId !== whId
      ) {
        return false;
      }
      if (cutoff !== null) {
        const t = parseDate(d.issuedAt);
        if (t === null || t < cutoff) return false;
      }
      const count = d.itemCount ?? d.items?.length ?? 0;
      if (min !== undefined && count < min) return false;
      if (max !== undefined && count > max) return false;
      return true;
    });

    const mul = docDir === "asc" ? 1 : -1;
    const text = (d: WarehouseDocument) =>
      docSort === "number"
        ? // Szkic nie ma jeszcze numeru — pusty tekst, czyli koniec listy.
          (d.docNumber ?? "")
        : docSort === "type"
          ? d.docType
          : docSort === "status"
            ? DOC_STATUS_META[d.status].label
            : docRoute(d);
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (d: WarehouseDocument): number | null =>
      docSort === "date"
        ? parseDate(d.issuedAt)
        : (d.itemCount ?? d.items?.length ?? null);
    const numeric = docSort === "date" || docSort === "items";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po numerze” zaczynałoby się
    // od szkiców. Remis rozstrzyga numer, żeby kolejność była stabilna.
    const compare = (a: WarehouseDocument, b: WarehouseDocument): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort(
      (a, b) =>
        compare(a, b) ||
        (a.docNumber ?? "").localeCompare(b.docNumber ?? "", "pl") ||
        b.id - a.id
    );
  }, [
    documents,
    docSearch,
    docTypeFilter,
    docStatusFilter,
    docWarehouseFilter,
    docFreshMode,
    docItemsMin,
    docItemsMax,
    docSort,
    docDir,
    docRoute,
  ]);

  const toggleDocSort = (key: DocSortKey) => {
    if (docSort === key) {
      setDocDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setDocSort(key);
    setDocDir(DOC_DEFAULT_DIR[key]);
  };

  const docFiltersActive =
    docSearch !== "" ||
    docTypeFilter !== "all" ||
    docStatusFilter !== "all" ||
    docWarehouseFilter !== "all" ||
    docFreshMode !== "all" ||
    docItemsMin !== "" ||
    docItemsMax !== "";

  const clearDocFilters = () => {
    setDocSearch("");
    setDocTypeFilter("all");
    setDocStatusFilter("all");
    setDocWarehouseFilter("all");
    setDocFreshMode("all");
    setDocItemsMin("");
    setDocItemsMax("");
  };

  // ---------------------------- TOWARY: dane ---------------------------
  /** Jeden przebieg: filtry + sortowanie kartoteki towarów. */
  const visibleItems = useMemo(() => {
    const q = itemSearch.trim().toLowerCase();
    const min = parseAmount(itemMin);
    const max = parseAmount(itemMax);

    const list = items.filter((i) => {
      if (
        q &&
        ![i.name, i.sku, i.barcode, i.manufacturer, i.description].some((v) =>
          (v ?? "").toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      if (itemStatus === "active" && i.isArchived) return false;
      if (itemStatus === "archived" && !i.isArchived) return false;
      if (itemCategory !== "all") {
        const cat = (i.category || "").trim();
        if (itemCategory === NONE ? cat !== "" : cat !== itemCategory) return false;
      }
      if (itemManufacturer !== "all") {
        const man = (i.manufacturer || "").trim();
        if (itemManufacturer === NONE ? man !== "" : man !== itemManufacturer)
          return false;
      }
      if (itemUnit !== "all" && i.unit.trim() !== itemUnit) return false;
      // Cena sprzedaży 0 zł (albo jej brak) = towar jeszcze niewyceniony,
      // więc filtr „bez ceny” łapie i zero, i kreskę.
      const price = i.effectiveSalePrice ?? 0;
      if (itemPriceMode === "with" && price <= 0) return false;
      if (itemPriceMode === "without" && price > 0) return false;
      if (min !== undefined && price < min) return false;
      if (max !== undefined && price > max) return false;
      return true;
    });

    const mul = itemDir === "asc" ? 1 : -1;
    const text = (i: WarehouseItem) =>
      itemSort === "name"
        ? i.name
        : itemSort === "category"
          ? (i.category ?? "")
          : i.unit;
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (i: WarehouseItem): number | null => {
      switch (itemSort) {
        case "purchase":
          return i.purchasePrice;
        case "sale":
          return i.effectiveSalePrice;
        case "margin":
          return i.marginPct;
        case "minStock":
          return i.minStock;
        case "created":
          return parseDate(i.createdAt);
        default:
          // „Zmienił”: tabela pokazuje kreskę, dopóki nikt nie ruszył kartoteki
          // od utworzenia — traktujemy to jak brak wartości.
          return i.updatedAt && i.updatedAt !== i.createdAt
            ? parseDate(i.updatedAt)
            : null;
      }
    };
    const numeric =
      itemSort === "purchase" ||
      itemSort === "sale" ||
      itemSort === "margin" ||
      itemSort === "minStock" ||
      itemSort === "created" ||
      itemSort === "updated";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po cenie zakupu”
    // zaczynałoby się od towarów bez ceny. Remis rozstrzyga nazwa.
    const compare = (a: WarehouseItem, b: WarehouseItem): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        if (av === null || bv === null) {
          if (av === null && bv === null) return 0;
          return av !== null ? -1 : 1;
        }
        return (av - bv) * mul;
      }
      const as = text(a).trim();
      const bs = text(b).trim();
      if (!as || !bs) {
        if (!as && !bs) return 0;
        return as ? -1 : 1;
      }
      return as.localeCompare(bs, "pl") * mul;
    };

    return list.sort(
      (a, b) => compare(a, b) || a.name.localeCompare(b.name, "pl")
    );
  }, [
    items,
    itemSearch,
    itemCategory,
    itemManufacturer,
    itemUnit,
    itemStatus,
    itemPriceMode,
    itemMin,
    itemMax,
    itemSort,
    itemDir,
  ]);

  const toggleItemSort = (key: ItemSortKey) => {
    if (itemSort === key) {
      setItemDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setItemSort(key);
    setItemDir(ITEM_DEFAULT_DIR[key]);
  };

  const itemFiltersActive =
    itemSearch !== "" ||
    itemCategory !== "all" ||
    itemManufacturer !== "all" ||
    itemUnit !== "all" ||
    itemStatus !== "active" ||
    itemPriceMode !== "all" ||
    itemMin !== "" ||
    itemMax !== "";

  const clearItemFilters = () => {
    setItemSearch("");
    setItemCategory("all");
    setItemManufacturer("all");
    setItemUnit("all");
    setItemStatus("active");
    setItemPriceMode("all");
    setItemMin("");
    setItemMax("");
  };

  const photoThumb = (item: WarehouseItem) =>
    item.photoData ? (
      <img
        src={item.photoData}
        alt=""
        className="h-10 w-10 rounded-md border object-cover"
      />
    ) : (
      <div className="flex h-10 w-10 items-center justify-center rounded-md border bg-muted text-muted-foreground">
        <ImageOff className="h-4 w-4" />
      </div>
    );

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <Tabs value={tab} onValueChange={setTab}>
        {/* Zakładki i akcje główne dzielą jeden rząd */}
        <div className="flex flex-wrap items-center gap-3">
          <TabsList>
            <TabsTrigger value="stany">Stany</TabsTrigger>
            <TabsTrigger value="dokumenty">Dokumenty</TabsTrigger>
            <TabsTrigger value="towary">Towary</TabsTrigger>
            <TabsTrigger value="magazyny">Magazyny</TabsTrigger>
          </TabsList>
          {editable && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Button onClick={() => openDocForm("PZ")}>
                <PackagePlus className="mr-1 h-4 w-4" /> Przyjmij dostawę (PZ)
              </Button>
              <Button variant="outline" onClick={() => openDocForm("issue")}>
                <PackageMinus className="mr-1 h-4 w-4" /> Wydaj
              </Button>
              <Button variant="outline" onClick={() => openDocForm("MM")}>
                <ArrowLeftRight className="mr-1 h-4 w-4" /> Przesuń (MM)
              </Button>
            </div>
          )}
        </div>

        {/* ------------------------------ STANY ------------------------------ */}
        <TabsContent value="stany" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={stockSearch}
              onChange={(e) => setStockSearch(e.target.value)}
              placeholder="Szukaj: nazwa / SKU / kod kreskowy…"
              className="max-w-xs"
            />
            <Select value={stockCategory} onValueChange={setStockCategory}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-stany-filter-category"
              >
                <SelectValue placeholder="Kategoria" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie kategorie</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
                <SelectItem value={NONE}>Bez kategorii</SelectItem>
              </SelectContent>
            </Select>
            <Select value={stockWarehouse} onValueChange={setStockWarehouse}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-stany-filter-warehouse"
              >
                <SelectValue placeholder="Magazyn" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie magazyny</SelectItem>
                {activeWarehouses.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={stockMode}
              onValueChange={(v) => setStockMode(v as StockMode)}
            >
              <SelectTrigger
                className="w-[220px]"
                data-testid="magazyn-stany-filter-stock-mode"
              >
                <SelectValue placeholder="Stan" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Stan: wszystkie</SelectItem>
                <SelectItem value="available">Tylko dostępne</SelectItem>
                <SelectItem value="zero">Tylko z zerowym stanem</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Druga linia filtrów: widełki ilości na stanie i wartości zapasu. */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Stan od</span>
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                className="w-24 tabular-nums"
                data-testid="magazyn-stany-filter-qty-min"
                value={stockQtyMin}
                onChange={(e) => setStockQtyMin(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="decimal"
                className="w-24 tabular-nums"
                data-testid="magazyn-stany-filter-qty-max"
                value={stockQtyMax}
                onChange={(e) => setStockQtyMax(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Wartość od</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="magazyn-stany-filter-value-min"
                value={stockValueMin}
                onChange={(e) => setStockValueMin(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="magazyn-stany-filter-value-max"
                value={stockValueMax}
                onChange={(e) => setStockValueMax(e.target.value)}
              />
              <span>zł netto</span>
            </div>
            {stockFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearStockFilters}
                data-testid="magazyn-stany-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-14 px-3 py-2 font-medium"></th>
                      <SortHeader
                        label="Towar"
                        sortKey="name"
                        sort={stockSort}
                        dir={stockDir}
                        onSort={toggleStockSort}
                        prefix="magazyn-stany"
                      />
                      <SortHeader
                        label="Kategoria"
                        sortKey="category"
                        sort={stockSort}
                        dir={stockDir}
                        onSort={toggleStockSort}
                        prefix="magazyn-stany"
                        title="Towary bez kategorii idą na koniec"
                      />
                      <SortHeader
                        label="Stan łączny"
                        sortKey="total"
                        sort={stockSort}
                        dir={stockDir}
                        onSort={toggleStockSort}
                        prefix="magazyn-stany"
                        align="right"
                      />
                      <SortHeader
                        label="Wartość"
                        sortKey="value"
                        sort={stockSort}
                        dir={stockDir}
                        onSort={toggleStockSort}
                        prefix="magazyn-stany"
                        align="right"
                        title="Stan × cena zakupu; towary bez ceny idą na koniec"
                      />
                      <SortHeader
                        label="Wg magazynów"
                        sortKey="warehouses"
                        sort={stockSort}
                        dir={stockDir}
                        onSort={toggleStockSort}
                        prefix="magazyn-stany"
                        title="Sortowanie po liczbie magazynów, w których towar leży"
                      />
                      <th className="px-3 py-2 text-right font-medium">
                        Akcje
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : stockRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={7}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          {stockFiltersActive
                            ? "Brak towarów dla wybranych filtrów"
                            : "Kartoteka towarów jest pusta."}
                        </td>
                      </tr>
                    ) : (
                      stockRows.map(({ item, entries, total }) => {
                        const low =
                          item.minStock != null && total < item.minStock;
                        return (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="px-3 py-2">{photoThumb(item)}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{item.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {[item.sku, item.isAsset ? "sprzęt zwrotny" : null]
                                  .filter(Boolean)
                                  .join(" · ") || " "}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {item.category || "—"}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <span className="font-medium">
                                {fmtQty(total)} {item.unit}
                              </span>
                              {low && (
                                <span className={pillClass("red", { className: "ml-2" })}>
                                  niski stan
                                </span>
                              )}
                            </td>
                            <td
                              className="px-3 py-2 text-right tabular-nums"
                              title={
                                item.purchasePrice != null
                                  ? `${fmtQty(total)} × ${fmtPln(item.purchasePrice)} (cena zakupu)`
                                  : "Towar nie ma ceny zakupu — wartości nie da się policzyć"
                              }
                            >
                              {item.purchasePrice != null
                                ? fmtPln(total * item.purchasePrice)
                                : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {entries.length === 0 ? (
                                  <span className="text-xs text-muted-foreground">
                                    —
                                  </span>
                                ) : (
                                  entries.map((e) => (
                                    <span
                                      key={e.warehouseId}
                                      className={pillClass("muted", {
                                        className: "font-normal",
                                      })}
                                    >
                                      {warehouseChipLabel(e.warehouseId)}:{" "}
                                      {fmtQty(e.quantity)}
                                    </span>
                                  ))
                                )}
                              </div>
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex justify-end gap-1">
                                {editable && (
                                  <>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Wydaj (RW/WZ)"
                                      onClick={() =>
                                        openDocForm("issue", item.id)
                                      }
                                    >
                                      <PackageMinus className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Przesuń (MM)"
                                      onClick={() => openDocForm("MM", item.id)}
                                    >
                                      <ArrowLeftRight className="h-4 w-4" />
                                    </Button>
                                  </>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  title="Historia ruchów"
                                  onClick={() => setHistoryItem(item)}
                                >
                                  <History className="h-4 w-4" />
                                </Button>
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- DOKUMENTY ---------------------------- */}
        <TabsContent value="dokumenty" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={docSearch}
              onChange={(e) => setDocSearch(e.target.value)}
              placeholder="Szukaj: numer / kontrahent / faktura…"
              className="max-w-xs"
            />
            <Select value={docTypeFilter} onValueChange={setDocTypeFilter}>
              <SelectTrigger
                className="w-[210px]"
                data-testid="magazyn-dokumenty-filter-type"
              >
                <SelectValue placeholder="Typ" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie typy</SelectItem>
                {(Object.keys(DOC_TYPE_META) as WarehouseDocType[]).map((t) => (
                  <SelectItem key={t} value={t}>
                    {DOC_TYPE_META[t].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={docStatusFilter} onValueChange={setDocStatusFilter}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-dokumenty-filter-status"
              >
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie statusy</SelectItem>
                {(Object.keys(DOC_STATUS_META) as WarehouseDocStatus[]).map(
                  (s) => (
                    <SelectItem key={s} value={s}>
                      {DOC_STATUS_META[s].label}
                    </SelectItem>
                  )
                )}
              </SelectContent>
            </Select>
            {/* Magazyn łapie dokument z obu stron trasy — i wydania z niego,
                i przyjęcia do niego. */}
            <Select
              value={docWarehouseFilter}
              onValueChange={setDocWarehouseFilter}
            >
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-dokumenty-filter-warehouse"
              >
                <SelectValue placeholder="Magazyn" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie magazyny</SelectItem>
                {activeWarehouses.map((w) => (
                  <SelectItem key={w.id} value={String(w.id)}>
                    {w.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Druga linia filtrów: świeżość daty wystawienia i widełki pozycji. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={docFreshMode}
              onValueChange={(v) => setDocFreshMode(v as FreshMode)}
            >
              <SelectTrigger
                className="w-[200px]"
                data-testid="magazyn-dokumenty-filter-issued"
              >
                <SelectValue placeholder="Data wystawienia" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Data: kiedykolwiek</SelectItem>
                <SelectItem value="7">Ostatnie 7 dni</SelectItem>
                <SelectItem value="30">Ostatnie 30 dni</SelectItem>
                <SelectItem value="90">Ostatnie 90 dni</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Pozycji od</span>
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="w-24 tabular-nums"
                data-testid="magazyn-dokumenty-filter-min"
                value={docItemsMin}
                onChange={(e) => setDocItemsMin(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="1"
                inputMode="numeric"
                className="w-24 tabular-nums"
                data-testid="magazyn-dokumenty-filter-max"
                value={docItemsMax}
                onChange={(e) => setDocItemsMax(e.target.value)}
              />
            </div>
            {docFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearDocFilters}
                data-testid="magazyn-dokumenty-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <SortHeader
                        label="Numer"
                        sortKey="number"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                        title="Numer koduje rok i miesiąc, więc malejąco = najnowsze u góry; szkice bez numeru idą na koniec"
                      />
                      <SortHeader
                        label="Typ"
                        sortKey="type"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                      />
                      <SortHeader
                        label="Data"
                        sortKey="date"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                      />
                      <SortHeader
                        label="Magazyny / kontrahent"
                        sortKey="route"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                        title="Sortowanie po trasie dokumentu (z → do)"
                      />
                      <SortHeader
                        label="Pozycje"
                        sortKey="items"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                        align="right"
                      />
                      <SortHeader
                        label="Status"
                        sortKey="status"
                        sort={docSort}
                        dir={docDir}
                        onSort={toggleDocSort}
                        prefix="magazyn-dokumenty"
                      />
                    </tr>
                  </thead>
                  <tbody>
                    {docsLoading ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visibleDocuments.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          {docFiltersActive
                            ? "Brak dokumentów dla wybranych filtrów"
                            : "Brak dokumentów."}
                        </td>
                      </tr>
                    ) : (
                      visibleDocuments.map((doc) => {
                        const typeMeta = DOC_TYPE_META[doc.docType];
                        const statusMeta = DOC_STATUS_META[doc.status];
                        const route = docRoute(doc) || "—";
                        return (
                          <tr
                            key={doc.id}
                            className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                            onClick={() => openDocumentDetails(doc)}
                          >
                            <td className="px-3 py-2 font-medium">
                              {doc.docNumber || (
                                <span className={pillClass("neutral")}>szkic</span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={pillClass(typeMeta.tone)}
                              >
                                {doc.docType}
                              </span>
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {fmtDate(doc.issuedAt)}
                            </td>
                            <td className="px-3 py-2">
                              <div>{route}</div>
                              {doc.contractorName && (
                                <div className="text-xs text-muted-foreground">
                                  {doc.contractorName}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {doc.itemCount ?? doc.items?.length ?? "—"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={pillClass(statusMeta.tone)}
                              >
                                {statusMeta.label}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------ TOWARY ----------------------------- */}
        <TabsContent value="towary" className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={itemSearch}
              onChange={(e) => setItemSearch(e.target.value)}
              placeholder="Szukaj: nazwa / SKU / producent / opis…"
              className="max-w-xs"
            />
            <Select value={itemCategory} onValueChange={setItemCategory}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-towary-filter-category"
              >
                <SelectValue placeholder="Kategoria" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie kategorie</SelectItem>
                {categories.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
                <SelectItem value={NONE}>Bez kategorii</SelectItem>
              </SelectContent>
            </Select>
            <Select value={itemManufacturer} onValueChange={setItemManufacturer}>
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-towary-filter-manufacturer"
              >
                <SelectValue placeholder="Producent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszyscy producenci</SelectItem>
                {manufacturers.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
                <SelectItem value={NONE}>Bez producenta</SelectItem>
              </SelectContent>
            </Select>
            {/* Jednostki biorą się z tego, co ktoś wpisał w kartotece — to pole
                tekstowe z podpowiedziami, a nie zamknięty słownik. */}
            <Select value={itemUnit} onValueChange={setItemUnit}>
              <SelectTrigger
                className="w-[150px]"
                data-testid="magazyn-towary-filter-unit"
              >
                <SelectValue placeholder="Jednostka" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Wszystkie jednostki</SelectItem>
                {units.map((u) => (
                  <SelectItem key={u} value={u}>
                    {u}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={itemStatus}
              onValueChange={(v) => setItemStatus(v as StatusMode)}
            >
              <SelectTrigger
                className="w-[190px]"
                data-testid="magazyn-towary-filter-status"
              >
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Tylko aktualne</SelectItem>
                <SelectItem value="archived">Tylko zarchiwizowane</SelectItem>
                <SelectItem value="all">Aktualne i archiwum</SelectItem>
              </SelectContent>
            </Select>
            {editable && (
              <Button
                className="ml-auto"
                onClick={() => {
                  setEditingItem(null);
                  setItemFormOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy towar
              </Button>
            )}
          </div>

          {/* Druga linia filtrów: cena sprzedaży — tryb i widełki kwot. */}
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={itemPriceMode}
              onValueChange={(v) => setItemPriceMode(v as PriceMode)}
            >
              <SelectTrigger
                className="w-[200px]"
                data-testid="magazyn-towary-filter-price-mode"
              >
                <SelectValue placeholder="Cena" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Cena: wszystkie</SelectItem>
                <SelectItem value="with">Tylko wycenione</SelectItem>
                <SelectItem value="without">Tylko bez ceny</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>Cena od</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="magazyn-towary-filter-min"
                value={itemMin}
                onChange={(e) => setItemMin(e.target.value)}
              />
              <span>do</span>
              <Input
                type="number"
                min="0"
                step="50"
                inputMode="decimal"
                className="w-28 tabular-nums"
                data-testid="magazyn-towary-filter-max"
                value={itemMax}
                onChange={(e) => setItemMax(e.target.value)}
              />
              <span>zł netto</span>
            </div>
            {itemFiltersActive && (
              <Button
                variant="ghost"
                size="sm"
                onClick={clearItemFilters}
                data-testid="magazyn-towary-filters-clear"
              >
                <X className="mr-1 h-4 w-4" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-14 px-3 py-2 font-medium"></th>
                      <SortHeader
                        label="Nazwa"
                        sortKey="name"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                      />
                      <SortHeader
                        label="Kategoria"
                        sortKey="category"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        title="Towary bez kategorii idą na koniec"
                      />
                      <SortHeader
                        label="Jedn."
                        sortKey="unit"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                      />
                      <SortHeader
                        label="Zakup"
                        sortKey="purchase"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        align="right"
                        title="Towary bez ceny zakupu idą na koniec"
                      />
                      <SortHeader
                        label="Sprzedaż"
                        sortKey="sale"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        align="right"
                      />
                      <SortHeader
                        label="Marża / narzut"
                        sortKey="margin"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        align="right"
                        title="Sortowanie po marży procentowej; towary bez policzonej marży idą na koniec"
                      />
                      <SortHeader
                        label="Min. stan"
                        sortKey="minStock"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        align="right"
                        title="Towary bez progu minimalnego idą na koniec"
                      />
                      <th className="px-3 py-2 font-medium">Oznaczenia</th>
                      <SortHeader
                        label="Utworzył"
                        sortKey="created"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                      />
                      <SortHeader
                        label="Zmienił"
                        sortKey="updated"
                        sort={itemSort}
                        dir={itemDir}
                        onSort={toggleItemSort}
                        prefix="magazyn-towary"
                        title="Kartoteki nieruszane od utworzenia idą na koniec"
                      />
                      {editable && (
                        <th className="px-3 py-2 text-right font-medium">
                          Akcje
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={editable ? 12 : 11}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visibleItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 12 : 11}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          {itemFiltersActive
                            ? "Brak towarów dla wybranych filtrów"
                            : "Kartoteka towarów jest pusta."}
                        </td>
                      </tr>
                    ) : (
                      visibleItems.map((item) => {
                        /* Towar bez żadnej ceny NIE jest przeterminowany: brak
                           kwoty to nie jest stara kwota, nie ma czego pilnować
                           ani czym straszyć. Alarm zapalamy dopiero wtedy, gdy
                           cena istnieje, a stempel `priceUpdatedAt` mówi, że
                           nikt jej nie potwierdzał od pół roku (lub go nie ma —
                           to reguła z lib/price-age.ts). */
                        const hasPrice =
                          item.purchasePrice !== null ||
                          item.effectiveSalePrice !== null;
                        const priceStale =
                          hasPrice && isPriceStale(item.priceUpdatedAt, "warehouse");
                        const priceTip = priceStale
                          ? tip(priceAgeLabel(item.priceUpdatedAt, "warehouse"))
                          : null;
                        // Czerwień tylko na komórce, która faktycznie pokazuje
                        // kwotę — kreska „brak ceny" nie ma się co czerwienić.
                        const staleCell = (value: number | null) =>
                          priceStale && value !== null
                            ? "font-medium text-red-600"
                            : "";
                        return (
                          <tr
                            key={item.id}
                            className={`border-b last:border-0 ${
                              item.isArchived ? "opacity-60" : ""
                            }`}
                          >
                            <td className="px-3 py-2">{photoThumb(item)}</td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{item.name}</div>
                              {(item.sku || item.manufacturer) && (
                                <div className="text-xs text-muted-foreground">
                                  {[item.manufacturer, item.sku]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </div>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {item.category || "—"}
                            </td>
                            <td className="px-3 py-2">{item.unit}</td>
                            <td
                              className={`px-3 py-2 text-right tabular-nums ${staleCell(
                                item.purchasePrice
                              )}`}
                            >
                              {priceStale && item.purchasePrice !== null ? (
                                <span
                                  className="inline-flex items-center gap-1"
                                  {...priceTip}
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  {fmtPlnOrDash(item.purchasePrice)}
                                </span>
                              ) : (
                                fmtPlnOrDash(item.purchasePrice)
                              )}
                            </td>
                            {/* nowrap: z ikoną ostrzeżenia kwota i plakietka
                                „auto" przestają się mieścić w jednej linii
                                i komórka rozjeżdża się na dwa wiersze. */}
                            <td
                              className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${staleCell(
                                item.effectiveSalePrice
                              )}`}
                            >
                              {priceStale && item.effectiveSalePrice !== null ? (
                                <span
                                  className="inline-flex items-center gap-1"
                                  {...priceTip}
                                >
                                  <AlertTriangle className="h-3 w-3" />
                                  {fmtPlnOrDash(item.effectiveSalePrice)}
                                </span>
                              ) : (
                                fmtPlnOrDash(item.effectiveSalePrice)
                              )}
                              {item.salePriceAuto &&
                                item.effectiveSalePrice !== null && (
                                  <span
                                    className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground"
                                    title={`Liczona z narzutu ${warehouseMarkup}% — towar nie ma własnej ceny`}
                                  >
                                    auto
                                  </span>
                                )}
                            </td>
                            <td
                              className="px-3 py-2 text-right tabular-nums"
                              title={
                                item.marginAmount !== null
                                  ? `Zysk ${fmtPln(item.marginAmount)} na ${item.unit}`
                                  : "Brak ceny zakupu — marży nie da się policzyć"
                              }
                            >
                              {item.marginPct !== null ? (
                                <>
                                  {fmtPct(item.marginPct)}
                                  <span className="text-muted-foreground">
                                    {" / "}
                                    {fmtPct(item.markupPct)}
                                  </span>
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td className="px-3 py-2 text-right">
                              {item.minStock != null
                                ? fmtQty(item.minStock)
                                : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-1">
                                {item.isAsset && (
                                  <span className={pillClass("violet")}>zwrotny</span>
                                )}
                                {item.isArchived && (
                                  <span className={pillClass("muted")}>archiwum</span>
                                )}
                              </div>
                            </td>
                            {/* Autor i data w jednej kolumnie — dokładnie ten sam
                                układ co w tabeli ofert, żeby „kto i kiedy" czytało
                                się tak samo w obu modułach. Pełny znacznik czasu
                                siedzi w dymku, bo „2 dni temu" czyta się szybciej
                                niż „30.08.2026 14:12". */}
                            <td className="px-3 py-2 text-xs">
                              <div>
                                {item.createdByLabel || (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </div>
                              <div
                                className="whitespace-nowrap text-muted-foreground"
                                {...tip(fmtTimestamp(item.createdAt))}
                              >
                                {fmtRelative(item.createdAt)}
                              </div>
                            </td>
                            <td className="px-3 py-2 text-xs">
                              {item.updatedAt && item.updatedAt !== item.createdAt ? (
                                <>
                                  <div>
                                    {item.updatedByLabel || (
                                      <span className="text-muted-foreground">—</span>
                                    )}
                                  </div>
                                  <div
                                    className="whitespace-nowrap text-muted-foreground"
                                    {...tip(fmtTimestamp(item.updatedAt))}
                                  >
                                    {fmtRelative(item.updatedAt)}
                                  </div>
                                </>
                              ) : (
                                <span
                                  className="text-muted-foreground"
                                  {...tip("Kartoteka nie była zmieniana od utworzenia")}
                                >
                                  —
                                </span>
                              )}
                            </td>
                            {editable && (
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    title="Edytuj"
                                    onClick={() => {
                                      setEditingItem(item);
                                      setItemFormOpen(true);
                                    }}
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  {item.isArchived ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Przywróć z archiwum"
                                      onClick={() => handleItemRestore(item)}
                                    >
                                      <ArchiveRestore className="mr-1 h-4 w-4" />
                                      Przywróć
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Archiwizuj"
                                      className="text-muted-foreground hover:text-destructive"
                                      onClick={() => handleItemArchive(item)}
                                    >
                                      <Archive className="h-4 w-4" />
                                    </Button>
                                  )}
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ----------------------------- MAGAZYNY ---------------------------- */}
        <TabsContent value="magazyny" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showArchivedWh}
                onChange={(e) => setShowArchivedWh(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Pokaż zarchiwizowane
            </label>
            {editable && (
              <Button
                onClick={() => {
                  setEditingWh(null);
                  setWhFormOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy magazyn
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Nazwa</th>
                      <th className="px-3 py-2 font-medium">Kod</th>
                      <th className="px-3 py-2 font-medium">Typ</th>
                      <th className="px-3 py-2 font-medium">Nadrzędny</th>
                      {editable && (
                        <th className="px-3 py-2 text-right font-medium">
                          Akcje
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={editable ? 5 : 4}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visibleWarehouses.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 5 : 4}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Brak magazynów.
                        </td>
                      </tr>
                    ) : (
                      visibleWarehouses.map((wh) => {
                        const typeMeta = WAREHOUSE_TYPE_META[wh.type];
                        const parent = wh.parentId
                          ? warehouses.find((w) => w.id === wh.parentId)
                          : null;
                        return (
                          <tr
                            key={wh.id}
                            className={`border-b last:border-0 ${
                              wh.isArchived ? "opacity-60" : ""
                            }`}
                          >
                            <td className="px-3 py-2 font-medium">
                              {wh.name}
                              {wh.isArchived && (
                                <span
                                  className={pillClass("muted", {
                                    className: "ml-2 font-normal",
                                  })}
                                >
                                  archiwum
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {wh.code || "—"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={pillClass(typeMeta.tone)}
                              >
                                {typeMeta.label}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {parent ? parent.name : "—"}
                            </td>
                            {editable && (
                              <td className="px-3 py-2">
                                <div className="flex justify-end gap-1">
                                  {wh.isArchived ? (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title="Przywróć z archiwum"
                                      onClick={() => handleWarehouseRestore(wh)}
                                    >
                                      <ArchiveRestore className="mr-1 h-4 w-4" />
                                      Przywróć
                                    </Button>
                                  ) : (
                                    <>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        title="Edytuj"
                                        onClick={() => {
                                          setEditingWh(wh);
                                          setWhFormOpen(true);
                                        }}
                                      >
                                        <Pencil className="h-4 w-4" />
                                      </Button>
                                      <Button
                                        variant="ghost"
                                        size="sm"
                                        title="Archiwizuj"
                                        className="text-muted-foreground hover:text-destructive"
                                        onClick={() => handleWarehouseArchive(wh)}
                                      >
                                        <Archive className="h-4 w-4" />
                                      </Button>
                                    </>
                                  )}
                                </div>
                              </td>
                            )}
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* --- Dialogi --- */}
      {docFormMode && (
        <WarehouseDocumentForm
          key={`${docFormMode}-${docFormPrefill ?? "none"}-${editingDoc?.id ?? "new"}-${docFormNonce}`}
          open={docFormMode !== null}
          onClose={closeDocForm}
          onSubmit={handleDocumentSubmit}
          mode={docFormMode}
          items={items}
          warehouses={warehouses}
          stock={stock}
          onCreateItem={handleInlineItemCreate}
          prefillItemId={docFormPrefill}
          editDocument={editingDoc}
        />
      )}

      <WarehouseDocumentDetails
        open={detailsDoc !== null}
        onClose={() => setDetailsDoc(null)}
        document={detailsDoc}
        warehouses={warehouses}
        editable={editable}
        onConfirm={handleDocumentConfirm}
        onCancelDocument={handleDocumentCancel}
        onDelete={handleDocumentDelete}
        onEdit={openDocEdit}
      />

      <WarehouseMovementsDialog
        key={historyItem?.id ?? "no-history"}
        open={historyItem !== null}
        onClose={() => setHistoryItem(null)}
        item={historyItem}
      />

      {itemFormOpen && (
        <WarehouseItemForm
          key={editingItem?.id ?? "new"}
          open={itemFormOpen}
          onClose={() => setItemFormOpen(false)}
          onSubmit={handleItemSubmit}
          item={editingItem}
          categories={categories}
          manufacturers={manufacturers}
          warehouseMarkup={warehouseMarkup}
        />
      )}

      {whFormOpen && (
        <WarehouseForm
          key={editingWh?.id ?? "new"}
          open={whFormOpen}
          onClose={() => setWhFormOpen(false)}
          onSubmit={handleWarehouseSubmit}
          warehouse={editingWh}
          warehouses={warehouses}
        />
      )}
    </div>
  );
}
