import { useState } from "react";
import { CalendarOff, ChevronLeft, ChevronRight, PlayCircle, Sun, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState } from "../ui/empty-state";
import { JobCard } from "../JobCard";
import { addDays, formatDayTitle, todayIso } from "../lib/dates";
import { jobStateOf } from "../lib/jobs";
import { useJobs } from "../lib/useJobs";
import { useTechnikMe } from "../lib/me";
import { useSwipeDay } from "../lib/use-swipe-day";

/**
 * DZIŚ — ekran domyślny, otwierany kilkanaście razy dziennie.
 *
 * Pasek dnia („‹ Dziś ›” + data) jest JEDNYM przyrządem: strzałki stoją przy
 * dacie, nie na dwóch końcach ekranu, bo to zawsze ruch „o jeden dzień w tył
 * od TEGO dnia”. Ten sam ruch da się zrobić gestem w lewo/prawo po liście.
 *
 * Zlecenie w toku idzie na górę listy — jest dokładnie jedno pytanie, które
 * technik zadaje temu ekranowi po przerwie: „co ja właściwie zacząłem”.
 */
export function Dzis() {
  const today = todayIso();
  const [date, setDate] = useState(today);
  const { jobs, loading, error } = useJobs(date, addDays(date, 1));
  const { me } = useTechnikMe();

  const swipeRef = useSwipeDay<HTMLDivElement>(
    () => setDate((d) => addDays(d, -1)),
    () => setDate((d) => addDays(d, 1)),
  );

  const running = jobs.filter((j) => jobStateOf(j) === "running");
  const rest = jobs.filter((j) => jobStateOf(j) !== "running");

  return (
    <div ref={swipeRef} className="space-y-3">
      {/* --- PASEK DNIA ------------------------------------------------- */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Poprzedni dzień"
          className="h-11 w-11 shrink-0"
          onClick={() => setDate(addDays(date, -1))}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        <Button
          variant={date === today ? "secondary" : "outline"}
          className="h-11 shrink-0"
          onClick={() => setDate(today)}
        >
          Dziś
        </Button>
        <Button
          variant="outline"
          size="icon"
          aria-label="Następny dzień"
          className="h-11 w-11 shrink-0"
          onClick={() => setDate(addDays(date, 1))}
        >
          <ChevronRight className="h-5 w-5" />
        </Button>
        <h2
          aria-live="polite"
          className="min-w-0 flex-1 truncate text-base font-semibold first-letter:uppercase sm:text-lg"
        >
          {formatDayTitle(date)}
        </h2>
      </div>

      {/* --- PIGUŁKI LICZNIKÓW — kontekst czytany PRZED listą ------------ */}
      <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
        <Pill label={`Dziś: ${me?.counts.today ?? 0}`} />
        <Pill
          icon={PlayCircle}
          label={`W toku: ${me?.counts.inProgress ?? 0}`}
          highlight={(me?.counts.inProgress ?? 0) > 0}
        />
        <Pill label={`14 dni: ${me?.counts.upcoming ?? 0}`} />
      </div>

      {/* --- LISTA ------------------------------------------------------ */}
      {me && !me.linked ? (
        <EmptyState
          icon={UserX}
          title="Konto nie jest powiązane z technikiem"
          description="Administrator musi połączyć to konto z kartoteką Technicy — dopiero wtedy pojawią się zlecenia."
        />
      ) : loading && jobs.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">Ładuję dzień…</p>
      ) : error ? (
        <EmptyState
          icon={CalendarOff}
          title="Nie udało się wczytać dnia"
          description="Sprawdź połączenie i spróbuj ponownie."
        />
      ) : jobs.length === 0 ? (
        <EmptyState
          icon={Sun}
          title="Brak zleceń tego dnia"
          description={date === today ? "Wolny dzień." : formatDayTitle(date)}
        />
      ) : (
        <ul className="space-y-2">
          {running.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
          {rest.map((j) => (
            <JobCard key={j.id} job={j} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** Pigułka licznika — statyczna, bo w v1 nie ma dokąd z niej wejść. */
function Pill({
  label,
  icon: Icon,
  highlight,
}: {
  label: string;
  icon?: typeof PlayCircle;
  highlight?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 text-sm",
        // Ton „coś się dzieje” bierzemy z konwencji chipów kalendarza
        // (border-…/50 + kolor tekstu), żeby pigułka nie znikała w ciemnym motywie.
        highlight
          ? "border-amber-500/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
          : "border-input bg-card",
      )}
    >
      {Icon && <Icon className="h-4 w-4" aria-hidden />}
      {label}
    </span>
  );
}
