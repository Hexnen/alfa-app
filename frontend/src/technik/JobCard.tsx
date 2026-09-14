import { Link } from "react-router-dom";
import { ChevronRight, FileText, MapPin, MessageSquarePlus, Users } from "lucide-react";
import { countNewNotes } from "./lib/seen";
import { countLabel } from "./lib/protocol";
import type { TechnikJob, WeatherBrief } from "@/lib/api";
// Ten sam znacznik co na kafelku kalendarza (ikona WMO + temperatura) — jedna
// mapa kodów i jedna paleta dla biura i dla tabletu, bez kopii w panelu.
import { WeatherMark } from "@/components/CalendarWeather";
import { cn } from "@/lib/utils";
import { timeOf } from "./lib/dates";
import {
  JOB_STATE_CLASSES,
  JOB_STATE_ICONS,
  JOB_STATE_LABELS,
  jobStateOf,
  jobTypeMeta,
  typeBarClass,
  typeChipClass,
} from "./lib/jobs";

/**
 * KARTA ZLECENIA — najczęściej dotykany element panelu.
 *
 * Układ: godzina (duża, tabelarycznie) · pasek koloru typu · obiekt i miasto ·
 * pigułka statusu. CAŁA karta jest linkiem: na tablecie, w rękawicy, cel
 * o wysokości 76 px trafia się bez patrzenia, a osobny przycisk „Otwórz”
 * zabierałby połowę wiersza z nazwą obiektu.
 *
 * Poniżej `sm` karta jest dwuwierszowa: na 390 px z „Centrum Handlowe…”
 * zostawało „Centr…”, gdy w tym samym wierszu stała jeszcze pigułka.
 */
export function JobCard({
  job,
  weather,
  className,
}: {
  job: TechnikJob;
  /** Skrót pogody dnia zlecenia; `null`/brak = nie renderujemy nic. */
  weather?: WeatherBrief | null;
  className?: string;
}) {
  const state = jobStateOf(job);
  const title = job.objectName || job.title;
  // Typ ma już swój chip z ikoną, więc w linii adresu nie powtarzamy etykiety.
  const meta = job.address || job.typeLabel;
  const typeMeta = jobTypeMeta(job.type);
  const TypeIcon = typeMeta?.icon;
  const StateIcon = JOB_STATE_ICONS[state];
  // Cudze notatki nowsze niż ostatnie otwarcie tego zlecenia na tym tablecie.
  const newNotes = countNewNotes(job.id, job.foreignNotesAt);

  return (
    <li>
      <Link
        to={`/technik/zlecenie/${job.id}`}
        className={cn(
          "flex min-h-[76px] flex-col gap-2 rounded-xl border bg-card p-3 shadow-sm",
          "transition-colors active:scale-[0.995] hover:bg-muted/40",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "sm:flex-row sm:items-center sm:gap-3",
          state === "cancelled" && "opacity-60",
          state === "running" && "border-amber-400 ring-1 ring-amber-300",
          className,
        )}
      >
        <div className="flex min-w-0 items-center gap-3 sm:flex-1">
          {/* Godzina — pierwsze, czego szuka oko rano w aucie. */}
          <div className="w-16 shrink-0 text-center">
            {job.allDay ? (
              <div className="text-sm font-semibold text-muted-foreground">cały dzień</div>
            ) : (
              <>
                <div
                  className={cn(
                    "text-lg font-semibold tabular-nums",
                    state === "cancelled" && "line-through",
                  )}
                >
                  {timeOf(job.startAt) || "—"}
                </div>
                <div className="text-xs tabular-nums text-muted-foreground">
                  {timeOf(job.endAt)}
                </div>
              </>
            )}
          </div>

          {/* Pasek koloru typu — dokładnie ten sam odcień co kafelek w kalendarzu
              technicznym (EVENT_TYPE_UI), a nie druga, własna paleta panelu. */}
          <span aria-hidden className={cn("h-12 w-1 shrink-0 rounded-full", typeBarClass(job.type))} />

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              {/* Chip typu jak przy filtrach kalendarza: ikona + obramowanie
                  w kolorze typu. Ikona niesie znaczenie także bez koloru. */}
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
              <span
                className={cn("truncate font-medium", state === "cancelled" && "line-through")}
              >
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
            {newNotes > 0 && (
              <div
                className="flex items-center gap-1 text-xs font-medium text-amber-700 dark:text-amber-300"
                data-testid="job-new-notes"
              >
                <MessageSquarePlus className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {countLabel(newNotes, "nowa notatka", "nowe notatki", "nowych notatek")}
              </div>
            )}
            <div className="hidden truncate text-sm text-muted-foreground sm:block">{meta}</div>
            {job.coTechnicians.length > 0 && (
              <div className="hidden items-center gap-1 truncate text-xs text-muted-foreground sm:flex">
                <Users className="h-3 w-3 shrink-0" aria-hidden />
                {job.coTechnicians.join(", ")}
              </div>
            )}
          </div>
        </div>

        {/* Wiersz 2 na telefonie; od `sm` zwykłe dzieci karty (jeden wiersz). */}
        <div className="flex items-center gap-2 sm:contents">
          <div className="flex min-w-0 flex-1 items-center gap-1 truncate text-sm text-muted-foreground sm:hidden">
            <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
            {meta}
          </div>

          {/* Pogoda tuż przed pigułką statusu: `shrink-0` + `whitespace-nowrap`
              pigułki trzymają wiersz w całości nawet na 390 px — adres obok
              i tak się ucina, a ikona z temperaturą to ~34 px. */}
          <WeatherMark brief={weather} compact />

          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium",
              JOB_STATE_CLASSES[state],
            )}
          >
            <StateIcon className="h-3 w-3" aria-hidden />
            {JOB_STATE_LABELS[state]}
          </span>
          <ChevronRight className="hidden h-5 w-5 shrink-0 text-muted-foreground sm:block" aria-hidden />
        </div>
      </Link>
    </li>
  );
}
