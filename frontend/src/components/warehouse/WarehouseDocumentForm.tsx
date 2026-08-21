import { useEffect, useMemo, useRef, useState } from "react";
import { Paperclip, Plus, Trash2, X } from "lucide-react";
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
  type StockEntry,
  type WarehouseDef,
  type WarehouseDocType,
  type WarehouseDocument,
  type WarehouseDocumentInput,
  type WarehouseItem,
  type WarehouseItemInput,
} from "@/lib/api";
import {
  COMMON_UNITS,
  fmtQty,
  readFileAsDataUrl,
  stockFor,
  todayIso,
} from "./warehouseShared";

/** Tryb formularza: PZ (przyjęcie), issue (RW/WZ do wyboru), MM. */
export type DocumentFormMode = "PZ" | "issue" | "MM";

interface WarehouseDocumentFormProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: WarehouseDocumentInput) => Promise<void>;
  mode: DocumentFormMode;
  items: WarehouseItem[];
  warehouses: WarehouseDef[];
  stock: StockEntry[];
  /** Tworzy towar bez opuszczania formularza ("+ Nowy towar"). */
  onCreateItem: (data: WarehouseItemInput) => Promise<WarehouseItem>;
  /** Prefill pozycji (akcje "Wydaj"/"Przesuń" z zakładki Stany). */
  prefillItemId?: number | null;
  /**
   * Szkic do edycji (pełny dokument z pozycjami z GET /documents/:id).
   * Włącza tryb edycji: prefill nagłówka i pozycji, zapis przez PUT.
   */
  editDocument?: WarehouseDocument | null;
}

interface PositionRow {
  key: number;
  itemId: number | null;
  query: string;
  quantity: string;
  unitPrice: string;
}

let rowKeySeq = 1;

function emptyRow(): PositionRow {
  return { key: rowKeySeq++, itemId: null, query: "", quantity: "", unitPrice: "" };
}

const MAX_INVOICE_BYTES = 10 * 1024 * 1024;

export function WarehouseDocumentForm({
  open,
  onClose,
  onSubmit,
  mode,
  items,
  warehouses,
  stock,
  onCreateItem,
  prefillItemId,
  editDocument,
}: WarehouseDocumentFormProps) {
  const editDoc = editDocument ?? null;
  const isEdit = editDoc != null;

  const activeWarehouses = useMemo(
    () => warehouses.filter((w) => !w.isArchived),
    [warehouses]
  );
  const defaultMain =
    activeWarehouses.find((w) => w.type === "main") ?? activeWarehouses[0];

  const [loading, setLoading] = useState(false);
  const [issueKind, setIssueKind] = useState<"RW" | "WZ">(
    editDoc?.docType === "WZ" ? "WZ" : "RW"
  );
  const [warehouseFromId, setWarehouseFromId] = useState<string>(() =>
    editDoc
      ? editDoc.warehouseFromId != null
        ? String(editDoc.warehouseFromId)
        : ""
      : mode !== "PZ" && defaultMain
        ? String(defaultMain.id)
        : ""
  );
  const [warehouseToId, setWarehouseToId] = useState<string>(() =>
    editDoc
      ? editDoc.warehouseToId != null
        ? String(editDoc.warehouseToId)
        : ""
      : mode === "PZ" && defaultMain
        ? String(defaultMain.id)
        : ""
  );
  const [contractorName, setContractorName] = useState(
    editDoc?.contractorName ?? ""
  );
  const [invoiceNumber, setInvoiceNumber] = useState(
    editDoc?.invoiceNumber ?? ""
  );
  const [invoiceFile, setInvoiceFile] = useState<{
    name: string;
    data: string;
  } | null>(null);
  /** Nazwa istniejącego załącznika szkicu (tryb edycji); null = brak/usunięty. */
  const [existingInvoice, setExistingInvoice] = useState<string | null>(
    editDoc && (editDoc.hasInvoiceFile || editDoc.invoiceFileName)
      ? editDoc.invoiceFileName || "załącznik faktury"
      : null
  );
  const [issuedAt, setIssuedAt] = useState(
    editDoc?.issuedAt ? editDoc.issuedAt.slice(0, 10) : todayIso()
  );
  const [notes, setNotes] = useState(editDoc?.notes ?? "");

  const prefillItem = prefillItemId
    ? items.find((i) => i.id === prefillItemId)
    : null;
  const [positions, setPositions] = useState<PositionRow[]>(() => {
    if (editDoc?.items?.length) {
      return editDoc.items.map((it) => ({
        key: rowKeySeq++,
        itemId: it.itemId,
        query:
          it.itemName ??
          items.find((i) => i.id === it.itemId)?.name ??
          `#${it.itemId}`,
        quantity: String(it.quantity),
        unitPrice: it.unitPrice != null ? String(it.unitPrice) : "",
      }));
    }
    return prefillItem
      ? [
          {
            key: rowKeySeq++,
            itemId: prefillItem.id,
            query: prefillItem.name,
            quantity: "",
            unitPrice: "",
          },
        ]
      : [emptyRow()];
  });

  // Świeże stany magazynowe na czas życia formularza — walidacja i podpowiedzi
  // "Dostępne: X" nie mogą bazować na snapshocie z wejścia na stronę.
  const [freshStock, setFreshStock] = useState<StockEntry[]>(stock);
  useEffect(() => {
    let alive = true;
    warehouseApi
      .getStock()
      .then((res) => {
        if (alive) setFreshStock(res.data || []);
      })
      .catch(() => {
        // Zostaje snapshot z props — walidację i tak domknie backend.
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [activeSearchKey, setActiveSearchKey] = useState<number | null>(null);
  const blurTimer = useRef<number | null>(null);

  // Inline "+ Nowy towar"
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemUnit, setNewItemUnit] = useState("szt");
  const [newItemBusy, setNewItemBusy] = useState(false);

  const docType: WarehouseDocType =
    mode === "PZ" ? "PZ" : mode === "MM" ? "MM" : issueKind;
  const isPz = docType === "PZ";
  const needsSource = !isPz;
  const sourceId = warehouseFromId ? Number(warehouseFromId) : null;

  const baseTitle =
    mode === "PZ"
      ? "Przyjęcie dostawy (PZ)"
      : mode === "MM"
        ? "Przesunięcie międzymagazynowe (MM)"
        : "Wydanie towaru";
  const title = isEdit ? `Edycja szkicu — ${baseTitle}` : baseTitle;

  const itemById = (id: number | null) =>
    id != null ? (items.find((i) => i.id === id) ?? null) : null;

  const suggestionsFor = (row: PositionRow): WarehouseItem[] => {
    const q = row.query.trim().toLowerCase();
    if (!q) return [];
    return items
      .filter((i) => !i.isArchived)
      .filter(
        (i) =>
          i.name.toLowerCase().includes(q) ||
          (i.sku ?? "").toLowerCase().includes(q) ||
          (i.barcode ?? "").toLowerCase().includes(q)
      )
      .slice(0, 8);
  };

  const patchRow = (key: number, patch: Partial<PositionRow>) =>
    setPositions((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r))
    );

  const selectItem = (key: number, item: WarehouseItem) => {
    patchRow(key, { itemId: item.id, query: item.name });
    setActiveSearchKey(null);
  };

  const handleInvoiceFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_INVOICE_BYTES) {
      window.alert("Plik faktury jest za duży (maks. 10 MB).");
      return;
    }
    try {
      const data = await readFileAsDataUrl(file);
      setInvoiceFile({ name: file.name, data });
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd wczytywania pliku"
      );
    }
  };

  const handleCreateItem = async () => {
    if (!newItemName.trim() || !newItemUnit.trim()) {
      window.alert("Podaj nazwę i jednostkę nowego towaru.");
      return;
    }
    setNewItemBusy(true);
    try {
      const created = await onCreateItem({
        name: newItemName.trim(),
        unit: newItemUnit.trim(),
      });
      // Dodaj świeżo utworzony towar jako pozycję (wypełnij pierwszy pusty
      // wiersz albo dołóż nowy).
      setPositions((prev) => {
        const emptyIdx = prev.findIndex((r) => r.itemId == null && !r.query);
        const filled: PositionRow = {
          key: rowKeySeq++,
          itemId: created.id,
          query: created.name,
          quantity: "",
          unitPrice: "",
        };
        if (emptyIdx >= 0) {
          const next = [...prev];
          next[emptyIdx] = filled;
          return next;
        }
        return [...prev, filled];
      });
      setNewItemOpen(false);
      setNewItemName("");
      setNewItemUnit("szt");
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Błąd zapisu towaru");
    } finally {
      setNewItemBusy(false);
    }
  };

  const submit = async (confirm: boolean) => {
    // Wiersze całkiem puste ignorujemy; wpisane, ale niewybrane — błąd.
    const nonEmpty = positions.filter((r) => r.itemId != null || r.query.trim());
    const unresolved = nonEmpty.find((r) => r.itemId == null);
    if (unresolved) {
      window.alert(
        `Wybierz towar z listy podpowiedzi dla pozycji "${unresolved.query}".`
      );
      return;
    }
    const rows = nonEmpty as (PositionRow & { itemId: number })[];
    if (rows.length === 0) {
      window.alert("Dodaj przynajmniej jedną pozycję dokumentu.");
      return;
    }
    for (const r of rows) {
      const qty = Number(r.quantity);
      if (!r.quantity.trim() || !Number.isFinite(qty) || qty <= 0) {
        const it = itemById(r.itemId);
        window.alert(
          `Podaj ilość większą od zera dla pozycji "${it?.name ?? "?"}".`
        );
        return;
      }
    }
    if (isPz && !warehouseToId) {
      window.alert("Wybierz magazyn docelowy dla przyjęcia.");
      return;
    }
    if (needsSource && !warehouseFromId) {
      window.alert("Wybierz magazyn źródłowy.");
      return;
    }
    if (docType === "MM") {
      if (!warehouseToId) {
        window.alert("Wybierz magazyn docelowy przesunięcia.");
        return;
      }
      if (warehouseFromId === warehouseToId) {
        window.alert("Magazyn źródłowy i docelowy muszą być różne.");
        return;
      }
    }
    if (docType === "WZ" && !contractorName.trim()) {
      window.alert("Podaj odbiorcę wydania zewnętrznego (WZ).");
      return;
    }
    if (needsSource && sourceId) {
      // Suma ilości per towar nie może przekroczyć dostępnego stanu.
      const perItem = new Map<number, number>();
      for (const r of rows) {
        perItem.set(r.itemId, (perItem.get(r.itemId) ?? 0) + Number(r.quantity));
      }
      for (const [itemId, qty] of perItem) {
        const available = stockFor(freshStock, itemId, sourceId);
        if (qty > available) {
          const it = itemById(itemId);
          window.alert(
            `Za mało towaru "${it?.name ?? "?"}" w magazynie źródłowym — ` +
              `dostępne: ${fmtQty(available)} ${it?.unit ?? ""}.`
          );
          return;
        }
      }
    }

    const payload: WarehouseDocumentInput = {
      docType,
      warehouseFromId: needsSource ? Number(warehouseFromId) : undefined,
      warehouseToId:
        isPz || docType === "MM" ? Number(warehouseToId) : undefined,
      contractorName:
        (isPz || docType === "WZ") && contractorName.trim()
          ? contractorName.trim()
          : undefined,
      invoiceNumber: isPz && invoiceNumber.trim() ? invoiceNumber.trim() : undefined,
      // Załącznik: nowy plik → wyślij; istniejący zachowany → pomiń (bez
      // zmian); usunięty w trybie edycji → null (jawne skasowanie na PUT).
      invoiceFileName:
        isPz && invoiceFile
          ? invoiceFile.name
          : isPz && isEdit && !existingInvoice
            ? null
            : undefined,
      invoiceFileData:
        isPz && invoiceFile
          ? invoiceFile.data
          : isPz && isEdit && !existingInvoice
            ? null
            : undefined,
      issuedAt: issuedAt || undefined,
      notes: notes.trim() || undefined,
      items: rows.map((r) => ({
        itemId: r.itemId,
        quantity: Number(r.quantity),
        unitPrice:
          isPz && r.unitPrice.trim() ? Number(r.unitPrice) : undefined,
      })),
      confirm,
    };

    setLoading(true);
    try {
      await onSubmit(payload);
      onClose();
    } catch (err) {
      window.alert(
        err instanceof Error ? err.message : "Błąd zapisu dokumentu"
      );
    } finally {
      setLoading(false);
    }
  };

  const warehouseSelect = (
    id: string,
    value: string,
    onChange: (v: string) => void,
    placeholder: string
  ) => (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
    >
      <option value="">{placeholder}</option>
      {activeWarehouses.map((w) => (
        <option key={w.id} value={String(w.id)}>
          {w.name}
          {w.code ? ` (${w.code})` : ""}
        </option>
      ))}
    </select>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-2xl max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {mode === "issue" && (
            <div className="space-y-2">
              <Label>Rodzaj wydania</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setIssueKind("RW")}
                  className={`rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                    issueKind === "RW"
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent"
                  }`}
                >
                  Zużycie / na obiekt (RW)
                  <span className="block text-xs text-muted-foreground">
                    materiał zużyty przy montażu lub serwisie
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setIssueKind("WZ")}
                  className={`rounded-md border px-3 py-2 text-sm text-left transition-colors ${
                    issueKind === "WZ"
                      ? "border-primary bg-primary/10 font-medium"
                      : "hover:bg-accent"
                  }`}
                >
                  Wydanie na zewnątrz (WZ)
                  <span className="block text-xs text-muted-foreground">
                    towar opuszcza firmę (klient, zwrot)
                  </span>
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {needsSource && (
              <div className="space-y-2">
                <Label htmlFor="doc-wh-from">Magazyn źródłowy *</Label>
                {warehouseSelect(
                  "doc-wh-from",
                  warehouseFromId,
                  setWarehouseFromId,
                  "— wybierz magazyn —"
                )}
              </div>
            )}
            {(isPz || docType === "MM") && (
              <div className="space-y-2">
                <Label htmlFor="doc-wh-to">Magazyn docelowy *</Label>
                {warehouseSelect(
                  "doc-wh-to",
                  warehouseToId,
                  setWarehouseToId,
                  "— wybierz magazyn —"
                )}
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="doc-date">Data</Label>
              <Input
                id="doc-date"
                type="date"
                value={issuedAt}
                onChange={(e) => setIssuedAt(e.target.value)}
              />
            </div>
            {isPz && (
              <div className="space-y-2">
                <Label htmlFor="doc-contractor">Dostawca</Label>
                <Input
                  id="doc-contractor"
                  value={contractorName}
                  onChange={(e) => setContractorName(e.target.value)}
                  placeholder="np. Hurtownia CCTV Sp. z o.o."
                />
              </div>
            )}
            {docType === "WZ" && (
              <div className="space-y-2">
                <Label htmlFor="doc-recipient">Odbiorca *</Label>
                <Input
                  id="doc-recipient"
                  value={contractorName}
                  onChange={(e) => setContractorName(e.target.value)}
                  placeholder="np. klient / firma odbierająca"
                />
              </div>
            )}
            {isPz && (
              <div className="space-y-2">
                <Label htmlFor="doc-invoice-no">Nr faktury</Label>
                <Input
                  id="doc-invoice-no"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                  placeholder="np. FV/123/2026"
                />
              </div>
            )}
            {isPz && (
              <div className="space-y-2">
                <Label>Załącznik faktury</Label>
                {invoiceFile || existingInvoice ? (
                  <div className="flex h-10 items-center justify-between gap-2 rounded-md border px-3 text-sm">
                    <span className="flex min-w-0 items-center gap-2">
                      <Paperclip className="h-4 w-4 shrink-0" />
                      <span className="truncate">
                        {invoiceFile ? invoiceFile.name : existingInvoice}
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        setInvoiceFile(null);
                        setExistingInvoice(null);
                      }}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label="Usuń załącznik"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                ) : (
                  <label className="flex h-10 cursor-pointer items-center gap-2 rounded-md border border-dashed px-3 text-sm text-muted-foreground hover:bg-accent">
                    <Paperclip className="h-4 w-4" />
                    Dodaj plik (PDF/JPG/PNG, maks. 10 MB)
                    <input
                      type="file"
                      accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
                      className="hidden"
                      onChange={(e) => {
                        handleInvoiceFile(e.target.files?.[0]);
                        e.target.value = "";
                      }}
                    />
                  </label>
                )}
              </div>
            )}
          </div>

          {/* Pozycje */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Pozycje *</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setNewItemOpen((v) => !v)}
              >
                <Plus className="mr-1 h-4 w-4" /> Nowy towar
              </Button>
            </div>

            {newItemOpen && (
              <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/40 p-3">
                <div className="min-w-40 flex-1 space-y-1">
                  <Label className="text-xs">Nazwa nowego towaru</Label>
                  <Input
                    value={newItemName}
                    onChange={(e) => setNewItemName(e.target.value)}
                    placeholder="np. Uchwyt kamery"
                  />
                </div>
                <div className="w-28 space-y-1">
                  <Label className="text-xs">Jednostka</Label>
                  <Input
                    list="doc-new-item-units"
                    value={newItemUnit}
                    onChange={(e) => setNewItemUnit(e.target.value)}
                  />
                  <datalist id="doc-new-item-units">
                    {COMMON_UNITS.map((u) => (
                      <option key={u} value={u} />
                    ))}
                  </datalist>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={handleCreateItem}
                  disabled={newItemBusy}
                >
                  {newItemBusy ? "Dodawanie…" : "Utwórz i dodaj"}
                </Button>
              </div>
            )}

            <div className="space-y-2">
              {positions.map((row) => {
                const item = itemById(row.itemId);
                const suggestions =
                  activeSearchKey === row.key ? suggestionsFor(row) : [];
                const available =
                  needsSource && item && sourceId
                    ? stockFor(freshStock, item.id, sourceId)
                    : null;
                return (
                  <div key={row.key} className="flex items-start gap-2">
                    <div className="relative flex-1">
                      <Input
                        value={row.query}
                        placeholder="Szukaj towaru (nazwa / SKU / kod)…"
                        onChange={(e) => {
                          patchRow(row.key, {
                            query: e.target.value,
                            itemId: null,
                          });
                          setActiveSearchKey(row.key);
                        }}
                        onFocus={() => {
                          if (blurTimer.current)
                            window.clearTimeout(blurTimer.current);
                          setActiveSearchKey(row.key);
                        }}
                        onBlur={() => {
                          blurTimer.current = window.setTimeout(
                            () => setActiveSearchKey(null),
                            150
                          );
                        }}
                      />
                      {suggestions.length > 0 && row.itemId == null && (
                        <div className="absolute left-0 right-0 top-full z-10 mt-1 overflow-hidden rounded-md border bg-background shadow-md">
                          {suggestions.map((s) => (
                            <button
                              key={s.id}
                              type="button"
                              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-accent"
                              onMouseDown={(e) => {
                                e.preventDefault();
                                selectItem(row.key, s);
                              }}
                            >
                              <span className="min-w-0 truncate">
                                {s.name}
                                {s.sku && (
                                  <span className="ml-1 text-xs text-muted-foreground">
                                    ({s.sku})
                                  </span>
                                )}
                              </span>
                              {needsSource && sourceId && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  dost. {fmtQty(stockFor(freshStock, s.id, sourceId))}{" "}
                                  {s.unit}
                                </span>
                              )}
                            </button>
                          ))}
                        </div>
                      )}
                      {item && available != null && (
                        <div
                          className={`mt-0.5 text-xs ${
                            Number(row.quantity || 0) > available
                              ? "text-destructive"
                              : "text-muted-foreground"
                          }`}
                        >
                          Dostępne w magazynie źródłowym: {fmtQty(available)}{" "}
                          {item.unit}
                        </div>
                      )}
                    </div>
                    <div className="w-24">
                      <Input
                        type="number"
                        min="0"
                        step="any"
                        value={row.quantity}
                        placeholder="Ilość"
                        onChange={(e) =>
                          patchRow(row.key, { quantity: e.target.value })
                        }
                      />
                      {item && (
                        <div className="mt-0.5 text-center text-xs text-muted-foreground">
                          {item.unit}
                        </div>
                      )}
                    </div>
                    {isPz && (
                      <div className="w-28">
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          value={row.unitPrice}
                          placeholder="Cena jedn."
                          onChange={(e) =>
                            patchRow(row.key, { unitPrice: e.target.value })
                          }
                        />
                      </div>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() =>
                        setPositions((prev) =>
                          prev.length > 1
                            ? prev.filter((r) => r.key !== row.key)
                            : [emptyRow()]
                        )
                      }
                      aria-label="Usuń pozycję"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                );
              })}
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPositions((prev) => [...prev, emptyRow()])}
            >
              <Plus className="mr-1 h-4 w-4" /> Dodaj pozycję
            </Button>
          </div>

          <div className="space-y-2">
            <Label htmlFor="doc-notes">Uwagi</Label>
            <Textarea
              id="doc-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder={
                docType === "RW"
                  ? "np. montaż na obiekcie XYZ"
                  : "dodatkowe informacje"
              }
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Anuluj
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={loading}
            onClick={() => submit(false)}
          >
            Zapisz szkic
          </Button>
          <Button type="button" disabled={loading} onClick={() => submit(true)}>
            {loading ? "Zapisywanie…" : "Zatwierdź"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
