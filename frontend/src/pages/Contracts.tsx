import { useEffect, useState, useCallback, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  Search,
  Eye,
  Pencil,
  Trash2,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  X,
} from "lucide-react";
import {
  getContracts,
  getObjects,
  getContractorCatalog,
  createContract,
  updateContract,
  deleteContract,
  contractDraftsApi,
  type ContractorCatalogEntry,
  type ContractSortKey,
  type ContractWithDetails,
  type Contract,
  type ContractInput,
  type ObjectWithContractor,
} from "@/lib/api";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn, contractStatusLabels, formatCurrency, formatDate } from "@/lib/utils";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { ContractDraftsPanel } from "@/components/contracts/ContractDraftsPanel";
import { ContractTemplatesPanel } from "@/components/contracts/ContractTemplatesPanel";
import { DocxPreview } from "@/components/contracts/DocxPreview";
import { SplitLayout } from "@/components/contracts/SplitLayout";

const statusColors: Record<string, "default" | "success" | "secondary" | "destructive"> = {
  draft: "secondary",
  active: "success",
  expired: "default",
  terminated: "destructive",
};

/**
 * Filtr wartości umowy: wszystkie / tylko z wpisaną kwotą / tylko bez.
 * „Bez” to `value IS NULL` — brak kwoty znaczy „nikt nie wpisał”, a nie 0 zł.
 */
type ValueMode = "all" | "with" | "without";

/** Domyślny kierunek sortowania kolumny — kwoty i daty ludzie czytają od najnowszych/największych. */
const DEFAULT_DIR: Record<ContractSortKey, "asc" | "desc"> = {
  number: "asc",
  object: "asc",
  contractor: "asc",
  start: "desc",
  end: "desc",
  value: "desc",
  status: "asc",
  created: "desc",
};

/** Umów bywa tyle, co obiektów — lista chodzi po stronach, jak w Obiektach i Kontrahentach. */
const PAGE_SIZE = 50;

/**
 * Panel „Rejestr umów” — zawarte umowy z numerem, okresem i wartością.
 * Baner „tylko do odczytu” siedzi nad zakładkami, w `Contracts` niżej.
 *
 * Filtry, sortowanie i paginacja są tu od czasu, gdy była to cała strona
 * `/contracts`, i zostały nietknięte. Dołożone jest ZAZNACZENIE wiersza:
 * kliknięta umowa pokazuje po prawej swój dokument, o ile jakiś ma — czyli
 * gdy powstała z draftu („Przenieś do rejestru”). Umowy wpisane ręcznie
 * dokumentu nie mają i nigdy nie miały; podgląd mówi to wprost, zamiast
 * udawać, że plik się nie wczytał.
 */
function ContractsRegisterPanel() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("contracts");
  const [contracts, setContracts] = useState<ContractWithDetails[]>([]);
  const [objects, setObjects] = useState<ObjectWithContractor[]>([]);
  const [contractors, setContractors] = useState<ContractorCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState({ total: 0, value: 0, withValue: 0 });

  // Filtry tekstowe trzymamy osobno od tych wysyłanych do API — wpisywanie w pole
  // nie może strzelać żądaniem na każdą literę (debounce niżej).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [range, setRange] = useState<{ min?: number; max?: number }>({});
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [period, setPeriod] = useState<{ from?: string; to?: string }>({});

  const [statusFilter, setStatusFilter] = useState("all");
  const [contractorFilter, setContractorFilter] = useState<number | undefined>(undefined);
  const [objectFilter, setObjectFilter] = useState<number | undefined>(undefined);
  const [valueMode, setValueMode] = useState<ValueMode>("all");

  const [sort, setSort] = useState<ContractSortKey>("number");
  const [dir, setDir] = useState<"asc" | "desc">("asc");

  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  /** Zaznaczony wiersz — to jego dokument widać w prawej kolumnie. */
  const [selectedId, setSelectedId] = useState<number | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editingContract, setEditingContract] = useState<Contract | null>(null);
  const [formData, setFormData] = useState<ContractInput>({
    objectId: 0,
    contractNumber: "",
    startDate: "",
    endDate: "",
    value: undefined,
    status: "draft",
  });

  // Wejście z kartoteki: /contracts?objectId=12 albo /contracts?contractorId=7.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const objectId = params.get("objectId");
    if (objectId) setObjectFilter(parseInt(objectId));
    const contractorId = params.get("contractorId");
    if (contractorId) setContractorFilter(parseInt(contractorId));
  }, []);

  // Debounce pól tekstowych (szukajka, widełki kwot i zakres dat — pole typu `date`
  // też wysyła zmiany w trakcie wpisywania roku).
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

  useEffect(() => {
    const t = setTimeout(() => {
      // Backend przyjmuje wyłącznie pełne „YYYY-MM-DD" — niedokończona data
      // po prostu nie nakłada filtru.
      const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
      setPeriod({ from: day(fromInput), to: day(toInput) });
    }, 300);
    return () => clearTimeout(t);
  }, [fromInput, toInput]);

  /**
   * Każda zmiana filtra albo sortowania wraca na pierwszą stronę — inaczej po
   * zawężeniu listy użytkownik ląduje na nieistniejącej stronie. Przestawiamy
   * w trakcie renderu (a nie w efekcie), żeby nie poszło zbędne żądanie o starą
   * stronę z nowym filtrem.
   */
  const filtersKey = [
    search,
    statusFilter,
    contractorFilter ?? "",
    objectFilter ?? "",
    range.min ?? "",
    range.max ?? "",
    period.from ?? "",
    period.to ?? "",
    valueMode,
    sort,
    dir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getContracts({
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        contractorId: contractorFilter,
        objectId: objectFilter,
        minValue: range.min,
        maxValue: range.max,
        hasValue: valueMode === "with" ? "1" : valueMode === "without" ? "0" : undefined,
        activeFrom: period.from,
        activeTo: period.to,
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setContracts(res.data);
      setTotalPages(Math.max(1, res.totalPages ?? 1));
      setSummary({
        total: res.total,
        value: res.totalValue ?? 0,
        withValue: res.withValue ?? 0,
      });
    } catch (error) {
      console.error("Error loading contracts:", error);
    } finally {
      setLoading(false);
    }
  }, [
    search,
    statusFilter,
    contractorFilter,
    objectFilter,
    range.min,
    range.max,
    period.from,
    period.to,
    valueMode,
    sort,
    dir,
    page,
  ]);

  const loadObjects = useCallback(async () => {
    try {
      const res = await getObjects({ pageSize: 1000 });
      setObjects(res.data);
    } catch (error) {
      console.error("Error loading objects:", error);
    }
  }, []);

  useEffect(() => {
    loadContracts();
  }, [loadContracts]);

  /**
   * Zaznaczenie trzyma się wybranej umowy, dopóki ta jest na stronie; gdy
   * zniknie (filtr, inna strona), skacze na pierwszą Z DOKUMENTEM — pusty
   * podgląd przy pełnej liście wyglądałby na awarię.
   */
  useEffect(() => {
    setSelectedId((prev) => {
      if (prev !== null && contracts.some((c) => c.id === prev)) return prev;
      return (contracts.find((c) => c.draftFileUrl) ?? contracts[0])?.id ?? null;
    });
  }, [contracts]);

  const selected = contracts.find((c) => c.id === selectedId) ?? null;

  useEffect(() => {
    loadObjects();
    // Komplet kartoteki, a nie pierwsza strona — filtr musi pokazywać wszystkich
    // kontrahentów (ta sama lista, co select na liście obiektów).
    getContractorCatalog()
      .then((res) => setContractors(res.data ?? []))
      .catch(() => setContractors([]));
  }, [loadObjects]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: ContractSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    statusFilter !== "all" ||
    contractorFilter !== undefined ||
    objectFilter !== undefined ||
    valueMode !== "all" ||
    minInput !== "" ||
    maxInput !== "" ||
    fromInput !== "" ||
    toInput !== "";

  const clearFilters = () => {
    setSearchInput("");
    setStatusFilter("all");
    setContractorFilter(undefined);
    setObjectFilter(undefined);
    setValueMode("all");
    setMinInput("");
    setMaxInput("");
    setFromInput("");
    setToInput("");
  };

  /** Sam przycisk sortowania — nagłówek kolumny albo dopisek obok niego. */
  const SortLink = ({
    label,
    sortKey,
    align = "left",
    className,
  }: {
    label: string;
    sortKey: ContractSortKey;
    align?: "left" | "right";
    className?: string;
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        data-testid={`umowy-sort-${sortKey}`}
        onClick={() => toggleSort(sortKey)}
        aria-label={`Sortuj po: ${label}`}
        className={cn(
          "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-foreground",
          align === "right" && "flex-row-reverse",
          active ? "text-foreground" : "text-muted-foreground",
          className
        )}
      >
        {label}
        <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
      </button>
    );
  };

  /**
   * Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania.
   * `children` mieści DRUGIE sortowanie w tej samej komórce: przy połowie
   * szerokości ekranu kontrahent i data zakończenia dzielą kolumnę z obiektem
   * i datą rozpoczęcia, ale każde z nich sortuje po swojemu — dokładnie jak
   * przed podziałem widoku.
   */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    children,
  }: {
    label: string;
    sortKey: ContractSortKey;
    align?: "left" | "right";
    children?: React.ReactNode;
  }) => (
    <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
      <SortLink label={label} sortKey={sortKey} align={align} />
      {children}
    </th>
  );

  const summaryLine = useMemo(() => {
    const parts = [`${summary.total} ${summary.total === 1 ? "umowa" : "umów"}`];
    // Suma liczy się TYLKO z umów z wpisaną kwotą, więc mówimy wprost, z ilu —
    // inaczej wyglądałaby na wartość całego portfela umów.
    if (summary.withValue > 0) {
      parts.push(`suma wartości ${formatCurrency(summary.value)}`);
      if (summary.withValue < summary.total) {
        parts.push(`wartość uzupełniona w ${summary.withValue} z ${summary.total}`);
      }
    }
    // Jedno zdanie o konwencji na ekran — kwoty w całej aplikacji są bez VAT.
    parts.push("kwoty netto (bez VAT)");
    return parts.join(" · ");
  }, [summary]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editable) return;
    if (!formData.objectId) {
      alert("Wybierz obiekt");
      return;
    }
    try {
      if (editingContract) {
        await updateContract(editingContract.id, formData);
      } else {
        await createContract(formData);
      }
      loadContracts();
      closeForm();
    } catch (error) {
      console.error("Error saving contract:", error);
    }
  };

  const handleDelete = async (id: number) => {
    if (!editable) return;
    if (window.confirm("Czy na pewno chcesz usunac ta umowe?")) {
      try {
        await deleteContract(id);
        loadContracts();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie mozna usunac umowy"
        );
      }
    }
  };

  const openEditForm = (contract: ContractWithDetails) => {
    if (!editable) return;
    setEditingContract(contract);
    setFormData({
      objectId: contract.objectId,
      contractNumber: contract.contractNumber,
      startDate: contract.startDate,
      endDate: contract.endDate || "",
      value: contract.value || undefined,
      status: contract.status,
    });
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditingContract(null);
    setFormData({
      objectId: 0,
      contractNumber: "",
      startDate: "",
      endDate: "",
      value: undefined,
      status: "draft",
    });
  };

  // Filtry idą NAD obie kolumny (szeroki pasek), lista i podgląd pod nimi.
  const header = (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj umowy, obiektu, kontrahenta..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>

        <Select
          value={contractorFilter === undefined ? "all" : String(contractorFilter)}
          onValueChange={(v) => setContractorFilter(v === "all" ? undefined : parseInt(v))}
        >
          <SelectTrigger className="w-[220px]" data-testid="umowy-filter-contractor">
            <SelectValue placeholder="Kontrahent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy kontrahenci</SelectItem>
            {contractors.map((co) => (
              <SelectItem key={co.id} value={String(co.id)}>
                {co.name}
                {!co.active ? " (archiwalny)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Ta sama lista obiektów, z której wybiera się obiekt w formularzu umowy —
            jedno źródło, więc filtr i formularz nigdy nie pokazują innego zbioru. */}
        <Select
          value={objectFilter === undefined ? "all" : String(objectFilter)}
          onValueChange={(v) => setObjectFilter(v === "all" ? undefined : parseInt(v))}
        >
          <SelectTrigger className="w-[220px]" data-testid="umowy-filter-object">
            <SelectValue placeholder="Obiekt" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie obiekty</SelectItem>
            {objects.map((obj) => (
              <SelectItem key={obj.id} value={String(obj.id)}>
                {obj.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[180px]" data-testid="umowy-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie statusy</SelectItem>
            {Object.entries(contractStatusLabels).map(([value, label]) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowa umowa
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: wartość umowy (tryb + widełki) i okres obowiązywania. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
          <SelectTrigger className="w-[210px]" data-testid="umowy-filter-value-mode">
            <SelectValue placeholder="Wartosc" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wartość: wszystkie</SelectItem>
            <SelectItem value="with">Tylko z wpisaną wartością</SelectItem>
            <SelectItem value="without">Tylko bez wartości</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Kwota od</span>
          <Input
            type="number"
            min="0"
            step="100"
            inputMode="decimal"
            className="w-28 tabular-nums"
            data-testid="umowy-filter-min"
            value={minInput}
            onChange={(e) => setMinInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="number"
            min="0"
            step="100"
            inputMode="decimal"
            className="w-28 tabular-nums"
            data-testid="umowy-filter-max"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
          <span>zł</span>
        </div>
        {/* Jeden filtr okresu zamiast dwóch osobnych na daty: pokazujemy umowy, których
            OKRES ZACHODZI na podany zakres. Ten sam dzień w obu polach = „obowiązujące
            w dniu", samo drugie pole = „zaczęte do dnia". Umowa bez daty końca trwa do
            odwołania, więc łapie każdy zakres sięgający jej początku. */}
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Obowiązuje od</span>
          <Input
            type="date"
            className="w-[150px]"
            data-testid="umowy-filter-active-from"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="date"
            className="w-[150px]"
            data-testid="umowy-filter-active-to"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
          />
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="umowy-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
        <p className="ml-auto text-sm text-muted-foreground" data-testid="umowy-summary">
          {summaryLine}
        </p>
      </div>
    </div>
  );

  const list = (
    <div className="space-y-3">
      <Card>
        <CardContent className="p-2">
          {loading ? (
            <div className="text-center py-8">Ladowanie...</div>
          ) : contracts.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              {filtersActive ? "Brak umów dla wybranych filtrów" : "Brak umow"}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full table-fixed text-sm" data-testid="umowy-rejestr-tabela">
                {/*
                  Stałe szerokości kolumn (`table-fixed` + colgroup), bo przy
                  połowie ekranu automatyczny układ oddawał całe wolne miejsce
                  kolumnom z krótką treścią, a nazwa obiektu zostawała ucięta po
                  kilku znakach. Kolumna obiektu jest jedyną „gumową”.
                */}
                <colgroup>
                  <col className="w-[132px]" />
                  <col />
                  <col className="w-[100px]" />
                  <col className="w-[88px]" />
                  <col className="w-[84px]" />
                  <col className="w-[92px]" />
                </colgroup>
                <thead>
                  <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
                    <SortHeader label="Nr umowy" sortKey="number" />
                    <SortHeader label="Obiekt" sortKey="object">
                      <span className="px-1">·</span>
                      <SortLink
                        label="kontrahent"
                        sortKey="contractor"
                        className="text-[10px] normal-case"
                      />
                    </SortHeader>
                    <SortHeader label="Okres" sortKey="start">
                      <span className="px-1">·</span>
                      <SortLink label="do" sortKey="end" className="text-[10px] normal-case" />
                    </SortHeader>
                    <SortHeader label="Wartosc" sortKey="value" align="right" />
                    <SortHeader label="Status" sortKey="status" />
                    <th className="text-right py-3 px-2 font-medium">Akcje</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((contract) => (
                    <tr
                      key={contract.id}
                      onClick={() => setSelectedId(contract.id)}
                      aria-selected={contract.id === selectedId}
                      className={cn(
                        "cursor-pointer border-b hover:bg-muted/50",
                        contract.id === selectedId && "bg-primary/10 hover:bg-primary/10"
                      )}
                      data-testid="umowy-rejestr-wiersz"
                    >
                      <td className="py-2 px-2 align-top font-medium">
                        {/* `truncate` też tutaj: przy stałej szerokości kolumny
                            długi numer wyszedłby na sąsiednią komórkę. */}
                        <span className="flex items-center gap-1">
                          <span className="min-w-0 truncate" title={contract.contractNumber}>
                            {contract.contractNumber}
                          </span>
                          {/* Umowa z draftu ma dokument — ikona prowadzi do niego
                              w panelu draftów (szukajka po numerze). */}
                          {contract.draftId !== null && (
                            <Link
                              to={`/contracts?panel=drafty&q=${encodeURIComponent(contract.contractNumber)}`}
                              onClick={(e) => e.stopPropagation()}
                              title="Pokaż draft, z którego powstała ta umowa"
                              className="text-muted-foreground hover:text-primary"
                              data-testid="umowy-rejestr-draft-link"
                            >
                              <FileText className="h-3.5 w-3.5 shrink-0" aria-hidden />
                            </Link>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-2 align-top">
                        {contract.object ? (
                          <button
                            className="block w-full truncate text-primary hover:underline text-left"
                            title={contract.object.name}
                            onClick={(e) => {
                              e.stopPropagation();
                              navigate(`/objects/${contract.objectId}`);
                            }}
                          >
                            {contract.object.name}
                          </button>
                        ) : (
                          "-"
                        )}
                        {contract.contractor ? (
                          <button
                            className="block w-full truncate text-left text-xs text-muted-foreground hover:underline"
                            onClick={(e) => {
                              e.stopPropagation();
                              setContractorFilter(contract.contractor!.id);
                            }}
                            title="Pokaż tylko umowy tego kontrahenta"
                          >
                            {contract.contractor.name}
                          </button>
                        ) : (
                          <span className="block text-xs text-muted-foreground">-</span>
                        )}
                      </td>
                      {/* Okres w jednej komórce: „od” u góry, „do” pod spodem.
                          Umowa bez daty końca trwa do odwołania — mówimy to wprost. */}
                      <td className="py-2 px-2 align-top whitespace-nowrap tabular-nums">
                        {formatDate(contract.startDate)}
                        <span className="block text-xs text-muted-foreground">
                          {contract.endDate ? `do ${formatDate(contract.endDate)}` : "bez końca"}
                        </span>
                      </td>
                      <td className="py-2 px-2 align-top text-right whitespace-nowrap tabular-nums">
                        {formatCurrency(contract.value)}
                      </td>
                      <td className="py-2 px-2 align-top">
                        <Badge variant={statusColors[contract.status]}>
                          {contractStatusLabels[contract.status]}
                        </Badge>
                      </td>
                      <td className="py-2 px-2 align-top" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-0.5">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => navigate(`/contracts/${contract.id}`)}
                            title="Szczegoly"
                          >
                            <Eye className="h-4 w-4" />
                          </Button>
                          {editable && (
                            <>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => openEditForm(contract)}
                                title="Edytuj"
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => handleDelete(contract.id)}
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

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2" data-testid="umowy-pagination">
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
    </div>
  );

  const preview = (
    <DocxPreview
      url={selected?.draftFileUrl ?? null}
      previewSrc={contractDraftsApi.previewUrl(selected?.draftFileUrl)}
      fieldLegend
      title={
        selected ? `${selected.contractNumber}${selected.object ? ` — ${selected.object.name}` : ""}` : null
      }
      emptyText={
        selected
          ? "Ta umowa nie ma powiązanego dokumentu — umowy dodane ręcznie nie mają pliku; drafty trafiają tu przez „Przenieś do rejestru”."
          : "Wybierz umowę z listy, aby zobaczyć podgląd"
      }
    />
  );

  return (
    <>
      <SplitLayout testid="umowy-rejestr-panel" header={header} list={list} preview={preview} />

      {/* Contract form dialog */}
      <Dialog open={formOpen} onOpenChange={closeForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingContract ? "Edytuj umowe" : "Nowa umowa"}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label>Obiekt *</Label>
                <Select
                  value={formData.objectId?.toString() || ""}
                  onValueChange={(value) =>
                    setFormData((prev) => ({
                      ...prev,
                      objectId: parseInt(value),
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Wybierz obiekt" />
                  </SelectTrigger>
                  <SelectContent>
                    {objects.map((obj) => (
                      <SelectItem key={obj.id} value={obj.id.toString()}>
                        {obj.name} ({obj.contractor?.name || "Brak kontrahenta"})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Numer umowy *</Label>
                <Input
                  value={formData.contractNumber}
                  onChange={(e) =>
                    setFormData((prev) => ({
                      ...prev,
                      contractNumber: e.target.value,
                    }))
                  }
                  required
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Data rozpoczecia *</Label>
                  <Input
                    type="date"
                    value={formData.startDate}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        startDate: e.target.value,
                      }))
                    }
                    required
                  />
                </div>
                <div className="space-y-2">
                  <Label>Data zakonczenia</Label>
                  <Input
                    type="date"
                    value={formData.endDate}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        endDate: e.target.value,
                      }))
                    }
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Wartosc (PLN)</Label>
                  <Input
                    type="number"
                    step="0.01"
                    value={formData.value || ""}
                    onChange={(e) =>
                      setFormData((prev) => ({
                        ...prev,
                        value: e.target.value
                          ? parseFloat(e.target.value)
                          : undefined,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <Label>Status</Label>
                  <Select
                    value={formData.status}
                    onValueChange={(value) =>
                      setFormData((prev) => ({
                        ...prev,
                        status: value as ContractInput["status"],
                      }))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {Object.entries(contractStatusLabels).map(
                        ([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        )
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={closeForm}>
                Anuluj
              </Button>
              <Button type="submit">Zapisz</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Zakładka „Umowy” — trzy panele wybierane przez `?panel=`: „Rejestr umów”
 * (zawarte umowy jako fakt handlowy), „Drafty umów” (dokumenty wystawione dla
 * obiektów) i „Wzory umów” (katalog szablonów, z których te dokumenty powstają).
 * Panel siedzi w query, a nie w stanie, żeby dało się go zalinkować z sidebara
 * i wrócić do niego przyciskiem „wstecz” (wzorzec `CmaInterventionGroups`).
 */
const PANELS = ["rejestr", "drafty", "wzory"] as const;
type PanelKey = (typeof PANELS)[number];

const TAB_KEY = "contracts";

export function Contracts() {
  const { canEdit } = usePerms();
  const editable = canEdit(TAB_KEY);
  const [params, setParams] = useSearchParams();
  const panelParam = params.get("panel");
  const panel: PanelKey = PANELS.includes(panelParam as PanelKey) ? (panelParam as PanelKey) : "rejestr";

  const setPanel = (next: string) => {
    const sp = new URLSearchParams(params);
    sp.set("panel", next);
    setParams(sp, { replace: true });
  };

  return (
    <div className="space-y-3" data-testid="umowy-page">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <Tabs value={panel} onValueChange={setPanel}>
        <TabsList>
          <TabsTrigger value="rejestr" data-testid="umowy-tab-rejestr">
            Rejestr umów
          </TabsTrigger>
          <TabsTrigger value="drafty" data-testid="umowy-tab-drafty">
            Drafty umów
          </TabsTrigger>
          <TabsTrigger value="wzory" data-testid="umowy-tab-wzory">
            Wzory umów
          </TabsTrigger>
        </TabsList>

        <TabsContent value="rejestr" className="mt-4">
          <ContractsRegisterPanel />
        </TabsContent>

        <TabsContent value="drafty" className="mt-4">
          {/* `templateKey` w adresie to wejście z „Wzory umów” → „Pokaż drafty”,
              `q` — z rejestru („pokaż draft tej umowy”, szukanie po numerze).
              Panel bierze oba tylko jako filtry POCZĄTKOWE. */}
          <ContractDraftsPanel
            editable={editable}
            initialTemplateKey={params.get("templateKey")}
            initialSearch={params.get("q")}
          />
        </TabsContent>

        <TabsContent value="wzory" className="mt-4">
          <ContractTemplatesPanel editable={editable} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
