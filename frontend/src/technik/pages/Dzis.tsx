import { useEffect, useState } from "react";
import { markSeen } from "../lib/seen";
import { CalendarOff, ChevronLeft, ChevronRight, Sun, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "../ui/empty-state";
import { JobCard } from "../JobCard";
import { addDays, formatDayMonth, formatDayTitle, formatWeekday, todayIso } from "../lib/dates";
import { jobStateOf } from "../lib/jobs";
import { useJobs } from "../lib/useJobs";
import { useRefreshOnFocus } from "../lib/refresh";
import { useWeather } from "../lib/useWeather";
import { useTechnikMe } from "../lib/me";
import { useSwipeDay } from "../lib/use-swipe-day";

/**
 * Szkielet dwóch kart zamiast zdania „Ładuję dzień…”. Przy przerzucaniu dni
 * tekst wyglądał jak pusty dzień (to samo miejsce, ten sam szary kolor) —
 * kształt kart od razu mówi „zaraz tu coś będzie”, a nie „nic nie ma”.
 */
function JobsSkeleton() {
  return (
    <ul className="space-y-2" aria-hidden data-testid="dzis-szkielet">
      {[0, 1].map((i) => (
        <li key={i} className="animate-pulse rounded-xl border bg-card p-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-14 shrink-0 rounded-md bg-muted" />
            <div className="min-w-0 flex-1 space-y-2">
              <div className="h-4 w-2/3 rounded bg-muted" />
              <div className="h-3 w-1/2 rounded bg-muted" />
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

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
  // Jeden batch pogody na dzień — karty dostają gotowy skrót, nie pytają same.
  const weather = useWeather(jobs);
  const { me } = useTechnikMe();

  // Wejście na zakładkę = „widziałem” — efekt dziecka odpala się PRZED
  // odświeżeniem liczników w powłoce, więc plakietka „Dziś” gaśnie od razu.
  useEffect(() => markSeen("seenToday"), []);
  // …i tak samo po powrocie z tła: bez tego technik wracał do panelu, patrzył
  // wprost na listę i dalej miał żółtą plakietkę „Dziś”, bo znacznik „widziałem”
  // stał na chwili wejścia sprzed godziny. Ten nasłuch stoi PRZED nasłuchem
  // liczników z powłoki (efekty dziecka biegną pierwsze), więc `/technik/me`
  // dostaje już nowy znacznik.
  useRefreshOnFocus(() => markSeen("seenToday"));

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
        {/* Dwie linie: dzień tygodnia nad datą — „poniedziałek, 14 września”
            w jednej linii nie mieściło się obok trzech przycisków na 390 px. */}
        <h2 aria-live="polite" className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {formatWeekday(date)}
          </span>
          <span className="block truncate text-base font-semibold sm:text-lg">{formatDayMonth(date)}</span>
        </h2>
      </div>

      {/* --- LISTA ------------------------------------------------------ */}
      {me && !me.linked ? (
        <EmptyState
          icon={UserX}
          title="Konto nie jest powiązane z technikiem"
          description="Administrator musi połączyć to konto z kartoteką Technicy — dopiero wtedy pojawią się zlecenia."
        />
      ) : loading && jobs.length === 0 ? (
        <JobsSkeleton />
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
            <JobCard key={j.id} job={j} weather={weather[j.id]} />
          ))}
          {rest.map((j) => (
            <JobCard key={j.id} job={j} weather={weather[j.id]} />
          ))}
        </ul>
      )}
    </div>
  );
}

