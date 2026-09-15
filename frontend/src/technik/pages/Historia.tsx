import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, FileText, History, Loader2, SearchX, Users } from "lucide-react";
import { technikApi, type TechnikJob } from "@/lib/api";
import { cn } from "@/lib/utils";
import { EmptyState } from "../ui/empty-state";
import { SegmentedControl } from "../ui/segmented";
import { ClearableInput } from "../ui/clearable-input";
import { clockOf, dayOf, formatMonthTitle, formatWeekdayShort, timeOf } from "../lib/dates";
import {
  JOB_STATE_CLASSES,
  JOB_STATE_ICONS,
  JOB_STATE_LABELS,
  jobStateOf,
  jobTypeMeta,
  typeBarClass,
  typeChipClass,
} from "../lib/jobs";

/**
 * HISTORIA — wszystko, co technik ma już za sobą.
 *
 * Wchodzi się tu z „Więcej”, nie z tab bara: to ekran otwierany przy pytaniu
 * „kiedy ja tam ostatnio byłem i co robiłem”, a nie codzienna lista roboty.
 * Dlatego też nie ma tu pogody, licznika ani plakietek „nowe notatki” —
 * przeszłości się nie planuje.
 *
 * DANE IDĄ STRONAMI PO 50, kursorem z backendu (`/technik/jobs/history`).
 * Technik z trzyletnim stażem ma w kartotece tysiące wydarzeń i wciągnięcie
 * ich naraz do pamięci tabletu kończyłoby się zadyszką przy każdym scrollu.
 *
 * FILTRY DZIAŁAJĄ NA WCZYTANYM (front, bez zapytania) — to świadoma
 * asymetria wobec list CRM-a. Szukanie po stronie serwera znaczyłoby nowy
 * endpoint z indeksem po nazwie obiektu, a tu chodzi o „odsiej te dwa ekrany,
 * które właśnie widzę”. Gdy filtr coś ukrywa, a na serwerze są jeszcze
 * strony, mówimy o tym wprost pod listą — inaczej pusty wynik wyglądałby na
 * „nigdy tam nie byłem”.
 */
export function Historia() {
  const [jobs, setJobs] = useState<TechnikJob[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  /** `true`, dopóki backend oddaje kursor — czyli „są jeszcze starsze”. */
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [proto, setProto] = useState<ProtoFilter>("all");

  /**
   * Strona w locie — bez tego obserwator dna listy potrafił wystrzelić drugie
   * zapytanie o TĘ SAMĄ stronę, zanim pierwsza wróciła, i zlecenia
   * podwajały się na ekranie.
   */
  const busy = useRef(false);

  const loadMore = useCallback(
    async (after: string | null) => {
      if (busy.current) return;
      busy.current = true;
      if (after) setLoadingMore(true);
      try {
        const page = await technikApi.history(after);
        setJobs((prev) => {
          // Pierwsza strona zastępuje, kolejne dokładają. `id` odsiewa
          // powtórki, gdyby zlecenie przesunęło się między stronami.
          if (!after) return page.items;
          const seen = new Set(prev.map((j) => j.id));
          return [...prev, ...page.items.filter((j) => !seen.has(j.id))];
        });
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor != null);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Nie udało się wczytać historii.");
      } finally {
        busy.current = false;
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadMore(null);
  }, [loadMore]);

  const filtered = useMemo(() => filterJobs(jobs, query, proto), [jobs, query, proto]);
  const groups = useMemo(() => groupByMonth(filtered), [filtered]);
  const filtering = query.trim().length > 0 || proto !== "all";

  /**
   * Dociąganie przy dojściu do dna. Obserwujemy PRZYCISK „Pokaż więcej”, a nie
   * niewidoczną kotwicę: przycisk i tak musi tam stać (dla klawiatury,
   * czytnika ekranu i gdy IntersectionObserver nie wypali), więc to jeden
   * element zamiast dwóch.
   */
  const moreRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const el = moreRef.current;
    if (!el || !hasMore || loading) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore(cursor);
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [cursor, hasMore, loading, loadMore, filtered.length]);

  if (loading) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Ładuję historię…</p>;
  }

  if (error && jobs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nie udało się wczytać historii"
        description="Sprawdź połączenie i spróbuj ponownie."
      />
    );
  }

  if (jobs.length === 0) {
    return (
      <EmptyState
        icon={History}
        title="Nie ma jeszcze historii"
        description="Zlecenia trafiają tutaj, gdy minie ich termin albo gdy je zakończysz."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <ClearableInput
          value={query}
          onChange={setQuery}
          // NIE `type="search"`: WebKit dokłada wtedy WŁASNY krzyżyk obok tego
          // z `ClearableInput` i w polu stoją dwa „×” obok siebie.
          type="text"
          inputMode="search"
          enterKeyHint="search"
          aria-label="Szukaj w historii"
          placeholder="Szukaj obiektu lub adresu"
          className="h-12 text-base"
          data-testid="historia-szukaj"
        />
        <SegmentedControl<ProtoFilter>
          label="Protokół"
          value={proto}
          onChange={setProto}
          dense
          options={[
            { value: "all", label: "Wszystkie", "data-testid": "historia-filtr-all" },
            { value: "with", label: "Z protokołem", "data-testid": "historia-filtr-with" },
            { value: "without", label: "Bez", "data-testid": "historia-filtr-without" },
          ]}
        />
      </div>

      {groups.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Nic nie pasuje"
          description={
            hasMore
              ? "Filtry działają na wczytanych zleceniach — dociągnij starsze przyciskiem niżej albo zmień zapytanie."
              : "Zmień zapytanie albo wyłącz filtr protokołu."
          }
        />
      ) : (
        groups.map(([month, items]) => (
          <section key={month} aria-labelledby={`m-${month}`}>
            <h2
              id={`m-${month}`}
              // Sticky jak nagłówek dnia w „Nadchodzących” — po pół roku
              // przewijania trzeba wiedzieć, w którym miesiącu stoi palec.
              // `top-under-bar`, a nie `top-safe`: ten ekran MA górny pasek.
              className="sticky top-under-bar z-10 -mx-4 bg-background/95 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm"
            >
              {formatMonthTitle(month)}
            </h2>
            <ul className="mt-2 space-y-2" data-testid="historia-lista">
              {items.map((job) => (
                <HistoryRow key={job.id} job={job} />
              ))}
            </ul>
          </section>
        ))
      )}

      {/* Filtr obejmuje tylko to, co już przyszło — bez tego zdania „3 wyniki”
          przy pełnej historii w tle wyglądałoby na kompletną odpowiedź. */}
      {filtering && hasMore && groups.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Filtry działają na wczytanych zleceniach — starsze dociągnij niżej.
        </p>
      )}

      {hasMore ? (
        <button
          ref={moreRef}
          type="button"
          onClick={() => void loadMore(cursor)}
          disabled={loadingMore}
          data-testid="historia-wiecej"
          className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border bg-card text-base font-medium active:scale-[0.99] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {loadingMore && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {loadingMore ? "Wczytuję…" : "Pokaż starsze"}
        </button>
      ) : (
        <p className="pb-2 text-center text-xs text-muted-foreground">To już wszystko.</p>
      )}

      {error && jobs.length > 0 && (
        <p className="text-center text-sm text-destructive">{error}</p>
      )}
    </div>
  );
}

/** Który filtr protokołu jest wciśnięty. */
type ProtoFilter = "all" | "with" | "without";

/** Dopasowanie po nazwie obiektu, adresie i tytule — bez znaków diakrytycznych. */
function norm(s: string): string {
  return s.toLocaleLowerCase("pl-PL").normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function filterJobs(jobs: TechnikJob[], query: string, proto: ProtoFilter): TechnikJob[] {
  const q = norm(query.trim());
  return jobs.filter((j) => {
    if (proto === "with" && j.protocol == null) return false;
    if (proto === "without" && j.protocol != null) return false;
    if (!q) return true;
    return norm([j.objectName, j.address, j.title].filter(Boolean).join(" ")).includes(q);
  });
}

/**
 * Kubełki „YYYY-MM” po dniu STARTU. Backend oddaje już malejąco, więc
 * kolejność miesięcy i zleceń w miesiącu bierze się z kolejności wejścia —
 * nie sortujemy drugi raz, żeby nie rozjechać się z paginacją kursorem.
 */
function groupByMonth(jobs: TechnikJob[]): [string, TechnikJob[]][] {
  const map = new Map<string, TechnikJob[]>();
  for (const job of jobs) {
    const month = job.startAt.slice(0, 7);
    const bucket = map.get(month);
    if (bucket) bucket.push(job);
    else map.set(month, [job]);
  }
  return [...map.entries()];
}

/**
 * WIERSZ HISTORII — kompaktowy krewny `JobCard`.
 *
 * Różnica jest jedna, ale zasadnicza: w lewej kolumnie stoi DATA, nie godzina
 * rozpoczęcia. Na liście dnia „09:00” odpowiada na „o której tam jadę”;
 * w historii to samo „09:00” nie mówi nic, dopóki nie wiadomo, którego dnia.
 * Godzina schodzi pod nazwę — i tylko dla zakończonych, bo tam pytanie
 * brzmi „o której skończyłem”.
 *
 * Reszta języka jest wspólna z kartą zlecenia (pasek koloru typu, chip typu,
 * pigułka stanu, ikona protokołu), bo to ta sama robota widziana później.
 */
function HistoryRow({ job }: { job: TechnikJob }) {
  const state = jobStateOf(job);
  const title = job.objectName || job.title;
  const meta = job.address || job.typeLabel;
  const typeMeta = jobTypeMeta(job.type);
  const TypeIcon = typeMeta?.icon;
  const StateIcon = JOB_STATE_ICONS[state];
  const day = dayOf(job.startAt);
  // Zakończone: godzina z „Zakończ” (znacznik UTC z bazy), a gdy jej nie ma —
  // planowany koniec terminu. Bez tego wiersz nie mówi, ile ta robota zajęła.
  const finished = state === "done" ? clockOf(job.finishedAt) || timeOf(job.endAt) : "";

  return (
    <li>
      <Link
        to={`/technik/zlecenie/${job.id}`}
        data-testid="historia-wiersz"
        className={cn(
          "flex min-h-16 items-center gap-3 rounded-xl border bg-card p-3 shadow-sm",
          "transition-colors active:scale-[0.995] hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          state === "cancelled" && "opacity-60",
        )}
      >
        {/* Data — pierwsze, czego szuka oko w historii. */}
        <div className="w-11 shrink-0 text-center">
          <div className={cn("text-lg font-semibold tabular-nums leading-tight", state === "cancelled" && "line-through")}>
            {day.slice(8)}
          </div>
          <div className="text-[11px] text-muted-foreground">{formatWeekdayShort(day)}</div>
        </div>

        <span aria-hidden className={cn("h-10 w-1 shrink-0 rounded-full", typeBarClass(job.type))} />

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium",
                typeChipClass(job.type),
              )}
              title={job.typeLabel}
            >
              {TypeIcon && <TypeIcon className="h-3 w-3" aria-hidden />}
              <span className="hidden sm:inline">{typeMeta?.label ?? job.typeLabel}</span>
            </span>
            <span className={cn("truncate font-medium", state === "cancelled" && "line-through")}>
              {title}
            </span>
            {job.protocol && (
              <FileText
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  job.protocol.signed ? "text-emerald-600" : "text-muted-foreground",
                )}
                aria-label={job.protocol.signed ? "Protokół podpisany" : "Protokół w toku"}
              />
            )}
          </div>
          <div className="truncate text-sm text-muted-foreground">{meta}</div>
          {/* Stan stoi POD nazwą, a nie w osobnej kolumnie po prawej jak na
              karcie dnia. Pigułka „Zakończone” zabiera na 390 px jedną trzecią
              wiersza, a w historii to nazwa obiektu jest tym, czego się szuka —
              z pigułką obok zostawało z niej „WM Bart…”. */}
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
                JOB_STATE_CLASSES[state],
              )}
            >
              <StateIcon className="h-3 w-3" aria-hidden />
              {JOB_STATE_LABELS[state]}
            </span>
            {finished && (
              <span className="truncate text-xs tabular-nums text-muted-foreground">o {finished}</span>
            )}
            {job.coTechnicians.length > 0 && (
              <span className="hidden min-w-0 items-center gap-1 truncate text-xs text-muted-foreground sm:flex">
                <Users className="h-3 w-3 shrink-0" aria-hidden />
                {job.coTechnicians.join(", ")}
              </span>
            )}
          </div>
        </div>

        <ChevronRight className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" aria-hidden />
      </Link>
    </li>
  );
}

export default Historia;
