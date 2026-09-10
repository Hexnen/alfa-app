/**
 * Kartoteka osób kontaktowych.
 *
 * Lista jest paginowana po stronie backendu (wzorzec `pages/Objects.tsx`):
 * sortowanie i filtry lecą w query, a nie w `Array.filter` na pobranej stronie —
 * inaczej „sortuj po nazwisku" sortowałoby tylko pięćdziesiątkę na ekranie.
 *
 * Klik w wiersz otwiera panel boczny z danymi osoby i jej ostatnimi
 * aktywnościami; usunięcie kontaktu wskazywanego przez wydarzenia kalendarza
 * kończy się po stronie API kodem 409 — wtedy proponujemy dezaktywację zamiast
 * kasowania, bo historia spotkań nie może zgubić rozmówcy.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowDown,
  ArrowUp,
  Building2,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Contact as ContactIcon,
  Handshake,
  Loader2,
  Mail,
  Pencil,
  Phone,
  Plus,
  Search,
  Star,
  Trash2,
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
import { ReadOnlyBanner } from "@/components/ReadOnlyBanner";
import { usePerms } from "@/auth/permissions";
import { ContactDialog } from "@/components/sales/ContactDialog";
import {
  calendarApi,
  contactsApi,
  getContractorCatalog,
  type CalendarEvent,
  type Contact,
  type ContactSortKey,
  type ContractorCatalogEntry,
} from "@/lib/api";
import {
  EVENT_TYPE_META,
  fmtRange,
  fmtRelative,
  pillClass,
  pluralPl,
  toDateStr,
} from "@/lib/calendar-labels";
import { leadHref } from "@/lib/sales-labels";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 50;

/** Domyślny kierunek kolumny — nazwiska od A, „ostatnio dodane" od najnowszych. */
const DEFAULT_DIR: Record<ContactSortKey, "asc" | "desc"> = {
  lastName: "asc",
  role: "asc",
  contractor: "asc",
  createdAt: "desc",
};

type ActiveMode = "all" | "1" | "0";

const shift = (days: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateStr(d);
};

const fullName = (c: Contact): string =>
  c.fullName || `${c.lastName} ${c.firstName}`.trim() || `Kontakt #${c.id}`;

export function HandlowyKontakty() {
  const { canEdit } = usePerms();
  const editable = canEdit("handlowy/kontakty");

  const [rows, setRows] = useState<Contact[]>([]);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [contractorFilter, setContractorFilter] = useState<number | undefined>(undefined);
  const [activeMode, setActiveMode] = useState<ActiveMode>("all");
  const [sort, setSort] = useState<ContactSortKey>("lastName");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(1);

  const [contractors, setContractors] = useState<ContractorCatalogEntry[]>([]);

  const [selected, setSelected] = useState<Contact | null>(null);
  const [panelEvents, setPanelEvents] = useState<CalendarEvent[]>([]);
  const [panelLoading, setPanelLoading] = useState(false);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Contact | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  useEffect(() => {
    getContractorCatalog()
      .then((res) => setContractors(res.data ?? []))
      .catch(() => setContractors([]));
  }, []);

  // Debounce szukajki — kartoteka bywa duża, a każde wciśnięcie klawisza to zapytanie.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Każda zmiana filtra wraca na pierwszą stronę — inaczej po zawężeniu listy
  // użytkownik ląduje na stronie, której już nie ma.
  const filtersKey = [search, contractorFilter, activeMode, sort, dir].join("|");
  const [lastFiltersKey, setLastFiltersKey] = useState(filtersKey);
  if (filtersKey !== lastFiltersKey) {
    setLastFiltersKey(filtersKey);
    if (page !== 1) setPage(1);
  }

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await contactsApi.list({
        q: search || undefined,
        contractorId: contractorFilter,
        active: activeMode === "all" ? undefined : activeMode === "1",
        sort,
        dir,
        page,
        pageSize: PAGE_SIZE,
      });
      setRows(res.data ?? []);
      setTotal(res.total ?? 0);
      setTotalPages(Math.max(1, res.totalPages ?? 1));
      setError(null);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nie udało się wczytać kontaktów.");
    } finally {
      setLoading(false);
    }
  }, [search, contractorFilter, activeMode, sort, dir, page]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Panel boczny: wydarzenia z tą osobą (rok wstecz i rok w przód). */
  useEffect(() => {
    if (!selected) {
      setPanelEvents([]);
      return;
    }
    let cancelled = false;
    setPanelLoading(true);
    calendarApi
      .getEvents({
        contactId: selected.id,
        department: "handlowy",
        from: shift(-365),
        to: shift(365),
      })
      .then((res) => {
        if (cancelled) return;
        const list = [...(res.data ?? [])].sort((a, b) => b.startAt.localeCompare(a.startAt));
        setPanelEvents(list);
      })
      .catch(() => {
        if (!cancelled) setPanelEvents([]);
      })
      .finally(() => {
        if (!cancelled) setPanelLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleSort = (key: ContactSortKey) => {
    if (sort === key) {
      setDir((d) => (d === "asc" ? "desc" : "asc"));
      return;
    }
    setSort(key);
    setDir(DEFAULT_DIR[key]);
  };

  const filtersActive = search !== "" || contractorFilter !== undefined || activeMode !== "all";
  const clearFilters = () => {
    setSearchInput("");
    setSearch("");
    setContractorFilter(undefined);
    setActiveMode("all");
  };

  /** Ustawienie „głównej" — backend sam zdejmuje flagę poprzedniej osobie. */
  const setPrimary = async (c: Contact) => {
    if (!editable || c.contractorId == null) return;
    setBusyId(c.id);
    try {
      await contactsApi.update(c.id, { lastName: c.lastName, isPrimary: !c.isPrimary });
      await load();
      if (selected?.id === c.id) setSelected({ ...c, isPrimary: !c.isPrimary });
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Nie udało się zmienić osoby głównej.");
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (c: Contact) => {
    if (!editable) return;
    if (!window.confirm(`Usunąć kontakt „${fullName(c)}”?`)) return;
    setBusyId(c.id);
    try {
      await contactsApi.remove(c.id);
      if (selected?.id === c.id) setSelected(null);
      await load();
    } catch (e) {
      const status = (e as { status?: number }).status;
      const msg = e instanceof Error && e.message ? e.message : "Nie udało się usunąć kontaktu.";
      if (status === 409) {
        // Kontakt jest w historii spotkań — kasowanie odpada, ale dezaktywacja
        // załatwia to, o co użytkownikowi zwykle chodzi (zniknąć z podpowiedzi).
        if (window.confirm(`${msg}\n\nUstawić go jako nieaktywny?`)) {
          try {
            await contactsApi.update(c.id, { lastName: c.lastName, active: false });
            await load();
            setError(null);
            return;
          } catch (e2) {
            setError(e2 instanceof Error ? e2.message : msg);
            return;
          }
        }
        setError(msg);
        return;
      }
      setError(msg);
    } finally {
      setBusyId(null);
    }
  };

  const SortHeader = ({
    label,
    sortKey,
  }: {
    label: string;
    sortKey: ContactSortKey;
  }) => {
    const active = sort === sortKey;
    const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <th className="px-2 py-3 text-left font-medium">
        <button
          type="button"
          data-testid={`kontakty-sort-${sortKey}`}
          onClick={() => toggleSort(sortKey)}
          aria-label={`Sortuj po: ${label}`}
          className={cn(
            "-mx-1 inline-flex items-center gap-1 rounded px-1 transition-colors hover:text-foreground",
            active ? "text-foreground" : "text-muted-foreground"
          )}
        >
          {label}
          <Icon className={cn("h-3.5 w-3.5", !active && "opacity-40")} />
        </button>
      </th>
    );
  };

  const summary = useMemo(
    () => `${pluralPl(total, "osoba", "osoby", "osób")} w kartotece`,
    [total]
  );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Kontakty</h1>
          <p className="text-sm text-muted-foreground">
            Osoby kontaktowe u kontrahentów i w szansach sprzedaży
          </p>
        </div>
        {editable && (
          <Button
            onClick={() => {
              setEditing(null);
              setDialogOpen(true);
            }}
            data-testid="kontakty-new"
          >
            <Plus className="mr-2 h-4 w-4" />
            Nowa osoba
          </Button>
        )}
      </div>

      {!editable && <ReadOnlyBanner />}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] max-w-sm flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Szukaj po nazwisku, telefonie, mailu…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-10"
            data-testid="kontakty-filter-q"
          />
        </div>

        <Select
          value={contractorFilter === undefined ? "all" : String(contractorFilter)}
          onValueChange={(v) => setContractorFilter(v === "all" ? undefined : Number(v))}
        >
          <SelectTrigger className="w-[220px]" data-testid="kontakty-filter-contractor">
            <SelectValue placeholder="Kontrahent" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszyscy kontrahenci</SelectItem>
            {contractors.map((ct) => (
              <SelectItem key={ct.id} value={String(ct.id)}>
                {ct.name}
                {!ct.active ? " (nieaktywny)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={activeMode} onValueChange={(v) => setActiveMode(v as ActiveMode)}>
          <SelectTrigger className="w-[180px]" data-testid="kontakty-filter-active">
            <SelectValue placeholder="Aktywność" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Wszystkie osoby</SelectItem>
            <SelectItem value="1">Tylko aktywne</SelectItem>
            <SelectItem value="0">Tylko nieaktywne</SelectItem>
          </SelectContent>
        </Select>

        {filtersActive && (
          <Button variant="ghost" size="sm" onClick={clearFilters} data-testid="kontakty-filters-clear">
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}

        <p className="ml-auto text-sm text-muted-foreground" data-testid="kontakty-summary">
          {summary}
        </p>
      </div>

      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert" data-testid="kontakty-error">
          {error}
        </p>
      )}

      <div className={cn("grid gap-4", selected && "lg:grid-cols-[1fr_360px]")}>
        <Card className="min-w-0">
          <CardContent className="p-0">
            {loading && rows.length === 0 ? (
              <p className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                Wczytywanie…
              </p>
            ) : rows.length === 0 ? (
              <p className="p-8 text-center text-sm text-muted-foreground" data-testid="kontakty-empty">
                {filtersActive
                  ? "Żadna osoba nie pasuje do filtrów."
                  : "Kartoteka jest pusta — dodaj pierwszą osobę kontaktową."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="kontakty-table">
                  <thead className="border-b text-xs">
                    <tr>
                      <SortHeader label="Nazwisko i imię" sortKey="lastName" />
                      <SortHeader label="Rola" sortKey="role" />
                      <th className="px-2 py-3 text-left font-medium text-muted-foreground">Telefon</th>
                      <th className="px-2 py-3 text-left font-medium text-muted-foreground">E-mail</th>
                      <SortHeader label="Kontrahent" sortKey="contractor" />
                      <th className="px-2 py-3 text-left font-medium text-muted-foreground">Szansa</th>
                      <th className="px-2 py-3 text-center font-medium text-muted-foreground">Główny</th>
                      <th className="px-2 py-3 text-center font-medium text-muted-foreground">Aktywny</th>
                      <th className="px-2 py-3 text-right font-medium text-muted-foreground">Akcje</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((c) => (
                      <tr
                        key={c.id}
                        data-testid={`kontakty-row-${c.id}`}
                        onClick={() => setSelected(c)}
                        className={cn(
                          "cursor-pointer hover:bg-muted/50",
                          selected?.id === c.id && "bg-muted/60",
                          !c.active && "opacity-60"
                        )}
                      >
                        <td className="px-2 py-2 font-medium">{fullName(c)}</td>
                        <td className="px-2 py-2 text-muted-foreground">{c.role || "—"}</td>
                        <td className="whitespace-nowrap px-2 py-2">
                          {c.phone ? (
                            <a
                              href={`tel:${c.phone.replace(/\s+/g, "")}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Phone className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                              {c.phone}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {c.email ? (
                            <a
                              href={`mailto:${c.email}`}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 truncate hover:underline"
                            >
                              <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                              {c.email}
                            </a>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {c.contractorId != null ? (
                            <Link
                              to={`/contractors?contractorId=${c.contractorId}`}
                              onClick={(e) => e.stopPropagation()}
                              className="hover:underline"
                            >
                              {c.contractorName || `#${c.contractorId}`}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">
                          {c.leadId != null ? (
                            <Link
                              to={leadHref(c.leadId)}
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 hover:underline"
                            >
                              <Handshake className="h-3.5 w-3.5" aria-hidden />
                              {c.leadTitle || `#${c.leadId}`}
                            </Link>
                          ) : (
                            "—"
                          )}
                        </td>
                        <td className="px-2 py-2 text-center">
                          <button
                            type="button"
                            disabled={!editable || c.contractorId == null || busyId === c.id}
                            data-testid={`kontakty-primary-${c.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void setPrimary(c);
                            }}
                            {...tip(
                              c.contractorId == null
                                ? "Główna osoba dotyczy kontrahenta — ten kontakt go nie ma"
                                : c.isPrimary
                                  ? "Zdejmij oznaczenie osoby głównej"
                                  : "Ustaw jako główną osobę kontrahenta"
                            )}
                            className="rounded p-1 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Star
                              className={cn(
                                "h-4 w-4",
                                c.isPrimary ? "fill-amber-400 text-amber-500" : "text-muted-foreground"
                              )}
                            />
                            <span className="sr-only">{c.isPrimary ? "Osoba główna" : "Nie jest osobą główną"}</span>
                          </button>
                        </td>
                        <td className="px-2 py-2 text-center">
                          <span className={pillClass(c.active ? "emerald" : "muted", { compact: true })}>
                            {c.active ? "Tak" : "Nie"}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-right">
                          {editable && (
                            <span className="inline-flex items-center gap-1">
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`kontakty-edit-${c.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditing(c);
                                  setDialogOpen(true);
                                }}
                                {...tip("Edytuj osobę")}
                              >
                                <Pencil className="h-4 w-4" />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon"
                                data-testid={`kontakty-delete-${c.id}`}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void remove(c);
                                }}
                                {...tip("Usuń osobę")}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </span>
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

        {selected && (
          <aside className="space-y-3" data-testid="kontakty-panel">
            <Card>
              <CardContent className="space-y-3 p-4">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 text-base font-semibold">
                      <ContactIcon className="h-4 w-4 text-muted-foreground" aria-hidden />
                      <span className="truncate">{fullName(selected)}</span>
                      {selected.isPrimary && <Star className="h-4 w-4 shrink-0 fill-amber-400 text-amber-500" aria-hidden />}
                    </p>
                    {selected.role && <p className="text-sm text-muted-foreground">{selected.role}</p>}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setSelected(null)}
                    {...tip("Zamknij panel")}
                    data-testid="kontakty-panel-close"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>

                <dl className="space-y-1.5 text-sm">
                  {selected.phone && (
                    <div className="flex items-center gap-2">
                      <Phone className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <a href={`tel:${selected.phone.replace(/\s+/g, "")}`} className="hover:underline">
                        {selected.phone}
                      </a>
                    </div>
                  )}
                  {selected.email && (
                    <div className="flex items-center gap-2">
                      <Mail className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <a href={`mailto:${selected.email}`} className="truncate hover:underline">
                        {selected.email}
                      </a>
                    </div>
                  )}
                  {selected.contractorId != null && (
                    <div className="flex items-center gap-2">
                      <Building2 className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <span className="truncate">{selected.contractorName || `#${selected.contractorId}`}</span>
                    </div>
                  )}
                  {selected.leadId != null && (
                    <div className="flex items-center gap-2">
                      <Handshake className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                      <Link to={leadHref(selected.leadId)} className="truncate hover:underline">
                        {selected.leadTitle || `Szansa #${selected.leadId}`}
                      </Link>
                    </div>
                  )}
                </dl>

                {selected.notes && (
                  <p className="whitespace-pre-wrap rounded-md bg-muted/50 p-2 text-xs text-muted-foreground">
                    {selected.notes}
                  </p>
                )}

                {editable && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onClick={() => {
                      setEditing(selected);
                      setDialogOpen(true);
                    }}
                    data-testid="kontakty-panel-edit"
                  >
                    <Pencil className="mr-1 h-3.5 w-3.5" />
                    Edytuj
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="space-y-2 p-4">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Ostatnie aktywności
                </p>
                {panelLoading ? (
                  <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    Wczytywanie…
                  </p>
                ) : panelEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground" data-testid="kontakty-panel-events-empty">
                    Brak wydarzeń z tą osobą w ostatnim roku.
                  </p>
                ) : (
                  <ul className="space-y-1.5" data-testid="kontakty-panel-events">
                    {panelEvents.slice(0, 10).map((ev) => {
                      const Icon = EVENT_TYPE_META[ev.type]?.icon ?? ContactIcon;
                      return (
                        <li key={ev.id} className="flex items-start gap-2 text-sm">
                          <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                          <span className="min-w-0">
                            <span className="block truncate">{ev.title}</span>
                            <span
                              className="block text-xs text-muted-foreground"
                              {...tip(fmtRange(ev.startAt, ev.endAt, ev.allDay))}
                            >
                              {fmtRelative(ev.startAt)}
                            </span>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </CardContent>
            </Card>
          </aside>
        )}
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2" data-testid="kontakty-pagination">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
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

      {dialogOpen && (
        <ContactDialog
          key={editing?.id ?? "new"}
          open={dialogOpen}
          onClose={() => setDialogOpen(false)}
          contact={editing}
          defaults={{ contractorId: contractorFilter ?? null }}
          onSaved={(saved) => {
            void load();
            if (selected?.id === saved.id) setSelected(saved);
          }}
        />
      )}
    </div>
  );
}
