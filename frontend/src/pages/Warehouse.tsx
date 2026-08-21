import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  ArrowLeftRight,
  History,
  ImageOff,
  PackageMinus,
  PackagePlus,
  Pencil,
  Plus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  warehouseApi,
  type StockEntry,
  type WarehouseDef,
  type WarehouseDefInput,
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
  fmtQty,
  totalStockFor,
  warehouseLabel,
} from "@/components/warehouse/warehouseShared";

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

export function Warehouse() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/magazyn");

  // --- Dane podstawowe (towary, magazyny, stany) ---
  const [items, setItems] = useState<WarehouseItem[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseDef[]>([]);
  const [stock, setStock] = useState<StockEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadCore = useCallback(async () => {
    try {
      const [itemsRes, whRes, stockRes] = await Promise.all([
        warehouseApi.getItems(true),
        warehouseApi.getWarehouses(),
        warehouseApi.getStock(),
      ]);
      setItems(itemsRes.data || []);
      setWarehouses(whRes.data || []);
      setStock(stockRes.data || []);
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
  const [docTypeFilter, setDocTypeFilter] = useState("");
  const [docStatusFilter, setDocStatusFilter] = useState("");

  const loadDocuments = useCallback(async () => {
    setDocsLoading(true);
    try {
      const res = await warehouseApi.getDocuments({
        type: docTypeFilter || undefined,
        status: docStatusFilter || undefined,
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

  // --- Zakładka Stany: filtry ---
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [warehouseFilter, setWarehouseFilter] = useState("");

  // --- Zakładka Towary ---
  const [showArchived, setShowArchived] = useState(false);
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

  const stockRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const whId = warehouseFilter ? Number(warehouseFilter) : null;
    return items
      .filter((i) => !i.isArchived)
      .filter(
        (i) =>
          !q ||
          i.name.toLowerCase().includes(q) ||
          (i.sku ?? "").toLowerCase().includes(q) ||
          (i.barcode ?? "").toLowerCase().includes(q)
      )
      .filter((i) => !categoryFilter || (i.category || "") === categoryFilter)
      .map((item) => {
        const entries = stock.filter(
          (s) => s.itemId === item.id && s.quantity !== 0
        );
        return {
          item,
          entries,
          total: totalStockFor(stock, item.id),
        };
      })
      .filter(
        (row) =>
          whId == null || row.entries.some((e) => e.warehouseId === whId)
      )
      .sort((a, b) => a.item.name.localeCompare(b.item.name, "pl"));
  }, [items, stock, search, categoryFilter, warehouseFilter]);

  const visibleItems = useMemo(
    () =>
      items
        .filter((i) => showArchived || !i.isArchived)
        .sort((a, b) => a.name.localeCompare(b.name, "pl")),
    [items, showArchived]
  );

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

  const selectClass =
    "flex h-10 rounded-md border border-input bg-background px-3 py-2 text-sm";

  return (
    <div className="space-y-4">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {/* Nagłówek + akcje główne */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Magazyn</h1>
        {editable && (
          <div className="flex flex-wrap gap-2">
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

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="stany">Stany</TabsTrigger>
          <TabsTrigger value="dokumenty">Dokumenty</TabsTrigger>
          <TabsTrigger value="towary">Towary</TabsTrigger>
          <TabsTrigger value="magazyny">Magazyny</TabsTrigger>
        </TabsList>

        {/* ------------------------------ STANY ------------------------------ */}
        <TabsContent value="stany" className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Szukaj: nazwa / SKU / kod kreskowy…"
              className="max-w-xs"
            />
            <select
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">Wszystkie kategorie</option>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              value={warehouseFilter}
              onChange={(e) => setWarehouseFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">Wszystkie magazyny</option>
              {activeWarehouses.map((w) => (
                <option key={w.id} value={String(w.id)}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="w-14 px-3 py-2 font-medium"></th>
                      <th className="px-3 py-2 font-medium">Towar</th>
                      <th className="px-3 py-2 font-medium">Kategoria</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Stan łączny
                      </th>
                      <th className="px-3 py-2 font-medium">Wg magazynów</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Akcje
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : stockRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Brak towarów spełniających kryteria.
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
                                <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700">
                                  niski stan
                                </span>
                              )}
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
                                      className="rounded-full bg-muted px-2 py-0.5 text-xs"
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
          <div className="flex flex-wrap gap-2">
            <select
              value={docTypeFilter}
              onChange={(e) => setDocTypeFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">Wszystkie typy</option>
              <option value="PZ">PZ — przyjęcie</option>
              <option value="WZ">WZ — wydanie zewn.</option>
              <option value="RW">RW — zużycie wewn.</option>
              <option value="MM">MM — przesunięcie</option>
            </select>
            <select
              value={docStatusFilter}
              onChange={(e) => setDocStatusFilter(e.target.value)}
              className={selectClass}
            >
              <option value="">Wszystkie statusy</option>
              <option value="draft">Szkic</option>
              <option value="confirmed">Zatwierdzony</option>
              <option value="cancelled">Anulowany</option>
            </select>
          </div>

          <Card>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Numer</th>
                      <th className="px-3 py-2 font-medium">Typ</th>
                      <th className="px-3 py-2 font-medium">Data</th>
                      <th className="px-3 py-2 font-medium">
                        Magazyny / kontrahent
                      </th>
                      <th className="px-3 py-2 text-right font-medium">
                        Pozycje
                      </th>
                      <th className="px-3 py-2 font-medium">Status</th>
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
                    ) : documents.length === 0 ? (
                      <tr>
                        <td
                          colSpan={6}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Brak dokumentów.
                        </td>
                      </tr>
                    ) : (
                      documents.map((doc) => {
                        const typeMeta = DOC_TYPE_META[doc.docType];
                        const statusMeta = DOC_STATUS_META[doc.status];
                        const from = doc.warehouseFromId
                          ? warehouseLabel(
                              warehouses,
                              doc.warehouseFromId,
                              doc.warehouseFromName
                            )
                          : null;
                        const to = doc.warehouseToId
                          ? warehouseLabel(
                              warehouses,
                              doc.warehouseToId,
                              doc.warehouseToName
                            )
                          : null;
                        const route =
                          [from, to].filter(Boolean).join(" → ") || "—";
                        return (
                          <tr
                            key={doc.id}
                            className="cursor-pointer border-b last:border-0 hover:bg-accent/50"
                            onClick={() => openDocumentDetails(doc)}
                          >
                            <td className="px-3 py-2 font-medium">
                              {doc.docNumber || (
                                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
                                  szkic
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeMeta.badge}`}
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
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusMeta.badge}`}
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
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="h-4 w-4 accent-primary"
              />
              Pokaż zarchiwizowane
            </label>
            {editable && (
              <Button
                onClick={() => {
                  setEditingItem(null);
                  setItemFormOpen(true);
                }}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy towar
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
                      <th className="px-3 py-2 font-medium">Nazwa</th>
                      <th className="px-3 py-2 font-medium">Kategoria</th>
                      <th className="px-3 py-2 font-medium">Jedn.</th>
                      <th className="px-3 py-2 font-medium">Kod kreskowy</th>
                      <th className="px-3 py-2 text-right font-medium">
                        Min. stan
                      </th>
                      <th className="px-3 py-2 font-medium">Oznaczenia</th>
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
                          colSpan={editable ? 8 : 7}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Ładowanie…
                        </td>
                      </tr>
                    ) : visibleItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editable ? 8 : 7}
                          className="px-3 py-8 text-center text-muted-foreground"
                        >
                          Kartoteka towarów jest pusta.
                        </td>
                      </tr>
                    ) : (
                      visibleItems.map((item) => (
                        <tr
                          key={item.id}
                          className={`border-b last:border-0 ${
                            item.isArchived ? "opacity-60" : ""
                          }`}
                        >
                          <td className="px-3 py-2">{photoThumb(item)}</td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{item.name}</div>
                            {item.sku && (
                              <div className="text-xs text-muted-foreground">
                                {item.sku}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {item.category || "—"}
                          </td>
                          <td className="px-3 py-2">{item.unit}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {item.barcode || "—"}
                          </td>
                          <td className="px-3 py-2 text-right">
                            {item.minStock != null
                              ? fmtQty(item.minStock)
                              : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1">
                              {item.isAsset && (
                                <span className="rounded-full bg-violet-100 px-2 py-0.5 text-xs font-medium text-violet-700">
                                  zwrotny
                                </span>
                              )}
                              {item.isArchived && (
                                <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                                  archiwum
                                </span>
                              )}
                            </div>
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
                      ))
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
                                <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                                  archiwum
                                </span>
                              )}
                            </td>
                            <td className="px-3 py-2 text-muted-foreground">
                              {wh.code || "—"}
                            </td>
                            <td className="px-3 py-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs font-medium ${typeMeta.badge}`}
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
