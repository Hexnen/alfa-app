import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  BookOpen,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Paperclip,
  Plus,
  Search,
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
import { ManualDialog, type ManualDialogMode } from "@/components/manuals/ManualDialog";
import { ManualLinkChip } from "@/components/manuals/ManualLinkChip";
import { ManualPreview } from "@/components/manuals/ManualPreview";
import { fmtRelative, fmtTimestamp } from "@/lib/calendar-labels";
import { manualsApi, type Manual } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Kolumny, po których da się sortować listę manuali (lewa kolumna jest kompaktowa). */
type ManualSort = "title" | "updated";

/** Domyślny kierunek: teksty alfabetycznie, daty od najnowszych. */
const DEFAULT_DIR: Record<ManualSort, "asc" | "desc"> = {
  title: "asc",
  updated: "desc",
};

/** Filtr „Powiązanie” — sentinel „all” jak w pozostałych listach (shadcn Select nie lubi pustej wartości). */
type LinkFilter = "all" | "item" | "service" | "none";

const PAGE_SIZE = 25;

/** Ile chipów powiązań pokazać w wierszu, zanim zwiniemy resztę w „+n”. */
const CHIPS_IN_ROW = 2;

/** Nagłówek klikalny — strzałka pokazuje kolumnę i kierunek sortowania. */
function SortHeader({
  label,
  sortKey,
  sort,
  dir,
  onToggle,
  align = "left",
  className,
}: {
  label: string;
  sortKey: ManualSort;
  sort: ManualSort;
  dir: "asc" | "desc";
  onToggle: (key: ManualSort) => void;
  align?: "left" | "right";
  /** Szerokość kolumny (tabela ma `table-fixed`). */
  className?: string;
}) {
  const activeCol = sort === sortKey;
  const Icon = !activeCol ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th className={cn("py-2 px-2 font-medium", align === "right" ? "text-right" : "text-left", className)}>
      <button
        type="button"
        data-testid={`manuals-sort-${sortKey}`}
        onClick={() => onToggle(sortKey)}
        aria-label={`Sortuj po: ${label}`}
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
}

/**
 * Biblioteka manuali działu technicznego: instrukcje, karty katalogowe i
 * dokumentacja podpięta pod konkretny sprzęt z magazynu albo usługę. Widok jest
 * dwukolumnowy (master-detail): po lewej filtrowana lista, po prawej podgląd
 * wybranego manuala. Lista jest mała, więc backend oddaje ją w całości, a
 * filtrowanie, sortowanie i stronicowanie dzieje się po stronie klienta (ten sam
 * wzorzec, co w Spółkach).
 */
export function Manuals() {
  const { canEdit } = usePerms();
  const editable = canEdit("technical/manuale");

  const [rows, setRows] = useState<Manual[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [linkFilter, setLinkFilter] = useState<LinkFilter>("all");
  const [sort, setSort] = useState<ManualSort>("updated");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Manual | null>(null);
  const [dialogMode, setDialogMode] = useState<ManualDialogMode>("create");
  // Bump przy każdym otwarciu: dialog dostaje świeży stan formularza z bieżącego
  // rekordu (wzorzec z ObjectDetails).
  const [dialogNonce, setDialogNonce] = useState(0);

  // Zaznaczenie trzymamy w URL (`?id=`), żeby reload i wysłany link wracały do
  // tego samego manuala — jedno źródło prawdy zamiast stanu duplikowanego obok.
  const [searchParams, setSearchParams] = useSearchParams();
  const idParam = Number(searchParams.get("id"));
  const selectedId = Number.isInteger(idParam) && idParam > 0 ? idParam : null;

  const select = useCallback(
    (id: number | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id == null) next.delete("id");
          else next.set("id", String(id));
          return next;
        },
        // `replace`, bo klikanie po liście nie powinno zapychać historii przeglądarki.
        { replace: true }
      );
    },
    [setSearchParams]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await manualsApi.list();
      setRows(res.data ?? []);
      setLoadError(null);
    } catch (err) {
      setRows([]);
      setLoadError(err instanceof Error ? err.message : "Nie udało się wczytać manuali");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows.filter((m) => {
      if (q) {
        const hay = [m.title, m.description, ...m.links.map((l) => l.name), ...m.links.map((l) => l.meta)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (linkFilter === "item" && !m.links.some((l) => l.kind === "item")) return false;
      if (linkFilter === "service" && !m.links.some((l) => l.kind === "service")) return false;
      if (linkFilter === "none" && m.links.length > 0) return false;
      return true;
    });

    const mul = dir === "asc" ? 1 : -1;

    return [...list].sort((a, b) => {
      if (sort === "title") {
        return (a.title || "").localeCompare(b.title || "", "pl") * mul || 0;
      }
      // Daty z SQLite („YYYY-MM-DD HH:MM:SS”) porównują się leksykograficznie.
      const av = a.updatedAt || a.createdAt || "";
      const bv = b.updatedAt || b.createdAt || "";
      return av.localeCompare(bv) * mul || a.title.localeCompare(b.title, "pl");
    });
  }, [rows, search, linkFilter, sort, dir]);

  // Zmiana filtrów/sortowania zawsze wraca na pierwszą stronę — inaczej można by
  // wylądować na pustej stronie po zawężeniu listy.
  useEffect(() => {
    setPage(1);
  }, [search, linkFilter, sort, dir]);

  // Zaznaczenie zawsze wskazuje coś, co widać na liście: po wczytaniu bez `?id=`
  // bierzemy pierwszy manual, a gdy wybrany wypadnie (filtry, usunięcie) —
  // pierwszy z tego, co zostało, albo pusty stan.
  useEffect(() => {
    if (loading || loadError) return;
    if (selectedId != null && visible.some((m) => m.id === selectedId)) return;
    const first = visible[0]?.id ?? null;
    if (first === selectedId) return;
    select(first);
  }, [loading, loadError, visible, selectedId, select]);

  const selected = useMemo(() => rows.find((m) => m.id === selectedId) ?? null, [rows, selectedId]);

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const pageSafe = Math.min(page, totalPages);
  const pageRows = visible.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  const filtersActive = search !== "" || linkFilter !== "all";

  const clearFilters = () => {
    setSearch("");
    setLinkFilter("all");
  };

  const toggleSort = (key: ManualSort) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const openNew = () => {
    setEditing(null);
    setDialogMode("create");
    setDialogNonce((n) => n + 1);
    setDialogOpen(true);
  };

  /** „Edytuj” w panelu podglądu — formularz dla zaznaczonego manuala. */
  const openEdit = (m: Manual) => {
    if (!editable) return;
    setEditing(m);
    setDialogMode("edit");
    setDialogNonce((n) => n + 1);
    setDialogOpen(true);
  };

  const closeDialog = () => {
    setDialogOpen(false);
    setEditing(null);
  };

  /** Po zapisie podmieniamy wiersz w miejscu, zaznaczamy go i dociągamy listę. */
  const handleSaved = (m: Manual) => {
    setRows((prev) => {
      const i = prev.findIndex((r) => r.id === m.id);
      if (i < 0) return [m, ...prev];
      const next = [...prev];
      next[i] = m;
      return next;
    });
    select(m.id);
    void load();
  };

  /** Usunięcie zaznaczonego manuala — efekt wyżej przeskoczy na pierwszy z listy. */
  const handleDelete = async (m: Manual) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć manual „${m.title}”? Załączniki znikną razem z nim.`)) return;
    try {
      await manualsApi.remove(m.id);
      setRows((prev) => prev.filter((r) => r.id !== m.id));
    } catch (err) {
      window.alert(err instanceof Error ? err.message : "Nie udało się usunąć manuala");
    }
  };

  return (
    <div className="space-y-3">
      {!editable && <ReadOnlyBanner className="mb-4" />}

      <div className="grid gap-4 lg:grid-cols-[minmax(320px,2fr)_3fr]">
        {/* --- Lewa kolumna: filtry + lista ---
            Panel po prawej pokazuje załączniki inline, więc bywa kilka razy wyższy
            od listy — bez `sticky` lista uciekała w górę i przy dłuższej instrukcji
            nie dało się przeskoczyć do innego manuala bez wracania na sam początek.
            `self-start` odpina kolumnę od rozciągania siatki (inaczej `sticky` nie
            ma czego przyklejać), a `max-h`+`overflow-y-auto` ratuje przypadek, gdy
            sama lista (do 25 pozycji) jest wyższa od okna — wtedy przewija się
            wewnątrz zamiast chować dolne wiersze pod krawędzią ekranu. */}
        <div className="min-w-0 space-y-3 lg:sticky lg:top-4 lg:self-start lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[180px] flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Szukaj manuala, sprzętu, usługi..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-10"
                data-testid="manuals-filter-search"
              />
            </div>

            {editable && (
              <Button onClick={openNew} data-testid="manuals-add">
                <Plus className="h-4 w-4 mr-2" />
                Nowy manual
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select value={linkFilter} onValueChange={(v) => setLinkFilter(v as LinkFilter)}>
              <SelectTrigger className="w-[220px]" data-testid="manuals-filter-link">
                <SelectValue placeholder="Powiązanie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Powiązanie: wszystkie</SelectItem>
                <SelectItem value="item">Tylko ze sprzętem</SelectItem>
                <SelectItem value="service">Tylko z usługą</SelectItem>
                <SelectItem value="none">Bez powiązań</SelectItem>
              </SelectContent>
            </Select>

            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="manuals-filters-clear">
                <X className="h-4 w-4 mr-1" />
                Wyczyść filtry
              </Button>
            )}
          </div>

          <Card>
            <CardContent className="p-2">
              {loading ? (
                <div className="py-10 text-center text-muted-foreground">Ładowanie…</div>
              ) : loadError ? (
                <div className="py-10 text-center text-destructive" data-testid="manuals-error">
                  {loadError}
                </div>
              ) : pageRows.length === 0 ? (
                <div className="py-10 text-center text-muted-foreground" data-testid="manuals-empty">
                  {filtersActive
                    ? "Brak manuali dla wybranych filtrów"
                    : editable
                      ? "Brak manuali. Kliknij „Nowy manual”, aby dodać pierwszy."
                      : "Brak manuali."}
                </div>
              ) : (
                <div>
                  {/* `table-fixed`: przy automatycznym układzie tabeli długi tytuł
                      rozpycha pierwszą kolumnę do szerokości treści (`truncate` nigdy
                      nie zadziała, bo kolumna rośnie razem z tekstem) i wypycha
                      „Zaktualizowano” poza wąską lewą kolumnę. Stała szerokość kolumny
                      dat trzyma obie w kadrze i włącza ucinanie tytułu. */}
                  <table className="w-full table-fixed text-sm">
                    <thead>
                      <tr className="border-b">
                        <SortHeader label="Tytuł" sortKey="title" sort={sort} dir={dir} onToggle={toggleSort} />
                        <SortHeader
                          label="Zaktualizowano"
                          sortKey="updated"
                          sort={sort}
                          dir={dir}
                          onToggle={toggleSort}
                          align="right"
                          className="w-[150px]"
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((m) => {
                        const isSelected = m.id === selectedId;
                        const count = m.attachmentsCount ?? m.attachments.length;
                        const chips = m.links.slice(0, CHIPS_IN_ROW);
                        const rest = m.links.length - chips.length;
                        return (
                          <tr
                            key={m.id}
                            className={cn(
                              // `ring-inset`, bo domyślny outline przeglądarki przycina
                              // się o `overflow-x-auto` opakowania tabeli — przy chodzeniu
                              // po liście Tabem nie było widać, który wiersz ma focus.
                              "cursor-pointer border-b transition-colors",
                              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                              isSelected ? "bg-muted" : "hover:bg-muted/50"
                            )}
                            onClick={() => select(m.id)}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              select(m.id);
                            }}
                            tabIndex={0}
                            aria-selected={isSelected}
                            data-selected={isSelected ? "true" : "false"}
                            data-testid={`manuals-row-${m.id}`}
                          >
                            <td className="py-2 px-2 align-top">
                              <span className="flex items-center gap-1.5 font-medium">
                                <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                                {/* Kolumna jest wąska, więc długie tytuły ucinamy — pełny
                                    w tooltipie, żeby dało się je odczytać bez klikania. */}
                                <span className="truncate" title={m.title}>
                                  {m.title}
                                </span>
                              </span>
                              <span className="mt-1 flex flex-wrap items-center gap-1">
                                {chips.map((l) => (
                                  <ManualLinkChip key={`${l.kind}-${l.refId}`} kind={l.kind} name={l.name} meta={l.meta} />
                                ))}
                                {rest > 0 && (
                                  <span
                                    className="text-[11px] text-muted-foreground"
                                    title={m.links.map((l) => l.name).join(", ")}
                                  >
                                    +{rest}
                                  </span>
                                )}
                                {count > 0 && (
                                  <span
                                    className="inline-flex items-center gap-1 text-[11px] tabular-nums text-muted-foreground"
                                    title={`Załączniki: ${count}`}
                                  >
                                    <Paperclip className="h-3 w-3" aria-hidden />
                                    {count}
                                  </span>
                                )}
                              </span>
                            </td>
                            <td
                              className="py-2 px-2 text-right align-top text-muted-foreground"
                              title={m.updatedAt ? fmtTimestamp(m.updatedAt) : undefined}
                            >
                              <span className="whitespace-nowrap">{m.updatedAt ? fmtRelative(m.updatedAt) : "-"}</span>
                              {m.updatedBy && (
                                <span className="block truncate text-xs" title={m.updatedBy}>
                                  {m.updatedBy}
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Stronicowanie po stronie klienta — pokazujemy je dopiero, gdy jest co przewijać. */}
          {!loading && !loadError && visible.length > PAGE_SIZE && (
            <div className="flex items-center justify-end gap-2 text-sm text-muted-foreground">
              <span className="tabular-nums">
                {(pageSafe - 1) * PAGE_SIZE + 1}–{Math.min(pageSafe * PAGE_SIZE, visible.length)} z {visible.length}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={pageSafe <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                aria-label="Poprzednia strona"
                data-testid="manuals-page-prev"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={pageSafe >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                aria-label="Następna strona"
                data-testid="manuals-page-next"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>

        {/* --- Prawa kolumna: podgląd wybranego manuala --- */}
        <div className="min-w-0">
          <ManualPreview
            manual={selected}
            canEdit={editable}
            onEdit={openEdit}
            onDelete={(m) => void handleDelete(m)}
          />
        </div>
      </div>

      {dialogOpen && (
        <ManualDialog
          key={`${editing?.id ?? "new"}-${dialogNonce}`}
          open={dialogOpen}
          onClose={closeDialog}
          manual={editing}
          mode={dialogMode}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
