import { useEffect, useRef, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Navigation, X } from "lucide-react";
import type { TechnikJob, WeatherBrief } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { JobCard } from "../JobCard";
import { mapsHref } from "../lib/jobs";
import type { JobPin } from "./pins";

/**
 * DOLNA KARTA MAPY — wysuwa się nad tab barem, nigdy go nie zasłaniając.
 *
 * Dlaczego karta, a nie dymek na pinezce: dymek Leafleta ma 250 px, zamyka się
 * przy każdym musnięciu mapy i nie mieści dwóch przycisków po 44 px. Karta na
 * dole jest w zasięgu kciuka trzymającego tablet i mieści całą kartę zlecenia.
 */
export function MapSheet({
  title,
  subtitle,
  onClose,
  onHeight,
  children,
  testId,
}: {
  title: string;
  subtitle?: string;
  /** Brak = karta bez „X” (komunikat, nie wybór). */
  onClose?: () => void;
  /** Wysokość karty w px — mapa podnosi o nią swoje przyciski. */
  onHeight?: (px: number) => void;
  children?: ReactNode;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !onHeight) return;
    onHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);

  return (
    <div
      ref={ref}
      data-testid={testId}
      className={cn(
        "fixed inset-x-0 bottom-kb-nav z-40 mx-auto max-w-3xl",
        "rounded-t-2xl border bg-card text-card-foreground shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.45)]",
      )}
    >
      <div className="flex items-start gap-2 px-3 pb-2 pt-2.5">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{title}</h2>
          {/* Adres w dwóch liniach — na 390 px „ul. Puławska 12, Warszawa”
              ucinało się w pół nazwy miasta, a to jedyna treść tej karty. */}
          {subtitle && <p className="text-xs text-muted-foreground line-clamp-2">{subtitle}</p>}
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Zamknij"
            data-testid="technik-mapa-karta-zamknij"
            className="-mr-1 -mt-1 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>
      {/* Karta nigdy nie zjada więcej niż połowy ekranu — mapa pod nią ma zostać czytelna. */}
      <div className="max-h-[42dvh] overflow-y-auto px-3 pb-3">{children}</div>
    </div>
  );
}

/**
 * Treść karty dla jednej pinezki. Jedno zlecenie = karta + dwa przyciski
 * („Otwórz” i „Nawiguj”), kilka zleceń w tym samym obiekcie = ich lista.
 * Kart zleceń nie przepisujemy — to ten sam `JobCard`, co na agendzie.
 */
export function PinJobs({
  pin,
  weather,
}: {
  pin: JobPin;
  weather: Record<number, WeatherBrief | null>;
}) {
  const single = pin.jobs.length === 1 ? pin.jobs[0] : null;
  const maps = single ? mapsHref(single) : null;

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {pin.jobs.map((job) => (
          <JobCard key={job.id} job={job} weather={weather[job.id]} />
        ))}
      </ul>
      {single && (
        <div className="flex gap-2">
          <Button asChild className="h-11 flex-1" data-testid="technik-mapa-otworz">
            <Link to={`/technik/zlecenie/${single.id}`}>Otwórz</Link>
          </Button>
          {maps ? (
            <Button asChild variant="secondary" className="h-11 flex-1 gap-2">
              {/* Nawigacja otwiera się obok panelu — technik ma wrócić do zlecenia
                  jednym przełączeniem aplikacji, a nie cofaniem historii. */}
              <a href={maps} target="_blank" rel="noopener noreferrer">
                <Navigation className="h-4 w-4" aria-hidden />
                Nawiguj
              </a>
            </Button>
          ) : (
            <Button variant="secondary" className="h-11 flex-1 gap-2" disabled>
              <Navigation className="h-4 w-4" aria-hidden />
              Nawiguj
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** Lista zleceń bez współrzędnych (chip „N bez lokalizacji”). */
export function PlainJobs({
  jobs,
  weather,
}: {
  jobs: TechnikJob[];
  weather: Record<number, WeatherBrief | null>;
}) {
  return (
    <ul className="space-y-2">
      {jobs.map((job) => (
        <JobCard key={job.id} job={job} weather={weather[job.id]} />
      ))}
    </ul>
  );
}
