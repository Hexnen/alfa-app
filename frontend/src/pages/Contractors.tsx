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
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  X,
} from "lucide-react";
import {
  getContractors,
  getObjects,
  getSalespeople,
  salespersonName,
  getCompanies,
  type Company,
  type Salesperson,
  createContractor,
  updateContractor,
  deleteContractor,
  type Contractor,
  type ContractorInput,
  type ContractorSortKey,
  type ObjectWithContractor,
} from "@/lib/api";
import { cn, formatCurrency, objectServicesLabel, statusLabels } from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

/** Filtr sumy abonamentów portfela: wszyscy / tylko z abonamentem / tylko bez. */
type ValueMode = "all" | "with" | "without";

/**
 * Filtr kosztu miesięcznego: wszyscy / tylko z uzupełnionym / tylko bez.
 * „Z uzupełnionym” to kontrahent, który ma CHOĆ JEDEN obiekt z wpisanym kosztem —
 * koszt 0 zł jest uzupełnioną informacją, a brak wpisu znaczy „nikt nie policzył”.
 */
type CostMode = "all" | "with" | "without";

/** Domyślny kierunek sortowania kolumny — kwoty i liczniki ludzie czytają od największych. */
const DEFAULT_DIR: Record<ContractorSortKey, "asc" | "desc"> = {
  name: "asc",
  city: "asc",
  salesperson: "asc",
  objects: "desc",
  value: "desc",
  cost: "desc",
  profit: "desc",
  created: "desc",
};

/** Kartoteka ma setki kontrahentów — lista chodzi po stronach, jak w module technicznym. */
const PAGE_SIZE = 50;

export function Contractors() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("contractors");
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [totals, setTotals] = useState({ objects: 0, value: 0, contractors: 0 });
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [tabCounts, setTabCounts] = useState({ active: 0, archived: 0 });
  const [loading, setLoading] = useState(true);

  // Filtry tekstowe trzymamy osobno od tych wysyłanych do API — wpisywanie w pole
  // nie może strzelać żądaniem na każdą literę (debounce niżej).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [range, setRange] = useState<{ min?: number; max?: number }>({});

  /** Zakładka: kontrahenci bieżący albo archiwalni (flaga `active`). */
  const [view, setView] = useState<"active" | "archived">("active");
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [salespersonFilter, setSalespersonFilter] = useState<number | "none" | undefined>(undefined);
  const [companyFilter, setCompanyFilter] = useState<number | "none" | undefined>(undefined);
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  const [costMode, setCostMode] = useState<CostMode>("all");

  const [sort, setSort] = useState<ContractorSortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

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

  // Debounce pól tekstowych (szukajka i widełki kwot).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const t = setTimeout(() => {
      const num = (v: string) => {
        const n = parseFloat(v.replace(",", "."));
        return Number.isFinite(n) ? n : undefined;
      };
      setRange({ min: num(minInput), max: num(maxInput) });
    }, 300);
    return () => clearTimeout(t);
  }, [minInput, maxInput]);

  /**
   * Zmiana zakładki, filtra albo sortowania wraca na pierwszą stronę — inaczej po
   * wejściu na stronę 5 „Archiwalnych" zakładka „Aktualni" świeciłaby pustką.
   * Przestawiamy jeszcze W TRAKCIE renderu (a nie w efekcie), żeby nie poszło
   * zbędne żądanie o starą stronę z nowym filtrem.
   */
  const filtersKey = [
    search,
    view,
    salespersonFilter ?? "",
    companyFilter ?? "",
    range.min ?? "",
    range.max ?? "",
    valueMode,
    costMode,
    sort,
    dir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const loadContractors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getContractors({
        search,
        active: view === "active" ? "1" : "0",
        salespersonId: salespersonFilter,
        companyId: companyFilter,
        minValue: range.min,
        maxValue: range.max,
        hasValue: valueMode === "with" ? "1" : valueMode === "without" ? "0" : undefined,
        hasCost: costMode === "with" ? "1" : costMode === "without" ? "0" : undefined,
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setContractors(res.data);
      setTotals({
        objects: res.totalObjects ?? 0,
        value: res.totalMonthlyValue ?? 0,
        contractors: res.total ?? res.data.length,
      });
      setTotalPages(Math.max(1, res.totalPages ?? 1));
      setTabCounts({ active: res.activeCount ?? 0, archived: res.archivedCount ?? 0 });
    } catch (error) {
      console.error("Error loading contractors:", error);
    } finally {
      setLoading(false);
    }
  }, [
    search,
    view,
    salespersonFilter,
    companyFilter,
    range.min,
    range.max,
    valueMode,
    costMode,
    sort,
    dir,
    page,
  ]);

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
    const companyId = params.get("companyId");
    if (companyId) {
      setCompanyFilter(companyId === "none" ? "none" : parseInt(companyId));
    }
    // `?hasValue=0` / `?hasCost=0` — wejście z kafelka analityki („uzupełnij koszty”).
    // Bez tego odczytu lista otwierałaby się nieprzefiltrowana i użytkownik dostawałby
    // całą kartotekę zamiast braków (ta sama zasada, co na liście obiektów).
    const hasValue = params.get("hasValue");
    if (hasValue === "0") setValueMode("without");
    else if (hasValue === "1") setValueMode("with");
    const hasCost = params.get("hasCost");
    if (hasCost === "0") setCostMode("without");
    else if (hasCost === "1") setCostMode("with");
  }, []);

  useEffect(() => {
    getSalespeople()
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
    getCompanies()
      .then((res) => setCompanies(res.data ?? []))
      .catch(() => setCompanies([]));
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

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: ContractorSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    salespersonFilter !== undefined ||
    companyFilter !== undefined ||
    valueMode !== "all" ||
    costMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearchInput("");
    setSalespersonFilter(undefined);
    setCompanyFilter(undefined);
    setValueMode("all");
    setCostMode("all");
    setMinInput("");
    setMaxInput("");
  };

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

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
  }: {
    label: string;
    sortKey: ContractorSortKey;
    align?: "left" | "right";
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`contractors-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
            align === "right" && "flex-row-reverse",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
        </button>
      </th>
    );
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj kontrahenta..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
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

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy kontrahent
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: spółka i sumy abonamentów — tryby i widełki kwot. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={companyFilter === undefined ? "all" : String(companyFilter)}
          onValueChange={(v) =>
            setCompanyFilter(v === "all" ? undefined : v === "none" ? "none" : parseInt(v))
          }
        >
          <SelectTrigger className="w-[180px]" data-testid="contractors-filter-company">
            <SelectValue placeholder="Spółka" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie spółki</SelectItem>
            <SelectItem value="none">Bez spółki</SelectItem>
            {companies.map((co) => (
              <SelectItem key={co.id} value={String(co.id)}>
                {co.name}
                {!co.active ? " (archiwalna)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
          <SelectTrigger className="w-[200px]" data-testid="contractors-filter-value-mode">
            <SelectValue placeholder="Wartosc" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wartość: wszystkie</SelectItem>
            <SelectItem value="with">Tylko z abonamentem</SelectItem>
            <SelectItem value="without">Tylko bez abonamentu</SelectItem>
          </SelectContent>
        </Select>

        {/* Filtr kosztu MUSI być widoczny, a nie tylko wczytany z URL-a: wejście
            z kafelka analityki zawęża listę do braków i użytkownik ma prawo
            wiedzieć, dlaczego nie widzi całej kartoteki. */}
        <Select value={costMode} onValueChange={(v) => setCostMode(v as CostMode)}>
          <SelectTrigger className="w-[220px]" data-testid="contractors-filter-cost-mode">
            <SelectValue placeholder="Koszt" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Koszt: wszystkie</SelectItem>
            <SelectItem value="with">Tylko z uzupełnionym kosztem</SelectItem>
            <SelectItem value="without">Tylko bez uzupełnionego kosztu</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Kwota od</span>
          <Input
            type="number"
            min="0"
            step="50"
            inputMode="decimal"
            className="w-28 tabular-nums"
            data-testid="contractors-filter-min"
            value={minInput}
            onChange={(e) => setMinInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="number"
            min="0"
            step="50"
            inputMode="decimal"
            className="w-28 tabular-nums"
            data-testid="contractors-filter-max"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
          <span>zł/mies.</span>
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="contractors-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
        <p className="ml-auto text-sm text-muted-foreground" data-testid="contractors-summary">
          {/* Liczymy CAŁY wynik filtrowania, a nie wczytaną stronę — obok stoją
              sumy obiektów i abonamentów z całego wyniku i muszą się zgadzać. */}
          {totals.contractors}{" "}
          {totals.contractors === 1 ? "kontrahent" : "kontrahentów"} ·{" "}
          {totals.objects} {totals.objects === 1 ? "obiekt" : "obiektów"} ·{" "}
          {formatCurrency(totals.value)} / mies. ·{" "}
          {/* Jedno zdanie o konwencji na ekran — abonamenty i koszty są bez VAT. */}
          kwoty netto (bez VAT)
        </p>
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
              {filtersActive
                ? "Brak kontrahentów dla wybranych filtrów"
                : view === "archived"
                  ? "Brak archiwalnych kontrahentów"
                  : "Brak kontrahentow"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <SortHeader label="Nazwa" sortKey="name" />
                    {/* NIP, telefon i osoba kontaktowa to dane kontaktowe — nie ma
                        po czym ich sensownie porządkować, więc nagłówki zostają
                        zwykłe (tak jak kolumna „Usługi" na liście obiektów). */}
                    <th className="text-left py-3 px-2 font-medium">NIP</th>
                    <SortHeader label="Miasto" sortKey="city" />
                    <th className="text-left py-3 px-2 font-medium">Telefon</th>
                    <th className="text-left py-3 px-2 font-medium">
                      Osoba kontaktowa
                    </th>
                    <SortHeader label="Handlowiec" sortKey="salesperson" />
                    <SortHeader label="Obiekty" sortKey="objects" align="right" />
                    <SortHeader label="Abonament" sortKey="value" align="right" />
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
                      rows.reduce((a, o) => a + (o.monthlyValue ?? 0) + (o.monthlyRental ?? 0), 0);
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
                                    <col className="w-[32%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[12%]" />
                                    <col className="w-[14%]" />
                                    <col className="w-[10%]" />
                                    <col className="w-[10%]" />
                                    <col className="w-[10%]" />
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
                                        Usługi
                                      </th>
                                      <th className="py-1 px-2 text-left font-medium">
                                        Status
                                      </th>
                                      <th className="py-1 px-2 text-right font-medium">
                                        Abonament
                                      </th>
                                      <th className="py-1 px-2 text-right font-medium">
                                        Koszt
                                      </th>
                                      <th className="py-1 px-2 text-right font-medium">
                                        Zysk
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
                                          {objectServicesLabel(o)}
                                        </td>
                                        <td className="py-1.5 px-2">
                                          <Badge variant={statusColors[o.status]}>
                                            {statusLabels[o.status] || o.status}
                                          </Badge>
                                        </td>
                                        {/* Przychód = abonament + dzierżawa sprzętu. */}
                                        <td className="py-1.5 px-2 text-right tabular-nums">
                                          {formatCurrency(
                                            (o.monthlyValue ?? 0) +
                                              (o.monthlyRental ?? 0)
                                          )}
                                        </td>
                                        {/* Brak kosztu = nieuzupełniony, nie 0 zł. */}
                                        <td className="py-1.5 px-2 text-right tabular-nums">
                                          {o.monthlyCost === null ? (
                                            <span className="text-muted-foreground">—</span>
                                          ) : (
                                            formatCurrency(o.monthlyCost)
                                          )}
                                        </td>
                                        <td className="py-1.5 px-2 text-right tabular-nums">
                                          {o.monthlyCost === null ? (
                                            <span className="text-muted-foreground">—</span>
                                          ) : (
                                            formatCurrency(
                                              (o.monthlyValue ?? 0) +
                                                (o.monthlyRental ?? 0) -
                                                o.monthlyCost
                                            )
                                          )}
                                        </td>
                                      </tr>
                                    ))}
                                    {(() => {
                                      // Przychód sumuje się po WSZYSTKICH obiektach,
                                      // a koszt tylko po tych z uzupełnioną kwotą —
                                      // więc różnica jest zyskiem WYŁĄCZNIE przy
                                      // komplecie kosztów. Bez tej bramki VITROMET
                                      // pokazywał „23 610 zł zysku”, mając „—” w
                                      // koszcie trzech z czterech obiektów. Wiersze
                                      // pojedyncze robią to samo od zawsze (`—`),
                                      // podsumowanie im dotąd przeczyło.
                                      const missing = rows.filter(
                                        (o) => o.monthlyCost === null
                                      ).length;
                                      const known = rows.length - missing;
                                      const value = rows.reduce(
                                        (a, o) =>
                                          a + (o.monthlyValue ?? 0) + (o.monthlyRental ?? 0),
                                        0
                                      );
                                      const cost = rows.reduce(
                                        (a, o) => a + (o.monthlyCost ?? 0),
                                        0
                                      );
                                      return (
                                        <tr className="border-t">
                                          <td
                                            className="py-1.5 pl-6 pr-2 font-medium"
                                            colSpan={4}
                                          >
                                            Razem: {rows.length}{" "}
                                            {rows.length === 1 ? "obiekt" : "obiektów"}
                                            {missing > 0 && (
                                              <span className="ml-1 font-normal text-muted-foreground">
                                                · koszt uzupełniony w {known} z{" "}
                                                {rows.length}
                                              </span>
                                            )}
                                          </td>
                                          <td className="py-1.5 px-2 text-right font-medium tabular-nums">
                                            {formatCurrency(value)} / mies.
                                          </td>
                                          <td
                                            className="py-1.5 px-2 text-right font-medium tabular-nums"
                                            title={
                                              missing > 0
                                                ? `Suma z ${known} obiektów; ${missing} bez uzupełnionego kosztu`
                                                : undefined
                                            }
                                          >
                                            {known > 0 ? (
                                              formatCurrency(cost)
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                          <td
                                            className="py-1.5 px-2 text-right font-medium tabular-nums"
                                            title={
                                              missing > 0
                                                ? `Zysku nie da się policzyć: ${missing} ${missing === 1 ? "obiekt nie ma" : "obiektów nie ma"} uzupełnionego kosztu`
                                                : undefined
                                            }
                                          >
                                            {missing === 0 && rows.length > 0 ? (
                                              formatCurrency(value - cost)
                                            ) : (
                                              <span className="text-muted-foreground">—</span>
                                            )}
                                          </td>
                                        </tr>
                                      );
                                    })()}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2" data-testid="contractors-pagination">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronLeft className="h-4 w-4" /> Poprzednia
          </Button>
          <span className="text-sm text-muted-foreground">
            Strona {page} z {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            Następna <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}

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
