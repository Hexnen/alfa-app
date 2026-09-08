import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { SalespersonForm } from "@/components/SalespersonForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  Building2,
  ChevronsUpDown,
  Pencil,
  Plus,
  Search,
  Trash2,
  Users,
  X,
} from "lucide-react";
import {
  getSalespeople,
  createSalesperson,
  updateSalesperson,
  deleteSalesperson,
  getHrEmployeeDirectory,
  type HrEmployeeRef,
  type Salesperson,
  type SalespersonInput,
} from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

/** Kolumny, po których da się sortować listę handlowców. */
type SalespersonSortKey =
  | "name"
  | "phone"
  | "email"
  | "region"
  | "hr"
  | "contractors"
  | "objects"
  | "value"
  | "cost"
  | "commission";

/**
 * Domyślny kierunek sortowania kolumny — kwoty i liczniki ludzie czytają od
 * największej wartości, teksty alfabetycznie (jak w kartotece obiektów).
 */
const DEFAULT_DIR: Record<SalespersonSortKey, "asc" | "desc"> = {
  name: "asc",
  phone: "asc",
  email: "asc",
  region: "asc",
  hr: "asc",
  contractors: "desc",
  objects: "desc",
  value: "desc",
  cost: "desc",
  commission: "desc",
};

/** Filtr wartości portfela: wszyscy / tylko z abonamentem / tylko bez. */
type ValueMode = "all" | "with" | "without";

/** Filtr powiązania z kartoteką kadrową (`employeeId`). */
type HrMode = "all" | "linked" | "unlinked";

/** Wartość w selekcie regionu oznaczająca „handlowcy bez wpisanego regionu”. */
const NO_REGION = "__none__";

/** Kwota z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** „Nazwisko Imię” — klucz alfabetyczny kartoteki osób (i remis przy każdym sortowaniu). */
function sortName(s: Salesperson): string {
  return `${s.lastName ?? ""} ${s.firstName ?? ""}`.trim();
}

/**
 * Handlowcy — słownik opiekunów przypisywanych kontrahentom i obiektom.
 * Zakładki „Aktualni / Archiwalni” działają jak przy technikach: archiwum jest
 * miękkie (flaga `active`), a kasowanie możliwe tylko dla osoby bez przypisań.
 */
export function Salespeople() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("handlowcy");

  const [rows, setRows] = useState<Salesperson[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  // Filtry i sortowanie liczymy po stronie klienta — `getSalespeople()` i tak zwraca
  // cały słownik (kilkunastu opiekunów), więc nie ma po co dokładać parametrów do API.
  // Z tego samego powodu widełki kwot idą bez debounce'u: nie ma żądania do
  // odciążenia, a lista przelicza się w tym samym renderze co wpisana cyfra.
  const [regionFilter, setRegionFilter] = useState("all");
  const [hrMode, setHrMode] = useState<HrMode>("all");
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [sort, setSort] = useState<SalespersonSortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Salesperson | null>(null);
  /** Kartoteka kadrowa — lista wyboru „Pracownik w kadrach" w formularzu. */
  const [hrEmployees, setHrEmployees] = useState<HrEmployeeRef[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getSalespeople();
      setRows(res.data ?? []);
    } catch (error) {
      console.error("Error loading salespeople:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // Lista pracowników kadr jest niezależna od handlowców, więc ciągniemy ją raz.
  // Brak uprawnień do Kadr nie może wywalić widoku — wtedy pole powiązania
  // po prostu zostaje puste.
  useEffect(() => {
    getHrEmployeeDirectory()
      .then((res) => setHrEmployees(res.data ?? []))
      .catch(() => setHrEmployees([]));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Regiony do selecta — unikalne wartości z listy, posortowane po polsku. */
  const regions = useMemo(
    () =>
      Array.from(
        new Set(rows.map((s) => (s.region ?? "").trim()).filter((r) => r !== ""))
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [rows]
  );

  /**
   * Jeden przebieg: filtry + sortowanie. Liczniki na zakładkach biorą się z tej
   * samej listy, więc „Aktualni (3)” zawsze zgadza się z tym, co widać w tabeli.
   */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);

    const list = rows.filter((s) => {
      if (
        q &&
        ![s.firstName, s.lastName, s.email, s.phone, s.region, s.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      ) {
        return false;
      }
      if (regionFilter !== "all") {
        const region = (s.region ?? "").trim();
        if (regionFilter === NO_REGION ? region !== "" : region !== regionFilter) return false;
      }
      if (hrMode === "linked" && !s.employeeId) return false;
      if (hrMode === "unlinked" && s.employeeId) return false;
      // Portfel 0 zł = handlowiec bez obiektów z ceną; tabela pokazuje tu kreskę,
      // więc filtr „bez abonamentu” łapie i zero, i brak.
      const value = s.objectsMonthlyValue ?? 0;
      if (valueMode === "with" && value <= 0) return false;
      if (valueMode === "without" && value > 0) return false;
      if (min !== undefined && value < min) return false;
      if (max !== undefined && value > max) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (s: Salesperson) =>
      (sort === "name"
        ? sortName(s)
        : sort === "phone"
          ? s.phone
          : sort === "email"
            ? s.email
            : sort === "region"
              ? s.region
              : // „Kadry”: sortujemy po nazwisku z listy płac, a osoby bez
                // powiązania (kreska w tabeli) lądują na końcu jak pusty tekst.
                (s.employeeId ? (s.employeeName ?? "powiązany") : "")) ?? "";
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (s: Salesperson): number | null => {
      switch (sort) {
        case "contractors":
          return s.contractorsCount ?? 0;
        case "objects":
          return s.objectsCount ?? 0;
        case "value":
          return s.objectsMonthlyValue || null;
        case "cost":
          // Przy powiązaniu z Kadrami tabela pokazuje „z Kadr”, a nie kwotę —
          // ręczny `monthlyCost` jest wtedy ignorowany, więc też traktujemy go
          // jak brak wartości.
          return s.employeeId ? null : (s.monthlyCost ?? null);
        default:
          return s.commissionRate ?? null;
      }
    };

    const numeric =
      sort === "contractors" ||
      sort === "objects" ||
      sort === "value" ||
      sort === "cost" ||
      sort === "commission";

    // Puste teksty i brak kwoty lądują na końcu w OBU kierunkach (jak NULLS LAST
    // w sortowaniu obiektów) — inaczej „sortuj po e-mailu” zaczynałoby się od
    // handlowców bez adresu. Remis rozstrzyga nazwisko, żeby kolejność była stabilna.
    const compare = (a: Salesperson, b: Salesperson): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
        // Liczniki kontrahentów i obiektów pokazujemy jako „0” (to informacja),
        // więc tylko kwoty i prowizja mogą być puste — i tylko one idą na koniec.
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

    return list.sort((a, b) => compare(a, b) || sortName(a).localeCompare(sortName(b), "pl"));
  }, [rows, search, regionFilter, hrMode, valueMode, minInput, maxInput, sort, dir]);

  const active = visible.filter((s) => s.active);
  const archived = visible.filter((s) => !s.active);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: SalespersonSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    regionFilter !== "all" ||
    hrMode !== "all" ||
    valueMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearch("");
    setRegionFilter("all");
    setHrMode("all");
    setValueMode("all");
    setMinInput("");
    setMaxInput("");
  };

  /** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
  const SortHeader = ({
    label,
    sortKey,
    align = "left",
    title,
  }: {
    label: string;
    sortKey: SalespersonSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`handlowcy-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
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
  };

  const handleCreate = async (data: SalespersonInput) => {
    await createSalesperson(data);
    load();
  };

  const handleUpdate = async (data: SalespersonInput) => {
    if (!editing) return;
    await updateSalesperson(editing.id, data);
    load();
  };

  const toggleArchive = async (s: Salesperson) => {
    if (!editable) return;
    try {
      await updateSalesperson(s.id, { active: !s.active });
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się zmienić statusu");
    }
  };

  const handleDelete = async (s: Salesperson) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć handlowca ${s.firstName} ${s.lastName}?`)) return;
    try {
      await deleteSalesperson(s.id);
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć handlowca");
    }
  };

  const openEdit = (s: Salesperson) => {
    setEditing(s);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const renderTable = (list: Salesperson[], emptyText: string) => {
    if (loading) return <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>;
    if (list.length === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {filtersActive ? "Brak handlowców dla wybranych filtrów" : emptyText}
        </div>
      );
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <SortHeader label="Handlowiec" sortKey="name" title="Kolejność alfabetyczna po nazwisku" />
              <SortHeader label="Telefon" sortKey="phone" />
              <SortHeader label="E-mail" sortKey="email" />
              <SortHeader label="Region" sortKey="region" />
              <SortHeader
                label="Kadry"
                sortKey="hr"
                title="Powiązanie z kartoteką kadrową — koszt takiej osoby liczy się z jej wypłat, a nie z pola „Koszt mies.”"
              />
              <SortHeader label="Kontrahenci" sortKey="contractors" align="right" />
              <SortHeader
                label="Obiekty"
                sortKey="objects"
                align="right"
                title="Obiekty handlowca — własne oraz te, które dziedziczą go po kontrahencie"
              />
              <SortHeader
                label="Portfel"
                sortKey="value"
                align="right"
                title="Suma abonamentów z obiektów handlowca (własnych i odziedziczonych po kontrahencie)"
              />
              <SortHeader
                label="Koszt mies."
                sortKey="cost"
                align="right"
                title="Kwota netto. Dla osoby powiązanej z Kadrami liczona z jej wypłat i powiększona o narzut składek pracodawcy (Administracja → Firma)."
              />
              <SortHeader label="Prowizja" sortKey="commission" align="right" />
              <th className="text-right py-3 px-2 font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id} className="border-b hover:bg-muted/50">
                <td className="py-3 px-2 font-medium">
                  {`${s.firstName} ${s.lastName}`.trim()}
                  {s.notes && (
                    <span className="block text-xs text-muted-foreground">{s.notes}</span>
                  )}
                </td>
                <td className="py-3 px-2">{s.phone || "-"}</td>
                <td className="py-3 px-2">{s.email || "-"}</td>
                <td className="py-3 px-2">{s.region || "-"}</td>
                <td className="py-3 px-2">
                  {s.employeeId ? (
                    <span
                      className="inline-flex items-center gap-1 text-xs"
                      title={`Na liście płac: ${s.employeeName ?? "pracownik kadr"}`}
                    >
                      <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                      {s.employeeName || "powiązany"}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.contractorsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/contractors?salespersonId=${s.id}`)}
                      title="Pokaż kontrahentów tego handlowca"
                    >
                      {s.contractorsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.objectsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/objects?salespersonId=${s.id}`)}
                      title="Pokaż obiekty tego handlowca"
                    >
                      {s.objectsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.objectsMonthlyValue ? formatCurrency(s.objectsMonthlyValue) : "-"}
                </td>
                {/* Pusty koszt / prowizja = nieuzupełnione, nie 0 — stąd kreska.
                    Przy powiązaniu z kadrami ręczna kwota nie obowiązuje: koszt
                    bierze się z wypłat, żeby nie policzyć osoby dwa razy. */}
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.employeeId ? (
                    <span
                      className="text-xs text-muted-foreground"
                      title="Koszt liczony z wypłat tej osoby w Kadrach"
                    >
                      z Kadr
                    </span>
                  ) : s.monthlyCost === null || s.monthlyCost === undefined ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    formatCurrency(s.monthlyCost)
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {s.commissionRate === null || s.commissionRate === undefined ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    `${s.commissionRate}%`
                  )}
                </td>
                <td className="py-3 px-2">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/objects?salespersonId=${s.id}`)}
                      title="Obiekty handlowca"
                    >
                      <Building2 className="h-4 w-4" />
                    </Button>
                    {editable && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(s)}
                          title="Edytuj"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleArchive(s)}
                          title={s.active ? "Przenieś do archiwum" : "Przywróć"}
                          data-testid={`salesperson-archive-${s.id}`}
                        >
                          {s.active ? (
                            <Archive className="h-4 w-4" />
                          ) : (
                            <ArchiveRestore className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(s)}
                          title="Usuń"
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
    );
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj handlowca..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Regiony biorą się z tego, co ktoś wpisał w kartotece — to pole tekstowe,
            a nie słownik, więc lista buduje się z aktualnych wartości. */}
        <Select value={regionFilter} onValueChange={setRegionFilter}>
          <SelectTrigger className="w-[200px]" data-testid="handlowcy-filter-region">
            <SelectValue placeholder="Region" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie regiony</SelectItem>
            {regions.map((r) => (
              <SelectItem key={r} value={r}>
                {r}
              </SelectItem>
            ))}
            <SelectItem value={NO_REGION}>Bez regionu</SelectItem>
          </SelectContent>
        </Select>

        <Select value={hrMode} onValueChange={(v) => setHrMode(v as HrMode)}>
          <SelectTrigger className="w-[220px]" data-testid="handlowcy-filter-hr">
            <SelectValue placeholder="Powiązanie z kadrami" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Kadry: wszyscy</SelectItem>
            <SelectItem value="linked">Tylko powiązani z kadrami</SelectItem>
            <SelectItem value="unlinked">Tylko niepowiązani</SelectItem>
          </SelectContent>
        </Select>

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy handlowiec
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: portfel handlowca — tryb i widełki kwot. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
          <SelectTrigger className="w-[200px]" data-testid="handlowcy-filter-value-mode">
            <SelectValue placeholder="Wartość" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wartość: wszystkie</SelectItem>
            <SelectItem value="with">Tylko z abonamentem</SelectItem>
            <SelectItem value="without">Tylko bez abonamentu</SelectItem>
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
            data-testid="handlowcy-filter-min"
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
            data-testid="handlowcy-filter-max"
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
            data-testid="handlowcy-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
        {/* Jedno zdanie o konwencji na ekran zamiast dopisku przy każdej kwocie.
            Uwaga o wypłatach jest tu istotna: koszt osoby z Kadr to kwota NA RĘKĘ,
            powiększona o narzut składek pracodawcy — czyli szacowany pełny koszt. */}
        <p className="ml-auto flex items-center gap-2 text-sm text-muted-foreground">
          <Users className="h-4 w-4" />
          Opiekunowie przypisywani kontrahentom i obiektom · kwoty netto (bez VAT);
          koszt osoby z Kadr to wypłata powiększona o szacowane składki pracodawcy
        </p>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active">Aktualni ({active.length})</TabsTrigger>
          <TabsTrigger value="archived">Archiwalni ({archived.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(
                active,
                "Brak handlowców. Kliknij „Nowy handlowiec”, aby dodać pierwszego."
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="archived" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(archived, "Brak archiwalnych handlowców.")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {formOpen && (
        <SalespersonForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          salesperson={editing}
          employees={hrEmployees}
        />
      )}
    </div>
  );
}
