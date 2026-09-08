import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArchiveRestore,
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Pencil,
  Plus,
  X,
} from "lucide-react";
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
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { tip } from "@/components/ui/tooltip";
import { isPriceStale, priceAgeLabel } from "@/lib/price-age";
import {
  servicesApi,
  SERVICE_CATEGORIES,
  SERVICE_SYSTEMS,
  type Service,
  type ServiceInput,
} from "@/lib/api";
import { ServiceForm } from "@/components/ServiceForm";
import {
  SERVICE_CATEGORY_LABEL,
  SERVICE_CATEGORY_TONE,
  SERVICE_SYSTEM_LABEL,
} from "@/components/servicesShared";
import {
  fmtPct,
  fmtPln,
} from "@/components/warehouse/warehouseShared";
import { fmtRelative, fmtTimestamp, pillClass } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";

const alertError = (err: unknown, fallback: string) =>
  window.alert(err instanceof Error ? err.message : fallback);

/** Kolumny, po których da się sortować katalog usług. */
type ServiceSortKey =
  | "name"
  | "category"
  | "system"
  | "unit"
  | "cost"
  | "price"
  | "margin"
  | "created"
  | "updated";

/**
 * Domyślny kierunek sortowania kolumny — kwoty, marże i daty ludzie czytają od
 * największej wartości (najnowsze/najdroższe u góry), teksty alfabetycznie
 * (jak w kartotece obiektów).
 */
const DEFAULT_DIR: Record<ServiceSortKey, "asc" | "desc"> = {
  name: "asc",
  category: "asc",
  system: "asc",
  unit: "asc",
  cost: "desc",
  price: "desc",
  margin: "desc",
  created: "desc",
  updated: "desc",
};

/** Filtr ceny: wszystkie / tylko wycenione / tylko z zerową ceną. */
type ValueMode = "all" | "with" | "without";

/** Filtr archiwum — zastępuje dawny przełącznik „Pokaż zarchiwizowane”. */
type StatusMode = "active" | "archived" | "all";

/** Wartość w selekcie oznaczająca „usługi bez wpisanego systemu”. */
const NO_SYSTEM = "__none__";

/** Kwota z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/** Data z bazy na liczbę do porównań; brak lub śmieć = wartość pusta (NULLS LAST). */
function parseDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * Komórka ze stawką. Na czerwono, gdy ceny nikt nie potwierdził od roku —
 * stara stawka robocizny w ofercie zjada marżę po cichu, więc sygnał musi być
 * widoczny już na liście katalogu, a nie dopiero w edytorze oferty.
 * Osobny komponent, żeby nie liczyć wieku dwa razy w ciele wiersza.
 */
function PriceCell({
  value,
  priceUpdatedAt,
}: {
  value: number;
  priceUpdatedAt: string | null;
}) {
  if (!isPriceStale(priceUpdatedAt, "service")) {
    return <td className="px-3 py-2 text-right tabular-nums">{fmtPln(value)}</td>;
  }
  return (
    <td className="px-3 py-2 text-right tabular-nums text-red-600 font-medium">
      <span
        className="inline-flex items-center gap-1"
        {...tip(priceAgeLabel(priceUpdatedAt, "service"))}
      >
        <AlertTriangle className="h-3 w-3" />
        {fmtPln(value)}
      </span>
    </td>
  );
}

export function Uslugi() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/uslugi");

  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Filtry i sortowanie liczymy po stronie klienta — `servicesApi.list()` i tak
  // zwraca cały katalog (kilkadziesiąt pozycji), więc nie ma po co dokładać
  // parametrów do API. Z tego samego powodu widełki kwot idą bez debounce'u:
  // nie ma żądania do odciążenia, a lista przelicza się w tym samym renderze
  // co wpisana cyfra.
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [systemFilter, setSystemFilter] = useState("all");
  const [unitFilter, setUnitFilter] = useState("all");
  const [statusMode, setStatusMode] = useState<StatusMode>("active");
  const [valueMode, setValueMode] = useState<ValueMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [sort, setSort] = useState<ServiceSortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Service | null>(null);

  // Zawsze pobieramy komplet (z archiwum) i filtrujemy lokalnie — katalog usług
  // jest mały, a dzięki temu przełącznik „pokaż archiwum" nie odpytuje serwera.
  const load = useCallback(async () => {
    try {
      const res = await servicesApi.list({ includeInactive: true });
      setServices(res.data || []);
    } catch (err) {
      alertError(err, "Błąd wczytywania usług");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Jednostki do selecta — wolne pole tekstowe, więc listę budujemy z danych. */
  const units = useMemo(
    () =>
      Array.from(
        new Set(services.map((s) => s.unit.trim()).filter((u) => u !== ""))
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [services]
  );

  /** Jeden przebieg: filtry + sortowanie. */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);

    const list = services.filter((s) => {
      if (statusMode === "active" && !s.active) return false;
      if (statusMode === "archived" && s.active) return false;
      if (
        q &&
        ![s.name, s.description, s.unit].some((v) =>
          (v ?? "").toLowerCase().includes(q)
        )
      ) {
        return false;
      }
      if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
      if (systemFilter !== "all") {
        if (systemFilter === NO_SYSTEM ? s.system !== null : s.system !== systemFilter) {
          return false;
        }
      }
      if (unitFilter !== "all" && s.unit.trim() !== unitFilter) return false;
      // Cena 0 zł = pozycja jeszcze niewyceniona (np. świeżo dodana usługa),
      // więc filtr „bez ceny” łapie i zero, i brak.
      const value = s.price ?? 0;
      if (valueMode === "with" && value <= 0) return false;
      if (valueMode === "without" && value > 0) return false;
      if (min !== undefined && value < min) return false;
      if (max !== undefined && value > max) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (s: Service) =>
      sort === "name"
        ? s.name
        : sort === "category"
          ? SERVICE_CATEGORY_LABEL[s.category]
          : sort === "system"
            ? // Usługa uniwersalna (kreska w tabeli) nie ma nazwy systemu,
              // więc idzie na koniec jak pusty tekst.
              (s.system ? SERVICE_SYSTEM_LABEL[s.system] : "")
            : s.unit;
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (s: Service): number | null => {
      switch (sort) {
        case "cost":
          return s.cost;
        case "price":
          return s.price;
        case "margin":
          return s.marginPct;
        case "created":
          return parseDate(s.createdAt);
        default:
          // „Zmienił”: tabela pokazuje kreskę, dopóki nikt nie ruszył pozycji
          // od utworzenia — traktujemy to jak brak wartości.
          return s.updatedAt && s.updatedAt !== s.createdAt
            ? parseDate(s.updatedAt)
            : null;
      }
    };

    const numeric =
      sort === "cost" ||
      sort === "price" ||
      sort === "margin" ||
      sort === "created" ||
      sort === "updated";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po marży” zaczynałoby się od
    // pozycji bez kosztu. Remis rozstrzyga nazwa, żeby kolejność była stabilna.
    const compare = (a: Service, b: Service): number => {
      if (numeric) {
        const av = number(a);
        const bv = number(b);
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

    return list.sort((a, b) => compare(a, b) || a.name.localeCompare(b.name, "pl"));
  }, [
    services,
    search,
    categoryFilter,
    systemFilter,
    unitFilter,
    statusMode,
    valueMode,
    minInput,
    maxInput,
    sort,
    dir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: ServiceSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    categoryFilter !== "all" ||
    systemFilter !== "all" ||
    unitFilter !== "all" ||
    statusMode !== "active" ||
    valueMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearch("");
    setCategoryFilter("all");
    setSystemFilter("all");
    setUnitFilter("all");
    setStatusMode("active");
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
    sortKey: ServiceSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`uslugi-sort-${sortKey}`}
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

  const handleSubmit = async (data: ServiceInput) => {
    if (editing) {
      await servicesApi.update(editing.id, data);
    } else {
      await servicesApi.create(data);
    }
    await load();
  };

  const handleArchive = async (s: Service) => {
    if (!window.confirm(`Zarchiwizować usługę „${s.name}"?`)) return;
    try {
      await servicesApi.archive(s.id);
      await load();
    } catch (err) {
      alertError(err, "Błąd archiwizacji usługi");
    }
  };

  const handleRestore = async (s: Service) => {
    try {
      await servicesApi.update(s.id, {
        name: s.name,
        category: s.category,
        system: s.system ?? "",
        unit: s.unit,
        cost: s.cost,
        price: s.price,
        description: s.description ?? undefined,
        active: true,
        position: s.position,
      });
      await load();
    } catch (err) {
      alertError(err, "Błąd przywracania usługi");
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold">Usługi</h1>
        <p className="text-sm text-muted-foreground">
          Robocizna, uruchomienia i abonamenty wchodzące do ofert. Każda pozycja
          ma koszt własny obok ceny — z tego liczy się marża oferty.
        </p>
      </div>

      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="flex flex-wrap items-center gap-2">
        <Input
          placeholder="Szukaj usługi…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="w-[190px]" data-testid="uslugi-filter-category">
            <SelectValue placeholder="Kategoria" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie kategorie</SelectItem>
            {SERVICE_CATEGORIES.map((k) => (
              <SelectItem key={k} value={k}>
                {SERVICE_CATEGORY_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* System jest opcjonalny (usługa może być uniwersalna), więc obok listy
            systemów jest osobna pozycja na pozycje bez przypisania. */}
        <Select value={systemFilter} onValueChange={setSystemFilter}>
          <SelectTrigger className="w-[190px]" data-testid="uslugi-filter-system">
            <SelectValue placeholder="System" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie systemy</SelectItem>
            {SERVICE_SYSTEMS.map((k) => (
              <SelectItem key={k} value={k}>
                {SERVICE_SYSTEM_LABEL[k]}
              </SelectItem>
            ))}
            <SelectItem value={NO_SYSTEM}>Bez systemu</SelectItem>
          </SelectContent>
        </Select>

        {/* Jednostki biorą się z tego, co ktoś wpisał w katalogu — to pole
            tekstowe z podpowiedziami, a nie słownik. */}
        <Select value={unitFilter} onValueChange={setUnitFilter}>
          <SelectTrigger className="w-[150px]" data-testid="uslugi-filter-unit">
            <SelectValue placeholder="Jednostka" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie jednostki</SelectItem>
            {units.map((u) => (
              <SelectItem key={u} value={u}>
                {u}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusMode} onValueChange={(v) => setStatusMode(v as StatusMode)}>
          <SelectTrigger className="w-[190px]" data-testid="uslugi-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Tylko aktualne</SelectItem>
            <SelectItem value="archived">Tylko zarchiwizowane</SelectItem>
            <SelectItem value="all">Aktualne i archiwum</SelectItem>
          </SelectContent>
        </Select>

        {editable && (
          <Button
            className="ml-auto"
            onClick={() => {
              setEditing(null);
              setFormOpen(true);
            }}
          >
            <Plus className="mr-1 h-4 w-4" /> Nowa usługa
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: cena sprzedaży — tryb i widełki kwot. */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={valueMode} onValueChange={(v) => setValueMode(v as ValueMode)}>
          <SelectTrigger className="w-[200px]" data-testid="uslugi-filter-value-mode">
            <SelectValue placeholder="Cena" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Cena: wszystkie</SelectItem>
            <SelectItem value="with">Tylko wycenione</SelectItem>
            <SelectItem value="without">Tylko bez ceny</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Cena od</span>
          <Input
            type="number"
            min="0"
            step="50"
            inputMode="decimal"
            className="w-28 tabular-nums"
            data-testid="uslugi-filter-min"
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
            data-testid="uslugi-filter-max"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
          <span>zł netto</span>
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="uslugi-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
                <tr>
                  <SortHeader label="Usługa" sortKey="name" />
                  <SortHeader label="Kategoria" sortKey="category" />
                  <SortHeader label="System" sortKey="system" />
                  <SortHeader label="Jedn." sortKey="unit" />
                  <SortHeader label="Koszt" sortKey="cost" align="right" />
                  <SortHeader label="Cena" sortKey="price" align="right" />
                  <SortHeader
                    label="Marża / narzut"
                    sortKey="margin"
                    align="right"
                    title="Sortowanie po marży procentowej; pozycje bez kosztu lub ceny idą na koniec"
                  />
                  <SortHeader label="Utworzył" sortKey="created" />
                  <SortHeader
                    label="Zmienił"
                    sortKey="updated"
                    title="Pozycje nieruszane od utworzenia idą na koniec"
                  />
                  {editable && (
                    <th className="px-3 py-2 text-right font-medium">Akcje</th>
                  )}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={editable ? 10 : 9}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      Ładowanie…
                    </td>
                  </tr>
                ) : visible.length === 0 ? (
                  <tr>
                    <td
                      colSpan={editable ? 10 : 9}
                      className="px-3 py-8 text-center text-muted-foreground"
                    >
                      {filtersActive
                        ? "Brak usług dla wybranych filtrów"
                        : "Katalog usług jest pusty. Dodaj pierwszą pozycję, np. „Montaż kamery IP”."}
                    </td>
                  </tr>
                ) : (
                  visible.map((s) => (
                    <tr
                      key={s.id}
                      className={`border-b last:border-0 ${
                        s.active ? "" : "opacity-60"
                      }`}
                    >
                      <td className="px-3 py-2">
                        <div className="font-medium">{s.name}</div>
                        {s.description && (
                          <div className="text-xs text-muted-foreground">
                            {s.description}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span className={pillClass(SERVICE_CATEGORY_TONE[s.category])}>
                          {SERVICE_CATEGORY_LABEL[s.category]}
                        </span>
                        {!s.active && (
                          <span className={pillClass("muted", { className: "ml-1" })}>
                            archiwum
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {s.system ? SERVICE_SYSTEM_LABEL[s.system] : "—"}
                      </td>
                      <td className="px-3 py-2">{s.unit}</td>
                      <PriceCell value={s.cost} priceUpdatedAt={s.priceUpdatedAt} />
                      <PriceCell value={s.price} priceUpdatedAt={s.priceUpdatedAt} />
                      <td
                        className="px-3 py-2 text-right tabular-nums"
                        title={
                          s.marginAmount !== null
                            ? `Zysk ${fmtPln(s.marginAmount)} na ${s.unit}`
                            : "Brak kosztu lub ceny — marży nie da się policzyć"
                        }
                      >
                        {s.marginPct !== null ? (
                          <>
                            {fmtPct(s.marginPct)}
                            <span className="text-muted-foreground">
                              {" / "}
                              {fmtPct(s.markupPct)}
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                      {/* Autor i data w jednej kolumnie — to jedna informacja
                          („kto i kiedy"), a osobna kolumna na samą datę tylko
                          rozpychałaby tabelę. Pełny znacznik czasu siedzi
                          w dymku, bo „2 dni temu" czyta się szybciej niż
                          „30.08.2026 14:12". Układ 1:1 jak w tabeli ofert. */}
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        <div>
                          {s.createdByLabel || (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </div>
                        <div
                          className="text-muted-foreground"
                          {...tip(fmtTimestamp(s.createdAt))}
                        >
                          {fmtRelative(s.createdAt)}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs whitespace-nowrap">
                        {s.updatedAt && s.updatedAt !== s.createdAt ? (
                          <>
                            <div>
                              {s.updatedByLabel || (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </div>
                            <div
                              className="text-muted-foreground"
                              {...tip(fmtTimestamp(s.updatedAt))}
                            >
                              {fmtRelative(s.updatedAt)}
                            </div>
                          </>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            {...tip("Pozycja nie była zmieniana od utworzenia")}
                          >
                            —
                          </span>
                        )}
                      </td>
                      {editable && (
                        <td className="px-3 py-2">
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              title="Edytuj"
                              onClick={() => {
                                setEditing(s);
                                setFormOpen(true);
                              }}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            {s.active ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Archiwizuj"
                                className="text-muted-foreground hover:text-destructive"
                                onClick={() => handleArchive(s)}
                              >
                                <Archive className="h-4 w-4" />
                              </Button>
                            ) : (
                              <Button
                                variant="ghost"
                                size="sm"
                                title="Przywróć z archiwum"
                                onClick={() => handleRestore(s)}
                              >
                                <ArchiveRestore className="h-4 w-4" />
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

      {formOpen && (
        <ServiceForm
          key={editing?.id ?? "new"}
          open={formOpen}
          onClose={() => setFormOpen(false)}
          onSubmit={handleSubmit}
          service={editing}
        />
      )}
    </div>
  );
}
