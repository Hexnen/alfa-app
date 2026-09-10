import { useState, useEffect, useCallback } from "react";
import { Link, useNavigate, useLocation } from "react-router-dom";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
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
import { OrderForm } from "@/components/OrderForm";
import { OrderIntakeForm } from "@/components/OrderIntakeForm";
import { OrderMailPreviewDialog } from "@/components/OrderMailPreviewDialog";
import {
  Plus,
  Search,
  Eye,
  Mail,
  Trash2,
  Edit3,
  ClipboardList,
  Camera,
  Phone,
  MapPin,
  Building2,
  User,
  ExternalLink,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  X,
} from "lucide-react";
import type {
  ContractorCatalogEntry,
  Order,
  OrderInput,
  OrderSortKey,
  Salesperson,
} from "@/lib/api";
import {
  getOrders,
  getContractorCatalog,
  getSalespeople,
  createOrder,
  updateOrder,
  deleteOrder,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";

const orderStatuses = [
  { value: "all", label: "Wszystkie" },
  { value: "new", label: "Nowe", color: "bg-blue-500" },
  { value: "in_progress", label: "W trakcie", color: "bg-yellow-500" },
  { value: "completed", label: "Zakończone", color: "bg-green-500" },
  { value: "cancelled", label: "Anulowane", color: "bg-red-500" },
];

/** Filtr zakresu prac: wszystkie / tylko montaże kamer / tylko pozostałe. */
type CameraMode = "all" | "with" | "without";

/** Domyślny kierunek sortowania kolumny — daty ludzie czytają od najnowszych. */
const DEFAULT_DIR: Record<OrderSortKey, "asc" | "desc"> = {
  number: "asc",
  status: "asc",
  requester: "asc",
  object: "asc",
  payer: "asc",
  salesperson: "asc",
  created: "desc",
};

/** Wartość w selekcie handlowca oznaczająca „zlecenia bez opiekuna”. */
const NO_SALESPERSON = "none";

export function Orders() {
  const navigate = useNavigate();
  const location = useLocation();
  const { canEdit } = usePerms();
  const editable = canEdit("orders");
  const activeTab = location.pathname.endsWith("/formularz")
    ? "formularz"
    : "lista";
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);

  // Filtry tekstowe trzymamy osobno od tych wysyłanych do API — wpisywanie w pole
  // nie może strzelać żądaniem na każdą literę (debounce niżej).
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [fromInput, setFromInput] = useState("");
  const [toInput, setToInput] = useState("");
  const [created, setCreated] = useState<{ from?: string; to?: string }>({});

  const [statusFilter, setStatusFilter] = useState("all");
  const [payerFilter, setPayerFilter] = useState<number | "none" | undefined>(undefined);
  const [cameraMode, setCameraMode] = useState<CameraMode>("all");
  const [contractors, setContractors] = useState<ContractorCatalogEntry[]>([]);
  /** Filtr „Handlowiec” — słownik jest mały, więc ciągniemy go raz przy wejściu. */
  const [salespersonFilter, setSalespersonFilter] = useState<number | "none" | undefined>(undefined);
  const [salespeople, setSalespeople] = useState<Salesperson[]>([]);

  const [sort, setSort] = useState<OrderSortKey>("created");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const [page, setPage] = useState(1);
  const [pageSize] = useState(10);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  /** Rozkład statusów CAŁEGO wyniku filtrowania (bez filtra statusu) — kafelki nad listą. */
  const [statusCounts, setStatusCounts] = useState({
    total: 0,
    new: 0,
    in_progress: 0,
    completed: 0,
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [orderToDelete, setOrderToDelete] = useState<Order | null>(null);
  /** Zlecenie, którego mail potwierdzający oglądamy (null = dialog zamknięty). */
  const [mailPreviewOrder, setMailPreviewOrder] = useState<Order | null>(null);

  // Debounce pól tekstowych (szukajka i zakres dat — pole typu `date` wysyła zmiany
  // już w trakcie wpisywania roku).
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    const t = setTimeout(() => {
      // Backend przyjmuje wyłącznie pełne „YYYY-MM-DD" — niedokończona data
      // po prostu nie nakłada filtru.
      const day = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
      setCreated({ from: day(fromInput), to: day(toInput) });
    }, 300);
    return () => clearTimeout(t);
  }, [fromInput, toInput]);

  useEffect(() => {
    // Komplet kartoteki, a nie pierwsza strona — filtr płatnika musi pokazywać
    // wszystkich kontrahentów (ta sama lista, co select na liście obiektów).
    getContractorCatalog()
      .then((res) => setContractors(res.data ?? []))
      .catch(() => setContractors([]));
    // Brak uprawnienia do kartoteki handlowców nie może wywalić listy zleceń —
    // wtedy filtr po prostu nie ma czego pokazać (jak w module Ofert).
    getSalespeople()
      .then((res) => setSalespeople(res.data ?? []))
      .catch(() => setSalespeople([]));
  }, []);

  /**
   * Każda zmiana filtra albo sortowania wraca na pierwszą stronę — inaczej po
   * zawężeniu listy użytkownik ląduje na nieistniejącej stronie. Przestawiamy
   * w trakcie renderu (a nie w efekcie), żeby nie poszło zbędne żądanie o starą
   * stronę z nowym filtrem.
   */
  const filtersKey = [
    search,
    statusFilter,
    payerFilter ?? "",
    salespersonFilter ?? "",
    cameraMode,
    created.from ?? "",
    created.to ?? "",
    sort,
    dir,
  ].join("|");
  const [prevFiltersKey, setPrevFiltersKey] = useState(filtersKey);
  if (prevFiltersKey !== filtersKey) {
    setPrevFiltersKey(filtersKey);
    setPage(1);
  }

  const fetchOrders = useCallback(async () => {
    setLoading(true);
    try {
      const response = await getOrders({
        search: search || undefined,
        status: statusFilter !== "all" ? statusFilter : undefined,
        payerContractorId: payerFilter,
        salespersonId: salespersonFilter,
        camera: cameraMode === "with" ? "1" : cameraMode === "without" ? "0" : undefined,
        createdFrom: created.from,
        createdTo: created.to,
        sort,
        dir,
        page,
        pageSize,
      });
      setOrders(response.data);
      setTotal(response.total);
      setTotalPages(response.totalPages);
      setStatusCounts({
        total: response.statusTotal ?? 0,
        new: response.statusCounts?.new ?? 0,
        in_progress: response.statusCounts?.in_progress ?? 0,
        completed: response.statusCounts?.completed ?? 0,
      });
    } catch (error) {
      console.error("Error fetching orders:", error);
    } finally {
      setLoading(false);
    }
  }, [
    search,
    statusFilter,
    payerFilter,
    salespersonFilter,
    cameraMode,
    created.from,
    created.to,
    sort,
    dir,
    page,
    pageSize,
  ]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: OrderSortKey) => {
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
    payerFilter !== undefined ||
    salespersonFilter !== undefined ||
    cameraMode !== "all" ||
    fromInput !== "" ||
    toInput !== "";

  const clearFilters = () => {
    setSearchInput("");
    setStatusFilter("all");
    setPayerFilter(undefined);
    setSalespersonFilter(undefined);
    setCameraMode("all");
    setFromInput("");
    setToInput("");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
  }: {
    label: string;
    sortKey: OrderSortKey;
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <TableHead className="font-semibold">
        <button
          type="button"
          data-testid={`zlecenia-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 transition-colors hover:text-slate-900",
            active ? "text-slate-900" : "text-slate-500"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
        </button>
      </TableHead>
    );
  };

  const handleCreateOrder = async (data: OrderInput) => {
    if (!editable) return;
    await createOrder(data);
    fetchOrders();
    setIsFormOpen(false);
  };

  const handleUpdateOrder = async (data: OrderInput) => {
    if (!editable) return;
    if (!editingOrder) return;
    try {
      // Backend wymaga echa `updatedAt` wersji, którą użytkownik miał na
      // ekranie — bez tego odrzuca zapis (428).
      await updateOrder(editingOrder.id, data, editingOrder.updatedAt);
    } catch (err) {
      if ((err as { status?: number }).status === 409) {
        // Ktoś zapisał zlecenie w międzyczasie. Odświeżamy listę (świeże
        // `updatedAt` dla kolejnej edycji) i podmieniamy angielski komunikat
        // backendu — formularz pokaże go w swoim Alercie.
        fetchOrders();
        throw new Error(
          "Zlecenie zostało w międzyczasie zmienione przez kogoś innego. Odśwież i spróbuj ponownie."
        );
      }
      throw err;
    }
    // Po udanym zapisie lista wraca ze świeżym `updatedAt`, więc kolejna
    // edycja tego samego zlecenia nie dostanie 409.
    fetchOrders();
    setEditingOrder(null);
  };

  const handleDeleteOrder = async () => {
    if (!editable) return;
    if (orderToDelete) {
      await deleteOrder(orderToDelete.id);
      fetchOrders();
      setDeleteDialogOpen(false);
      setOrderToDelete(null);
    }
  };

  const openEditForm = (order: Order) => {
    setEditingOrder(order);
    setIsFormOpen(true);
  };

  const openDeleteDialog = (order: Order) => {
    setOrderToDelete(order);
    setDeleteDialogOpen(true);
  };

  const closeForm = () => {
    setIsFormOpen(false);
    setEditingOrder(null);
  };

  const getStatusBadge = (status: string) => {
    const statusInfo = orderStatuses.find((s) => s.value === status);
    if (!statusInfo || statusInfo.value === "all") {
      return <Badge variant="secondary">{status}</Badge>;
    }
    return (
      <Badge className={`${statusInfo.color} text-white`}>
        {statusInfo.label}
      </Badge>
    );
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      {activeTab === "formularz" ? (
        editable ? (
          <div className="space-y-4">
            <div className="flex justify-end">
              <Button
                variant="outline"
                onClick={() => window.open("/formularz/zlecenie", "_blank")}
              >
                <ExternalLink className="w-4 h-4 mr-2" />
                Otwórz samodzielny formularz
              </Button>
            </div>
            <OrderIntakeForm onCreated={fetchOrders} />
          </div>
        ) : (
          <div className="p-8 text-center text-slate-500">
            Brak uprawnień do tworzenia zleceń.
          </div>
        )
      ) : (
        <div className="space-y-4">
          {/* Stats Cards */}
      {/* Kafelki liczą CAŁY wynik filtrowania (bez filtra statusu), a nie wczytaną
          stronę — wcześniej „Nowe: 3" znaczyło „3 na tej stronie z 10". */}
      <div className="grid grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium text-slate-500">Wszystkie zlecenia</p>
            <div className="text-2xl font-bold text-slate-900" data-testid="zlecenia-count-all">
              {statusCounts.total}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium text-slate-500">Nowe</p>
            <div className="text-2xl font-bold text-blue-600" data-testid="zlecenia-count-new">
              {statusCounts.new}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium text-slate-500">W trakcie</p>
            <div className="text-2xl font-bold text-yellow-600" data-testid="zlecenia-count-in-progress">
              {statusCounts.in_progress}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium text-slate-500">Zakończone</p>
            <div className="text-2xl font-bold text-green-600" data-testid="zlecenia-count-completed">
              {statusCounts.completed}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 p-4 bg-white rounded-lg border border-slate-200">
        <div className="relative flex-1 min-w-[200px] max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <Input
            placeholder="Szukaj zleceń..."
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40" data-testid="zlecenia-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            {orderStatuses.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Płatnik z kartoteki; „Spoza kartoteki" to zlecenia, których płatnika nikt
            jeszcze nie powiązał z kontrahentem (zostaje sama migawka z formularza). */}
        <Select
          value={payerFilter === undefined ? "all" : String(payerFilter)}
          onValueChange={(v) =>
            setPayerFilter(v === "all" ? undefined : v === "none" ? "none" : parseInt(v))
          }
        >
          <SelectTrigger className="w-[220px]" data-testid="zlecenia-filter-payer">
            <SelectValue placeholder="Płatnik" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy płatnicy</SelectItem>
            <SelectItem value="none">Spoza kartoteki</SelectItem>
            {contractors.map((co) => (
              <SelectItem key={co.id} value={String(co.id)}>
                {co.name}
                {!co.active ? " (archiwalny)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Handlowiec prowadzący — kolumna „Handlowiec" niżej pokazuje to samo.
            „Bez handlowca" to zlecenia spoza lejka (np. z formularza publicznego). */}
        <Select
          value={salespersonFilter === undefined ? "all" : String(salespersonFilter)}
          onValueChange={(v) =>
            setSalespersonFilter(
              v === "all" ? undefined : v === NO_SALESPERSON ? "none" : parseInt(v)
            )
          }
        >
          <SelectTrigger className="w-[200px]" data-testid="zlecenia-filter-salesperson">
            <SelectValue placeholder="Handlowiec" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy handlowcy</SelectItem>
            <SelectItem value={NO_SALESPERSON}>Bez handlowca</SelectItem>
            {salespeople.map((sp) => (
              <SelectItem key={sp.id} value={String(sp.id)}>
                {sp.firstName} {sp.lastName}
                {sp.active ? "" : " (archiwalny)"}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={cameraMode} onValueChange={(v) => setCameraMode(v as CameraMode)}>
          <SelectTrigger className="w-[200px]" data-testid="zlecenia-filter-camera">
            <SelectValue placeholder="Zakres" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Zakres: wszystkie</SelectItem>
            <SelectItem value="with">Tylko montaż kamer</SelectItem>
            <SelectItem value="without">Bez montażu kamer</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex items-center gap-1 text-sm text-slate-500">
          <span>Przyjęte od</span>
          <Input
            type="date"
            className="w-[150px]"
            data-testid="zlecenia-filter-created-from"
            value={fromInput}
            onChange={(e) => setFromInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="date"
            className="w-[150px]"
            data-testid="zlecenia-filter-created-to"
            value={toInput}
            onChange={(e) => setToInput(e.target.value)}
          />
        </div>

        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="zlecenia-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}

        {/* Liczba pozycji PO wszystkich filtrach (kafelki wyżej ignorują status). */}
        <span className="text-sm text-slate-500" data-testid="zlecenia-summary">
          {total} {total === 1 ? "zlecenie" : "zleceń"} dla wybranych filtrów
        </span>

        {editable && (
          <Button
            onClick={() => setIsFormOpen(true)}
            className="ml-auto bg-indigo-600 hover:bg-indigo-700 text-white"
          >
            <Plus className="w-4 h-4 mr-2" />
            Nowe zlecenie
          </Button>
        )}
      </div>

      {/* Orders Table */}
      <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-slate-50">
              <SortHeader label="Numer" sortKey="number" />
              <SortHeader label="Status" sortKey="status" />
              <SortHeader label="Zlecający" sortKey="requester" />
              <SortHeader label="Obiekt" sortKey="object" />
              <SortHeader label="Płatnik" sortKey="payer" />
              <SortHeader label="Handlowiec" sortKey="salesperson" />
              {/* „Techniczne" to zbiór znaczników (kamery, megafony), a nie jedna
                  wartość — nie ma po czym sortować, więc nagłówek zostaje zwykły. */}
              <TableHead className="font-semibold">Techniczne</TableHead>
              <SortHeader label="Data" sortKey="created" />
              {/* Tabela jest szersza niż ekran poniżej ~1440 px i kolumna akcji
                  wyjeżdżała poza kadr (widać było samo „oko”). Przyklejamy ją do
                  prawej krawędzi kontenera przewijania — `Table` opakowuje
                  <table> w div z `overflow-auto`, więc `sticky right-0` działa. */}
              <TableHead className="sticky right-0 z-20 bg-slate-50 text-right font-semibold shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.15)]">
                Akcje
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-slate-500">
                  Ładowanie...
                </TableCell>
              </TableRow>
            ) : orders.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-slate-500">
                  {filtersActive
                    ? "Brak zleceń dla wybranych filtrów"
                    : "Brak zleceń. Utwórz pierwsze zlecenie używając przycisku wyżej."}
                </TableCell>
              </TableRow>
            ) : (
              orders.map((order) => (
                // `group` jest po to, żeby przyklejona komórka akcji podświetlała
                // się razem z wierszem — ma własne, nieprzezroczyste tło (inaczej
                // przewijana treść prześwitywałaby pod spodem), więc sam
                // `hover:bg-slate-50` na <tr> by jej nie dosięgnął.
                <TableRow key={order.id} className="group hover:bg-slate-50">
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <ClipboardList className="w-4 h-4 text-indigo-500" />
                      <span className="font-medium text-slate-900">
                        {order.orderNumber}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>{getStatusBadge(order.status)}</TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <User className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.requesterName}
                        </span>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-slate-500">
                        <Phone className="w-3 h-3" />
                        {order.requesterPhone}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <MapPin className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.objectName}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        {order.objectCity || "-"}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="flex items-center gap-1 text-sm">
                        <Building2 className="w-3 h-3 text-slate-400" />
                        <span className="font-medium text-slate-700">
                          {order.payerName}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500">
                        NIP: {order.payerNip}
                      </div>
                    </div>
                  </TableCell>
                  {/* Handlowiec prowadzący, a pod nim szansa, z której zlecenie
                      wyszło — jedna kolumna, bo to jedna informacja: skąd to
                      zlecenie się wzięło i kto za nie odpowiada. */}
                  <TableCell className="text-sm">
                    {order.salespersonName || (
                      <span className="text-slate-400">—</span>
                    )}
                    {order.leadId ? (
                      <div className="text-xs">
                        <Link
                          to={`/handlowy/leady/${order.leadId}`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-indigo-600 hover:underline"
                          data-testid="zlecenia-lead-link"
                        >
                          {order.leadTitle || "z szansy"}
                        </Link>
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {order.isCameraInstallation && (
                        <Badge variant="outline" className="text-xs">
                          <Camera className="w-3 h-3 mr-1" />
                          {order.cameraCount || 0} kamer
                        </Badge>
                      )}
                      {order.megaphoneCount ? (
                        <Badge variant="outline" className="text-xs">
                          {order.megaphoneCount} megafonów
                        </Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-slate-500">
                    {new Date(order.createdAt).toLocaleDateString("pl-PL")}
                  </TableCell>
                  <TableCell className="sticky right-0 z-10 bg-white text-right shadow-[-6px_0_8px_-6px_rgba(0,0,0,0.15)] group-hover:bg-slate-50">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => navigate(`/orders/${order.id}`)}
                        className="text-slate-600 hover:text-indigo-600"
                        title="Szczegóły"
                      >
                        <Eye className="w-4 h-4" />
                      </Button>
                      {/* Podgląd maila potwierdzającego — sam podgląd, bez wysyłki,
                          więc dostępny też w trybie tylko do odczytu. */}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setMailPreviewOrder(order)}
                        className="text-slate-600 hover:text-indigo-600"
                        title="Podgląd maila do klienta"
                        data-testid="zlecenia-mail-preview-open"
                      >
                        <Mail className="w-4 h-4" />
                      </Button>
                      {editable && (
                        <>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openEditForm(order)}
                            className="text-slate-600 hover:text-indigo-600"
                            title="Edytuj"
                          >
                            <Edit3 className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => openDeleteDialog(order)}
                            className="text-slate-600 hover:text-red-600"
                            title="Usuń"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="border-t border-slate-200 p-4">
            <Pagination>
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    className={page === 1 ? "pointer-events-none opacity-50" : ""}
                  />
                </PaginationItem>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
                  <PaginationItem key={p}>
                    <PaginationLink
                      onClick={() => setPage(p)}
                      isActive={page === p}
                    >
                      {p}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    className={
                      page === totalPages ? "pointer-events-none opacity-50" : ""
                    }
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          </div>
        )}
      </div>
        </div>
      )}

      {/* Order Form Dialog */}
      <OrderForm
        open={isFormOpen}
        onClose={closeForm}
        onSubmit={editingOrder ? handleUpdateOrder : handleCreateOrder}
        order={editingOrder}
      />

      {/* Podgląd maila potwierdzającego przyjęcie zlecenia */}
      <OrderMailPreviewDialog
        order={mailPreviewOrder}
        open={mailPreviewOrder !== null}
        onClose={() => setMailPreviewOrder(null)}
        canSend={editable}
      />

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Potwierdź usunięcie</AlertDialogTitle>
            <AlertDialogDescription>
              Czy na pewno chcesz usunąć zlecenie{" "}
              <strong>{orderToDelete?.orderNumber}</strong>? Tej operacji nie można
              cofnąć.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Anuluj</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteOrder}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              Usuń
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
