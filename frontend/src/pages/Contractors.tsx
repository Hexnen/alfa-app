import { Fragment, useEffect, useMemo, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/admin-assistant/shared";
import { ContractorForm } from "@/components/ContractorForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Plus,
  Search,
  Pencil,
  Trash2,
  Building2,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import {
  getContractors,
  getObjects,
  getSalespeople,
  salespersonName,
  type Salesperson,
  createContractor,
  updateContractor,
  deleteContractor,
  type Contractor,
  type ContractorInput,
  type ObjectWithContractor,
} from "@/lib/api";
import { formatCurrency, objectTypeLabels, statusLabels } from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

export function Contractors() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("contractors");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [totals, setTotals] = useState({ objects: 0, value: 0 });
  const [tabCounts, setTabCounts] = useState({ active: 0, archived: 0 });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  /** Zakładka: kontrahenci bieżący albo archiwalni (flaga `active`). */
  const [view, setView] = useState<"active" | "archived">("active");
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [salespersonFilter, setSalespersonFilter] = useState<number | "none" | undefined>(undefined);
  const [formOpen, setFormOpen] = useState(false);
  const [editingContractor, setEditingContractor] = useState<Contractor | null>(
    null
  );

  /**
   * Widok rozwinięty: pod każdym kontrahentem lista jego obiektów z abonamentami.
   * Obiekty ciągniemy dopiero po włączeniu przełącznika (jednym żądaniem dla wszystkich)
   * — w widoku zwiniętym wystarczą agregaty, które liczy już GET /contractors.
   */
  const [expanded, setExpanded] = useState(false);
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [objectsLoading, setObjectsLoading] = useState(false);

  const loadContractors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getContractors({
        search,
        active: view === "active" ? "1" : "0",
        salespersonId: salespersonFilter,
        pageSize: 100,
      });
      setContractors(res.data);
      setTotals({
        objects: res.totalObjects ?? 0,
        value: res.totalMonthlyValue ?? 0,
      });
      setTabCounts({ active: res.activeCount ?? 0, archived: res.archivedCount ?? 0 });
    } catch (error) {
      console.error("Error loading contractors:", error);
    } finally {
      setLoading(false);
    }
  }, [search, view, salespersonFilter]);

  useEffect(() => {
    loadContractors();
  }, [loadContractors]);

  // Wejście z zakładki „Handlowcy”: /contractors?salespersonId=3
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const salespersonId = params.get("salespersonId");
    if (salespersonId) {
      setSalespersonFilter(salespersonId === "none" ? "none" : parseInt(salespersonId));
    }
  }, []);

  useEffect(() => {
    getSalespeople()
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
  }, []);

  const loadObjects = useCallback(async () => {
    setObjectsLoading(true);
    try {
      const res = await getObjects({ pageSize: 1000, sort: "value", dir: "desc" });
      setObjects(res.data);
    } catch (error) {
      console.error("Error loading objects:", error);
      setObjects([]);
    } finally {
      setObjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (expanded && objects.length === 0 && !objectsLoading) loadObjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded]);

  /** Obiekty pogrupowane po kontrahencie — malejąco po abonamencie (kolejność z API). */
  const objectsByContractor = useMemo(() => {
    const map = new Map<number, ObjectWithContractor[]>();
    for (const o of objects) {
      const list = map.get(o.contractorId);
      if (list) list.push(o);
      else map.set(o.contractorId, [o]);
    }
    return map;
  }, [objects]);

  const handleCreate = async (data: ContractorInput) => {
    if (!editable) return;
    await createContractor(data);
    loadContractors();
    if (expanded) loadObjects();
  };

  const handleUpdate = async (data: ContractorInput) => {
    if (!editable) return;
    if (editingContractor) {
      await updateContractor(editingContractor.id, data);
      loadContractors();
    }
  };

  /** Archiwum jest miękkie — kontrahent znika z zakładki „Aktualni”, historia zostaje. */
  const toggleArchive = async (contractor: Contractor) => {
    if (!editable) return;
    try {
      // Wysyłamy SAM przełącznik — pełny wiersz niesie też pola wyliczane
      // (handlowiec, liczniki), których backend nie ma gdzie zapisać.
      await updateContractor(contractor.id, { active: !contractor.active });
      loadContractors();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się zmienić statusu");
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac tego kontrahenta?")) {
      try {
        await deleteContractor(id);
        loadContractors();
        if (expanded) loadObjects();
      } catch (error) {
        alert(
          error instanceof Error
            ? error.message
            : "Nie mozna usunac kontrahenta"
        );
      }
    }
  };

  const openEditForm = (contractor: Contractor) => {
    setEditingContractor(contractor);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingContractor(null);
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj kontrahenta..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select
          value={salespersonFilter === undefined ? "all" : String(salespersonFilter)}
          onValueChange={(v) =>
            setSalespersonFilter(v === "all" ? undefined : v === "none" ? "none" : parseInt(v))
          }
        >
          <SelectTrigger className="w-[190px]" data-testid="contractors-filter-salesperson">
            <SelectValue placeholder="Handlowiec" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy handlowcy</SelectItem>
            <SelectItem value="none">Bez handlowca</SelectItem>
            {salespeople.map((sp) => (
              <SelectItem key={sp.id} value={String(sp.id)}>
                {salespersonName(sp)}
                {!sp.active ? " (archiwalny)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <label
          className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground"
          htmlFor="contractors-expanded"
        >
          <Switch
            id="contractors-expanded"
            checked={expanded}
            onChange={setExpanded}
            label="Pokaż obiekty i abonamenty"
          />
          <span>Widok rozwinięty</span>
        </label>

        <p className="text-sm text-muted-foreground" data-testid="contractors-summary">
          {contractors.length}{" "}
          {contractors.length === 1 ? "kontrahent" : "kontrahentów"} ·{" "}
          {totals.objects} {totals.objects === 1 ? "obiekt" : "obiektów"} ·{" "}
          {formatCurrency(totals.value)} / mies.
        </p>

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy kontrahent
          </Button>
        )}
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active" data-testid="contractors-tab-active">
            Aktualni ({tabCounts.active})
          </TabsTrigger>
          <TabsTrigger value="archived" data-testid="contractors-tab-archived">
            Archiwalni ({tabCounts.archived})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="text-center py-8">Ladowanie...</div>
          ) : contractors.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {view === "archived" ? "Brak archiwalnych kontrahentów" : "Brak kontrahentow"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-3 px-2 font-medium">Nazwa</th>
                    <th className="text-left py-3 px-2 font-medium">NIP</th>
                    <th className="text-left py-3 px-2 font-medium">Miasto</th>
                    <th className="text-left py-3 px-2 font-medium">Telefon</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Osoba kontaktowa
                    </th>
                    <th className="text-left py-3 px-2 font-medium">Handlowiec</th>
                    <th className="text-right py-3 px-2 font-medium">Obiekty</th>
                    <th className="text-right py-3 px-2 font-medium">
                      Abonament
                    </th>
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {contractors.map((contractor) => {
                    const rows = objectsByContractor.get(contractor.id) ?? [];
                    const count = contractor.objectsCount ?? rows.length;
                    const active = contractor.activeObjectsCount ?? 0;
                    const value =
                      contractor.objectsMonthlyValue ??
                      rows.reduce((a, o) => a + (o.monthlyValue ?? 0), 0);
                    return (
                      <Fragment key={contractor.id}>
                        <tr className="border-b hover:bg-muted/50">
                          <td className="py-3 px-2">
                            <button
                              className="font-medium text-primary hover:underline text-left"
                              onClick={() =>
                                navigate(`/objects?contractorId=${contractor.id}`)
                              }
                            >
                              {contractor.name}
                            </button>
                          </td>
                          <td className="py-3 px-2">{contractor.nip}</td>
                          <td className="py-3 px-2">{contractor.city || "-"}</td>
                          <td className="py-3 px-2">{contractor.phone || "-"}</td>
                          <td className="py-3 px-2">
                            {contractor.contactPerson || "-"}
                          </td>
                          <td className="py-3 px-2">
                            {contractor.salesperson ? (
                              <button
                                className="text-left hover:underline"
                                onClick={() => setSalespersonFilter(contractor.salesperson!.id)}
                                title="Pokaż tylko klientów tego handlowca"
                              >
                                {salespersonName(contractor.salesperson)}
                              </button>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                          <td
                            className="py-3 px-2 text-right tabular-nums"
                            data-testid={`contractor-objects-${contractor.id}`}
                          >
                            {count === 0 ? (
                              <span className="text-muted-foreground">0</span>
                            ) : (
                              <>
                                {count}
                                {active > 0 && active !== count && (
                                  <span className="text-muted-foreground">
                                    {" "}
                                    ({active} akt.)
                                  </span>
                                )}
                              </>
                            )}
                          </td>
                          <td
                            className="py-3 px-2 text-right tabular-nums font-medium"
                            data-testid={`contractor-value-${contractor.id}`}
                          >
                            {value > 0 ? (
                              formatCurrency(value)
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )}
                          </td>
                          <td className="py-3 px-2">
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() =>
                                  navigate(
                                    `/objects?contractorId=${contractor.id}`
                                  )
                                }
                                title="Zobacz obiekty"
                              >
                                <Building2 className="h-4 w-4" />
                              </Button>
                              {editable && (
                                <>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => openEditForm(contractor)}
                                    title="Edytuj"
                                  >
                                    <Pencil className="h-4 w-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => toggleArchive(contractor)}
                                    title={
                                      contractor.active
                                        ? "Przenieś do archiwum"
                                        : "Przywróć do aktualnych"
                                    }
                                    data-testid={`contractor-archive-${contractor.id}`}
                                  >
                                    {contractor.active ? (
                                      <Archive className="h-4 w-4" />
                                    ) : (
                                      <ArchiveRestore className="h-4 w-4" />
                                    )}
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    onClick={() => handleDelete(contractor.id)}
                                    title="Usun"
                                  >
                                    <Trash2 className="h-4 w-4 text-destructive" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>

                        {expanded && (
                          <tr className="border-b bg-muted/30">
                            <td colSpan={9} className="px-2 py-2">
                              {objectsLoading ? (
                                <p className="py-2 pl-6 text-sm text-muted-foreground">
                                  Ładowanie obiektów…
                                </p>
                              ) : rows.length === 0 ? (
                                <p className="py-2 pl-6 text-sm text-muted-foreground">
                                  Brak obiektów u tego kontrahenta.
                                </p>
                              ) : (
                                <table className="w-full table-fixed text-sm">
                                  <colgroup>
                                    <col className="w-[38%]" />
                                    <col className="w-[15%]" />
                                    <col className="w-[15%]" />
                                    <col className="w-[16%]" />
                                    <col className="w-[16%]" />
                                  </colgroup>
                                  <thead>
                                    <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                                      <th className="py-1 pl-6 pr-2 text-left font-medium">
                                        Obiekt
                                      </th>
                                      <th className="py-1 px-2 text-left font-medium">
                                        Miasto
                                      </th>
                                      <th className="py-1 px-2 text-left font-medium">
                                        Typ
                                      </th>
                                      <th className="py-1 px-2 text-left font-medium">
                                        Status
                                      </th>
                                      <th className="py-1 px-2 text-right font-medium">
                                        Abonament
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {rows.map((o) => (
                                      <tr key={o.id} className="hover:bg-background/60">
                                        <td className="py-1.5 pl-6 pr-2">
                                          <button
                                            className="text-left text-primary hover:underline"
                                            onClick={() => navigate(`/objects/${o.id}`)}
                                          >
                                            {o.name}
                                          </button>
                                        </td>
                                        <td className="py-1.5 px-2">{o.city || "-"}</td>
                                        <td className="py-1.5 px-2">
                                          {objectTypeLabels[o.type] || o.type}
                                        </td>
                                        <td className="py-1.5 px-2">
                                          <Badge variant={statusColors[o.status]}>
                                            {statusLabels[o.status] || o.status}
                                          </Badge>
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums">
                                          {formatCurrency(o.monthlyValue)}
                                        </td>
                                      </tr>
                                    ))}
                                    <tr className="border-t">
                                      <td
                                        className="py-1.5 pl-6 pr-2 font-medium"
                                        colSpan={4}
                                      >
                                        Razem: {rows.length}{" "}
                                        {rows.length === 1 ? "obiekt" : "obiektów"}
                                      </td>
                                      <td className="py-1.5 px-2 text-right font-medium tabular-nums">
                                        {formatCurrency(
                                          rows.reduce(
                                            (a, o) => a + (o.monthlyValue ?? 0),
                                            0
                                          )
                                        )}{" "}
                                        / mies.
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t">
                    <td className="py-3 px-2 font-medium" colSpan={6}>
                      Razem
                    </td>
                    <td className="py-3 px-2 text-right font-medium tabular-nums">
                      {totals.objects}
                    </td>
                    <td className="py-3 px-2 text-right font-medium tabular-nums">
                      {formatCurrency(totals.value)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <ContractorForm
        // Remount przy każdym otwarciu — inaczej stan formularza (w tym dane
        // podstawione z wykazu MF) przenosi się na kolejnego kontrahenta.
        key={`${editingContractor?.id ?? "new"}-${formOpen}`}
        open={formOpen}
        onClose={closeForm}
        onSubmit={editingContractor ? handleUpdate : handleCreate}
        contractor={editingContractor}
      />
    </div>
  );
}
