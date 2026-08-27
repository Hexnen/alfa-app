import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Copy,
  CopyPlus,
  Eye,
  EyeOff,
  Pencil,
  Plus,
  Star,
  Trash2,
  Users,
} from "lucide-react";
import { PriceItemForm } from "@/components/PriceItemForm";
import { PriceListForm } from "./PriceListForm";
import { AssignTechniciansDialog } from "./AssignTechniciansDialog";
import { CopyItemsDialog } from "./CopyItemsDialog";
import {
  createPriceItem,
  deletePriceItem,
  getPriceList,
  getTechnicians,
  priceItemKind,
  priceListsApi,
  updatePriceItem,
  PRICE_ITEM_KIND_LABEL,
  type PriceItem,
  type PriceItemInput,
  type PriceItemKind,
  type PriceListGroup,
  type PriceListGroupInput,
  type Technician,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { tip } from "@/components/ui/tooltip";

const pln = new Intl.NumberFormat("pl-PL", {
  style: "currency",
  currency: "PLN",
});
const money = (v: number | null | undefined) => pln.format(Number(v || 0));

const techName = (t: Technician) =>
  `${t.firstName} ${t.lastName}`.trim() || `#${t.id}`;

/** Filtr rodzaju nad tabelą pozycji. */
type KindFilter = "all" | PriceItemKind;

const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "Wszystkie",
  service: "Usługi",
  material: "Materiały",
};

/** Kolor pigułki rodzaju — usługa i materiał mają się różnić na pierwszy rzut oka. */
const KIND_BADGE: Record<PriceItemKind, string> = {
  service: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  material: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
};

const KIND_TIP: Record<PriceItemKind, string> = {
  service: "Usługa — stawki RBH i KM automat bierze wyłącznie stąd",
  material: "Materiał — pozycje protokołu wyceniają się wyłącznie po materiałach",
};

interface PriceListTabProps {
  /** Uprawnienie „edit" dla technical/cennik — read-only ukrywa akcje. */
  editable: boolean;
}

/**
 * Zakładka Techniczny → Cennik: po lewej lista cenników (z cennikiem głównym),
 * po prawej pozycje wybranego cennika i technicy, którzy z niego korzystają.
 */
export function PriceListTab({ editable }: PriceListTabProps) {
  const [lists, setLists] = useState<PriceListGroup[]>([]);
  const [listsLoading, setListsLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [items, setItems] = useState<PriceItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(true);
  /**
   * Licznik wymuszający przeładowanie pozycji po zapisie. Efekt zależy od
   * (selectedId, itemsVersion), więc po usunięciu cennika pozycje ładują się
   * dopiero dla nowo wybranego id — nigdy dla tego, którego już nie ma.
   */
  const [itemsVersion, setItemsVersion] = useState(0);
  const [selectedItemIds, setSelectedItemIds] = useState<number[]>([]);
  /** Filtr rodzaju — czysto widokowy, nie zawęża zaznaczenia ani kopiowania. */
  const [kindFilter, setKindFilter] = useState<KindFilter>("all");

  const [priceFormOpen, setPriceFormOpen] = useState(false);
  const [editingPrice, setEditingPrice] = useState<PriceItem | null>(null);

  const [listFormOpen, setListFormOpen] = useState(false);
  const [editingList, setEditingList] = useState<PriceListGroup | null>(null);
  const [duplicateSource, setDuplicateSource] = useState<PriceListGroup | null>(
    null
  );

  const [deleteTarget, setDeleteTarget] = useState<PriceListGroup | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [technicians, setTechnicians] = useState<Technician[]>([]);
  const [assigned, setAssigned] = useState<Technician[]>([]);
  const [assignOpen, setAssignOpen] = useState(false);

  const [copyOpen, setCopyOpen] = useState(false);

  const selected = lists.find((l) => l.id === selectedId) ?? null;

  // Filtrujemy w UI, a nie zapytaniem — lista pozycji jest krótka, a licznik
  // przy każdym filtrze i tak wymaga kompletu (starszy backend `?kind=` zignoruje).
  const kindCount = (k: KindFilter) =>
    k === "all" ? items.length : items.filter((i) => priceItemKind(i) === k).length;
  const visibleItems =
    kindFilter === "all" ? items : items.filter((i) => priceItemKind(i) === kindFilter);
  /** LP. zostaje z pełnej listy, żeby filtr nie przenumerowywał pozycji. */
  const lpById = new Map(items.map((i, idx) => [i.id, idx + 1]));

  // --- ładowanie ---
  const loadLists = useCallback(async (keepId?: number) => {
    setListsLoading(true);
    try {
      const res = await priceListsApi.list();
      const rows = res.data || [];
      setLists(rows);
      setSelectedId((prev) => {
        const want = keepId ?? prev;
        if (want && rows.some((l) => l.id === want)) return want;
        return rows.find((l) => l.isDefault)?.id ?? rows[0]?.id ?? null;
      });
    } catch (error) {
      console.error("Error loading price lists:", error);
    } finally {
      setListsLoading(false);
    }
  }, []);

  const loadTechnicians = useCallback(async () => {
    try {
      const res = await getTechnicians();
      setTechnicians(res.data || []);
    } catch (error) {
      console.error("Error loading technicians:", error);
    }
  }, []);

  useEffect(() => {
    loadLists();
    loadTechnicians();
  }, [loadLists, loadTechnicians]);

  const loadItems = useCallback(async (listId: number | null) => {
    if (!listId) {
      setItems([]);
      setItemsLoading(false);
      return;
    }
    setItemsLoading(true);
    try {
      const [itemsRes, techRes] = await Promise.all([
        getPriceList(listId),
        priceListsApi.technicians(listId),
      ]);
      setItems(itemsRes.data || []);
      setAssigned(techRes.data || []);
      setSelectedItemIds([]);
    } catch (error) {
      console.error("Error loading price list items:", error);
    } finally {
      setItemsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadItems(selectedId);
  }, [selectedId, itemsVersion, loadItems]);

  const refresh = async (keepId?: number) => {
    await loadLists(keepId);
    setItemsVersion((v) => v + 1);
    await loadTechnicians();
  };

  // --- akcje na cennikach ---
  const handleListCreate = async (data: PriceListGroupInput) => {
    if (!editable) return;
    if (duplicateSource) {
      const res = await priceListsApi.duplicate(duplicateSource.id, {
        name: data.name,
        description: data.description,
      });
      await refresh(res.data?.id);
      return;
    }
    const res = await priceListsApi.create(data);
    await refresh(res.data?.id);
  };

  const handleListUpdate = async (data: PriceListGroupInput) => {
    if (!editable || !editingList) return;
    await priceListsApi.update(editingList.id, data);
    await refresh(editingList.id);
  };

  const toggleActive = async (list: PriceListGroup) => {
    if (!editable) return;
    try {
      await priceListsApi.update(list.id, {
        name: list.name,
        description: list.description,
        active: !list.active,
      });
      await refresh(list.id);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Nie można zmienić aktywności"
      );
    }
  };

  const setAsDefault = async (list: PriceListGroup) => {
    if (!editable) return;
    try {
      await priceListsApi.setDefault(list.id);
      await refresh(list.id);
    } catch (error) {
      alert(
        error instanceof Error ? error.message : "Nie można ustawić cennika głównego"
      );
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      // Cennik z pozycjami / technikami usuwamy z przeniesieniem — backend
      // przepisuje pozycje do głównego i zdejmuje przypisania techników.
      const force =
        deleteTarget.itemCount > 0 || deleteTarget.technicianCount > 0;
      await priceListsApi.remove(deleteTarget.id, force);
      setDeleteTarget(null);
      await refresh(undefined);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć cennika");
    } finally {
      setDeleting(false);
    }
  };

  const handleAssign = async (technicianIds: number[]) => {
    if (!editable || !selected) return;
    await priceListsApi.setTechnicians(selected.id, technicianIds);
    await refresh(selected.id);
  };

  // --- akcje na pozycjach ---
  const handlePriceCreate = async (data: PriceItemInput) => {
    if (!editable || !selected) return;
    await createPriceItem({ ...data, priceListId: selected.id });
    await refresh(selected.id);
  };

  const handlePriceUpdate = async (data: PriceItemInput) => {
    if (!editable || !editingPrice) return;
    await updatePriceItem(editingPrice.id, data);
    await refresh(selectedId ?? undefined);
  };

  const handlePriceDelete = async (item: PriceItem) => {
    if (!editable) return;
    if (window.confirm(`Usunąć pozycję "${item.name}" z cennika?`)) {
      try {
        await deletePriceItem(item.id);
        await refresh(selectedId ?? undefined);
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć pozycji"
        );
      }
    }
  };

  const handleCopyItems = async (toListId: number) => {
    if (!editable || !selected) return;
    await priceListsApi.copyItems(
      selected.id,
      toListId,
      selectedItemIds.length > 0 ? selectedItemIds : undefined
    );
    await refresh(selected.id);
  };

  const toggleItemSelection = (id: number) =>
    setSelectedItemIds((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : [...p, id]
    );

  const openPriceForm = (item: PriceItem | null) => {
    setEditingPrice(item);
    setPriceFormOpen(true);
  };

  return (
    <div className="space-y-6">
      {/* min-w-0 na obu kolumnach: bez tego szeroka tabela pozycji rozpycha
          jednokolumnowy grid na telefonie i strona przewija się w poziomie. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[300px_minmax(0,1fr)]">
        {/* Lewa kolumna — cenniki */}
        <Card className="h-fit min-w-0">
          <CardContent className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Cenniki</h3>
              {editable && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid="new-price-list"
                  onClick={() => {
                    setEditingList(null);
                    setDuplicateSource(null);
                    setListFormOpen(true);
                  }}
                >
                  <Plus className="mr-1 h-4 w-4" />
                  Nowy
                </Button>
              )}
            </div>

            {listsLoading ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Ładowanie…
              </p>
            ) : lists.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Brak cenników.
              </p>
            ) : (
              <ul className="space-y-1" data-testid="price-lists">
                {lists.map((l) => (
                  <li key={l.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      data-testid={`price-list-${l.id}`}
                      onClick={() => setSelectedId(l.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          setSelectedId(l.id);
                        }
                      }}
                      className={`w-full cursor-pointer rounded-md border px-3 py-2 text-left transition-colors ${
                        l.id === selectedId
                          ? "border-primary bg-accent"
                          : "border-transparent hover:bg-accent/50"
                      } ${l.active ? "" : "opacity-60"}`}
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="truncate text-sm font-medium">
                              {l.name}
                            </span>
                            {l.isDefault && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
                                <Star className="h-3 w-3" />
                                główny
                              </span>
                            )}
                            {!l.active && (
                              <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                                nieaktywny
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {l.itemCount}{" "}
                            {l.itemCount === 1 ? "pozycja" : "poz."} ·{" "}
                            {l.technicianCount}{" "}
                            {l.technicianCount === 1 ? "technik" : "tech."}
                          </p>
                        </div>
                        {editable && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 shrink-0"
                            title={
                              l.isDefault
                                ? "Cennik główny musi być aktywny"
                                : l.active
                                  ? "Dezaktywuj"
                                  : "Aktywuj"
                            }
                            disabled={l.isDefault}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleActive(l);
                            }}
                          >
                            {l.active ? (
                              <Eye className="h-4 w-4" />
                            ) : (
                              <EyeOff className="h-4 w-4" />
                            )}
                          </Button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Prawa kolumna — pozycje wybranego cennika */}
        <div className="min-w-0 space-y-6">
          {selected && (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base font-semibold">{selected.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {selected.description ||
                    "Cennik usług serwisowych — załącznik do protokołu końcowego."}
                </p>
              </div>
              {editable && (
                <div className="flex flex-wrap gap-2">
                  {!selected.isDefault && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="set-default-list"
                      onClick={() => setAsDefault(selected)}
                    >
                      <Star className="mr-1 h-4 w-4" />
                      Ustaw jako główny
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="edit-price-list"
                    onClick={() => {
                      setEditingList(selected);
                      setDuplicateSource(null);
                      setListFormOpen(true);
                    }}
                  >
                    <Pencil className="mr-1 h-4 w-4" />
                    Zmień nazwę
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="duplicate-price-list"
                    onClick={() => {
                      setEditingList(null);
                      setDuplicateSource(selected);
                      setListFormOpen(true);
                    }}
                  >
                    <CopyPlus className="mr-1 h-4 w-4" />
                    Duplikuj
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={selected.isDefault}
                    title={
                      selected.isDefault
                        ? "Nie można usunąć cennika głównego"
                        : "Usuń cennik"
                    }
                    data-testid="delete-price-list"
                    onClick={() => setDeleteTarget(selected)}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    Usuń
                  </Button>
                  <Button
                    size="sm"
                    data-testid="add-price-item"
                    onClick={() => openPriceForm(null)}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Dodaj pozycję
                  </Button>
                </div>
              )}
            </div>
          )}

          {items.length > 0 && (
            <div
              role="radiogroup"
              aria-label="Filtr rodzaju pozycji"
              data-testid="pricelist-kind-filter"
              className="inline-flex rounded-lg border bg-muted/40 p-0.5"
            >
              {(["all", "service", "material"] as KindFilter[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  role="radio"
                  aria-checked={kindFilter === k}
                  data-testid={`pricelist-kind-filter-${k}`}
                  onClick={() => setKindFilter(k)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                    kindFilter === k
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {KIND_FILTER_LABEL[k]}
                  <span className="ml-1.5 text-xs tabular-nums opacity-70">{kindCount(k)}</span>
                </button>
              ))}
            </div>
          )}

          {editable && items.length > 0 && (
            <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
              <Button
                variant="outline"
                size="sm"
                data-testid="copy-items"
                onClick={() => setCopyOpen(true)}
              >
                <Copy className="mr-1 h-4 w-4" />
                {selectedItemIds.length > 0
                  ? `Kopiuj zaznaczone (${selectedItemIds.length}) do…`
                  : "Kopiuj wszystkie pozycje do…"}
              </Button>
              {selectedItemIds.length > 0 && (
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() => setSelectedItemIds([])}
                >
                  Wyczyść zaznaczenie
                </button>
              )}
            </div>
          )}

          <Card>
            <CardContent className="p-0">
              {itemsLoading ? (
                <div className="py-10 text-center text-muted-foreground">
                  Ładowanie…
                </div>
              ) : items.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Cennik jest pusty.
                </div>
              ) : visibleItems.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground">
                  Brak pozycji rodzaju „{KIND_FILTER_LABEL[kindFilter]}" w tym cenniku.{" "}
                  <button type="button" className="underline" onClick={() => setKindFilter("all")}>
                    Pokaż wszystkie
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                        {editable && <th className="w-10 px-3 py-2"></th>}
                        <th className="w-12 px-3 py-2 font-medium">LP.</th>
                        <th className="px-3 py-2 font-medium">
                          Nazwa pozycji
                        </th>
                        <th className="px-3 py-2 font-medium">Rodzaj</th>
                        <th className="px-3 py-2 font-medium">J.M.</th>
                        <th className="px-3 py-2 text-right font-medium">
                          Cena sprzedaży (netto)
                        </th>
                        <th className="px-3 py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleItems.map((item) => (
                        <tr
                          key={item.id}
                          className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${!item.active ? "opacity-50" : ""}`}
                          onClick={() => openPriceForm(item)}
                        >
                          {editable && (
                            <td
                              className="px-3 py-2"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                className="h-4 w-4 accent-primary"
                                checked={selectedItemIds.includes(item.id)}
                                onChange={() => toggleItemSelection(item.id)}
                                aria-label={`Zaznacz ${item.name}`}
                                data-testid={`select-item-${item.id}`}
                              />
                            </td>
                          )}
                          <td className="px-3 py-2 tabular-nums">
                            {lpById.get(item.id) ?? ""}
                          </td>
                          <td className="px-3 py-2 font-medium">
                            {item.name}
                            {!item.active && (
                              <span className="ml-2 text-xs text-muted-foreground">
                                (nieaktywna)
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-2">
                            <span
                              data-testid={`price-kind-badge-${item.id}`}
                              className={cn(
                                "inline-flex rounded-md px-2 py-0.5 text-xs font-medium",
                                KIND_BADGE[priceItemKind(item)]
                              )}
                              {...tip(KIND_TIP[priceItemKind(item)])}
                            >
                              {PRICE_ITEM_KIND_LABEL[priceItemKind(item)]}
                            </span>
                          </td>
                          <td className="px-3 py-2">{item.unit}</td>
                          <td className="px-3 py-2 text-right font-semibold tabular-nums">
                            {money(item.price)}
                          </td>
                          <td className="px-3 py-2">
                            {editable && (
                              <div
                                className="flex justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8"
                                  onClick={() => openPriceForm(item)}
                                  title="Edytuj"
                                >
                                  <Pencil className="h-4 w-4" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 text-destructive hover:text-destructive"
                                  onClick={() => handlePriceDelete(item)}
                                  title="Usuń"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Technicy korzystający z cennika */}
          {selected && (
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold">
                    <Users className="mr-1 inline h-4 w-4" />
                    Technicy korzystający z tego cennika ({assigned.length})
                  </h4>
                  {editable && (
                    <Button
                      variant="outline"
                      size="sm"
                      data-testid="assign-technicians"
                      onClick={() => setAssignOpen(true)}
                    >
                      Przypisz techników
                    </Button>
                  )}
                </div>
                {assigned.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    {selected.isDefault
                      ? "Technicy bez własnego cennika korzystają z cennika głównego."
                      : "Nikt nie korzysta z tego cennika."}
                  </p>
                ) : (
                  <ul
                    className="flex flex-wrap gap-2"
                    data-testid="assigned-technicians"
                  >
                    {assigned.map((t) => (
                      <li
                        key={t.id}
                        className="rounded-md bg-muted px-2 py-1 text-sm"
                      >
                        {techName(t)}
                        {t.company && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            · {t.company}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {priceFormOpen && (
        <PriceItemForm
          key={editingPrice?.id ?? "new"}
          open={priceFormOpen}
          onClose={() => {
            setPriceFormOpen(false);
            setEditingPrice(null);
          }}
          onSubmit={editingPrice ? handlePriceUpdate : handlePriceCreate}
          item={editingPrice}
        />
      )}

      {listFormOpen && (
        <PriceListForm
          key={editingList?.id ?? (duplicateSource ? `dup-${duplicateSource.id}` : "new")}
          open={listFormOpen}
          onClose={() => {
            setListFormOpen(false);
            setEditingList(null);
            setDuplicateSource(null);
          }}
          onSubmit={editingList ? handleListUpdate : handleListCreate}
          list={editingList}
          duplicateOf={duplicateSource}
        />
      )}

      {assignOpen && selected && (
        <AssignTechniciansDialog
          key={selected.id}
          open={assignOpen}
          onClose={() => setAssignOpen(false)}
          list={selected}
          technicians={technicians}
          assignedIds={assigned.map((t) => t.id)}
          onSubmit={handleAssign}
        />
      )}

      {copyOpen && selected && (
        <CopyItemsDialog
          key={`${selected.id}-${selectedItemIds.length}`}
          open={copyOpen}
          onClose={() => setCopyOpen(false)}
          from={selected}
          lists={lists}
          count={selectedItemIds.length > 0 ? selectedItemIds.length : items.length}
          onSubmit={handleCopyItems}
        />
      )}

      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Usunąć cennik „{deleteTarget?.name}"?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget && deleteTarget.itemCount > 0 ? (
                <>
                  Cennik ma <strong>{deleteTarget.itemCount}</strong> poz. —
                  zostaną <strong>przeniesione do cennika głównego</strong>
                  {deleteTarget.technicianCount > 0 && (
                    <>
                      , a <strong>{deleteTarget.technicianCount}</strong>{" "}
                      przypisanych techników wróci na cennik główny
                    </>
                  )}
                  . Operacji nie można cofnąć.
                </>
              ) : deleteTarget && deleteTarget.technicianCount > 0 ? (
                <>
                  <strong>{deleteTarget.technicianCount}</strong> przypisanych
                  techników wróci na cennik główny. Operacji nie można cofnąć.
                </>
              ) : (
                "Cennik jest pusty — usunięcie nie wpłynie na inne dane."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              data-testid="confirm-delete-price-list"
              disabled={deleting}
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {deleting ? "Usuwanie…" : "Usuń"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
