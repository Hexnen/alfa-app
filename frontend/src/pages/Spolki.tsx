import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { CompanyForm, type EmployerMarkupGlobals } from "@/components/CompanyForm";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import {
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronsUpDown,
  Loader2,
  Pencil,
  Plus,
  Search,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import {
  adminCompanyApi,
  getCompanies,
  createCompany,
  updateCompany,
  deleteCompany,
  lookupCompanyInMf,
  COMPANY_FALLBACK_VALUES,
  type Company,
  type CompanyInput,
} from "@/lib/api";
import { cn, formatCurrency } from "@/lib/utils";

/** Kolumny, po których da się sortować listę spółek. */
type CompanySortKey = "name" | "fullName" | "nip" | "vat" | "objects" | "value" | "contracts";

/**
 * Domyślny kierunek sortowania kolumny — kwoty i liczniki ludzie czytają od
 * największej wartości, teksty alfabetycznie (jak w kartotece obiektów).
 */
const DEFAULT_DIR: Record<CompanySortKey, "asc" | "desc"> = {
  name: "asc",
  fullName: "asc",
  nip: "asc",
  vat: "asc",
  objects: "desc",
  value: "desc",
  contracts: "desc",
};

/** Filtr wartości miesięcznej: wszystkie / tylko z abonamentem / tylko bez. */
type ValueMode = "all" | "with" | "without";

/**
 * Filtr statusu VAT. Wartości „Czynny”/„Zwolniony”/„Niezarejestrowany” to dokładnie
 * te, które backend zapisuje z wykazu MF (`normalizeStatus` w `lib/mf-whitelist.ts`);
 * „unchecked” to spółki, których nikt jeszcze nie sprawdził (pusty `vatStatus`).
 */
type VatFilter = "all" | "Czynny" | "Zwolniony" | "Niezarejestrowany" | "unchecked";

/** Kwota z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Spółki grupy — słownik wspólny z kadrami. Nazwy pochodzą z arkusza WYNAGRODZENIA
 * (`hr_contracts.company`), więc kolumna „Umowy” pokazuje, ile umów kadrowych wisi
 * na danej spółce, a „Obiekty” — ile obiektów jest do niej przypisanych.
 */
export function Spolki() {
  const navigate = useNavigate();
  const { canEdit } = usePerms();
  const editable = canEdit("spolki");

  const [rows, setRows] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<"active" | "archived">("active");
  // Filtry i sortowanie liczymy po stronie klienta — `getCompanies()` i tak zwraca
  // cały słownik (kilkanaście spółek), więc nie ma po co dokładać parametrów do API.
  // Z tego samego powodu widełki kwot idą bez debounce'u: nie ma żądania do
  // odciążenia, a lista przelicza się w tym samym renderze co wpisana cyfra.
  const [vatFilter, setVatFilter] = useState<VatFilter>("all");
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [sort, setSort] = useState<CompanySortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Company | null>(null);
  /** Id spółki, dla której trwa sprawdzenie w wykazie MF. */
  const [checking, setChecking] = useState<number | null>(null);
  /**
   * Globalne narzuty składek — potrzebne tylko po to, żeby w formularzu pokazać
   * w placeholderze, co spółka odziedziczy. Endpoint jest za `requireAdmin`,
   * więc dla zwykłego użytkownika po cichu zostają wartości domyślne.
   */
  const [globalMarkups, setGlobalMarkups] = useState<EmployerMarkupGlobals>({
    uop: COMPANY_FALLBACK_VALUES.employerMarkupUop,
    zua: COMPANY_FALLBACK_VALUES.employerMarkupZlecenieZua,
    zza: COMPANY_FALLBACK_VALUES.employerMarkupZlecenieZza,
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getCompanies();
      setRows(res.data ?? []);
    } catch (error) {
      console.error("Error loading companies:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    adminCompanyApi
      .settings()
      .then((s) =>
        setGlobalMarkups({
          uop: s.values.employerMarkupUop,
          zua: s.values.employerMarkupZlecenieZua,
          zza: s.values.employerMarkupZlecenieZza,
        })
      )
      .catch(() => {
        /* brak uprawnień albo starszy backend — zostają wartości domyślne */
      });
  }, []);

  /** Ma własne narzuty? Wystarczy jedno nadpisanie, żeby oznaczyć wiersz. */
  const hasOwnMarkups = (c: Company) =>
    c.employerMarkupUop != null || c.employerMarkupZlecenieZua != null || c.employerMarkupZlecenieZza != null;

  /** Podpowiedź pod plakietką: które formy mają własny mnożnik. */
  const markupsTitle = (c: Company) =>
    [
      c.employerMarkupUop != null ? `umowa o pracę: ${c.employerMarkupUop}` : null,
      c.employerMarkupZlecenieZua != null ? `zlecenie ZUA: ${c.employerMarkupZlecenieZua}` : null,
      c.employerMarkupZlecenieZza != null ? `zlecenie ZZA: ${c.employerMarkupZlecenieZza}` : null,
    ]
      .filter(Boolean)
      .join(" · ");

  /**
   * Jeden przebieg: filtry + sortowanie. Liczniki na zakładkach biorą się z tej
   * samej listy, więc „Aktualne (3)” zawsze zgadza się z tym, co widać w tabeli.
   */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);

    const list = rows.filter((c) => {
      if (
        q &&
        ![c.name, c.fullName, c.nip, c.notes]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q))
      ) {
        return false;
      }
      if (vatFilter !== "all") {
        const status = (c.vatStatus ?? "").trim();
        if (vatFilter === "unchecked" ? status !== "" : status !== vatFilter) return false;
      }
      // Abonament 0 zł = spółka bez obiektów z ceną; tabela pokazuje tu kreskę,
      // więc filtr „bez abonamentu” łapie i zero, i brak.
      const value = c.objectsMonthlyValue ?? 0;
      if (valueMode === "with" && value <= 0) return false;
      if (valueMode === "without" && value > 0) return false;
      if (min !== undefined && value < min) return false;
      if (max !== undefined && value > max) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (c: Company) =>
      (sort === "name"
        ? c.name
        : sort === "fullName"
          ? c.fullName
          : sort === "nip"
            ? c.nip
            : c.vatStatus) ?? "";
    const number = (c: Company) =>
      sort === "objects"
        ? (c.objectsCount ?? 0)
        : sort === "value"
          ? (c.objectsMonthlyValue ?? 0)
          : (c.contractsCount ?? 0);

    // Puste teksty i brak kwoty lądują na końcu w OBU kierunkach (jak NULLS LAST
    // w sortowaniu obiektów) — inaczej „sortuj po NIP-ie” zaczynałoby się od
    // spółek bez NIP-u. Remis rozstrzyga nazwa, żeby kolejność była stabilna.
    const compare = (a: Company, b: Company): number => {
      if (sort === "objects" || sort === "value" || sort === "contracts") {
        const av = number(a);
        const bv = number(b);
        // Liczniki obiektów i umów pokazujemy jako „0” (to informacja), więc
        // tylko brak kwoty abonamentu jest traktowany jak wartość pusta.
        if (sort === "value" && (!av || !bv)) {
          if (!av && !bv) return 0;
          return av ? -1 : 1;
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

    return list.sort((a, b) => compare(a, b) || a.name.localeCompare(b.name, "pl"));
  }, [rows, search, vatFilter, valueMode, minInput, maxInput, sort, dir]);

  const active = visible.filter((c) => c.active);
  const archived = visible.filter((c) => !c.active);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: CompanySortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    vatFilter !== "all" ||
    valueMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearch("");
    setVatFilter("all");
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
    sortKey: CompanySortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("py-3 px-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`spolki-sort-${sortKey}`}
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

  const handleCreate = async (data: CompanyInput) => {
    await createCompany(data);
    load();
  };

  const handleUpdate = async (data: CompanyInput) => {
    if (!editing) return;
    await updateCompany(editing.id, data);
    load();
  };

  const toggleArchive = async (c: Company) => {
    if (!editable) return;
    try {
      await updateCompany(c.id, { active: !c.active });
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się zmienić statusu");
    }
  };

  const handleDelete = async (c: Company) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć spółkę ${c.name}?`)) return;
    try {
      await deleteCompany(c.id);
      load();
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie można usunąć spółki");
    }
  };

  /** Sprawdzenie w wykazie VAT MF po NIP-ie spółki (nasz walidator) + zapis danych. */
  const checkInMf = async (c: Company) => {
    if (!editable) return;
    if (!c.nip) {
      alert("Spółka nie ma NIP-u — uzupełnij go w edycji, wtedy pobiorę dane z wykazu MF.");
      return;
    }
    setChecking(c.id);
    try {
      const res = await lookupCompanyInMf(c.id);
      await load();
      if (res.message) alert(res.message);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Nie udało się sprawdzić w wykazie MF");
    } finally {
      setChecking(null);
    }
  };

  const openEdit = (c: Company) => {
    setEditing(c);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  const totals = (list: Company[]) => ({
    objects: list.reduce((a, c) => a + (c.objectsCount ?? 0), 0),
    value: list.reduce((a, c) => a + (c.objectsMonthlyValue ?? 0), 0),
    contracts: list.reduce((a, c) => a + (c.contractsCount ?? 0), 0),
  });

  const renderTable = (list: Company[], emptyText: string) => {
    if (loading) return <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>;
    if (list.length === 0) {
      return (
        <div className="py-10 text-center text-muted-foreground">
          {filtersActive ? "Brak spółek dla wybranych filtrów" : emptyText}
        </div>
      );
    }
    const sum = totals(list);
    return (
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b">
              <SortHeader label="Spółka" sortKey="name" />
              <SortHeader label="Pełna nazwa" sortKey="fullName" />
              <SortHeader label="NIP" sortKey="nip" />
              <SortHeader label="VAT (wykaz MF)" sortKey="vat" />
              <SortHeader label="Obiekty" sortKey="objects" align="right" />
              <SortHeader label="Abonament" sortKey="value" align="right" />
              <SortHeader
                label="Umowy (kadry)"
                sortKey="contracts"
                align="right"
                title="Umowy w module Kadry → Wynagrodzenia wskazujące na tę spółkę"
              />
              <th className="text-right py-3 px-2 font-medium">Akcje</th>
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={c.id} className="border-b hover:bg-muted/50">
                <td className="py-3 px-2 font-medium">
                  <span className="flex flex-wrap items-center gap-1.5">
                    {c.name}
                    {hasOwnMarkups(c) && (
                      <Badge
                        variant="secondary"
                        className="h-5 px-1.5 text-[10px] font-normal"
                        title={`Własne narzuty składek pracodawcy (${markupsTitle(c)}) — pozostałe formy biorą wartość globalną`}
                        data-testid={`company-markups-${c.id}`}
                      >
                        własne składki
                      </Badge>
                    )}
                  </span>
                  {c.notes && (
                    <span className="block text-xs text-muted-foreground">{c.notes}</span>
                  )}
                </td>
                <td className="py-3 px-2">{c.fullName || "-"}</td>
                <td className="py-3 px-2 tabular-nums">{c.nip || "-"}</td>
                <td className="py-3 px-2">
                  {c.vatStatus ? (
                    <span className="flex flex-col gap-0.5">
                      {/* „Niezarejestrowany” = podmiot nie figuruje w wykazie VAT. Dla spółek
                          komandytowych grupy to normalne (nie są podatnikami VAT), więc
                          pokazujemy to spokojnym kolorem, a nie alarmem. */}
                      <Badge
                        variant={
                          c.vatStatus === "Czynny"
                            ? "success"
                            : c.vatStatus === "Zwolniony"
                              ? "warning"
                              : "secondary"
                        }
                        className="w-fit"
                        title={
                          c.vatStatus === "Niezarejestrowany"
                            ? "Nie figuruje w wykazie podatników VAT (biała lista MF)"
                            : undefined
                        }
                      >
                        {c.vatStatus === "Niezarejestrowany" ? "Brak w wykazie VAT" : c.vatStatus}
                      </Badge>
                      {c.vatCheckedAt && (
                        <span className="text-xs text-muted-foreground">{c.vatCheckedAt}</span>
                      )}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">
                      {c.nip ? "niesprawdzona" : "brak NIP-u"}
                    </span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.objectsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate(`/objects?companyId=${c.id}`)}
                      title="Pokaż obiekty tej spółki"
                    >
                      {c.objectsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.objectsMonthlyValue ? formatCurrency(c.objectsMonthlyValue) : "-"}
                </td>
                <td className="py-3 px-2 text-right tabular-nums">
                  {c.contractsCount ? (
                    <button
                      className="hover:underline"
                      onClick={() => navigate("/kadry/wynagrodzenia")}
                      title="Przejdź do wynagrodzeń"
                    >
                      {c.contractsCount}
                    </button>
                  ) : (
                    <span className="text-muted-foreground">0</span>
                  )}
                </td>
                <td className="py-3 px-2">
                  <div className="flex items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => navigate(`/objects?companyId=${c.id}`)}
                      title="Obiekty spółki"
                    >
                      <Building2 className="h-4 w-4" />
                    </Button>
                    {editable && (
                      <>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => checkInMf(c)}
                          disabled={checking === c.id}
                          title={
                            c.nip
                              ? "Sprawdź w wykazie VAT MF i uzupełnij dane"
                              : "Brak NIP-u — uzupełnij go w edycji"
                          }
                          data-testid={`company-mf-${c.id}`}
                        >
                          {checking === c.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <ShieldCheck className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => openEdit(c)}
                          title="Edytuj"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => toggleArchive(c)}
                          title={c.active ? "Przenieś do archiwum" : "Przywróć"}
                          data-testid={`company-archive-${c.id}`}
                        >
                          {c.active ? (
                            <Archive className="h-4 w-4" />
                          ) : (
                            <ArchiveRestore className="h-4 w-4" />
                          )}
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleDelete(c)}
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
          <tfoot>
            <tr className="border-t">
              <td className="py-3 px-2 font-medium" colSpan={4}>
                Razem
              </td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">{sum.objects}</td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">
                {formatCurrency(sum.value)}
              </td>
              <td className="py-3 px-2 text-right font-medium tabular-nums">{sum.contracts}</td>
              <td />
            </tr>
          </tfoot>
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
            placeholder="Szukaj spółki..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>

        {/* Etykiety takie same jak plakietki w tabeli — „Niezarejestrowany” z wykazu
            MF czytamy jako „Brak w wykazie VAT”, bo dla spółek komandytowych grupy
            to normalny stan, a nie błąd. */}
        <Select value={vatFilter} onValueChange={(v) => setVatFilter(v as VatFilter)}>
          <SelectTrigger className="w-[220px]" data-testid="spolki-filter-vat">
            <SelectValue placeholder="Status VAT" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie statusy VAT</SelectItem>
            <SelectItem value="Czynny">VAT czynny</SelectItem>
            <SelectItem value="Zwolniony">VAT zwolniony</SelectItem>
            <SelectItem value="Niezarejestrowany">Brak w wykazie VAT</SelectItem>
            <SelectItem value="unchecked">Niesprawdzone</SelectItem>
          </SelectContent>
        </Select>

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowa spółka
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: abonament z obiektów spółki — tryb i widełki kwot. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
          <SelectTrigger className="w-[200px]" data-testid="spolki-filter-value-mode">
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
            data-testid="spolki-filter-min"
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
            data-testid="spolki-filter-max"
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
            data-testid="spolki-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
        <p className="ml-auto text-sm text-muted-foreground">
          Ten sam słownik, co spółki w Kadrach → Wynagrodzenia
        </p>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as "active" | "archived")}>
        <TabsList>
          <TabsTrigger value="active">Aktualne ({active.length})</TabsTrigger>
          <TabsTrigger value="archived">Archiwalne ({archived.length})</TabsTrigger>
        </TabsList>
        <TabsContent value="active" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(active, "Brak spółek. Kliknij „Nowa spółka”, aby dodać pierwszą.")}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="archived" className="mt-4">
          <Card>
            <CardContent className="p-2">
              {renderTable(archived, "Brak archiwalnych spółek.")}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {formOpen && (
        <CompanyForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={closeForm}
          onSubmit={editing ? handleUpdate : handleCreate}
          company={editing}
          globalMarkups={globalMarkups}
        />
      )}
    </div>
  );
}
