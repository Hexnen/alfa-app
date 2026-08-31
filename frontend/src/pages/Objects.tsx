import { useEffect, useState, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ObjectForm } from "@/components/ObjectForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Plus,
  Search,
  Eye,
  Pencil,
  Trash2,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  X,
} from "lucide-react";
import {
  getObjects,
  getContractors,
  getSalespeople,
  salespersonName,
  getCompanies,
  type Company,
  type Salesperson,
  createObject,
  updateObject,
  deleteObject,
  type Contractor,
  type ObjectSortKey,
  type ObjectWithContractor,
  type ObjectInput,
} from "@/lib/api";
import {
  objectServiceLabels,
  objectServicesLabel,
  type ObjectServiceKey,
  statusLabels,
  departmentLabels,
  formatCurrency,
  cn,
} from "@/lib/utils";

const statusColors: Record<string, "warning" | "info" | "success" | "secondary"> = {
  pending: "warning",
  in_progress: "info",
  active: "success",
  inactive: "secondary",
};

const departmentColors: Record<string, "default" | "secondary" | "outline"> = {
  sales: "default",
  technical: "secondary",
  accounting: "outline",
};

/** Filtr wartości miesięcznej: wszystkie / tylko z abonamentem / tylko bez. */
type ValueMode = "all" | "with" | "without";

/**
 * Filtr kosztu miesięcznego: wszystkie / tylko z uzupełnionym / tylko bez.
 * „Bez” to `monthly_cost IS NULL` — koszt 0 zł jest uzupełnioną informacją.
 */
type CostMode = "all" | "with" | "without";

/** Domyślny kierunek sortowania kolumny — kwoty ludzie czytają od największej. */
const DEFAULT_DIR: Record<ObjectSortKey, "asc" | "desc"> = {
  name: "asc",
  contractor: "asc",
  city: "asc",
  status: "asc",
  department: "asc",
  salesperson: "asc",
  company: "asc",
  value: "desc",
  cost: "desc",
  profit: "desc",
  created: "desc",
};

export function Objects() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("objects");
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [summary, setSummary] = useState({
    total: 0,
    value: 0,
    withValue: 0,
    cost: 0,
    withCost: 0,
  });
  const [contractors, setContractors] = useState<Contractor[]>([]);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  /** Zakładki listy + liczniki z API (liczone przy bieżących filtrach). */
  const [scope, setScope] = useState<"current" | "archived">("current");
  const [tabCounts, setTabCounts] = useState({ current: 0, archived: 0 });

  // Filtry tekstowe trzymamy osobno od tych wysyłanych do API — wpisywanie w pole
  // nie może strzelać żądaniem na każdą literę (debounce niżej).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [range, setRange] = useState<{ min?: number; max?: number }>({});

  const [statusFilter, setStatusFilter] = useState("all");
  const [departmentFilter, setDepartmentFilter] = useState("all");
  // Filtr po USŁUDZE, a nie po jednym „typie ochrony”: usługi nie są rozłączne,
  // więc filtr wybiera obiekty MAJĄCE daną usługę — obiekt z kamerami i SSWiN-em
  // widać pod obydwoma.
  const [serviceFilter, setServiceFilter] = useState<ObjectServiceKey | "all">("all");
  const [contractorFilter, setContractorFilter] = useState<number | undefined>(undefined);
  const [salespersonFilter, setSalespersonFilter] = useState<number | "none" | undefined>(undefined);
  const [companyFilter, setCompanyFilter] = useState<number | "none" | undefined>(undefined);
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  // Wejście z każdego kafelka analityki (/objects?hasCost=0 — „uzupełnij koszty”).
  const [costMode, setCostMode] = useState<CostMode>("all");

  const [sort, setSort] = useState<ObjectSortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const [formOpen, setFormOpen] = useState(false);
  const [editingObject, setEditingObject] = useState<ObjectWithContractor | null>(
    null
  );

  // Wejście z kartoteki kontrahenta (/objects?contractorId=12) albo od handlowca
  // (/objects?salespersonId=3 — link z zakładki „Handlowcy”).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const contractorId = params.get("contractorId");
    if (contractorId) setContractorFilter(parseInt(contractorId));
    const salespersonId = params.get("salespersonId");
    if (salespersonId) {
      setSalespersonFilter(salespersonId === "none" ? "none" : parseInt(salespersonId));
    }
    const companyId = params.get("companyId");
    if (companyId) {
      setCompanyFilter(companyId === "none" ? "none" : parseInt(companyId));
    }
    // `?hasCost=0` — link „uzupełnij koszty” spod KAŻDEGO kafelka analityki
    // (parts.tsx, ObiektyView, HandlowcyView). Bez tego odczytu lista otwierała
    // się nieprzefiltrowana i użytkownik dostawał wszystko zamiast braków.
    const hasCost = params.get("hasCost");
    if (hasCost === "0") setCostMode("without");
    else if (hasCost === "1") setCostMode("with");
  }, []);

  useEffect(() => {
    getContractors({ pageSize: 500 })
      .then((res) => setContractors(res.data))
      .catch(() => setContractors([]));
    getSalespeople()
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
    getCompanies()
      .then((res) => setCompanies(res.data ?? []))
      .catch(() => setCompanies([]));
  }, []);

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

  const loadObjects = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getObjects({
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        department: departmentFilter !== "all" ? departmentFilter : undefined,
        service: serviceFilter !== "all" ? serviceFilter : undefined,
        contractorId: contractorFilter,
        salespersonId: salespersonFilter,
        companyId: companyFilter,
        scope,
        minValue: range.min,
        maxValue: range.max,
        hasValue: valueMode === "with" ? "1" : valueMode === "without" ? "0" : undefined,
        hasCost: costMode === "with" ? "1" : costMode === "without" ? "0" : undefined,
        sort,
        dir,
        pageSize: 200,
      });
      setObjects(res.data);
      setSummary({
        total: res.total,
        value: res.totalMonthlyValue ?? 0,
        withValue: res.withMonthlyValue ?? 0,
        cost: res.totalMonthlyCost ?? 0,
        withCost: res.withMonthlyCost ?? 0,
      });
      setTabCounts({ current: res.currentCount ?? 0, archived: res.archivedCount ?? 0 });
    } catch (error) {
      console.error("Error loading objects:", error);
    } finally {
      setLoading(false);
    }
  }, [
    search,
    statusFilter,
    departmentFilter,
    serviceFilter,
    contractorFilter,
    salespersonFilter,
    companyFilter,
    scope,
    range.min,
    range.max,
    valueMode,
    costMode,
    sort,
    dir,
  ]);

  useEffect(() => {
    loadObjects();
  }, [loadObjects]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: ObjectSortKey) => {
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
    statusFilter !== "all" ||
    departmentFilter !== "all" ||
    serviceFilter !== "all" ||
    contractorFilter !== undefined ||
    valueMode !== "all" ||
    costMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearchInput("");
    setStatusFilter("all");
    setDepartmentFilter("all");
    setServiceFilter("all");
    setContractorFilter(undefined);
    setSalespersonFilter(undefined);
    setCompanyFilter(undefined);
    setValueMode("all");
    setCostMode("all");
    setMinInput("");
    setMaxInput("");
  };

  const handleCreate = async (data: ObjectInput) => {
    if (!editable) return;
    await createObject(data);
    loadObjects();
  };

  const handleUpdate = async (data: ObjectInput) => {
    if (!editable) return;
    if (editingObject) {
      await updateObject(editingObject.id, data);
      loadObjects();
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac ten obiekt?")) {
      try {
        await deleteObject(id);
        loadObjects();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie mozna usunac obiektu"
        );
      }
    }
  };

  const openEditForm = (obj: ObjectWithContractor) => {
    setEditingObject(obj);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingObject(null);
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
  }: {
    label: string;
    sortKey: ObjectSortKey;
    align?: "left" | "right";
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`objects-sort-${sortKey}`}
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

  const summaryLine = useMemo(() => {
    const parts = [`${summary.total} ${summary.total === 1 ? "obiekt" : "obiektów"}`];
    if (summary.withValue > 0) {
      parts.push(`suma abonamentów ${formatCurrency(summary.value)} / mies.`);
      parts.push(`z abonamentem: ${summary.withValue}`);
    }
    // Koszty pokazujemy tylko, gdy ktoś je w ogóle uzupełnił — inaczej „zysk”
    // byłby po prostu przepisaną sumą abonamentów i wprowadzał w błąd.
    if (summary.withCost > 0) {
      parts.push(`koszty ${formatCurrency(summary.cost)}`);
      parts.push(`koszt uzupełniony: ${summary.withCost}`);
    }
    // Zysk = przychód − koszt, ale przychód sumuje się po WSZYSTKICH obiektach,
    // a koszt tylko po uzupełnionych. Dopóki brakuje choćby jednego kosztu, ta
    // różnica nie jest zyskiem, tylko liczbą zawyżoną o obiekty bez kosztu —
    // bramka `withCost > 0` puszczała tu „zysk 223 010 zł" przy 26 obiektach
    // wnoszących sam przychód. Ta sama reguła co w Analityce i w Kontrahentach.
    const missingCost = summary.total - summary.withCost;
    if (summary.total > 0) {
      parts.push(
        missingCost === 0 && summary.withCost > 0
          ? `zysk ${formatCurrency(summary.value - summary.cost)}`
          : `zysk — (brak kosztu w ${missingCost} ${missingCost === 1 ? "obiekcie" : "obiektach"})`
      );
    }
    // Jedno zdanie o konwencji na ekran zamiast dopisku „netto” przy każdej
    // kolumnie — kwoty handlowe w całej aplikacji są bez VAT.
    parts.push("kwoty netto (bez VAT)");
    return parts.join(" · ");
  }, [summary]);

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj obiektu..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select
          value={contractorFilter === undefined ? "all" : String(contractorFilter)}
          onValueChange={(v) => setContractorFilter(v === "all" ? undefined : parseInt(v))}
        >
          <SelectTrigger className="w-[220px]" data-testid="objects-filter-contractor">
            <SelectValue placeholder="Kontrahent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy kontrahenci</SelectItem>
            {contractors.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={salespersonFilter === undefined ? "all" : String(salespersonFilter)}
          onValueChange={(v) =>
            setSalespersonFilter(v === "all" ? undefined : v === "none" ? "none" : parseInt(v))
          }
        >
          <SelectTrigger className="w-[190px]" data-testid="objects-filter-salesperson">
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

        <Select
          value={serviceFilter}
          onValueChange={(v) => setServiceFilter(v as ObjectServiceKey | "all")}
        >
          <SelectTrigger className="w-[190px]" data-testid="objects-filter-service">
            <SelectValue placeholder="Usługa" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie usługi</SelectItem>
            {Object.entries(objectServiceLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[170px]" data-testid="objects-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie statusy</SelectItem>
            {Object.entries(statusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={departmentFilter} onValueChange={setDepartmentFilter}>
          <SelectTrigger className="w-[160px]" data-testid="objects-filter-department">
            <SelectValue placeholder="Dzial" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie dzialy</SelectItem>
            {Object.entries(departmentLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy obiekt
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: wartość miesięczna — tryb i widełki kwot. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={companyFilter === undefined ? "all" : String(companyFilter)}
          onValueChange={(v) =>
            setCompanyFilter(v === "all" ? undefined : v === "none" ? "none" : parseInt(v))
          }
        >
          <SelectTrigger className="w-[180px]" data-testid="objects-filter-company">
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
          <SelectTrigger className="w-[200px]" data-testid="objects-filter-value-mode">
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
            wiedzieć, dlaczego nie widzi wszystkich obiektów. */}
        <Select value={costMode} onValueChange={(v) => setCostMode(v as CostMode)}>
          <SelectTrigger className="w-[220px]" data-testid="objects-filter-cost-mode">
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
            data-testid="objects-filter-min"
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
            data-testid="objects-filter-max"
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
            data-testid="objects-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
        <p className="ml-auto text-sm text-muted-foreground" data-testid="objects-summary">
          {summaryLine}
        </p>
      </div>

      {/* Zakładki: „nieaktywny” to archiwum obiektu — nie miesza się z bieżącą pracą. */}
      <Tabs value={scope} onValueChange={(v) => setScope(v as "current" | "archived")}>
        <TabsList>
          <TabsTrigger value="current" data-testid="objects-tab-current">
            Aktualne ({tabCounts.current})
          </TabsTrigger>
          <TabsTrigger value="archived" data-testid="objects-tab-archived">
            Archiwalne ({tabCounts.archived})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="text-center py-8">Ladowanie...</div>
          ) : objects.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {filtersActive
                ? "Brak obiektów dla wybranych filtrów"
                : "Brak obiektow"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b">
                    <SortHeader label="Nazwa" sortKey="name" />
                    <SortHeader label="Kontrahent" sortKey="contractor" />
                    <SortHeader label="Miasto" sortKey="city" />
                    {/* Usługi to zbiór, a nie jedna wartość — nie ma po czym
                        sortować, więc nagłówek jest zwykły (klucz `type`
                        zniknął też z SORT_COLUMNS na backendzie). */}
                    <th className="py-3 px-2 font-medium text-left">Usługi</th>
                    <SortHeader label="Status" sortKey="status" />
                    <SortHeader label="Dzial" sortKey="department" />
                    <SortHeader label="Spółka" sortKey="company" />
                    <SortHeader label="Handlowiec" sortKey="salesperson" />
                    <SortHeader label="Wartosc mies." sortKey="value" align="right" />
                    {/* To jest koszt POZOSTAŁY z kartoteki (monitoring, sprzęt);
                        pensje załogi dolicza dopiero Analityka z Kadr. */}
                    <SortHeader label="Koszt mies." sortKey="cost" align="right" />
                    <SortHeader label="Zysk mies." sortKey="profit" align="right" />
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {objects.map((obj) => (
                    <tr key={obj.id} className="border-b hover:bg-muted/50">
                      <td className="py-3 px-2">
                        <button
                          className="font-medium text-primary hover:underline text-left"
                          onClick={() => navigate(`/objects/${obj.id}`)}
                        >
                          {obj.name}
                        </button>
                      </td>
                      <td className="py-3 px-2">
                        {obj.contractor ? (
                          <button
                            className="text-left hover:underline"
                            onClick={() => setContractorFilter(obj.contractor!.id)}
                            title="Pokaż tylko obiekty tego kontrahenta"
                          >
                            {obj.contractor.name}
                          </button>
                        ) : (
                          "-"
                        )}
                      </td>
                      <td className="py-3 px-2">{obj.city || "-"}</td>
                      {/* „Kamery (ilość?)” = usługa jest, ale kamer nikt nie
                          policzył; brak liczby ma być widać tak samo, jak kreska
                          przy nieuzupełnionym koszcie. */}
                      <td className="py-3 px-2">{objectServicesLabel(obj)}</td>
                      <td className="py-3 px-2">
                        <Badge variant={statusColors[obj.status]}>
                          {statusLabels[obj.status] || obj.status}
                        </Badge>
                      </td>
                      <td className="py-3 px-2">
                        <Badge variant={departmentColors[obj.department]}>
                          {departmentLabels[obj.department] || obj.department}
                        </Badge>
                      </td>
                      <td className="py-3 px-2">
                        {obj.company ? (
                          <button
                            className="text-left hover:underline"
                            onClick={() => setCompanyFilter(obj.company!.id)}
                            title="Pokaż tylko obiekty tej spółki"
                          >
                            {obj.company.name}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      <td className="py-3 px-2">
                        {obj.salesperson ? (
                          <button
                            className="text-left hover:underline"
                            onClick={() => setSalespersonFilter(obj.salesperson!.id)}
                            title={
                              obj.salesperson.inherited
                                ? "Opiekun kontrahenta (obiekt nie ma własnego handlowca)"
                                : "Handlowiec przypisany do obiektu"
                            }
                          >
                            {salespersonName(obj.salesperson)}
                            {obj.salesperson.inherited && (
                              <span className="text-muted-foreground"> (kontrahent)</span>
                            )}
                          </button>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </td>
                      {/* Przychód = abonament + dzierżawa. Rozbicie pokazujemy
                          pod kwotą tylko wtedy, gdy dzierżawa faktycznie jest —
                          inaczej kolumna zaszumiłaby się przy wszystkich obiektach. */}
                      <td className="py-3 px-2 text-right tabular-nums">
                        {formatCurrency(
                          (obj.monthlyValue ?? 0) + (obj.monthlyRental ?? 0)
                        )}
                        {obj.monthlyRental ? (
                          <div className="text-xs text-muted-foreground">
                            {formatCurrency(obj.monthlyValue)} + dzierżawa{" "}
                            {formatCurrency(obj.monthlyRental)}
                          </div>
                        ) : null}
                      </td>
                      {/* Brak kosztu to „nieuzupełniony”, a nie 0 zł — stąd kreska
                          zamiast kwoty i pusty zysk zamiast całego abonamentu. */}
                      <td className="py-3 px-2 text-right tabular-nums">
                        {obj.monthlyCost === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          formatCurrency(obj.monthlyCost)
                        )}
                      </td>
                      <td className="py-3 px-2 text-right tabular-nums">
                        {obj.monthlyCost === null ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          (() => {
                            const profit =
                              (obj.monthlyValue ?? 0) +
                              (obj.monthlyRental ?? 0) -
                              obj.monthlyCost;
                            return (
                              <span
                                className={cn(
                                  profit > 0 && "text-emerald-700",
                                  profit < 0 && "text-red-600"
                                )}
                              >
                                {formatCurrency(profit)}
                              </span>
                            );
                          })()
                        )}
                      </td>
                      <td className="py-3 px-2">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => navigate(`/objects/${obj.id}`)}
                            title="Szczegoly"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => openEditForm(obj)}
                                title="Edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => handleDelete(obj.id)}
                                title="Usun"
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Montujemy dopiero na otwarcie i z kluczem per obiekt — formularz czyta
          `object` tylko w inicjalizatorze stanu, więc trwale zamontowany
          pokazywałby puste pola przy edycji (wzorzec jak w PriceItemForm). */}
      {formOpen && (
        <ObjectForm
          key={editingObject?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editingObject ? handleUpdate : handleCreate}
          object={editingObject}
          preselectedContractorId={contractorFilter}
        />
      )}
    </div>
  );
}
