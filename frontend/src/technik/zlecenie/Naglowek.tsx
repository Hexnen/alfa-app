import { useEffect, useState } from "react";
import { ChevronLeft } from "lucide-react";
import type { TechnikJobDetails, WeatherBrief } from "@/lib/api";
import { Button } from "@/components/ui/button";
// Ten sam znacznik pogody co na kafelku kalendarza i na karcie zlecenia.
import { WeatherMark } from "@/components/CalendarWeather";
import { fmtMinutes } from "@/lib/calendar-labels";
import { cn } from "@/lib/utils";
import { clockOf, dayOf, groupLabel, parseStamp, timeOf } from "../lib/dates";
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
 * NAGŁÓWEK ZLECENIA — sticky, dokładnie DWIE linie.
 *
 * Tytułem jest NAZWA OBIEKTU, bo to jej technik szuka wzrokiem („jestem pod
 * Kauflandem czy pod magazynem?”). Typ pracy zjeżdża do małej pigułki w drugiej
 * linii: niesie go już kolorowy pasek z lewej i ikona, a jako nagłówek zabierał
 * całą szerokość, żeby powiedzieć „Serwis”.
 *
 * Druga linia to jedno zdanie o terminie: „dziś 09:00–11:00 · ☁ 17°”.
 *
 * Po prawej pigułka stanu w konwencji kalendarza, a w trakcie roboty licznik
 * „w toku od 09:12 (48 min)” odświeżany co minutę — technik rozlicza się
 * z godzin i ma je widzieć bez liczenia w pamięci.
 */
export function Naglowek({
  job,
  weather,
  onBack,
}: {
  job: TechnikJobDetails;
  weather: WeatherBrief | null | undefined;
  onBack: () => void;
}) {
  const state = jobStateOf(job);
  const typeMeta = jobTypeMeta(job.type);
  const TypeIcon = typeMeta?.icon;
  const StateIcon = JOB_STATE_ICONS[state];
  const title = job.objectName || job.title || typeMeta?.label || job.typeLabel;

  const when = groupLabel(dayOf(job.startAt)).toLocaleLowerCase("pl");
  const hours = job.allDay
    ? "cały dzień"
    : `${timeOf(job.startAt)}${timeOf(job.endAt) ? `–${timeOf(job.endAt)}` : ""}`;

  return (
    <header
      className="sticky top-0 z-30 -mx-4 mb-3 border-b bg-background/95 px-2 pb-1.5 pt-safe backdrop-blur-sm"
      data-testid="zlecenie-naglowek"
    >
      <div className="flex min-h-12 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Wstecz"
          className="h-11 w-11 shrink-0"
          onClick={onBack}
        >
          <ChevronLeft className="h-5 w-5" />
        </Button>
        {/* Pasek koloru typu — ten sam odcień, co kafelek w kalendarzu biura. */}
        <span aria-hidden className={cn("h-9 w-1 shrink-0 rounded-full", typeBarClass(job.type))} />

        <div className="min-w-0 flex-1 pl-1">
          <h1 className="truncate text-base font-semibold leading-tight" title={title}>
            {title}
          </h1>
          {/* `flex-wrap`: przy 320/360 px godziny („dziś 14:00–16:00”) nie
              mieszczą się obok pigułki typu i wcześniej ucinały się w pół —
              teraz schodzą do własnej linii w całości. */}
          <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {/* Pigułka typu: ikona niesie znaczenie także bez koloru. Na telefonie
                zostaje sama ikona — etykieta „Konserwacja” zjadała tam godziny,
                a to ta sama konwencja, co na karcie zlecenia. */}
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[11px] font-medium",
                typeChipClass(job.type),
              )}
              title={typeMeta?.label ?? job.typeLabel}
            >
              {TypeIcon && <TypeIcon className="h-3 w-3" aria-hidden />}
              <span className="hidden sm:inline">{typeMeta?.label ?? job.typeLabel}</span>
            </span>
            <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">
              {when} {hours}
            </span>
            <WeatherMark brief={weather} compact />
          </div>
        </div>

        {state === "running" ? (
          <Licznik startedAt={job.startedAt} />
        ) : (
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
              JOB_STATE_CLASSES[state],
            )}
            data-testid="zlecenie-stan"
          >
            <StateIcon className="h-3 w-3" aria-hidden />
            {JOB_STATE_LABELS[state]}
          </span>
        )}
      </div>
    </header>
  );
}

/**
 * LICZNIK „W TOKU” — dwie mikro-linie w jednej pigułce, bo pełne zdanie
 * („w toku od 09:12 (48 min)”) w jednej linii zjadało na 390 px połowę miejsca
 * na nazwę obiektu. Pełna treść zostaje w `aria-label`.
 *
 * Tyka co minutę: sekundy nie są tu nikomu potrzebne, a przerysowywanie co
 * sekundę budziłoby ekran tabletu leżącego w aucie.
 */
function Licznik({ startedAt }: { startedAt: string | null }) {
  const minutes = useElapsedMinutes(startedAt);
  const from = clockOf(startedAt);
  // „431 min” nic nie mówi — od godziny w górę pokazujemy „7 godz. 11 min”
  // (ten sam format co dojazd i kalendarz). Poniżej minuty: „< 1 min”.
  const elapsed = minutes == null ? null : minutes < 1 ? "< 1 min" : fmtMinutes(minutes);
  const label = `w toku od ${from}${elapsed == null ? "" : ` (${elapsed})`}`;
  const PlayIcon = JOB_STATE_ICONS.running;

  return (
    <span
      className={cn(
        "flex shrink-0 flex-col items-end rounded-lg px-2 py-1 text-[11px] font-medium leading-tight tabular-nums",
        JOB_STATE_CLASSES.running,
      )}
      aria-label={label}
      data-testid="zlecenie-licznik"
    >
      <span className="flex items-center gap-1 whitespace-nowrap">
        <PlayIcon className="h-3 w-3" aria-hidden />
        od {from || "—"}
      </span>
      {elapsed != null && <span className="whitespace-nowrap">{elapsed}</span>}
    </span>
  );
}

/** Minuty od znacznika `startedAt`; `null` = nie ma czego liczyć. Tyka co minutę. */
function useElapsedMinutes(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, [startedAt]);

  const from = parseStamp(startedAt);
  if (!from) return null;
  const mins = Math.floor((now - from.getTime()) / 60_000);
  // Znacznik z przyszłości (technik wpisał „inną godzinę”) nie ma pokazywać minusa.
  return mins < 0 ? 0 : mins;
}
