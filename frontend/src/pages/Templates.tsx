import { useEffect, useMemo, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CameraModelForm } from "@/components/CameraModelForm";
import { usePerms } from "@/auth/permissions";
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import {
  ArrowDown,
  ArrowUp,
  ChevronsUpDown,
  Plus,
  Search,
  Pencil,
  Trash2,
  X,
} from "lucide-react";
import {
  getCameraModels,
  createCameraModel,
  updateCameraModel,
  deleteCameraModel,
  type CameraModel,
  type CameraModelInput,
  type CameraModelType,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const typeLabels: Record<CameraModelType, string> = {
  bullet: "Tubowa",
  dome: "Kopułkowa",
  ptz: "PTZ",
  pano: "360°",
  lpr: "LPR (tablice)",
};

/** Kolumny, po których da się sortować listę szablonów kamer. */
type TemplateSortKey =
  | "name"
  | "manufacturer"
  | "type"
  | "resolution"
  | "fov"
  | "range"
  | "ir";

/**
 * Domyślny kierunek sortowania kolumny — parametry liczbowe ludzie czytają od
 * największej wartości (najlepsza optyka u góry), teksty alfabetycznie
 * (jak w kartotece obiektów).
 */
const DEFAULT_DIR: Record<TemplateSortKey, "asc" | "desc"> = {
  name: "asc",
  manufacturer: "asc",
  type: "asc",
  resolution: "desc",
  fov: "desc",
  range: "desc",
  ir: "desc",
};

/** Wartość w selekcie producenta oznaczająca „szablony bez wpisanego producenta”. */
const NO_MANUFACTURER = "__none__";

/** Filtr aktywności szablonu. */
type StatusMode = "all" | "active" | "inactive";

/** Liczba z pola tekstowego — przecinek jak kropka, śmieci traktujemy jak brak filtra. */
function parseAmount(raw: string): number | undefined {
  const n = parseFloat(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Rozdzielczość („4MP”) i zasięg IR („30m”) trzymamy jako wolny tekst, ale
 * sortować trzeba po liczbie — inaczej „12MP” wylądowałoby przed „4MP”.
 * Brak liczby = wartość pusta, czyli koniec listy w obu kierunkach.
 */
function leadingNumber(raw: string | null | undefined): number | null {
  const n = parseFloat(String(raw ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export function Templates() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/szablony");
  const [models, setModels] = useState<CameraModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  // Filtry i sortowanie liczymy po stronie klienta — `getCameraModels()` i tak
  // zwraca cały słownik szablonów (kilkadziesiąt pozycji), więc nie ma po co
  // dokładać parametrów do API. Z tego samego powodu widełki zasięgu idą bez
  // debounce'u: nie ma żądania do odciążenia, a lista przelicza się w tym samym
  // renderze co wpisana cyfra.
  const [typeFilter, setTypeFilter] = useState("all");
  const [manufacturerFilter, setManufacturerFilter] = useState("all");
  const [statusMode, setStatusMode] = useState<StatusMode>("all");
  const [minInput, setMinInput] = useState("");
  const [maxInput, setMaxInput] = useState("");
  const [sort, setSort] = useState<TemplateSortKey>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<CameraModel | null>(null);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getCameraModels();
      setModels(res.data ?? []);
    } catch (error) {
      console.error("Error loading camera models:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  const handleCreate = async (data: CameraModelInput) => {
    if (!editable) return;
    await createCameraModel(data);
    loadModels();
  };

  const handleUpdate = async (data: CameraModelInput) => {
    if (!editable) return;
    if (editing) {
      await updateCameraModel(editing.id, data);
      loadModels();
    }
  };

  const handleDelete = async (item: CameraModel) => {
    if (!editable) return;
    if (window.confirm(`Usunąć szablon "${item.name}"?`)) {
      try {
        await deleteCameraModel(item.id);
        loadModels();
      } catch (error) {
        alert(
          error instanceof Error ? error.message : "Nie można usunąć szablonu"
        );
      }
    }
  };

  const openEdit = (item: CameraModel) => {
    setEditing(item);
    setFormOpen(true);
  };

  const closeForm = () => {
    setFormOpen(false);
    setEditing(null);
  };

  /** Producenci do selecta — wolne pole tekstowe, więc listę budujemy z danych. */
  const manufacturers = useMemo(
    () =>
      Array.from(
        new Set(models.map((m) => m.manufacturer.trim()).filter((v) => v !== ""))
      ).sort((a, b) => a.localeCompare(b, "pl")),
    [models]
  );

  /** Jeden przebieg: filtry + sortowanie. */
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const min = parseAmount(minInput);
    const max = parseAmount(maxInput);

    const list = models.filter((m) => {
      if (statusMode === "active" && !m.active) return false;
      if (statusMode === "inactive" && m.active) return false;
      if (
        q &&
        ![m.name, m.manufacturer, typeLabels[m.type] ?? m.type, m.resolution]
          .filter(Boolean)
          .some((v) => v.toLowerCase().includes(q))
      ) {
        return false;
      }
      if (typeFilter !== "all" && m.type !== typeFilter) return false;
      if (manufacturerFilter !== "all") {
        const manufacturer = m.manufacturer.trim();
        if (
          manufacturerFilter === NO_MANUFACTURER
            ? manufacturer !== ""
            : manufacturer !== manufacturerFilter
        ) {
          return false;
        }
      }
      // Zasięg 0 m = parametr nieuzupełniony, więc widełki go nie łapią —
      // inaczej „od 20 m” wyrzucałoby też szablony bez danych, a „do 50 m”
      // pokazywałoby je jako najkrótsze.
      if (min !== undefined && m.range < min) return false;
      if (max !== undefined && m.range > max) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;
    const text = (m: CameraModel) =>
      sort === "name"
        ? m.name
        : sort === "manufacturer"
          ? m.manufacturer
          : (typeLabels[m.type] ?? m.type);
    /** Liczba do sortowania; `null` = w tabeli jest kreska, czyli wartość pusta. */
    const number = (m: CameraModel): number | null => {
      switch (sort) {
        case "resolution":
          return leadingNumber(m.resolution);
        case "fov":
          // FOV i zasięg zawsze są liczbą (0 = nieuzupełnione, ale tabela
          // pokazuje wtedy „0”, więc to informacja, a nie brak wartości).
          return m.fov;
        case "range":
          return m.range;
        default:
          return leadingNumber(m.irRange);
      }
    };

    const numeric =
      sort === "resolution" || sort === "fov" || sort === "range" || sort === "ir";

    // Puste teksty i brak wartości lądują na końcu w OBU kierunkach (jak NULLS
    // LAST w sortowaniu obiektów) — inaczej „sortuj po producencie” zaczynałoby
    // się od szablonów bez producenta. Remis rozstrzyga nazwa modelu, żeby
    // kolejność była stabilna.
    const compare = (a: CameraModel, b: CameraModel): number => {
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
    models,
    search,
    typeFilter,
    manufacturerFilter,
    statusMode,
    minInput,
    maxInput,
    sort,
    dir,
  ]);

  /** Klik w nagłówek: ta sama kolumna odwraca kierunek, nowa startuje od swojego domyślnego. */
  const toggleSort = (key: TemplateSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive =
    search !== "" ||
    typeFilter !== "all" ||
    manufacturerFilter !== "all" ||
    statusMode !== "all" ||
    minInput !== "" ||
    maxInput !== "";

  const clearFilters = () => {
    setSearch("");
    setTypeFilter("all");
    setManufacturerFilter("all");
    setStatusMode("all");
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
    sortKey: TemplateSortKey;
    align?: "left" | "right";
    title?: string;
  }) => {
    const activeCol = sort === sortKey;
    const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className={cn("px-3 py-2 font-medium", align === "right" ? "text-right" : "text-left")}>
        <button
          type="button"
          data-testid={`szablony-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          title={title}
          className={cn(
            "inline-flex items-center gap-1 rounded px-1 -mx-1 uppercase tracking-wide transition-colors hover:text-foreground",
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

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Szukaj modelu…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-10"
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-[180px]" data-testid="szablony-filter-type">
            <SelectValue placeholder="Typ kamery" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie typy</SelectItem>
            {(Object.keys(typeLabels) as CameraModelType[]).map((t) => (
              <SelectItem key={t} value={t}>
                {typeLabels[t]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Producenci biorą się z tego, co ktoś wpisał w szablonie — to pole
            tekstowe, a nie słownik, więc lista buduje się z aktualnych wartości. */}
        <Select value={manufacturerFilter} onValueChange={setManufacturerFilter}>
          <SelectTrigger className="w-[190px]" data-testid="szablony-filter-manufacturer">
            <SelectValue placeholder="Producent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy producenci</SelectItem>
            {manufacturers.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
            <SelectItem value={NO_MANUFACTURER}>Bez producenta</SelectItem>
          </SelectContent>
        </Select>

        <Select value={statusMode} onValueChange={(v) => setStatusMode(v as StatusMode)}>
          <SelectTrigger className="w-[180px]" data-testid="szablony-filter-status">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie szablony</SelectItem>
            <SelectItem value="active">Tylko aktywne</SelectItem>
            <SelectItem value="inactive">Tylko nieaktywne</SelectItem>
          </SelectContent>
        </Select>

        {editable && (
          <Button className="ml-auto" onClick={() => setFormOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Nowy model
          </Button>
        )}
      </div>

      {/* Druga linia filtrów: widełki zasięgu — najczęstszy parametr doboru kamery.
          Odpowiednik widełek kwot z kartoteki obiektów; ta lista nie ma cen. */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-sm text-muted-foreground">
          <span>Zasięg od</span>
          <Input
            type="number"
            min="0"
            step="5"
            inputMode="decimal"
            className="w-24 tabular-nums"
            data-testid="szablony-filter-min"
            value={minInput}
            onChange={(e) => setMinInput(e.target.value)}
          />
          <span>do</span>
          <Input
            type="number"
            min="0"
            step="5"
            inputMode="decimal"
            className="w-24 tabular-nums"
            data-testid="szablony-filter-max"
            value={maxInput}
            onChange={(e) => setMaxInput(e.target.value)}
          />
          <span>m</span>
        </div>
        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            data-testid="szablony-filters-clear"
          >
            <X className="h-4 w-4 mr-1" />
            Wyczyść filtry
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="py-10 text-center text-muted-foreground">
              Ładowanie…
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              {filtersActive
                ? "Brak szablonów dla wybranych filtrów"
                : "Brak szablonów kamer."}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <SortHeader label="Model" sortKey="name" />
                    <SortHeader label="Producent" sortKey="manufacturer" />
                    <SortHeader label="Typ" sortKey="type" />
                    <SortHeader
                      label="Rozdz."
                      sortKey="resolution"
                      title="Sortowanie po liczbie z wpisu (np. „4MP”); szablony bez rozdzielczości idą na koniec"
                    />
                    <SortHeader label="FOV (°)" sortKey="fov" align="right" />
                    <SortHeader label="Zasięg (m)" sortKey="range" align="right" />
                    <SortHeader
                      label="IR"
                      sortKey="ir"
                      title="Sortowanie po liczbie z wpisu (np. „30m”); szablony bez zasięgu IR idą na koniec"
                    />
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item) => (
                    <tr
                      key={item.id}
                      className={`cursor-pointer border-b last:border-0 hover:bg-accent/50 ${!item.active ? "opacity-50" : ""}`}
                      onClick={() => openEdit(item)}
                    >
                      <td className="px-3 py-2 font-medium">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block h-3 w-3 rounded-full border"
                            style={{ backgroundColor: item.color }}
                          />
                          {item.name}
                        </span>
                        {!item.active && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (nieaktywny)
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2">{item.manufacturer || "—"}</td>
                      <td className="px-3 py-2">
                        {typeLabels[item.type] ?? item.type}
                      </td>
                      <td className="px-3 py-2">{item.resolution || "—"}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.fov}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {item.range}
                      </td>
                      <td className="px-3 py-2">{item.irRange || "—"}</td>
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
                              onClick={() => openEdit(item)}
                              title="Edytuj"
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              onClick={() => handleDelete(item)}
                              title="Usuń"
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
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

      <CameraModelForm
        open={formOpen}
        onClose={closeForm}
        onSubmit={editing ? handleUpdate : handleCreate}
        item={editing}
      />
    </div>
  );
}
