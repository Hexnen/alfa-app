import { useMemo } from "react";
import { CalendarOff, CalendarCheck } from "lucide-react";
import type { TechnikJob } from "@/lib/api";
import { EmptyState } from "../ui/empty-state";
import { JobCard } from "../JobCard";
import { addDays, dayOf, groupLabel, todayIso } from "../lib/dates";
import { useJobs } from "../lib/useJobs";

/** Ile dni do przodu pokazuje panel. Dalej planowanie i tak się zmienia. */
const HORIZON_DAYS = 14;

/**
 * Koniec zakresu jest WYŁĄCZNY (`startAt < to`), więc żeby czternasty dzień
 * wszedł w całości, pytamy o `dziś + 15`.
 */
const RANGE_END_OFFSET = HORIZON_DAYS + 1;

/**
 * NADCHODZĄCE — dwa tygodnie do przodu, pogrupowane dniami.
 *
 * Nagłówki grup to „Dziś” / „Jutro” / „pt. 19.09”: o dwóch najbliższych dniach
 * myśli się słowami, o reszcie datą. Dni bez zleceń nie mają nagłówka — pusty
 * wiersz „czwartek: nic” wydłużałby scroll o połowę i niczego nie mówił.
 */
export function Nadchodzace() {
  const today = todayIso();
  const to = addDays(today, RANGE_END_OFFSET);
  const { jobs, loading, error } = useJobs(today, to);

  const groups = useMemo(() => groupByDay(jobs), [jobs]);

  if (loading && jobs.length === 0) {
    return <p className="py-10 text-center text-sm text-muted-foreground">Ładuję zlecenia…</p>;
  }

  if (error) {
    return (
      <EmptyState
        icon={CalendarOff}
        title="Nie udało się wczytać zleceń"
        description="Sprawdź połączenie i spróbuj ponownie."
      />
    );
  }

  if (groups.length === 0) {
    return (
      <EmptyState
        icon={CalendarCheck}
        title="Brak zleceń na najbliższe dwa tygodnie"
        description="Nowe zlecenia pojawią się tu, gdy tylko biuro przypisze Cię do wydarzenia."
      />
    );
  }

  return (
    <div className="space-y-5">
      {groups.map(([day, items]) => (
        <section key={day} aria-labelledby={`d-${day}`}>
          <h2
            id={`d-${day}`}
            // Sticky nagłówek dnia: przy przewijaniu dwóch tygodni trzeba
            // wiedzieć, którego dnia dotyczy karta pod palcem.
            className="sticky top-12 z-10 -mx-4 bg-background/95 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground backdrop-blur-sm"
          >
            {groupLabel(day, today)}
          </h2>
          <ul className="mt-2 space-y-2">
            {items.map((j) => (
              <JobCard key={j.id} job={j} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** Zlecenia w kubełkach dniami, dni i godziny rosnąco. */
function groupByDay(jobs: TechnikJob[]): [string, TechnikJob[]][] {
  const map = new Map<string, TechnikJob[]>();
  for (const job of jobs) {
    const day = dayOf(job.startAt);
    const bucket = map.get(day);
    if (bucket) bucket.push(job);
    else map.set(day, [job]);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, items]) => [day, items.sort((a, b) => a.startAt.localeCompare(b.startAt))]);
}
