/**
 * Kadry → Historia — dziennik zmian całego modułu.
 *
 * Jedna oś czasu na wszystko: kartoteka, umowy, godziny, wypłaty, biuro,
 * słowniki obiektów i działów, normy. Filtry zawężają zapytanie NA SERWERZE
 * (`GET /hr/activity`), a nie już pobraną stronę — inaczej „pokaż zmiany
 * Kowalskiego z września” działałoby tylko w obrębie ostatnich 50 wpisów.
 *
 * Kliknięcie nazwiska prowadzi do kartoteki z ustawioną szukajką
 * (`/kadry/pracownicy?q=Nazwisko Imię`).
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Filter, History, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ActivityTimeline } from "@/components/ActivityTimeline";
import {
  getHrActivity,
  getHrActivityUsers,
  type HrActivityEntityType,
  type HrActivityEntry,
} from "@/lib/api";
import {
  HR_ENTITY_LABELS,
  HR_ENTITY_OPTIONS,
  describeHrActivity,
  hrEntryDetail,
  hrFieldLabel,
  hrFieldValue,
  hrPeriodLabel,
} from "./history-labels";
import { EmptyState, FILTER_GROUP_LABEL_CLS, TOOLBAR_BTN_CLS } from "./ui";
import { KadryHelp } from "./KadryHelp";

/** Wartość „bez filtra” w selektach shadcn — pusty string nie jest dozwolony. */
const ALL = "all";

export function HistoryTab() {
  const [q, setQ] = useState("");
  const [entityType, setEntityType] = useState<string>(ALL);
  const [userId, setUserId] = useState<string>(ALL);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const [users, setUsers] = useState<{ id: number; label: string }[]>([]);
  const [entries, setEntries] = useState<HrActivityEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await getHrActivityUsers();
        setUsers(res.data ?? []);
      } catch {
        // Lista autorów to wygoda filtra — jej brak nie ma blokować dziennika.
        setUsers([]);
      }
    })();
  }, []);

  const params = useCallback(
    () => ({
      q,
      entityType: entityType === ALL ? ("" as const) : (entityType as HrActivityEntityType),
      userId: userId === ALL ? null : Number(userId),
      from: from || undefined,
      to: to || undefined,
      limit: 50,
    }),
    [q, entityType, userId, from, to],
  );

  // Pierwsza strona po każdej zmianie filtrów; szukajka z opóźnieniem, żeby
  // wpisywanie nazwiska nie wysyłało zapytania po każdej literze.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const res = await getHrActivity(params());
          if (!alive) return;
          setEntries(res.data?.items ?? []);
          setCursor(res.data?.nextCursor ?? null);
          setError(null);
        } catch (e) {
          if (!alive) return;
          setError(e instanceof Error ? e.message : "Nie udało się pobrać dziennika");
          setEntries([]);
          setCursor(null);
        } finally {
          if (alive) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [params]);

  const loadMore = async () => {
    if (!cursor) return;
    setLoadingMore(true);
    try {
      const res = await getHrActivity({ ...params(), cursor });
      setEntries((prev) => [...prev, ...(res.data?.items ?? [])]);
      setCursor(res.data?.nextCursor ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nie udało się pobrać kolejnej strony");
    } finally {
      setLoadingMore(false);
    }
  };

  const activeFilterCount =
    (q !== "" ? 1 : 0) +
    (entityType !== ALL ? 1 : 0) +
    (userId !== ALL ? 1 : 0) +
    (from !== "" ? 1 : 0) +
    (to !== "" ? 1 : 0);
  const filtersActive = activeFilterCount > 0;

  const clearFilters = () => {
    setQ("");
    setEntityType(ALL);
    setUserId(ALL);
    setFrom("");
    setTo("");
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {/* Etykieta grupy filtrów z licznikiem — jak pasek filtrów kalendarza
            i Realizacji: od razu widać, że lista jest zawężona. */}
        <span className={cn(FILTER_GROUP_LABEL_CLS, "inline-flex items-center gap-1")}>
          <Filter className="h-3.5 w-3.5" aria-hidden /> Filtry
          {activeFilterCount > 0 && (
            <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold tabular-nums text-primary-foreground">
              {activeFilterCount}
            </span>
          )}
        </span>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Szukaj: nazwisko, pole, wartość…"
            className="w-[280px] pl-8"
            data-testid="kadry-historia-filter-q"
          />
        </div>

        <Select value={entityType} onValueChange={setEntityType}>
          <SelectTrigger className="w-[170px]" data-testid="kadry-historia-filter-entity">
            <SelectValue placeholder="Typ wpisu" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Wszystko</SelectItem>
            {HR_ENTITY_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={userId} onValueChange={setUserId}>
          <SelectTrigger className="w-[190px]" data-testid="kadry-historia-filter-user">
            <SelectValue placeholder="Użytkownik" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Wszyscy użytkownicy</SelectItem>
            {users.map((u) => (
              <SelectItem key={u.id} value={String(u.id)}>
                {u.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="w-[150px]"
          aria-label="Data od"
          {...tip("Pokaż zmiany od tego dnia (włącznie)")}
          data-testid="kadry-historia-filter-from"
        />
        <Input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="w-[150px]"
          aria-label="Data do"
          {...tip("Pokaż zmiany do tego dnia (włącznie)")}
          data-testid="kadry-historia-filter-to"
        />

        {filtersActive && (
          <Button
            variant="ghost"
            size="sm"
            className={TOOLBAR_BTN_CLS}
            onClick={clearFilters}
            {...tip(`Zdejmij wszystkie filtry (aktywne: ${activeFilterCount})`)}
            data-testid="kadry-historia-filters-clear"
          >
            <X className="mr-1 h-4 w-4" />
            Wyczyść filtry
          </Button>
        )}
        <KadryHelp tab="historia" className="ml-auto" />
      </div>

      <div className="rounded-md border bg-background p-4" data-testid="kadry-historia-list">
        {error ? (
          <EmptyState
            icon={History}
            title="Nie udało się wczytać dziennika"
            description={error}
          />
        ) : loading ? (
          <p className="py-10 text-center text-sm text-muted-foreground">Wczytywanie…</p>
        ) : (
          <>
            <ActivityTimeline
              entries={entries}
              describe={(e) => describeHrActivity(e as HrActivityEntry)}
              fieldLabel={hrFieldLabel}
              formatValue={hrFieldValue}
              entryDetail={(e) => hrEntryDetail(e as HrActivityEntry)}
              initialLimit={50}
              emptyText={
                filtersActive
                  ? "Brak wpisów pasujących do filtrów."
                  : "Dziennik jest pusty — zmiany zaczną się w nim pojawiać po pierwszym zapisie."
              }
              renderExtra={(e) => <EntryMeta entry={e as HrActivityEntry} />}
            />
            {cursor && (
              <Button
                variant="outline"
                size="sm"
                className="mt-3 w-full"
                onClick={() => void loadMore()}
                disabled={loadingMore}
                data-testid="kadry-historia-more"
              >
                {loadingMore ? "Wczytywanie…" : "Pokaż więcej"}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** Podpis pod wpisem: typ, miesiąc i link do kartoteki pracownika. */
function EntryMeta({ entry }: { entry: HrActivityEntry }) {
  const type = HR_ENTITY_LABELS[entry.entityType as HrActivityEntityType];
  const period = hrPeriodLabel(entry.period);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
      {type && <span>{type}</span>}
      {period && <span>· {period}</span>}
      {entry.employee && (
        <>
          <span>·</span>
          <Link
            to={`/kadry/pracownicy?q=${encodeURIComponent(entry.employee.fullName)}`}
            className="text-primary hover:underline"
            data-testid="kadry-historia-employee-link"
          >
            {entry.employee.fullName}
          </Link>
        </>
      )}
    </div>
  );
}
